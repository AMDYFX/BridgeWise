/**
 * File: src/operations/mainnet/mainnet-canary-transfer.service.ts
 *
 * Mainnet canary transfer procedure (#1381).
 *
 * Safety properties:
 * - Only explicitly registered mainnet chains and assets are accepted.
 * - Every transfer is capped per chain, validated against a decimal-safe
 *   comparison, and destination addresses are masked in records.
 * - `canaryId` is idempotent: re-running the same plan returns the stored
 *   outcome and never resubmits; concurrent calls share one in-flight promise.
 * - Duplicate active canaries on the same route are rejected.
 * - A guard hook blocks submission during chain incidents or signer readiness
 *   failures, and full rollout requires a confirmed, verified canary.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  CanaryChainPolicy,
  CanaryFailureReason,
  CanaryPreflightResult,
  CanaryTransferDependencies,
  CanaryTransferGuard,
  CanaryTransferGuardDecision,
  CanaryTransferRequest,
  MainnetCanaryTransferPlan,
  MainnetCanaryTransferRecord,
  MainnetCanaryTransferResult,
  RunCanaryTransferOptions,
} from './mainnet-canary-transfer.types';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const ACTIVE_CANARY_STATUSES = ['planned', 'submitted'];
const SAFE_CODE = /^[a-z0-9_.:-]{1,64}$/i;
const DECIMAL_PATTERN = /^(\d{1,24})(?:\.(\d{1,18}))?$/;

interface NormalizedCanaryPlan {
  canaryId: string;
  chain: string;
  routeId: string;
  asset: string;
  amount: string;
  destination: string;
  requestedBy: string;
  requiredConfirmations: number;
  timeoutMs: number;
}

interface PlanEvaluation {
  result: CanaryPreflightResult;
  plan?: NormalizedCanaryPlan;
  policy?: CanaryChainPolicy;
}

export interface MainnetCanaryTransferServiceOptions {
  /** Injectable clock for deterministic timeout tests. */
  now?: () => number;
  /** Injectable sleep for deterministic confirmation polling. */
  sleep?: (ms: number) => Promise<void>;
  defaultPollIntervalMs?: number;
}

@Injectable()
export class MainnetCanaryTransferService {
  private readonly logger = new Logger(MainnetCanaryTransferService.name);
  private readonly policies = new Map<string, CanaryChainPolicy>();
  private readonly records = new Map<string, MainnetCanaryTransferRecord>();
  private readonly inFlight = new Map<
    string,
    Promise<MainnetCanaryTransferResult>
  >();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly defaultPollIntervalMs: number;

  constructor(options: MainnetCanaryTransferServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.defaultPollIntervalMs =
      options.defaultPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (
      !Number.isFinite(this.defaultPollIntervalMs) ||
      this.defaultPollIntervalMs <= 0
    ) {
      throw new Error('defaultPollIntervalMs must be a positive number');
    }
  }

  public registerChainPolicy(policy: CanaryChainPolicy): CanaryChainPolicy {
    const normalized = this.normalizePolicy(policy);
    this.policies.set(normalized.chain, normalized);
    return this.copyPolicy(normalized);
  }

  public getChainPolicy(chain: string): CanaryChainPolicy | undefined {
    const policy = this.policies.get(normalizeChain(chain));
    return policy ? this.copyPolicy(policy) : undefined;
  }

  public listChainPolicies(): CanaryChainPolicy[] {
    return Array.from(this.policies.values()).map((policy) =>
      this.copyPolicy(policy),
    );
  }

  /**
   * Validate a plan without touching the submission path. Useful for dry runs
   * and operator checks before a canary window.
   */
  public preflight(plan: MainnetCanaryTransferPlan): CanaryPreflightResult {
    return this.evaluatePlan(plan).result;
  }

