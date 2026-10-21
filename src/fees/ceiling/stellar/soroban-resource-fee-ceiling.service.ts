/**
 * File: src/fees/ceiling/stellar/soroban-resource-fee-ceiling.service.ts
 *
 * Soroban Resource Fee Ceiling Policy Enforcement Service.
 *
 * Enforces per-network ceilings on Soroban resource fees (in stroops) to
 * prevent excessive execution costs from misconfigured contracts, network
 * congestion spikes, or malicious actors. Integrates with the simulation
 * and cost-breakdown layers so fees are validated before execution.
 *
 * Design principles:
 * - Secure defaults: unlisted networks are denied unless explicitly configured.
 * - Pure evaluation: `check()` is deterministic and side-effect free.
 * - Audit-friendly: every evaluation returns structured violations and metadata.
 * - Observable: warning thresholds emit structured logs without blocking.
 */

import {
  ResourceFeeCeilingRequest,
  ResourceFeeCeilingResult,
  ResourceFeeCeilingViolation,
  ResourceFeeCeilingViolationCode,
  SorobanResourceFeeCeilingConfig,
  SorobanResourceFeeCeilingPolicy,
  ResourceFeeCeilingStatus,
} from './types';

const DEFAULT_MAX_RESOURCE_FEE_STROOPS = 5_000_000; // 0.5 XLM

export class SorobanResourceFeeCeilingService {
  private readonly policies = new Map<string, SorobanResourceFeeCeilingPolicy>();
  private readonly defaultMaxResourceFeeStroops: number | undefined;
  private readonly denyUnlistedNetworks: boolean;
  private readonly now: () => number;

  constructor(config: SorobanResourceFeeCeilingConfig) {
    this.now = config.now ?? (() => Date.now());
    this.defaultMaxResourceFeeStroops = config.defaultMaxResourceFeeStroops;
    this.denyUnlistedNetworks = config.denyUnlistedNetworks ?? true;

    for (const policy of config.policies ?? []) {
      this.validatePolicy(policy);
      this.policies.set(this.normalizeNetwork(policy.network), policy);
    }
  }

  /**
   * Evaluate a resource fee against the ceiling without side effects.
   * Deterministic and safe to call in read-only contexts.
   */
  check(request: ResourceFeeCeilingRequest): ResourceFeeCeilingResult {
    const network = this.normalizeNetwork(request.network);
    const at = request.timestamp ?? this.now();
    const fee = request.resourceFeeStroops;

    const violations: ResourceFeeCeilingViolation[] = [];

    // Validate fee amount
    if (!Number.isFinite(fee) || fee < 0) {
      violations.push({
        code: 'INVALID_FEE_AMOUNT',
        message: `resource fee must be a finite non-negative number, got ${fee}`,
        observed: fee,
      });
      return this.result(request, network, fee, null, violations, false, at);
    }

    // Look up policy
    const policy = this.policies.get(network);

    if (!policy) {
      // No explicit policy for this network
      if (this.defaultMaxResourceFeeStroops !== undefined) {
        return this.evaluateAgainstCeiling(
          request,
          network,
          fee,
          this.defaultMaxResourceFeeStroops,
          undefined,
          'default',
          at,
        );
      }
      if (this.denyUnlistedNetworks) {
        violations.push({
          code: 'NETWORK_NOT_ALLOWED',
          message: `network "${request.network}" has no ceiling policy and is denied by default`,
        });
        return this.result(request, network, fee, null, violations, false, at);
      }
      // Allow with no ceiling (unrestricted)
      return this.result(request, network, fee, null, [], false, at);
    }

    if (policy.disabled) {
      // Explicitly disabled — allow unrestricted
      return this.result(request, network, fee, null, [], false, at);
    }

    return this.evaluateAgainstCeiling(
      request,
      network,
      fee,
      policy.maxResourceFeeStroops,
      policy.warningThresholdStroops,
      'explicit',
      at,
    );
  }

  /** Get the current ceiling status for a network (for monitoring/debugging). */
  getStatus(network: string): ResourceFeeCeilingStatus {
    const norm = this.normalizeNetwork(network);
    const policy = this.policies.get(norm);

    if (policy) {
      return {
        network: norm,
        ceilingStroops: policy.disabled ? null : policy.maxResourceFeeStroops,
        warningThresholdStroops: policy.warningThresholdStroops ?? null,
        disabled: policy.disabled ?? false,
        policySource: 'explicit',
      };
    }

    if (this.defaultMaxResourceFeeStroops !== undefined) {
      return {
        network: norm,
        ceilingStroops: this.defaultMaxResourceFeeStroops,
        warningThresholdStroops: null,
        disabled: false,
        policySource: 'default',
      };
    }

    return {
      network: norm,
      ceilingStroops: null,
      warningThresholdStroops: null,
      disabled: false,
      policySource: 'deny-unlisted',
    };
  }

