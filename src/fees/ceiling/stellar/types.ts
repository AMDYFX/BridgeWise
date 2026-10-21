/**
 * File: src/fees/ceiling/stellar/types.ts
 *
 * Soroban Resource Fee Ceiling Policy types.
 *
 * Defines the configuration surface and result types for enforcing a ceiling
 * on Soroban resource fees (in stroops) to prevent excessive execution costs
 * from misconfigured contracts, network congestion, or malicious actors.
 */

export const STROOPS_PER_XLM = 10_000_000n;

/** Per-network ceiling policy for Soroban resource fees. */
export interface SorobanResourceFeeCeilingPolicy {
  /** Network identifier (e.g. "stellar-testnet", "stellar-mainnet"). */
  network: string;
  /** Maximum allowed resource fee in stroops. */
  maxResourceFeeStroops: number;
  /** Optional warning threshold in stroops (logs a warning when exceeded). */
  warningThresholdStroops?: number;
  /** Optional: disable the ceiling for this network (default: false). */
  disabled?: boolean;
}

/** Configuration for the ceiling enforcement service. */
export interface SorobanResourceFeeCeilingConfig {
  /** Per-network ceiling policies. */
  policies: SorobanResourceFeeCeilingPolicy[];
  /** Default ceiling in stroops when no policy matches the network. */
  defaultMaxResourceFeeStroops?: number;
  /** Whether to deny transactions when no policy matches and no default is set. Default: true (secure). */
  denyUnlistedNetworks?: boolean;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/** Request to evaluate a resource fee against the ceiling. */
export interface ResourceFeeCeilingRequest {
  /** Network identifier. */
  network: string;
  /** Resource fee in stroops to evaluate. */
  resourceFeeStroops: number;
  /** Optional transaction reference for audit. */
  reference?: string;
  /** Optional timestamp override (epoch ms). */
  timestamp?: number;
}

/** Result of evaluating a resource fee against the ceiling. */
export interface ResourceFeeCeilingResult {
  /** Whether the fee is within the ceiling. */
  allowed: boolean;
  /** The network that was evaluated. */
  network: string;
  /** The resource fee that was evaluated (stroops). */
  resourceFeeStroops: number;
  /** The ceiling that was applied (stroops). */
  ceilingStroops: number | null;
  /** Whether a warning threshold was crossed. */
  warningTriggered: boolean;
  /** Human-readable violations, empty when allowed. */
  violations: ResourceFeeCeilingViolation[];
  /** Timestamp of evaluation (epoch ms). */
  evaluatedAt: number;
}

/** A single ceiling violation. */
export interface ResourceFeeCeilingViolation {
  /** Machine-readable violation code. */
  code: ResourceFeeCeilingViolationCode;
  /** Human-readable message. */
  message: string;
  /** The ceiling limit that was breached. */
  limit?: number;
  /** The observed value that breached it. */
  observed?: number;
}

/** Stable machine-readable reasons a resource fee can be denied. */
export type ResourceFeeCeilingViolationCode =
  | 'NETWORK_NOT_ALLOWED'
  | 'EXCEEDS_CEILING'
  | 'INVALID_FEE_AMOUNT';

/** Current ceiling status for a network (used for monitoring/debugging). */
export interface ResourceFeeCeilingStatus {
  network: string;
  ceilingStroops: number | null;
  warningThresholdStroops: number | null;
  disabled: boolean;
  policySource: 'explicit' | 'default' | 'deny-unlisted';
}