  /**
   * Run (or replay) a canary. Reusing a `canaryId` never resubmits, even when
   * the previous attempt failed; operators must use a new id to retry.
   */
  public async run(
    plan: MainnetCanaryTransferPlan,
    dependencies: CanaryTransferDependencies,
    options: RunCanaryTransferOptions = {},
  ): Promise<MainnetCanaryTransferResult> {
    const canaryId =
      typeof plan?.canaryId === 'string' ? plan.canaryId.trim() : '';
    if (!canaryId) {
      throw new Error('canaryId must be a non-empty string');
    }

    const pending = this.inFlight.get(canaryId);
    if (pending !== undefined) {
      return pending;
    }
    const existing = this.records.get(canaryId);
    if (existing) {
      return this.toResult(existing);
    }

    const promise = this.execute(plan, dependencies, options).finally(() => {
      this.inFlight.delete(canaryId);
    });
    this.inFlight.set(canaryId, promise);
    return promise;
  }

  public getRecord(canaryId: string): MainnetCanaryTransferRecord | undefined {
    const record = this.records.get(canaryId.trim());
    return record ? this.copyRecord(record) : undefined;
  }

  public listRecords(): MainnetCanaryTransferRecord[] {
    return Array.from(this.records.values()).map((record) =>
      this.copyRecord(record),
    );
  }

  public hasActiveCanary(routeId: string): boolean {
    return Array.from(this.records.values()).some(
      (record) =>
        record.routeId === routeId.trim() &&
        ACTIVE_CANARY_STATUSES.includes(record.status),
    );
  }

  /**
   * Gate for expanding a rollout. Throws unless the canary reached confirmed
   * status after confirmation and settlement verification.
   */
  public authorizeFullRollout(canaryId: string): MainnetCanaryTransferRecord {
    const record = this.records.get(canaryId.trim());
    if (!record) {
      throw new Error(`Canary transfer not found: ${canaryId}`);
    }
    if (record.status !== 'confirmed') {
      throw new Error(
        `Canary ${record.canaryId} is ${record.status} and cannot authorize a rollout`,
      );
    }
    return this.copyRecord(record);
  }

  public clear(): void {
    this.records.clear();
    this.inFlight.clear();
  }

  private async execute(
    plan: MainnetCanaryTransferPlan,
    dependencies: CanaryTransferDependencies,
    options: RunCanaryTransferOptions,
  ): Promise<MainnetCanaryTransferResult> {
    this.assertDependencies(dependencies);
    const pollIntervalMs = options.pollIntervalMs ?? this.defaultPollIntervalMs;
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new Error('pollIntervalMs must be a positive number');
    }

    const evaluation = this.evaluatePlan(plan);
    if (!evaluation.result.allowed || !evaluation.plan) {
      return this.recordBlockedAttempt(plan, evaluation.result);
    }

    const normalized = evaluation.plan;
    const record: MainnetCanaryTransferRecord = {
      canaryId: normalized.canaryId,
      chain: normalized.chain,
      routeId: normalized.routeId,
      asset: normalized.asset,
      amount: normalized.amount,
      destinationMasked: maskDestination(normalized.destination),
      status: 'planned',
      requestedBy: normalized.requestedBy,
      requiredConfirmations: normalized.requiredConfirmations,
      timeoutMs: normalized.timeoutMs,
      confirmations: 0,
      attempts: 0,
      audit: [{ at: this.now(), step: 'planned' }],
    };
    this.records.set(record.canaryId, record);

    if (options.guard) {
      const guardDecision = await this.evaluateGuard(options.guard, record);
      if (!guardDecision.allowed) {
        return this.fail(
          record,
          'operator_guard_denied',
          sanitizeCode(guardDecision.reasonCode, 'guard_denied'),
        );
      }
    }

    const request: CanaryTransferRequest = {
      canaryId: normalized.canaryId,
      chain: normalized.chain,
      routeId: normalized.routeId,
      asset: normalized.asset,
      amount: normalized.amount,
      destination: normalized.destination,
    };

