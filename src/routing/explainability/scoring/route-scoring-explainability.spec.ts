/**
 * File: src/routing/explainability/scoring/route-scoring-explainability.spec.ts
 *
 * Tests for RouteScoringExplainabilityService (#1287).
 */

import { RouteScoringExplainabilityService } from './route-scoring-explainability.service';
import { RouteCandidateInput } from './route-scoring-explainability.types';

describe('RouteScoringExplainabilityService', () => {
  let service: RouteScoringExplainabilityService;

  beforeEach(() => {
    service = new RouteScoringExplainabilityService();
  });

  const candidateA: RouteCandidateInput = {
    routeId: 'route-stellar-circle',
    dimensionScores: {
      feeScore: 0.95, // very cheap
      speedScore: 0.5, // moderate speed
      reliabilityScore: 0.98, // highly reliable
      confidenceScore: 0.9,
    },
    rawMetrics: {
      fee: 1.25, // $1.25
      speed: 180, // 3 mins
      reliability: 0.998,
      confidence: 0.95,
    },
  };

  const candidateB: RouteCandidateInput = {
    routeId: 'route-fast-hop',
    dimensionScores: {
      feeScore: 0.4, // expensive
      speedScore: 0.95, // very fast
      reliabilityScore: 0.85, // decent
      confidenceScore: 0.8,
    },
    rawMetrics: {
      fee: 8.5, // $8.50
      speed: 15, // 15 seconds
      reliability: 0.96,
      confidence: 0.9,
    },
  };

  describe('Input Validation', () => {
    it('throws when candidate has empty routeId', () => {
      expect(() =>
        service.explainRoute({
          routeId: '',
          dimensionScores: {
            feeScore: 0.5,
            speedScore: 0.5,
            reliabilityScore: 0.5,
            confidenceScore: 0.5,
          },
        }),
      ).toThrow('Candidate routeId must be a non-empty string.');
    });

    it('throws when dimension score is out of [0, 1] range', () => {
      expect(() =>
        service.explainRoute({
          routeId: 'test',
          dimensionScores: {
            feeScore: 1.5,
            speedScore: 0.5,
            reliabilityScore: 0.5,
            confidenceScore: 0.5,
          },
        }),
      ).toThrow('contains invalid dimension score: 1.5');
    });

    it('throws when dimension score is non-finite or negative', () => {
      expect(() =>
        service.explainRoute({
          routeId: 'test',
          dimensionScores: {
            feeScore: -0.1,
            speedScore: 0.5,
            reliabilityScore: 0.5,
            confidenceScore: 0.5,
          },
        }),
      ).toThrow('contains invalid dimension score: -0.1');
    });
  });

  describe('Single Route Explainability', () => {
    it('generates complete factor breakdown and summary', () => {
      const result = service.explainRoute(candidateA);

      expect(result.routeId).toBe('route-stellar-circle');
      expect(result.compositeScore).toBeGreaterThan(0.7);
      expect(result.factorBreakdowns.length).toBe(4);

      const feeBreakdown = result.factorBreakdowns.find((b) => b.factor === 'fee');
      expect(feeBreakdown).toBeDefined();
      expect(feeBreakdown?.normalizedScore).toBe(0.95);
      expect(feeBreakdown?.rawMetric).toBe(1.25);
      expect(feeBreakdown?.isStrength).toBe(true);

      const speedBreakdown = result.factorBreakdowns.find((b) => b.factor === 'speed');
      expect(speedBreakdown?.normalizedScore).toBe(0.5);

      expect(result.dominantStrength).toBe('reliability'); // 0.98 is highest
      expect(result.primaryTradeoff).toBe('speed'); // 0.5 is lowest

      expect(result.summary).toContain('route-stellar-circle');
      expect(result.summary).toContain('Execution Speed');
    });
  });

  describe('Cohort Explainability & Relative Factor Ranking', () => {
    it('ranks and explains cohort with per-factor relative ranks', () => {
      const candidateC: RouteCandidateInput = {
        routeId: 'route-balanced',
        dimensionScores: {
          feeScore: 0.7,
          speedScore: 0.7,
          reliabilityScore: 0.9,
          confidenceScore: 0.85,
        },
      };

      const explanations = service.explainCohort([candidateA, candidateB, candidateC]);

      expect(explanations.length).toBe(3);
      expect(explanations[0].rank).toBe(1);
      expect(explanations[1].rank).toBe(2);
      expect(explanations[2].rank).toBe(3);

      // Verify relative factor ranking for speed (candidateB had highest speed: 0.95)
      const bExplanation = explanations.find((e) => e.routeId === 'route-fast-hop')!;
      const bSpeed = bExplanation.factorBreakdowns.find((f) => f.factor === 'speed')!;
      expect(bSpeed.relativeRank).toBe(1);

      // candidateA had lowest speed (0.5), so relative rank is 3
      const aExplanation = explanations.find((e) => e.routeId === 'route-stellar-circle')!;
      const aSpeed = aExplanation.factorBreakdowns.find((f) => f.factor === 'speed')!;
      expect(aSpeed.relativeRank).toBe(3);
    });

    it('returns empty array when cohort is empty', () => {
      expect(service.explainCohort([])).toEqual([]);
    });
  });

  describe('Pairwise Route Comparison', () => {
    it('explains why route A beat route B with factor impact deltas', () => {
      const comparison = service.explainPairwise(candidateA, candidateB);

      expect(comparison.winnerRouteId).toBe('route-stellar-circle');
      expect(comparison.loserRouteId).toBe('route-fast-hop');
      expect(comparison.scoreDelta).toBeGreaterThan(0);

      // Deciding factor should include fee (0.95 vs 0.40)
      const feeDelta = comparison.decidingFactors.find((d) => d.factor === 'fee');
      expect(feeDelta).toBeDefined();
      expect(feeDelta?.delta).toBeCloseTo(0.55, 2);
      expect(feeDelta?.favorsWinner).toBe(true);

      // Conceding factor should include speed where loser was faster (0.50 vs 0.95)
      const speedDelta = comparison.concedingFactors.find((d) => d.factor === 'speed');
      expect(speedDelta).toBeDefined();
      expect(speedDelta?.delta).toBeCloseTo(-0.45, 2);

      expect(comparison.narrative).toContain(
        'Route route-stellar-circle ranked above Route route-fast-hop',
      );
      expect(comparison.narrative).toContain('fee');
      expect(comparison.narrative).toContain('speed');
    });

    it('handles tied routes gracefully', () => {
      const candidateTied: RouteCandidateInput = {
        routeId: 'route-clone',
        dimensionScores: { ...candidateA.dimensionScores },
      };

      const comparison = service.explainPairwise(candidateA, candidateTied);
      expect(comparison.scoreDelta).toBe(0);
      expect(comparison.narrative).toContain('identical composite scores');
    });
  });
});