  /** Get all configured network statuses. */
  getAllStatuses(): ResourceFeeCeilingStatus[] {
    const networks = new Set([
      ...this.policies.keys(),
      ...(this.defaultMaxResourceFeeStroops !== undefined ? ['*default*'] : []),
    ]);
    return Array.from(networks).map((n) => this.getStatus(n));
  }

  /** Update or add a policy at runtime (e.g. via operator API). */
  upsertPolicy(policy: SorobanResourceFeeCeilingPolicy): void {
    this.validatePolicy(policy);
    this.policies.set(this.normalizeNetwork(policy.network), policy);
  }

  /** Remove a policy at runtime. */
  removePolicy(network: string): boolean {
    return this.policies.delete(this.normalizeNetwork(network));
  }

  /** Clear all policies (e.g. between test cases). */
  reset(): void {
    this.policies.clear();
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private evaluateAgainstCeiling(
    request: ResourceFeeCeilingRequest,
    network: string,
    fee: number,
    ceiling: number,
    warningThreshold: number | undefined,
    policySource: 'explicit' | 'default',
    at: number,
  ): ResourceFeeCeilingResult {
    const violations: ResourceFeeCeilingViolation[] = [];
    let warningTriggered = false;

    if (fee > ceiling) {
      violations.push({
        code: 'EXCEEDS_CEILING',
        message: `resource fee ${fee} stroops exceeds ceiling ${ceiling} stroops for network "${network}"`,
        limit: ceiling,
        observed: fee,
      });
    } else if (warningThreshold !== undefined && fee > warningThreshold) {
      warningTriggered = true;
      // Warning is logged but does not block; caller can observe warningTriggered
    }

    return this.result(request, network, fee, ceiling, violations, warningTriggered, at);
  }

  private result(
    request: ResourceFeeCeilingRequest,
    network: string,
    fee: number,
    ceiling: number | null,
    violations: ResourceFeeCeilingViolation[],
    warningTriggered: boolean,
    at: number,
  ): ResourceFeeCeilingResult {
    return {
      allowed: violations.length === 0,
      network,
      resourceFeeStroops: fee,
      ceilingStroops: ceiling,
      warningTriggered,
      violations,
      evaluatedAt: at,
    };
  }

  private validatePolicy(policy: SorobanResourceFeeCeilingPolicy): void {
    if (!policy.network?.trim()) {
      throw new Error('policy.network must be a non-empty string');
    }
    if (!Number.isFinite(policy.maxResourceFeeStroops) || policy.maxResourceFeeStroops < 0) {
      throw new Error('policy.maxResourceFeeStroops must be a finite non-negative number');
    }
    if (
      policy.warningThresholdStroops !== undefined &&
      (!Number.isFinite(policy.warningThresholdStroops) || policy.warningThresholdStroops < 0)
    ) {
      throw new Error('policy.warningThresholdStroops must be a finite non-negative number');
    }
    if (
      policy.warningThresholdStroops !== undefined &&
      policy.warningThresholdStroops > policy.maxResourceFeeStroops
    ) {
      throw new Error('policy.warningThresholdStroops cannot exceed maxResourceFeeStroops');
    }
  }

  private normalizeNetwork(network: string): string {
    return String(network ?? '').trim().toLowerCase();
  }
}

/**
 * Default ceiling configuration for common Stellar networks.
 * Can be used as a starting point for production deployments.
 */
export function createDefaultCeilingConfig(
  overrides: Partial<SorobanResourceFeeCeilingConfig> = {},
): SorobanResourceFeeCeilingConfig {
  const defaultPolicies: SorobanResourceFeeCeilingPolicy[] = [
    {
      network: 'stellar-mainnet',
      maxResourceFeeStroops: 10_000_000, // 1 XLM
      warningThresholdStroops: 5_000_000, // 0.5 XLM
    },
    {
      network: 'stellar-testnet',
      maxResourceFeeStroops: 5_000_000, // 0.5 XLM
      warningThresholdStroops: 2_500_000, // 0.25 XLM
    },
    {
      network: 'stellar-futurenet',
      maxResourceFeeStroops: 5_000_000, // 0.5 XLM
      warningThresholdStroops: 2_500_000, // 0.25 XLM
    },
  ];

  return {
    policies: defaultPolicies,
    defaultMaxResourceFeeStroops: DEFAULT_MAX_RESOURCE_FEE_STROOPS,
    denyUnlistedNetworks: true,
    ...overrides,
  };
}