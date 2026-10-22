/**
 * Stellar transaction envelope size-limit types.
 *
 * Defines the configuration surface, request/result shapes, audit events, and
 * stable violation codes used before a Stellar transaction envelope is signed
 * or submitted. All limits are local policy; chain/RPC responses are treated as
 * untrusted inputs.
 */

import { SimulationCheckResult } from '../simulation';

/** Stellar protocol limit on operations in one transaction. */
export const MAX_OPERATIONS_PER_STELLAR_TRANSACTION = 100;

/** Stellar protocol limit on memo payload bytes. */
export const MAX_STELLAR_MEMO_BYTES = 28;

/** Stellar int64 maximum sequence number. */
export const MAX_STELLAR_SEQUENCE = 9_223_372_036_854_775_807n;

/** Well-known Stellar network passphrases. */
export const STELLAR_NETWORK_PASSPHRASES = {
  public: 'Public Global Stellar Network ; September 2015',
  testnet: 'Test SDF Network ; September 2015',
  futurenet: 'Test SDF Future Network ; October 2022',
} as const;

export type StellarNetworkName = keyof typeof STELLAR_NETWORK_PASSPHRASES;

/**
 * Envelope-size policy for one network.
 *
 * `maxEnvelopeBytes` is the decoded XDR size of the transaction envelope, as
 * reported by the network's ledger-upgrade configuration. Operators should pin
 * it to the value published for the target network rather than assuming a
 * permanent protocol constant.
 */
export interface StellarEnvelopePolicy {
  /** Network identifier, e.g. "stellar-testnet". */
  network: string;
  /** Expected passphrase for this network. */
  networkPassphrase: string;
  /** Maximum decoded envelope XDR size in bytes. */
  maxEnvelopeBytes: number;
  /** Optional warning threshold in bytes; must be <= maxEnvelopeBytes. */
  warningThresholdBytes?: number;
  /** Maximum operations per transaction. Defaults to the protocol limit (100). */
  maxOperations?: number;
  /** Maximum memo payload size in bytes. Defaults to the protocol limit (28). */
  maxMemoBytes?: number;
  /** Optional cap on Soroban transaction-data bytes. */
  maxSorobanTransactionDataBytes?: number;
  /** Require a successful simulation check before allowing submission. */
  requireSimulation?: boolean;
}

/** Configuration for the envelope size limiter. */
export interface StellarEnvelopeSizeLimiterConfig {
  /** Per-network policies. Unknown networks are denied unless allowed below. */
  policies: StellarEnvelopePolicy[];
  /** Allow networks without a policy (no size enforcement). Default: false. */
  allowUnlistedNetworks?: boolean;
  /** Require the request to carry a network passphrase. Default: true. */
  requireNetworkPassphrase?: boolean;
  /** Behavior when the RPC network lookup fails. Default: "deny". */
  onRpcFailure?: 'deny' | 'allow';
  /** Behavior when the same envelope fingerprint is seen again. Default: "deny". */
  duplicatePolicy?: 'deny' | 'warn';
  /** Duplicate/idempotency window in milliseconds. Default: 300_000 (5 min). */
  dedupeWindowMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Optional audit sink; events never contain raw envelopes or keys. */
  audit?: StellarEnvelopeAuditSink;
}

/** A request to validate one transaction envelope before signing/submitting. */
export interface StellarEnvelopeSizeRequest {
  /** Network identifier matching a configured policy. */
  network: string;
  /** Passphrase observed from signing configuration or RPC. */
  networkPassphrase?: string;
  /** Base64-encoded transaction envelope XDR. */
  envelopeXdr?: string;
  /** Pre-decoded envelope size in bytes; must match `envelopeXdr` when both set. */
  envelopeBytes?: number;
  /** Transaction sequence number (string, number, or bigint). */
  sequence?: string | number | bigint;
  /** Number of operations in the transaction. */
  operationCount?: number;
  /** Memo payload size in bytes. */
  memoBytes?: number;
  /** Soroban transaction-data payload size in bytes. */
  sorobanTransactionDataBytes?: number;
  /** Result from the simulation checker, when simulation was performed. */
  simulation?: SimulationCheckResult;
  /** Optional operator-facing reference (route id, quote id, etc.). */
  reference?: string;
  /** Idempotency key; repeated checks return the cached decision. */
  idempotencyKey?: string;
}