    record.attempts = 1;
    record.status = 'submitted';
    record.submittedAt = this.now();
    record.audit.push({ at: record.submittedAt, step: 'submitted' });

    let txHash: string;
    try {
      const submission = await dependencies.submit(request);
      if (!submission?.txHash || typeof submission.txHash !== 'string') {
        return this.fail(record, 'submission_failed', 'missing_tx_hash');
      }
      txHash = submission.txHash;
      record.txHash = txHash;
      this.logger.log(
        `Canary transfer submitted canary=${record.canaryId} chain=${record.chain} route=${record.routeId}`,
      );
    } catch (error) {
      return this.fail(
        record,
        'submission_failed',
        sanitizeCode((error as { code?: unknown })?.code, 'submit_error'),
      );
    }

    const deadline = this.now() + record.timeoutMs;
    let confirmationProbeError: string | undefined;
    for (;;) {
      try {
        const confirmations = await dependencies.getConfirmations(
          record.chain,
          txHash,
        );
        if (Number.isFinite(confirmations) && confirmations >= 0) {
          record.confirmations = Math.max(
            record.confirmations,
            Math.floor(confirmations),
          );
          if (record.confirmations >= record.requiredConfirmations) break;
        }
      } catch (error) {
        confirmationProbeError = sanitizeCode(
          (error as { code?: unknown })?.code,
          'confirmation_probe_error',
        );
      }

      const remaining = deadline - this.now();
      if (remaining <= 0) {
        return this.fail(
          record,
          'confirmation_timeout',
          confirmationProbeError ?? 'confirmation_timeout',
        );
      }
      await this.sleep(Math.min(pollIntervalMs, remaining));
    }

    if (dependencies.verifySettlement) {
      try {
        const verified = await dependencies.verifySettlement(request, txHash);
        if (!verified) {
          return this.fail(
            record,
            'verification_failed',
            'settlement_mismatch',
          );
        }
      } catch (error) {
        return this.fail(
          record,
          'verification_failed',
          sanitizeCode(
            (error as { code?: unknown })?.code,
            'verification_error',
          ),
        );
      }
    }

