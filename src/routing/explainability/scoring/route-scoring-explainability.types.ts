/**
 * File: src/routing/explainability/scoring/route-scoring-explainability.types.ts
 *
 * Types for route scoring explainability (#1287).
 * Provides transparent factor breakdowns, pairwise comparisons,
 * and human-readable narratives for cross-chain route ranking.
 */

import { RoutingDimensionScores, RoutingScoringWeights } from '../../scoring/types';

export type ScoringFactorName =
  | 'fee'
  | 'speed'
  | 'reliability'
  | 'confidence'
  | 'network'
  | 'liquidity';

export interface FactorBreakdown {
  factor: ScoringFactorName;
  rawMetric?: number;
  normalizedScore: number; // 0 to 1
  weight: number; // weight used
  weightPercentage: number; // e.g. 30 (%)
  weightedContribution: number; // normalizedScore * normalizedWeight
  contributionPercentage: number; // share of composite score
  isStrength: boolean;
  isWeakness: boolean;
  relativeRank?: number; // rank among compared cohort (1 = best)
}

export interface RouteScoringExplanation {
  routeId: string;
  rank: number;
  compositeScore: number;
  factorBreakdowns: FactorBreakdown[];
  dominantStrength: ScoringFactorName;
  primaryTradeoff: ScoringFactorName;
  summary: string;
}

export interface FactorComparisonDelta {
  factor: ScoringFactorName;
  winnerScore: number;
  loserScore: number;
  delta: number;
  weightedImpact: number;
  favorsWinner: boolean;
}

export interface PairwiseRouteExplanation {
  winnerRouteId: string;
  loserRouteId: string;
  scoreDelta: number;
  decidingFactors: FactorComparisonDelta[];
  concedingFactors: FactorComparisonDelta[];
  narrative: string;
}

export interface ExplainabilityOptions {
  strengthThreshold?: number; // default 0.70
  weaknessThreshold?: number; // default 0.40
  factorLabels?: Partial<Record<ScoringFactorName, string>>;
  detailedNarrative?: boolean;
}

export interface RouteCandidateInput {
  routeId: string;
  dimensionScores: RoutingDimensionScores & {
    networkScore?: number;
    liquidityScore?: number;
  };
  rawMetrics?: {
    fee?: number; // USD
    speed?: number; // minutes or seconds
    reliability?: number; // 0-1
    confidence?: number; // 0-1
    network?: number;
    liquidity?: number;
  };
  weights?: RoutingScoringWeights;
}
