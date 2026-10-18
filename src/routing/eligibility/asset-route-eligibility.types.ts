/**
 * File: src/routing/eligibility/asset-route-eligibility.types.ts
 *
 * Types for per-asset route eligibility policies (#1284).
 * Supports chain boundary constraints, provider whitelists/blacklists,
 * amount limits, and hop restrictions per asset.
 */

import type { BridgeRoute } from '../../services/route-ranker';

export type AssetPolicyStatus = 'active' | 'quarantined' | 'paused' | 'deprecated';

export interface ChainCorridor {
  fromChain: string;
  toChain: string;
}

export interface AssetRouteEligibilityPolicy {
  /** Asset identifier (e.g., 'USDC', 'XLM', 'ETH'). Case-insensitive. */
  asset: string;
  /** Overall asset policy status. Defaults to 'active'. */
  status?: AssetPolicyStatus;
  /** Allowed providers for this asset. If specified, route provider must be in this list. */
  allowedProviders?: string[];
  /** Blocked providers for this asset. If specified, route provider must NOT be in this list. */
  blockedProviders?: string[];
  /** Allowed corridors for this asset. If specified, corridor must match. */
  allowedCorridors?: ChainCorridor[];
  /** Blocked corridors for this asset. If specified, corridor must NOT match. */
  blockedCorridors?: ChainCorridor[];
  /** Minimum transfer amount in asset base units (decimal string). */
  minTransferAmount?: string;
  /** Maximum transfer amount in asset base units (decimal string). */
  maxTransferAmount?: string;
  /** Maximum hops allowed for this asset. Direct routes = 1. */
  maxHops?: number;
  /** Maximum allowable route slippage percentage (e.g. 0.5 for 0.5%). */
  maxSlippagePercent?: number;
  /** Custom operator tags or notes (never include private keys or secrets). */
  metadata?: Record<string, string>;
  /** Timestamp when policy was last updated. */
  updatedAt?: number;
}

export type AssetEligibilityRejectionCode =
  | 'ASSET_POLICY_NOT_FOUND'
  | 'ASSET_QUARANTINED'
  | 'ASSET_PAUSED'
  | 'ASSET_DEPRECATED'
  | 'AMOUNT_BELOW_MINIMUM'
  | 'AMOUNT_EXCEEDS_MAXIMUM'
  | 'INVALID_AMOUNT'
  | 'PROVIDER_NOT_ALLOWED'
  | 'PROVIDER_BLOCKED'
  | 'CORRIDOR_NOT_ALLOWED'
  | 'CORRIDOR_BLOCKED'
  | 'MAX_HOPS_EXCEEDED'
  | 'SLIPPAGE_EXCEEDED';

export interface AssetEligibilityRejectionReason {
  code: AssetEligibilityRejectionCode;
  message: string;
}

export interface RouteEligibilityEvaluation {
  routeId: string;
  asset: string;
  eligible: boolean;
  reasons: AssetEligibilityRejectionReason[];
  evaluatedAt: number;
}

export interface BatchRouteEligibilityResult {
  eligibleRoutes: BridgeRoute[];
  rejectedRoutes: {
    route: BridgeRoute;
    reasons: AssetEligibilityRejectionReason[];
  }[];
  totalEvaluated: number;
}
