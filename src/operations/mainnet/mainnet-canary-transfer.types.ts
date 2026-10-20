/**
 * File: src/operations/mainnet/mainnet-canary-transfer.types.ts
 *
 * Types for the mainnet canary transfer procedure (#1381).
 *
 * A canary transfer is a deliberately tiny, capped mainnet transfer used to
 * prove a route end to end before a feature rollout is expanded. Plans carry
 * only public transfer data; signing stays behind the submission dependency.
 */

export type CanaryTransferStatus =
  'planned' | 'submitted' | 'confirmed' | 'failed' | 'blocked';

export type CanaryFailureReason =
  | 'invalid_plan'
  | 'chain_not_allowed'
  | 'asset_not_allowed'
  | 'amount_exceeds_cap'
  | 'duplicate_active_canary'
  | 'operator_guard_denied'
  | 'submission_failed'
  | 'confirmation_timeout'
  | 'confirmation_failed'
  | 'verification_failed';

export interface CanaryChainPolicy {
  /** Normalized mainnet chain identifier, e.g. `stellar-mainnet`. */
  chain: string;
  /** Assets approved for canary transfers on this chain. */
  assets: string[];
  /** Hard cap for a single canary amount, as a decimal string. */
  maxAmount: string;
  requiredConfirmations: number;
  timeoutMs: number;
}

export interface MainnetCanaryTransferPlan {
  /** Unique id; reusing it is idempotent and never resubmits. */
  canaryId: string;
  chain: string;
  routeId: string;
  asset: string;
  /** Decimal string, e.g. `0.01`. */
  amount: string;
  destination: string;
  requestedBy: string;
  /** Optional override bounded by the chain policy. */
  requiredConfirmations?: number;
  /** Optional override bounded by the chain policy. */
  timeoutMs?: number;
}

export interface CanaryTransferRequest {
  canaryId: string;
  chain: string;
  routeId: string;
  asset: string;
  amount: string;
  destination: string;
}

export interface CanarySubmission {
  txHash: string;
}

/**
 * Submission and confirmation adapters live behind this boundary. They must
 * not log destinations, signed payloads, or key material.
 */
export interface CanaryTransferDependencies {
  submit(request: CanaryTransferRequest): Promise<CanarySubmission>;
  getConfirmations(chain: string, txHash: string): Promise<number>;
  /** Optional post-confirmation settlement check (balance delta, receipt). */
  verifySettlement?(
    request: CanaryTransferRequest,
    txHash: string,
  ): Promise<boolean>;
}

export interface CanaryTransferGuardContext {
  canaryId: string;
  chain: string;
  routeId: string;
  subjectId: string;
}

export interface CanaryTransferGuardDecision {
  allowed: boolean;
  /** Low-cardinality, non-secret reason, e.g. `chain_outage`. */
  reasonCode?: string;
}

/**
 * Chain-scoped authorization hook used to block canaries during outages or
 * when signer readiness falls below quorum.
 */
export type CanaryTransferGuard = (
  context: CanaryTransferGuardContext,
) => CanaryTransferGuardDecision | Promise<CanaryTransferGuardDecision>;

export interface CanaryPreflightResult {
  allowed: boolean;
  reason?: CanaryFailureReason;
  detail?: string;
}

export interface CanaryTransferAuditEntry {
  at: number;
  step: string;
  detail?: string;
}

export interface MainnetCanaryTransferRecord {
  canaryId: string;
  chain: string;
  routeId: string;
  asset: string;
  amount: string;
  /** Masked destination; full addresses are never exposed in reports. */
  destinationMasked: string;
  status: CanaryTransferStatus;
  requestedBy: string;
  requiredConfirmations: number;
  timeoutMs: number;
  submittedAt?: number;
  confirmedAt?: number;
  txHash?: string;
  confirmations: number;
  failureReason?: CanaryFailureReason;
  failureDetail?: string;
  attempts: number;
  audit: CanaryTransferAuditEntry[];
}

export interface MainnetCanaryTransferResult {
  record: MainnetCanaryTransferRecord;
  passed: boolean;
  fullRolloutAuthorized: boolean;
}

export interface RunCanaryTransferOptions {
  guard?: CanaryTransferGuard;
  /** Poll interval for confirmation checks. Defaults to 1,000 ms. */
  pollIntervalMs?: number;
}
