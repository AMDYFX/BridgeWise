/**
 * File: src/routing/denylist/bridge-route-denylist.types.ts
 *
 * Types for configurable cross-chain bridge route denylist (#1289).
 * Allows operators to block unsafe, compromised, or congested routes,
 * providers, corridors, and assets with time-based auto-expiration.
 */

export type DenylistTargetType =
  | 'route'
  | 'provider'
  | 'corridor'
  | 'token'
  | 'asset_pair';

export type DenylistScope = 'temporary' | 'permanent';

export interface DenylistRule {
  id: string;
  targetType: DenylistTargetType;
  /**
   * The matching target:
   * - 'route': route ID (e.g. 'route-123')
   * - 'provider': provider name (e.g. 'risky-bridge')
   * - 'corridor': 'fromChain:toChain' (e.g. 'stellar:polygon')
   * - 'token': token symbol or address (e.g. 'USDC')
   * - 'asset_pair': 'fromToken:toToken' (e.g. 'ETH:USDC')
   */
  target: string;
  reason: string;
  scope: DenylistScope;
  expiresAt?: number; // timestamp in ms; undefined for permanent
  enabled: boolean;
  addedBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateDenylistRuleDto {
  id?: string;
  targetType: DenylistTargetType;
  target: string;
  reason: string;
  scope?: DenylistScope;
  expiresAt?: number;
  enabled?: boolean;
  addedBy?: string;
}

export interface CandidateRouteForDenylist {
  id: string;
  fromChain: string;
  toChain: string;
  fromToken: string;
  toToken: string;
  provider: string;
  amount?: string;
  metadata?: Record<string, unknown>;
}

export interface RouteDenylistEvaluation {
  routeId: string;
  isDenied: boolean;
  matchedRule?: DenylistRule;
  denialReason?: string;
  evaluatedAt: number;
}

export interface DenylistFilterResult<T extends CandidateRouteForDenylist = CandidateRouteForDenylist> {
  allowedRoutes: T[];
  deniedRoutes: Array<{
    route: T;
    evaluation: RouteDenylistEvaluation;
  }>;
  totalEvaluated: number;
  allowedCount: number;
  deniedCount: number;
}

export interface DenylistQueryFilter {
  targetType?: DenylistTargetType;
  enabledOnly?: boolean;
  activeOnly?: boolean; // excludes expired rules
  targetSubstring?: string;
}
