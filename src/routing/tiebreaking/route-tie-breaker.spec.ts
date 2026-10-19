/**
 * File: src/routing/tiebreaking/route-tie-breaker.spec.ts
 *
 * Tests for RouteTieBreakerService (#1288).
 */

import { RouteTieBreakerService } from './route-tie-breaker.service';
import { TieBreakableRoute } from './route-tie-breaker.types';

describe('RouteTieBreakerService', () => {
  let service: RouteTieBreakerService;

  beforeEach(() => {
    service = new RouteTieBreakerService({
      preferredProviders: ['circle-cctp', 'allbridge', 'stargate'],
    });
  });

  const baseRoute1: TieBreakableRoute = {
    id: 'route-1',
    fromChain: 'stellar',
    toChain: 'ethereum',
    fromToken: 'USDC',
    toToken: 'USDC',
    provider: 'stargate',
    compositeScore: 0.85,
    reliability: 0.98,
    feeAmountUsd: 2.5,
    estimatedTimeMinutes: 5.0,
  };

  const baseRoute2: TieBreakableRoute = {
    id: 'route-2',
    fromChain: 'stellar',
    toChain: 'ethereum',
    fromToken: 'USDC',
    toToken: 'USDC',
    provider: 'circle-cctp',
    compositeScore: 0.85, // Tied with route-1
    reliability: 0.98, // Tied with route-1
    feeAmountUsd: 2.5, // Tied with route-1
    estimatedTimeMinutes: 5.0, // Tied with route-1
  };

  describe('Primary Score Comparison', () => {
    it('orders by composite score when difference exceeds epsilon', () => {
      const higher: TieBreakableRoute = { ...baseRoute1, id: 'high', compositeScore: 0.9 };
      const lower: TieBreakableRoute = { ...baseRoute2, id: 'low', compositeScore: 0.8 };

      const result = service.breakTies([lower, higher]);
      expect(result.rankedRoutes[0].route.id).toBe('high');
      expect(result.rankedRoutes[1].route.id).toBe('low');
    });
  });

  describe('Multi-Tier Tie-Breaking When Scores Are Equal', () => {
    it('breaks tie using historical reliability when scores are equal', () => {
      const routeA: TieBreakableRoute = { ...baseRoute1, id: 'route-rel-high', reliability: 0.99 };
      const routeB: TieBreakableRoute = { ...baseRoute2, id: 'route-rel-low', reliability: 0.95 };

      const result = service.breakTies([routeB, routeA]);
      expect(result.rankedRoutes[0].route.id).toBe('route-rel-high');
      expect(result.rankedRoutes[0].decidingRule).toBe('historical_reliability');
      expect(result.tieResolutions.length).toBeGreaterThan(0);
    });

    it('breaks tie using lowest fee when scores and reliability are equal', () => {
      const cheap: TieBreakableRoute = { ...baseRoute1, id: 'route-cheap', feeAmountUsd: 1.2 };
      const expensive: TieBreakableRoute = { ...baseRoute2, id: 'route-exp', feeAmountUsd: 4.5 };

      const result = service.breakTies([expensive, cheap]);
      expect(result.rankedRoutes[0].route.id).toBe('route-cheap');
      expect(result.rankedRoutes[0].decidingRule).toBe('lowest_fee');
    });

    it('breaks tie using execution speed when scores, reliability, and fees are equal', () => {
      const fast: TieBreakableRoute = { ...baseRoute1, id: 'route-fast', estimatedTimeMinutes: 1.5 };
      const slow: TieBreakableRoute = { ...baseRoute2, id: 'route-slow', estimatedTimeMinutes: 10.0 };

      const result = service.breakTies([slow, fast]);
      expect(result.rankedRoutes[0].route.id).toBe('route-fast');
      expect(result.rankedRoutes[0].decidingRule).toBe('execution_speed');
    });

    it('breaks tie using preferred provider when all numerical metrics are equal', () => {
      // circle-cctp is index 0, stargate is index 2 in preferredProviders
      const preferred: TieBreakableRoute = { ...baseRoute2, id: 'route-preferred', provider: 'circle-cctp' };
      const nonPreferred: TieBreakableRoute = { ...baseRoute1, id: 'route-other', provider: 'stargate' };

      const result = service.breakTies([nonPreferred, preferred]);
      expect(result.rankedRoutes[0].route.id).toBe('route-preferred');
      expect(result.rankedRoutes[0].decidingRule).toBe('provider_preference');
    });

    it('breaks tie using stable fingerprint when all other factors are identical', () => {
      const twinA: TieBreakableRoute = { ...baseRoute1, id: 'twin-alpha', provider: 'unknown-provider' };
      const twinB: TieBreakableRoute = { ...baseRoute1, id: 'twin-beta', provider: 'unknown-provider' };

      const result = service.breakTies([twinA, twinB]);
      expect(result.rankedRoutes.length).toBe(2);
      expect(result.rankedRoutes[0].decidingRule).toBe('stable_fingerprint');
    });
  });

  describe('Determinism & Permutation Invariance', () => {
    it('produces identical ranking and deterministicDigest regardless of input permutation', () => {
      const r1: TieBreakableRoute = { ...baseRoute1, id: 'r1', compositeScore: 0.85 };
      const r2: TieBreakableRoute = { ...baseRoute2, id: 'r2', compositeScore: 0.85 };
      const r3: TieBreakableRoute = { ...baseRoute1, id: 'r3', compositeScore: 0.95 };

      const res1 = service.breakTies([r1, r2, r3]);
      const res2 = service.breakTies([r3, r1, r2]);
      const res3 = service.breakTies([r2, r3, r1]);

      const order1 = res1.rankedRoutes.map((r) => r.route.id);
      const order2 = res2.rankedRoutes.map((r) => r.route.id);
      const order3 = res3.rankedRoutes.map((r) => r.route.id);

      expect(order1).toEqual(order2);
      expect(order2).toEqual(order3);
      expect(res1.deterministicDigest).toEqual(res2.deterministicDigest);
      expect(res2.deterministicDigest).toEqual(res3.deterministicDigest);
    });

    it('handles empty route array gracefully', () => {
      const result = service.breakTies([]);
      expect(result.rankedRoutes).toEqual([]);
      expect(result.tieResolutions).toEqual([]);
      expect(result.deterministicDigest).toBeDefined();
    });
  });

  describe('Validation & Configuration', () => {
    it('throws on invalid route data', () => {
      expect(() =>
        service.breakTies([{ ...baseRoute1, compositeScore: NaN }]),
      ).toThrow('compositeScore must be a finite number');

      expect(() =>
        service.breakTies([{ ...baseRoute1, reliability: -0.5 }]),
      ).toThrow('reliability must be between 0 and 1');

      expect(() =>
        service.breakTies([{ ...baseRoute1, feeAmountUsd: -1 }]),
      ).toThrow('feeAmountUsd must be a non-negative number');
    });

    it('allows updating configuration and custom rule order', () => {
      service.updateConfig({
        scoreEpsilon: 0.05,
        ruleOrder: ['lowest_fee', 'execution_speed'],
      });

      const config = service.getConfig();
      expect(config.scoreEpsilon).toBe(0.05);
      expect(config.ruleOrder).toEqual(['lowest_fee', 'execution_speed']);
    });
  });
});
