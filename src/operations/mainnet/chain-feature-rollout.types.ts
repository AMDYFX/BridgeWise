/**
 * File: src/operations/mainnet/chain-feature-rollout.types.ts
 *
 * Types for controlled feature rollout by chain (#1380).
 *
 * Rollouts are scoped to explicit chains. Unknown features, untargeted chains,
 * and paused features all fail closed. Cohort assignment is deterministic per
 * subject so retries and repeated evaluations never flip a user's treatment.
 */

export interface FeatureChainRollout {
  /** Normalized chain identifier, e.g. `stellar-mainnet`. */
  chain: string;
  /** Integer percentage in [0, 100]. */
  percentage: number;
  /** Subjects that bypass the percentage gate for this chain. */
  allowlist?: string[];
}

export interface FeatureRolloutDefinition {
  key: string;
  description: string;
  enabled: boolean;
  paused: boolean;
  chains: FeatureChainRollout[];
  updatedAt: number;
  updatedBy: string;
}

export type RolloutDecisionReason =
  | 'enabled'
  | 'allowlisted'
  | 'feature_disabled'
  | 'feature_paused'
  | 'chain_not_targeted'
  | 'chain_percentage_zero'
  | 'cohort_excluded'
  | 'unknown_feature';

export interface RolloutEvaluationContext {
  chain: string;
  subjectId: string;
}

export interface RolloutDecision {
  featureKey: string;
  chain: string;
  subjectId: string;
  enabled: boolean;
  percentage: number;
  reason: RolloutDecisionReason;
  evaluatedAt: number;
}

export interface DefineFeatureChainInput {
  chain: string;
  percentage: number;
  allowlist?: string[];
}

export interface DefineFeatureRolloutInput {
  key: string;
  description?: string;
  enabled?: boolean;
  chains: DefineFeatureChainInput[];
  updatedBy: string;
}

export type RolloutAuditAction =
  | 'define'
  | 'set_percentage'
  | 'add_chain'
  | 'pause'
  | 'resume'
  | 'enable'
  | 'disable';

export interface RolloutAuditEntry {
  at: number;
  featureKey: string;
  chain?: string;
  action: RolloutAuditAction;
  actor: string;
  fromPercentage?: number;
  toPercentage?: number;
}

export interface FeatureRolloutSnapshot {
  key: string;
  description: string;
  enabled: boolean;
  paused: boolean;
  updatedAt: number;
  updatedBy: string;
  chains: FeatureChainRollout[];
  audit: RolloutAuditEntry[];
}