    record.status = 'confirmed';
    record.confirmedAt = this.now();
    record.audit.push({
      at: record.confirmedAt,
      step: 'confirmed',
      detail: `${record.confirmations}_confirmations`,
    });
    this.logger.log(
      `Canary transfer confirmed canary=${record.canaryId} chain=${record.chain} confirmations=${record.confirmations}`,
    );
    return this.toResult(record);
  }

  private evaluatePlan(plan: MainnetCanaryTransferPlan): PlanEvaluation {
    if (!plan || typeof plan !== 'object') {
      return {
        result: { allowed: false, reason: 'invalid_plan', detail: 'plan' },
      };
    }

    const requiredFields: Array<keyof MainnetCanaryTransferPlan> = [
      'canaryId',
      'chain',
      'routeId',
      'asset',
      'amount',
      'destination',
      'requestedBy',
    ];
    for (const field of requiredFields) {
      const value = plan[field];
      if (typeof value !== 'string' || value.trim() === '') {
        return {
          result: { allowed: false, reason: 'invalid_plan', detail: field },
        };
      }
    }

    const amount = parseDecimal(plan.amount);
    if (amount === undefined || amount <= 0n) {
      return {
        result: {
          allowed: false,
          reason: 'invalid_plan',
          detail: 'amount',
        },
      };
    }

    const chain = normalizeChain(plan.chain);
    const policy = this.policies.get(chain);
    if (!policy) {
      return {
        result: {
          allowed: false,
          reason: 'chain_not_allowed',
          detail: chain,
        },
      };
    }

    const asset = plan.asset.trim().toUpperCase();
    if (!policy.assets.includes(asset)) {
      return {
        result: {
          allowed: false,
          reason: 'asset_not_allowed',
          detail: asset,
        },
      };
    }

    const cap = parseDecimal(policy.maxAmount);
    if (cap === undefined || amount > cap) {
      return {
        result: {
          allowed: false,
          reason: 'amount_exceeds_cap',
          detail: policy.maxAmount,
        },
      };
    }

    const requiredConfirmations =
      plan.requiredConfirmations ?? policy.requiredConfirmations;
    if (
      !Number.isInteger(requiredConfirmations) ||
      requiredConfirmations < policy.requiredConfirmations ||
      requiredConfirmations > 1_000
    ) {
      return {
        result: {
          allowed: false,
          reason: 'invalid_plan',
          detail: 'requiredConfirmations',
        },
      };
    }

    const timeoutMs = plan.timeoutMs ?? policy.timeoutMs;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > policy.timeoutMs
    ) {
      return {
        result: {
          allowed: false,
          reason: 'invalid_plan',
          detail: 'timeoutMs',
        },
      };
    }

    const routeId = plan.routeId.trim();
    const duplicate = Array.from(this.records.values()).find(
      (record) =>
        record.routeId === routeId &&
        record.canaryId !== plan.canaryId.trim() &&
        ACTIVE_CANARY_STATUSES.includes(record.status),
    );
    if (duplicate) {
      return {
        result: {
          allowed: false,
          reason: 'duplicate_active_canary',
          detail: duplicate.canaryId,
        },
      };
    }

    return {
      result: { allowed: true },
      policy,
      plan: {
        canaryId: plan.canaryId.trim(),
        chain,
        routeId,
        asset,
        amount: plan.amount.trim(),
        destination: plan.destination.trim(),
        requestedBy: plan.requestedBy.trim(),
        requiredConfirmations,
        timeoutMs,
      },
    };
  }

  private recordBlockedAttempt(
    plan: MainnetCanaryTransferPlan,
    preflight: CanaryPreflightResult,
  ): MainnetCanaryTransferResult {
    const at = this.now();
    const record: MainnetCanaryTransferRecord = {
      canaryId: String(plan?.canaryId ?? '').trim(),
      chain:
        typeof plan?.chain === 'string' ? plan.chain.trim().toLowerCase() : '',
      routeId: typeof plan?.routeId === 'string' ? plan.routeId.trim() : '',
      asset:
        typeof plan?.asset === 'string' ? plan.asset.trim().toUpperCase() : '',
      amount: typeof plan?.amount === 'string' ? plan.amount.trim() : '',
      destinationMasked: maskDestination(plan?.destination),
      status: 'blocked',
      requestedBy:
        typeof plan?.requestedBy === 'string' ? plan.requestedBy.trim() : '',
      requiredConfirmations: 0,
      timeoutMs: 0,
      confirmations: 0,
      failureReason: preflight.reason ?? 'invalid_plan',
      failureDetail: sanitizeCode(preflight.detail, 'preflight_failed'),
      attempts: 0,
      audit: [{ at, step: 'blocked', detail: preflight.reason }],
    };
    if (record.canaryId) {
      this.records.set(record.canaryId, record);
    }
    this.logger.warn(
      `Canary transfer blocked canary=${record.canaryId} chain=${record.chain} reason=${record.failureReason}`,
    );
    return this.toResult(record);
  }

  private fail(
    record: MainnetCanaryTransferRecord,
    reason: CanaryFailureReason,
    detail: string,
  ): MainnetCanaryTransferResult {
    record.status = 'failed';
    record.failureReason = reason;
    record.failureDetail = sanitizeCode(detail, 'unspecified');
    record.audit.push({
      at: this.now(),
      step: 'failed',
      detail: `${reason}:${record.failureDetail}`,
    });
    this.logger.warn(
      `Canary transfer failed canary=${record.canaryId} chain=${record.chain} reason=${reason} detail=${record.failureDetail}`,
    );
    return this.toResult(record);
  }

  private async evaluateGuard(
    guard: CanaryTransferGuard,
    record: MainnetCanaryTransferRecord,
  ): Promise<CanaryTransferGuardDecision> {
    try {
      return await guard({
        canaryId: record.canaryId,
        chain: record.chain,
        routeId: record.routeId,
        subjectId: record.requestedBy,
      });
    } catch {
      return { allowed: false, reasonCode: 'guard_error' };
    }
  }

  private assertDependencies(dependencies: CanaryTransferDependencies): void {
    if (
      !dependencies ||
      typeof dependencies.submit !== 'function' ||
      typeof dependencies.getConfirmations !== 'function'
    ) {
      throw new Error(
        'submit and getConfirmations dependencies are required for a canary transfer',
      );
    }
  }

  private normalizePolicy(policy: CanaryChainPolicy): CanaryChainPolicy {
    const chain = normalizeChain(policy?.chain);
    if (!Array.isArray(policy.assets) || policy.assets.length === 0) {
      throw new Error('Canary chain policy must allow at least one asset');
    }
    const assets = policy.assets.map((asset) => {
      if (typeof asset !== 'string' || asset.trim() === '') {
        throw new Error('Canary assets must be non-empty strings');
      }
      return asset.trim().toUpperCase();
    });
    if (new Set(assets).size !== assets.length) {
      throw new Error('Canary assets must be unique per chain');
    }

    const maxAmount = parseDecimal(policy.maxAmount);
    if (maxAmount === undefined || maxAmount <= 0n) {
      throw new Error('maxAmount must be a positive decimal string');
    }
    if (
      !Number.isInteger(policy.requiredConfirmations) ||
      policy.requiredConfirmations < 1 ||
      policy.requiredConfirmations > 1_000
    ) {
      throw new Error(
        'requiredConfirmations must be an integer between 1 and 1000',
      );
    }
    if (
      !Number.isInteger(policy.timeoutMs) ||
      policy.timeoutMs <= 0 ||
      policy.timeoutMs > 3_600_000
    ) {
      throw new Error('timeoutMs must be an integer between 1 and 3600000');
    }

    return {
      chain,
      assets,
      maxAmount: policy.maxAmount.trim(),
      requiredConfirmations: policy.requiredConfirmations,
      timeoutMs: policy.timeoutMs,
    };
  }

  private copyPolicy(policy: CanaryChainPolicy): CanaryChainPolicy {
    return { ...policy, assets: [...policy.assets] };
  }

  private copyRecord(
    record: MainnetCanaryTransferRecord,
  ): MainnetCanaryTransferRecord {
    return {
      ...record,
      audit: record.audit.map((entry) => ({ ...entry })),
    };
  }

  private toResult(
    record: MainnetCanaryTransferRecord,
  ): MainnetCanaryTransferResult {
    return {
      record: this.copyRecord(record),
      passed: record.status === 'confirmed',
      fullRolloutAuthorized: record.status === 'confirmed',
    };
  }
}

function normalizeChain(chain: string): string {
  if (typeof chain !== 'string' || chain.trim() === '') {
    throw new Error('chain must be a non-empty string');
  }
  return chain.trim().toLowerCase();
}

/**
 * Parse a non-negative decimal into a fixed 18-decimal integer. Avoids float
 * rounding when comparing a canary amount with a chain cap.
 */
function parseDecimal(value: unknown): bigint | undefined {
  if (typeof value !== 'string') return undefined;
  const match = DECIMAL_PATTERN.exec(value.trim());
  if (!match) return undefined;
  const fraction = (match[2] ?? '').padEnd(18, '0');
  return BigInt(`${match[1]}${fraction}`);
}

function maskDestination(destination: unknown): string {
  if (typeof destination !== 'string') return '';
  const trimmed = destination.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) return '*'.repeat(trimmed.length);
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

function sanitizeCode(value: unknown, fallback: string): string {
  if (typeof value === 'string' && SAFE_CODE.test(value)) {
    return value.toLowerCase();
  }
  return fallback;
}