/** Result of evaluating one envelope against the configured limits. */
export interface StellarEnvelopeSizeResult {
  /** True only when no error-severity violations were found. */
  allowed: boolean;
  /** Network evaluated (normalized). */
  network: string;
  /** Decoded envelope size in bytes, when known. */
  envelopeBytes: number | null;
  /** Applied envelope byte limit, when a policy matched. */
  limitBytes: number | null;
  /** envelopeBytes / limitBytes, rounded to 4 decimals; null when unknown. */
  utilization: number | null;
  /** Stable fingerprint used for duplicate detection and audit. */
  fingerprint: string | null;
  /** Errors and warnings, in evaluation order. */
  violations: StellarEnvelopeSizeViolation[];
  /** True when the result came from the idempotency cache. */
  cached: boolean;
  /** Evaluation timestamp (epoch ms). */
  evaluatedAt: number;
}

/** A single limit violation. */
export interface StellarEnvelopeSizeViolation {
  code: StellarEnvelopeViolationCode;
  severity: 'error' | 'warning';
  message: string;
  /** Limit that was breached, when numeric. */
  limit?: number;
  /** Observed value that breached the limit, when numeric. */
  observed?: number;
}

/** Stable machine-readable envelope rejection/warning reasons. */
export type StellarEnvelopeViolationCode =
  | 'NETWORK_NOT_CONFIGURED'
  | 'NETWORK_PASSPHRASE_MISSING'
  | 'NETWORK_PASSPHRASE_MISMATCH'
  | 'NETWORK_UNVERIFIED'
  | 'ENVELOPE_SIZE_MISSING'
  | 'INVALID_ENVELOPE_SIZE'
  | 'INVALID_ENVELOPE_ENCODING'
  | 'ENVELOPE_SIZE_MISMATCH'
  | 'ENVELOPE_TOO_LARGE'
  | 'ENVELOPE_NEAR_LIMIT'
  | 'INVALID_SEQUENCE'
  | 'SEQUENCE_OUT_OF_RANGE'
  | 'INVALID_OPERATION_COUNT'
  | 'TOO_MANY_OPERATIONS'
  | 'MEMO_TOO_LARGE'
  | 'SOROBAN_DATA_TOO_LARGE'
  | 'SIMULATION_REQUIRED'
  | 'SIMULATION_REJECTED'
  | 'DUPLICATE_ENVELOPE'
  | 'RPC_UNAVAILABLE'
  | 'RPC_RESPONSE_INVALID';

/** Auditable decision event. Contains no raw envelope, passphrase, or keys. */
export interface StellarEnvelopeAuditEvent {
  network: string;
  decision: 'allow' | 'deny';
  fingerprint: string | null;
  envelopeBytes: number | null;
  limitBytes: number | null;
  codes: StellarEnvelopeViolationCode[];
  reference?: string;
  idempotencyKey?: string;
  evaluatedAt: number;
}

/** Sink for audit events (structured logger, table, queue, etc.). */
export interface StellarEnvelopeAuditSink {
  record(event: StellarEnvelopeAuditEvent): void;
}

/** Minimal RPC boundary used to verify the network passphrase. */
export interface StellarEnvelopeRpcClient {
  /** Returns the network passphrase reported by the RPC node. */
  getNetworkPassphrase(): Promise<unknown>;
}

/** Operator-facing metrics for envelope decisions. */
export interface StellarEnvelopeSizeMetrics {
  evaluations: number;
  allowed: number;
  denied: number;
  duplicates: number;
  rpcFailures: number;
}

/** Current policy status for one network (monitoring/debugging). */
export interface StellarEnvelopeNetworkStatus {
  network: string;
  limitBytes: number | null;
  warningThresholdBytes: number | null;
  maxOperations: number | null;
  requireSimulation: boolean;
  configured: boolean;
}

/** Default policies for public, testnet, and futurenet with 100 KiB envelopes. */
export function createDefaultEnvelopePolicies(): StellarEnvelopePolicy[] {
  return [
    {
      network: 'stellar-public',
      networkPassphrase: STELLAR_NETWORK_PASSPHRASES.public,
      maxEnvelopeBytes: 100 * 1024,
      warningThresholdBytes: 90 * 1024,
    },
    {
      network: 'stellar-testnet',
      networkPassphrase: STELLAR_NETWORK_PASSPHRASES.testnet,
      maxEnvelopeBytes: 100 * 1024,
      warningThresholdBytes: 90 * 1024,
    },
    {
      network: 'stellar-futurenet',
      networkPassphrase: STELLAR_NETWORK_PASSPHRASES.futurenet,
      maxEnvelopeBytes: 100 * 1024,
      warningThresholdBytes: 90 * 1024,
    },
  ];
}
