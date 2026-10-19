/**
 * File: src/routing/explainability/scoring/route-scoring-explainability.service.ts
 *
 * Implements route scoring explainability (#1287).
 * Generates transparent factor breakdowns, pairwise deltas,
 * and deterministic natural language narratives.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_ROUTING_SCORING_WEIGHTS,
  RoutingDimensionScores,
  RoutingScoringWeights,
} from '../../scoring/types';
import { normaliseWeights } from '../../scoring/scoring-weights';
import {
  ExplainabilityOptions,
  FactorBreakdown,
  FactorComparisonDelta,
  PairwiseRouteExplanation,
  RouteCandidateInput,
  RouteScoringExplanation,
  ScoringFactorName,
} from './route-scoring-explainability.types';

const DEFAULT_OPTIONS: Required<ExplainabilityOptions> = {
  strengthThreshold: 0.7,
  weaknessThreshold: 0.4,
  detailedNarrative: true,
  factorLabels: {
    fee: 'Cost / Low Fee',
    speed: 'Execution Speed',
    reliability: 'Historical Reliability',
    confidence: 'Estimate Confidence',
    network: 'Real-time Network Health',
    liquidity: 'Pool Liquidity Depth',
  },
};

@Injectable()
export class RouteScoringExplainabilityService {
  private readonly logger = new Logger(RouteScoringExplainabilityService.name);

  /**
   * Explain the scoring for a single route in isolation or with given weights.
   */
  public explainRoute(
    candidate: RouteCandidateInput,
    weights: RoutingScoringWeights = DEFAULT_ROUTING_SCORING_WEIGHTS,
    options: ExplainabilityOptions = {},
  ): RouteScoringExplanation {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    this.validateCandidate(candidate);

    const normWeights = normaliseWeights(candidate.weights ?? weights);
    const breakdowns = this.calculateFactorBreakdowns(candidate, normWeights, opts);

    const compositeScore = breakdowns.reduce(
      (sum, b) => sum + b.weightedContribution,
      0,
    );

    // Identify dominant strength and primary tradeoff
    const sortedByContribution = [...breakdowns].sort(
      (a, b) => b.weightedContribution - a.weightedContribution,
    );
    const sortedByScore = [...breakdowns].sort(
      (a, b) => b.normalizedScore - a.normalizedScore,
    );

    const dominantStrength = sortedByScore[0].factor;
    const primaryTradeoff = sortedByScore[sortedByScore.length - 1].factor;

    const summary = this.generateSummaryNarrative(
      candidate.routeId,
      1,
      compositeScore,
      breakdowns,
      dominantStrength,
      primaryTradeoff,
      opts,
    );

    return {
      routeId: candidate.routeId,
      rank: 1,
      compositeScore,
      factorBreakdowns: breakdowns,
      dominantStrength,
      primaryTradeoff,
      summary,
    };
  }

  /**
   * Explain an entire cohort of competing routes, assigning ranks and cohort relative factor ranks.
   */
  public explainCohort(
    candidates: RouteCandidateInput[],
    weights: RoutingScoringWeights = DEFAULT_ROUTING_SCORING_WEIGHTS,
    options: ExplainabilityOptions = {},
  ): RouteScoringExplanation[] {
    if (!candidates || candidates.length === 0) {
      return [];
    }

    const opts = { ...DEFAULT_OPTIONS, ...options };
    candidates.forEach((c) => this.validateCandidate(c));

    const normWeights = normaliseWeights(weights);

    // First pass: compute composite scores
    const scored = candidates.map((candidate) => {
      const breakdowns = this.calculateFactorBreakdowns(candidate, normWeights, opts);
      const compositeScore = breakdowns.reduce(
        (sum, b) => sum + b.weightedContribution,
        0,
      );
      return {
        candidate,
        breakdowns,
        compositeScore,
      };
    });

    // Sort descending by compositeScore
    scored.sort((a, b) => b.compositeScore - a.compositeScore);

    // Second pass: compute relative ranks per factor across cohort
    const factors: ScoringFactorName[] = ['fee', 'speed', 'reliability', 'confidence'];

    factors.forEach((factor) => {
      // Sort candidates by this factor's normalized score descending
      const factorSorted = [...scored].sort((a, b) => {
        const scoreA = a.breakdowns.find((bk) => bk.factor === factor)?.normalizedScore ?? 0;
        const scoreB = b.breakdowns.find((bk) => bk.factor === factor)?.normalizedScore ?? 0;
        return scoreB - scoreA;
      });

      factorSorted.forEach((entry, idx) => {
        const factorEntry = entry.breakdowns.find((bk) => bk.factor === factor);
        if (factorEntry) {
          factorEntry.relativeRank = idx + 1;
        }
      });
    });

    // Third pass: build final explanations
    return scored.map((item, index) => {
      const rank = index + 1;
      const sortedByScore = [...item.breakdowns].sort(
        (a, b) => b.normalizedScore - a.normalizedScore,
      );
      const dominantStrength = sortedByScore[0].factor;
      const primaryTradeoff = sortedByScore[sortedByScore.length - 1].factor;

      const summary = this.generateSummaryNarrative(
        item.candidate.routeId,
        rank,
        item.compositeScore,
        item.breakdowns,
        dominantStrength,
        primaryTradeoff,
        opts,
      );

      return {
        routeId: item.candidate.routeId,
        rank,
        compositeScore: item.compositeScore,
        factorBreakdowns: item.breakdowns,
        dominantStrength,
        primaryTradeoff,
        summary,
      };
    });
  }

  /**
   * Generate an explainable pairwise comparison between two routes.
   */
  public explainPairwise(
    candidateA: RouteCandidateInput,
    candidateB: RouteCandidateInput,
    weights: RoutingScoringWeights = DEFAULT_ROUTING_SCORING_WEIGHTS,
    options: ExplainabilityOptions = {},
  ): PairwiseRouteExplanation {
    this.validateCandidate(candidateA);
    this.validateCandidate(candidateB);

    const explanationA = this.explainRoute(candidateA, weights, options);
    const explanationB = this.explainRoute(candidateB, weights, options);

    const winner =
      explanationA.compositeScore >= explanationB.compositeScore
        ? explanationA
        : explanationB;
    const loser =
      winner === explanationA ? explanationB : explanationA;

    const scoreDelta = winner.compositeScore - loser.compositeScore;

    const decidingFactors: FactorComparisonDelta[] = [];
    const concedingFactors: FactorComparisonDelta[] = [];

    winner.factorBreakdowns.forEach((winnerFactor) => {
      const loserFactor = loser.factorBreakdowns.find(
        (f) => f.factor === winnerFactor.factor,
      );
      if (!loserFactor) return;

      const delta = winnerFactor.normalizedScore - loserFactor.normalizedScore;
      const weightedImpact =
        winnerFactor.weightedContribution - loserFactor.weightedContribution;

      const comparison: FactorComparisonDelta = {
        factor: winnerFactor.factor,
        winnerScore: winnerFactor.normalizedScore,
        loserScore: loserFactor.normalizedScore,
        delta,
        weightedImpact,
        favorsWinner: delta >= 0,
      };

      if (delta >= 0) {
        decidingFactors.push(comparison);
      } else {
        concedingFactors.push(comparison);
      }
    });

    // Sort deciding factors by highest weighted impact
    decidingFactors.sort((a, b) => b.weightedImpact - a.weightedImpact);
    // Sort conceding factors by most negative weighted impact
    concedingFactors.sort((a, b) => a.weightedImpact - b.weightedImpact);

    const narrative = this.generatePairwiseNarrative(
      winner.routeId,
      loser.routeId,
      scoreDelta,
      decidingFactors,
      concedingFactors,
    );

    return {
      winnerRouteId: winner.routeId,
      loserRouteId: loser.routeId,
      scoreDelta,
      decidingFactors,
      concedingFactors,
      narrative,
    };
  }

  /**
   * Calculate breakdown per factor for a given candidate.
   */
  private calculateFactorBreakdowns(
    candidate: RouteCandidateInput,
    normWeights: RoutingScoringWeights,
    opts: Required<ExplainabilityOptions>,
  ): FactorBreakdown[] {
    const factors: {
      factor: ScoringFactorName;
      score: number;
      weight: number;
      raw?: number;
    }[] = [
      {
        factor: 'fee',
        score: candidate.dimensionScores.feeScore,
        weight: normWeights.feeWeight,
        raw: candidate.rawMetrics?.fee,
      },
      {
        factor: 'speed',
        score: candidate.dimensionScores.speedScore,
        weight: normWeights.speedWeight,
        raw: candidate.rawMetrics?.speed,
      },
      {
        factor: 'reliability',
        score: candidate.dimensionScores.reliabilityScore,
        weight: normWeights.reliabilityWeight,
        raw: candidate.rawMetrics?.reliability,
      },
      {
        factor: 'confidence',
        score: candidate.dimensionScores.confidenceScore,
        weight: normWeights.confidenceWeight,
        raw: candidate.rawMetrics?.confidence,
      },
    ];

    const totalContribution = factors.reduce(
      (acc, f) => acc + f.score * f.weight,
      0,
    );

    return factors.map((item) => {
      const weightedContribution = item.score * item.weight;
      const contributionPercentage =
        totalContribution > 0
          ? Math.round((weightedContribution / totalContribution) * 1000) / 10
          : 0;

      return {
        factor: item.factor,
        rawMetric: item.raw,
        normalizedScore: Math.round(item.score * 1000) / 1000,
        weight: item.weight,
        weightPercentage: Math.round(item.weight * 100),
        weightedContribution: Math.round(weightedContribution * 1000) / 1000,
        contributionPercentage,
        isStrength: item.score >= opts.strengthThreshold,
        isWeakness: item.score <= opts.weaknessThreshold,
      };
    });
  }

  /**
   * Generate human-readable narrative explanation for a route.
   */
  private generateSummaryNarrative(
    routeId: string,
    rank: number,
    compositeScore: number,
    breakdowns: FactorBreakdown[],
    dominantStrength: ScoringFactorName,
    primaryTradeoff: ScoringFactorName,
    opts: Required<ExplainabilityOptions>,
  ): string {
    const strengthLabel = opts.factorLabels[dominantStrength] || dominantStrength;
    const tradeoffLabel = opts.factorLabels[primaryTradeoff] || primaryTradeoff;

    const strengthEntry = breakdowns.find((b) => b.factor === dominantStrength);
    const tradeoffEntry = breakdowns.find((b) => b.factor === primaryTradeoff);

    const scoreFormatted = (compositeScore * 100).toFixed(1);
    const strengthScore = ((strengthEntry?.normalizedScore ?? 0) * 100).toFixed(0);
    const tradeoffScore = ((tradeoffEntry?.normalizedScore ?? 0) * 100).toFixed(0);

    return `Route ${routeId} ranked #${rank} with composite score of ${scoreFormatted}/100. Its primary advantage is ${strengthLabel} (score: ${strengthScore}%), while its main tradeoff is ${tradeoffLabel} (score: ${tradeoffScore}%).`;
  }

  /**
   * Generate narrative comparison for a pairwise winner vs loser.
   */
  private generatePairwiseNarrative(
    winnerId: string,
    loserId: string,
    scoreDelta: number,
    deciding: FactorComparisonDelta[],
    conceding: FactorComparisonDelta[],
  ): string {
    const deltaPoints = (scoreDelta * 100).toFixed(1);
    if (scoreDelta === 0) {
      return `Route ${winnerId} and Route ${loserId} are tied with identical composite scores.`;
    }

    const topAdvantage = deciding[0];
    let text = `Route ${winnerId} ranked above Route ${loserId} (+${deltaPoints} pts). `;

    if (topAdvantage) {
      const advImpact = (topAdvantage.weightedImpact * 100).toFixed(1);
      text += `The primary differentiator was superior ${topAdvantage.factor} (+${advImpact} pts contribution). `;
    }

    if (conceding.length > 0 && conceding[0].weightedImpact < -0.01) {
      const defFactor = conceding[0];
      const defImpact = (Math.abs(defFactor.weightedImpact) * 100).toFixed(1);
      text += `This offset a minor deficit in ${defFactor.factor} (-${defImpact} pts).`;
    }

    return text.trim();
  }

  /**
   * Validate candidate input structure.
   */
  private validateCandidate(candidate: RouteCandidateInput): void {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error('Candidate route must be a valid object.');
    }
    if (!candidate.routeId || typeof candidate.routeId !== 'string') {
      throw new Error('Candidate routeId must be a non-empty string.');
    }
    if (!candidate.dimensionScores || typeof candidate.dimensionScores !== 'object') {
      throw new Error(`Candidate ${candidate.routeId} missing dimensionScores.`);
    }

    const { feeScore, speedScore, reliabilityScore, confidenceScore } =
      candidate.dimensionScores;

    const scores = [feeScore, speedScore, reliabilityScore, confidenceScore];
    for (const s of scores) {
      if (typeof s !== 'number' || !Number.isFinite(s) || s < 0 || s > 1) {
        throw new Error(
          `Candidate ${candidate.routeId} contains invalid dimension score: ${s}. All scores must be in range [0, 1].`,
        );
      }
    }
  }
}
