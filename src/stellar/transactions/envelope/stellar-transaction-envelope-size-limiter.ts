/**
 * Stellar transaction envelope size-limit enforcement.
 *
 * Evaluates an envelope against per-network policy before signing/submitting:
 * passphrase identity, decoded XDR size, sequence range, operation/resource
 * limits, simulation outcome, and duplicate submission. Chain/RPC responses are
 * treated as untrusted inputs and never trusted for policy decisions beyond the
 * explicitly validated passphrase string.
 *
 * Failure semantics are fail-closed: unknown networks, missing passphrases,
 * malformed sizes, RPC failures, and failed/absent required simulations deny
 * submission. All decisions are auditable and secret-free.
 */

import {
  MAX_OPERATIONS_PER_STELLAR_TRANSACTION,
  MAX_STELLAR_MEMO_BYTES,
  MAX_STELLAR_SEQUENCE,
  StellarEnvelopeAuditEvent,
  StellarEnvelopeNetworkStatus,
  StellarEnvelopePolicy,
  StellarEnvelopeSizeLimiterConfig,
  StellarEnvelopeSizeMetrics,
  StellarEnvelopeSizeRequest,
  StellarEnvelopeSizeResult,
  StellarEnvelopeSizeViolation,
  StellarEnvelopeViolationCode,
  StellarEnvelopeRpcClient,
} from './types';

interface CachedDecision {
  result: StellarEnvelopeSizeResult;
  expiresAt: number;
}

const MAX_PASSPHRASE_LENGTH = 256;

/**
 * Returns the decoded byte length of a strict, padded base64 string, or null
 * when the input is not canonical base64.
 */
