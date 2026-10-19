/**
 * File: src/routing/tiebreaking/route-tie-breaker.types.ts
 *
 * Types for deterministic route tie-breaking (#1288).
 * Ensures stable, reproducible ordering when routes achieve equal scores.
 */

export type TieBreakerRule =
  | 'composite_score'
  | 'historical_reliability'
  | 'lowest_fee'
  | 'execution_speed'
  | 'provider_preference'
  | 'stable_fingerprint';

export interface TieBreakableRoute {
  id: string;
  fromChain: string;
  toChain: string;
  fromToken: string;
  toToken: string;
  provider: string;
  compositeScore: number;
  reliability: number; // 0 to 1
  feeAmountUsd: number; // USD
  estimatedTimeMinutes: number; // minutes
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface MetricEpsilons {
  reliability?: number; // default 1e-5
  fee?: number; // default 1e-4 ($0.0001)
  speed?: number; // default 1e-4 (minutes)
}

export interface TieBreakerConfig {
  scoreEpsilon?: number; // default 1e-6
  ruleOrder?: TieBreakerRule[];
  preferredProviders?: string[];
  metricEpsilons?: MetricEpsilons;
}

export interface TieResolution {
  routeAId: string;
  routeBId: string;
  winningRouteId: string;
  decidingRule: TieBreakerRule;
  detail: string;
}

export interface RankedTieBrokenRoute<T extends TieBreakableRoute = TieBreakableRoute> {
  route: T;
  rank: number;
  decidingRule?: TieBreakerRule;
}

export interface TieBrokenResult<T extends TieBreakableRoute = TieBreakableRoute> {
  rankedRoutes: RankedTieBrokenRoute<T>[];
  tieResolutions: TieResolution[];
  deterministicDigest: string;
}