export function decodedBase64ByteLength(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;

  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

/** Stable, non-cryptographic fingerprint for audit and duplicate detection. */
export function envelopeFingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}:${value.length}`;
}

function violation(
  code: StellarEnvelopeViolationCode,
  message: string,
  severity: 'error' | 'warning' = 'error',
  limit?: number,
  observed?: number,
): StellarEnvelopeSizeViolation {
  return {
    code,
    severity,
    message,
    ...(limit !== undefined ? { limit } : {}),
    ...(observed !== undefined ? { observed } : {}),
  };
}

export class StellarTransactionEnvelopeSizeLimiter {
  private readonly policies = new Map<string, StellarEnvelopePolicy>();
  private readonly allowUnlistedNetworks: boolean;
  private readonly requireNetworkPassphrase: boolean;
  private readonly onRpcFailure: 'deny' | 'allow';
  private readonly duplicatePolicy: 'deny' | 'warn';
  private readonly dedupeWindowMs: number;
  private readonly now: () => number;
  private readonly audit?: StellarEnvelopeSizeLimiterConfig['audit'];
  private readonly decisions = new Map<string, CachedDecision>();
  private readonly seenFingerprints = new Map<string, number>();
  private readonly metrics: StellarEnvelopeSizeMetrics = {
    evaluations: 0,
    allowed: 0,
    denied: 0,
    duplicates: 0,
    rpcFailures: 0,
  };

  constructor(config: StellarEnvelopeSizeLimiterConfig) {
    this.allowUnlistedNetworks = config.allowUnlistedNetworks ?? false;
    this.requireNetworkPassphrase = config.requireNetworkPassphrase ?? true;
    this.onRpcFailure = config.onRpcFailure ?? 'deny';
    this.duplicatePolicy = config.duplicatePolicy ?? 'deny';
    this.dedupeWindowMs = config.dedupeWindowMs ?? 300_000;
    this.now = config.now ?? (() => Date.now());
    this.audit = config.audit;

    for (const policy of config.policies) {
      this.validatePolicy(policy);
      const key = this.normalizeNetwork(policy.network);
      if (this.policies.has(key)) {
        throw new Error(`Duplicate envelope policy for network: ${key}`);
      }
      this.policies.set(key, { ...policy, network: key });
    }
  }

  /**
   * Verify the network passphrase against the RPC node, then evaluate the
   * request. RPC failures deny by default; set `onRpcFailure: 'allow'` to
   * evaluate with an explicit warning instead.
   */
  async checkWithRpc(
    request: StellarEnvelopeSizeRequest,
    client: StellarEnvelopeRpcClient,
  ): Promise<StellarEnvelopeSizeResult> {
    const network = this.normalizeNetwork(request.network);
    const policy = this.policies.get(network);

    let reported: unknown;
    try {
      reported = await client.getNetworkPassphrase();
    } catch {
      this.metrics.rpcFailures += 1;
      if (this.onRpcFailure === 'deny') {
        const result = this.buildResult(
          network,
          request,
          null,
          policy,
          [
            violation(
              'RPC_UNAVAILABLE',
              'Network passphrase could not be verified because the Stellar RPC request failed',
            ),
          ],
          null,
        );
        return this.finalize(result, request);
      }

      return this.check(
        {
          ...request,
          network,
          networkPassphrase: request.networkPassphrase,
        },
        [
          violation(
            'NETWORK_UNVERIFIED',
            'RPC passphrase lookup failed; proceeding under onRpcFailure=allow',
            'warning',
          ),
        ],
      );
    }

    if (
      typeof reported !== 'string' ||
      reported.length === 0 ||
      reported.length > MAX_PASSPHRASE_LENGTH
    ) {
      this.metrics.rpcFailures += 1;
      const result = this.buildResult(
        network,
        request,
        null,
        policy,
        [
          violation(
            'RPC_RESPONSE_INVALID',
            'Stellar RPC returned a malformed network passphrase',
          ),
        ],
        null,
      );
      return this.finalize(result, request);
    }

    return this.check({
      ...request,
      network,
      networkPassphrase: reported,
    });
  }

  /**
   * Deterministic, side-effect-free limit evaluation (aside from audit,
   * metrics, and the duplicate/idempotency windows).
   */
  check(
    request: StellarEnvelopeSizeRequest,
    seedViolations: StellarEnvelopeSizeViolation[] = [],
  ): StellarEnvelopeSizeResult {
    const network = this.normalizeNetwork(request.network);
    const at = this.now();

    const cached = request.idempotencyKey
      ? this.decisions.get(request.idempotencyKey)
      : undefined;
    if (cached && cached.expiresAt > at) {
      return { ...cached.result, cached: true };
    }

    const policy = this.policies.get(network);
    if (!policy) {
      if (this.allowUnlistedNetworks) {
        return this.finalize(
          this.buildResult(
            network,
            request,
            null,
            undefined,
            [
              ...seedViolations,
              violation(
                'NETWORK_NOT_CONFIGURED',
                `No envelope policy configured for network "${request.network}"; size enforcement skipped`,
                'warning',
              ),
            ],
            null,
          ),
          request,
        );
      }

      return this.finalize(
        this.buildResult(
          network,
          request,
          null,
          undefined,
          [
            ...seedViolations,
            violation(
              'NETWORK_NOT_CONFIGURED',
              `No envelope policy configured for network "${request.network}"`,
            ),
          ],
          null,
        ),
        request,
      );
    }

    const violations: StellarEnvelopeSizeViolation[] = [...seedViolations];
    const envelope = this.resolveEnvelopeSize(request, violations);
    const fingerprint = this.resolveFingerprint(request, envelope.bytes);

    this.checkPassphrase(request, policy, violations);
    this.checkEnvelopeSize(envelope.bytes, policy, violations);
    this.checkSequence(request.sequence, violations);
    this.checkOperationCount(request.operationCount, policy, violations);
    this.checkMemo(request.memoBytes, policy, violations);
    this.checkSorobanData(
      request.sorobanTransactionDataBytes,
      policy,
      violations,
    );
    this.checkSimulation(request, policy, violations);

    if (
      fingerprint &&
      violations.every((item) => item.severity !== 'error') &&
      this.isDuplicate(fingerprint, at)
    ) {
      this.metrics.duplicates += 1;
      violations.push(
        violation(
          'DUPLICATE_ENVELOPE',
          `Envelope fingerprint ${fingerprint} was already accepted inside the ${this.dedupeWindowMs}ms window`,
          this.duplicatePolicy === 'deny' ? 'error' : 'warning',
        ),
      );
    }

    const result = this.buildResult(
      network,
      request,
      fingerprint,
      policy,
      violations,
      envelope.bytes,
    );

    if (result.allowed && fingerprint) {
      this.seenFingerprints.set(fingerprint, at + this.dedupeWindowMs);
    }

    return this.finalize(result, request);
  }

  /** Current policy status for one network. */
  getStatus(network: string): StellarEnvelopeNetworkStatus {
    const key = this.normalizeNetwork(network);
    const policy = this.policies.get(key);

    return {
      network: key,
      limitBytes: policy?.maxEnvelopeBytes ?? null,
      warningThresholdBytes: policy?.warningThresholdBytes ?? null,
      maxOperations: policy?.maxOperations ?? null,
      requireSimulation: policy?.requireSimulation ?? false,
      configured: policy !== undefined,
    };
  }

  /** Snapshot of decision metrics. */
  getMetrics(): StellarEnvelopeSizeMetrics {
    return { ...this.metrics };
  }

  /** Clear idempotency/duplicate state and metrics (tests and restarts). */
  reset(): void {
    this.decisions.clear();
    this.seenFingerprints.clear();
    this.metrics.evaluations = 0;
    this.metrics.allowed = 0;
    this.metrics.denied = 0;
    this.metrics.duplicates = 0;
    this.metrics.rpcFailures = 0;
  }

  private resolveEnvelopeSize(
    request: StellarEnvelopeSizeRequest,
    violations: StellarEnvelopeSizeViolation[],
  ): { bytes: number | null } {
    const decoded =
      request.envelopeXdr !== undefined
        ? decodedBase64ByteLength(request.envelopeXdr)
        : null;

    if (request.envelopeXdr !== undefined && decoded === null) {
      violations.push(
        violation(
          'INVALID_ENVELOPE_ENCODING',
          'envelopeXdr is not canonical padded base64',
        ),
      );
      return { bytes: null };
    }

    if (request.envelopeBytes !== undefined) {
      const bytes = request.envelopeBytes;
      if (!Number.isInteger(bytes) || bytes <= 0) {
        violations.push(
          violation(
            'INVALID_ENVELOPE_SIZE',
            `envelopeBytes must be a positive integer, got ${String(bytes)}`,
          ),
        );
        return { bytes: null };
      }

      if (decoded !== null && decoded !== bytes) {
        violations.push(
          violation(
            'ENVELOPE_SIZE_MISMATCH',
            `envelopeBytes (${bytes}) does not match decoded envelopeXdr size (${decoded})`,
            'error',
            decoded,
            bytes,
          ),
        );
        return { bytes };
      }

      return { bytes };
    }

    if (decoded !== null) return { bytes: decoded };

    violations.push(
      violation(
        'ENVELOPE_SIZE_MISSING',
        'Provide envelopeXdr or envelopeBytes to enforce the envelope size limit',
      ),
    );
    return { bytes: null };
  }

  private resolveFingerprint(
    request: StellarEnvelopeSizeRequest,
    bytes: number | null,
  ): string | null {
    if (request.envelopeXdr !== undefined) {
      return envelopeFingerprint(request.envelopeXdr);
    }
    if (bytes !== null) return envelopeFingerprint(`bytes:${bytes}`);
    return null;
  }

  private checkPassphrase(
    request: StellarEnvelopeSizeRequest,
    policy: StellarEnvelopePolicy,
    violations: StellarEnvelopeSizeViolation[],
  ): void {
    const passphrase = request.networkPassphrase;

    if (passphrase === undefined || passphrase === '') {
      if (this.requireNetworkPassphrase) {
        violations.push(
          violation(
            'NETWORK_PASSPHRASE_MISSING',
            'networkPassphrase is required to prove the envelope targets this network',
          ),
        );
      }
      return;
    }

    if (passphrase !== policy.networkPassphrase) {
      violations.push(
        violation(
          'NETWORK_PASSPHRASE_MISMATCH',
          `networkPassphrase does not match the configured ${policy.network} passphrase`,
        ),
      );
    }
  }

  private checkEnvelopeSize(
    bytes: number | null,
    policy: StellarEnvelopePolicy,
    violations: StellarEnvelopeSizeViolation[],
  ): void {
    if (bytes === null) return;

    if (bytes > policy.maxEnvelopeBytes) {
      violations.push(
        violation(
          'ENVELOPE_TOO_LARGE',
          `Envelope size ${bytes} bytes exceeds the ${policy.maxEnvelopeBytes} byte limit`,
          'error',
          policy.maxEnvelopeBytes,
          bytes,
        ),
      );
      return;
    }

    if (
      policy.warningThresholdBytes !== undefined &&
      bytes >= policy.warningThresholdBytes
    ) {
      violations.push(
        violation(
          'ENVELOPE_NEAR_LIMIT',
          `Envelope size ${bytes} bytes is at or above the warning threshold ${policy.warningThresholdBytes}`,
          'warning',
          policy.warningThresholdBytes,
          bytes,
        ),
      );
    }
  }

  private checkSequence(
    sequence: string | number | bigint | undefined,
    violations: StellarEnvelopeSizeViolation[],
  ): void {
    if (sequence === undefined) return;

    if (
      !(
        typeof sequence === 'bigint' ||
        typeof sequence === 'number' ||
        (typeof sequence === 'string' && /^[0-9]+$/.test(sequence))
      )
    ) {
      violations.push(
        violation(
          'INVALID_SEQUENCE',
          'sequence must be a positive integer string, number, or bigint',
        ),
      );
      return;
    }

    if (typeof sequence === 'number' && !Number.isSafeInteger(sequence)) {
      violations.push(
        violation(
          'INVALID_SEQUENCE',
          'sequence number must be a safe integer; pass a bigint or decimal string',
        ),
      );
      return;
    }

    let value: bigint;
    try {
      value = BigInt(sequence);
    } catch {
      violations.push(
        violation(
          'INVALID_SEQUENCE',
          'sequence could not be parsed as an integer',
        ),
      );
      return;
    }

    if (value <= 0n) {
      violations.push(
        violation(
          'SEQUENCE_OUT_OF_RANGE',
          `sequence must be greater than zero, got ${value.toString()}`,
        ),
      );
      return;
    }

    if (value > MAX_STELLAR_SEQUENCE) {
      violations.push(
        violation(
          'SEQUENCE_OUT_OF_RANGE',
          `sequence ${value.toString()} exceeds the Stellar int64 maximum`,
        ),
      );
    }
  }

  private checkOperationCount(
    count: number | undefined,
    policy: StellarEnvelopePolicy,
    violations: StellarEnvelopeSizeViolation[],
  ): void {
    if (count === undefined) return;

    if (!Number.isInteger(count) || count < 1) {
      violations.push(
        violation(
          'INVALID_OPERATION_COUNT',
          `operationCount must be a positive integer, got ${String(count)}`,
        ),
      );
      return;
    }

    const limit =
      policy.maxOperations ?? MAX_OPERATIONS_PER_STELLAR_TRANSACTION;
    if (count > limit) {
      violations.push(
        violation(
          'TOO_MANY_OPERATIONS',
          `${count} operations exceed the ${limit} operation limit`,
          'error',
          limit,
          count,
        ),
      );
    }
  }

  private checkMemo(
    bytes: number | undefined,
    policy: StellarEnvelopePolicy,
    violations: StellarEnvelopeSizeViolation[],
  ): void {
    if (bytes === undefined) return;

    const limit = policy.maxMemoBytes ?? MAX_STELLAR_MEMO_BYTES;
    if (!Number.isInteger(bytes) || bytes < 0) {
      violations.push(
        violation(
          'INVALID_ENVELOPE_SIZE',
          `memoBytes must be a non-negative integer, got ${String(bytes)}`,
        ),
      );
      return;
    }

    if (bytes > limit) {
      violations.push(
        violation(
          'MEMO_TOO_LARGE',
          `Memo size ${bytes} bytes exceeds the ${limit} byte limit`,
          'error',
          limit,
          bytes,
        ),
      );
    }
  }

  private checkSorobanData(
    bytes: number | undefined,
    policy: StellarEnvelopePolicy,
    violations: StellarEnvelopeSizeViolation[],
  ): void {
    if (bytes === undefined) return;

    if (!Number.isInteger(bytes) || bytes < 0) {
      violations.push(
        violation(
          'INVALID_ENVELOPE_SIZE',
          `sorobanTransactionDataBytes must be a non-negative integer, got ${String(bytes)}`,
        ),
      );
      return;
    }

    if (
      policy.maxSorobanTransactionDataBytes !== undefined &&
      bytes > policy.maxSorobanTransactionDataBytes
    ) {
      violations.push(
        violation(
          'SOROBAN_DATA_TOO_LARGE',
          `Soroban transaction data ${bytes} bytes exceeds the ${policy.maxSorobanTransactionDataBytes} byte limit`,
          'error',
          policy.maxSorobanTransactionDataBytes,
          bytes,
        ),
      );
    }
  }

  private checkSimulation(
    request: StellarEnvelopeSizeRequest,
    policy: StellarEnvelopePolicy,
    violations: StellarEnvelopeSizeViolation[],
  ): void {
    if (!request.simulation) {
      if (policy.requireSimulation) {
        violations.push(
          violation(
            'SIMULATION_REQUIRED',
            `Network ${policy.network} requires a successful simulation before submission`,
          ),
        );
      }
      return;
    }

    if (!request.simulation.safeToSubmit) {
      const failed = request.simulation.checks
        .filter((check) => check.status === 'failed')
        .map((check) => check.code)
        .join(', ');
      violations.push(
        violation(
          'SIMULATION_REJECTED',
          failed
            ? `Simulation rejected submission: ${failed}`
            : 'Simulation rejected submission',
        ),
      );
    }
  }

  private isDuplicate(fingerprint: string, at: number): boolean {
    const expiresAt = this.seenFingerprints.get(fingerprint);
    if (expiresAt === undefined) return false;
    if (expiresAt <= at) {
      this.seenFingerprints.delete(fingerprint);
      return false;
    }
    return true;
  }

  private buildResult(
    network: string,
    request: StellarEnvelopeSizeRequest,
    fingerprint: string | null,
    policy: StellarEnvelopePolicy | undefined,
    violations: StellarEnvelopeSizeViolation[],
    envelopeBytes: number | null,
  ): StellarEnvelopeSizeResult {
    const limitBytes = policy?.maxEnvelopeBytes ?? null;
    const allowed = violations.every((item) => item.severity !== 'error');

    return {
      allowed,
      network,
      envelopeBytes,
      limitBytes,
      utilization:
        envelopeBytes !== null && limitBytes !== null
          ? Math.round((envelopeBytes / limitBytes) * 10_000) / 10_000
          : null,
      fingerprint,
      violations,
      cached: false,
      evaluatedAt: this.now(),
    };
  }

  private finalize(
    result: StellarEnvelopeSizeResult,
    request: StellarEnvelopeSizeRequest,
  ): StellarEnvelopeSizeResult {
    this.metrics.evaluations += 1;
    if (result.allowed) this.metrics.allowed += 1;
    else this.metrics.denied += 1;

    if (request.idempotencyKey) {
      this.decisions.set(request.idempotencyKey, {
        result,
        expiresAt: result.evaluatedAt + this.dedupeWindowMs,
      });
    }

    if (this.audit) {
      const event: StellarEnvelopeAuditEvent = {
        network: result.network,
        decision: result.allowed ? 'allow' : 'deny',
        fingerprint: result.fingerprint,
        envelopeBytes: result.envelopeBytes,
        limitBytes: result.limitBytes,
        codes: result.violations.map((item) => item.code),
        ...(request.reference !== undefined
          ? { reference: request.reference }
          : {}),
        ...(request.idempotencyKey !== undefined
          ? { idempotencyKey: request.idempotencyKey }
          : {}),
        evaluatedAt: result.evaluatedAt,
      };
      this.audit.record(event);
    }

    return result;
  }

  private normalizeNetwork(network: string): string {
    return typeof network === 'string' ? network.trim().toLowerCase() : '';
  }

  private validatePolicy(policy: StellarEnvelopePolicy): void {
    if (!this.normalizeNetwork(policy.network)) {
      throw new Error('Envelope policy network is required');
    }
    if (!policy.networkPassphrase) {
      throw new Error(
        `Envelope policy ${policy.network} requires a network passphrase`,
      );
    }
    if (
      !Number.isInteger(policy.maxEnvelopeBytes) ||
      policy.maxEnvelopeBytes <= 0
    ) {
      throw new Error(
        `Envelope policy ${policy.network} maxEnvelopeBytes must be a positive integer`,
      );
    }
    if (
      policy.warningThresholdBytes !== undefined &&
      (!Number.isInteger(policy.warningThresholdBytes) ||
        policy.warningThresholdBytes <= 0 ||
        policy.warningThresholdBytes > policy.maxEnvelopeBytes)
    ) {
      throw new Error(
        `Envelope policy ${policy.network} warningThresholdBytes must be within (0, maxEnvelopeBytes]`,
      );
    }
    if (
      policy.maxOperations !== undefined &&
      (!Number.isInteger(policy.maxOperations) || policy.maxOperations <= 0)
    ) {
      throw new Error(
        `Envelope policy ${policy.network} maxOperations must be a positive integer`,
      );
    }
    if (
      policy.maxSorobanTransactionDataBytes !== undefined &&
      (!Number.isInteger(policy.maxSorobanTransactionDataBytes) ||
        policy.maxSorobanTransactionDataBytes <= 0)
    ) {
      throw new Error(
        `Envelope policy ${policy.network} maxSorobanTransactionDataBytes must be a positive integer`,
      );
    }
  }
}
