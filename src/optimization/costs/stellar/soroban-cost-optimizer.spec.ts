import {
  SorobanRouteCostOptimizer,
  calculateRouteCost,
} from './soroban-cost-optimizer';
import type { CostRoute, CeilingService } from './soroban-cost-optimizer.types';

function createMockCeilingService(allowed: boolean, ceilingStroops = 5_000_000): CeilingService {
  return {
    check: jest.fn((request: { network: string; resourceFeeStroops: number }) => ({
      allowed,
      ceilingStroops,
      violations: allowed ? [] : [{ code: 'EXCEEDS_CEILING', message: 'Fee exceeds ceiling' }],
    })),
  };
}

const sampleRoutes: CostRoute[] = [
  {
    id: 'route-a',
    provider: 'StellarBridge',
    sourceChain: 'stellar',
    destinationChain: 'ethereum',
    bridgeFeeUsd: 0.5,
    networkFeeStroops: 100_000,
    xlmUsdPrice: 0.12,
    gasUsd: 0.2,
    slippagePercent: 0.1,
    amountUsd: 1_000,
    network: 'stellar-testnet',
  },
  {
    id: 'route-b',
    provider: 'CheapBridge',
    sourceChain: 'stellar',
    destinationChain: 'ethereum',
    bridgeFeeUsd: 0.1,
    networkFeeStroops: 500_000,
    xlmUsdPrice: 0.12,
    gasUsd: 0.3,
    slippagePercent: 0.2,
    amountUsd: 1_000,
    network: 'stellar-testnet',
  },
  {
    id: 'route-c',
    provider: 'FastBridge',
    sourceChain: 'stellar',
    destinationChain: 'polygon',
    bridgeFeeUsd: 1.0,
    networkFeeStroops: 50_000,
    xlmUsdPrice: 0.12,
    gasUsd: 0.05,
    slippagePercent: 0.05,
    amountUsd: 1_000,
    network: 'stellar-mainnet',
  },
];

// ---------------------------------------------------------------------------
// calculateRouteCost
// ---------------------------------------------------------------------------

describe('calculateRouteCost', () => {
  it('computes a weighted breakdown with default weights', () => {
    const result = calculateRouteCost(sampleRoutes[0]);
    expect(result.breakdown.bridgeCostUsd).toBe(0.5);
    expect(result.breakdown.networkCostUsd).toBeCloseTo(0.0012, 4);
    expect(result.breakdown.gasCostUsd).toBe(0.2);
    expect(result.breakdown.slippageCostUsd).toBe(1.0);
    expect(result.totalCostUsd).toBeGreaterThan(0);
  });

  it('treats missing gas/slippage as zero', () => {
    const result = calculateRouteCost({
      ...sampleRoutes[0],
      gasUsd: undefined,
      slippagePercent: undefined,
    });
    expect(result.breakdown.gasCostUsd).toBe(0);
    expect(result.breakdown.slippageCostUsd).toBe(0);
  });

  it('returns zero when weights sum to zero', () => {
    const result = calculateRouteCost(sampleRoutes[0], {
      bridge: 0,
      network: 0,
      gas: 0,
      slippage: 0,
    });
    expect(result.totalCostUsd).toBe(0);
  });

  it('normalizes weights that do not sum to 1', () => {
    const a = calculateRouteCost(sampleRoutes[0], { bridge: 2, network: 1, gas: 1, slippage: 0 });
    const b = calculateRouteCost(sampleRoutes[0], { bridge: 1, network: 0.5, gas: 0.5, slippage: 0 });
    expect(a.totalCostUsd).toBeCloseTo(b.totalCostUsd, 4);
  });

  it('handles amountUsd = 0 for costPercent', () => {
    const result = calculateRouteCost({ ...sampleRoutes[0], amountUsd: 0 });
    expect(result.costPercent).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SorobanRouteCostOptimizer
// ---------------------------------------------------------------------------

describe('SorobanRouteCostOptimizer', () => {
  it('evaluates every route with a total cost > 0', () => {
    const engine = new SorobanRouteCostOptimizer();
    const evaluated = engine.evaluate(sampleRoutes);
    expect(evaluated).toHaveLength(3);
    evaluated.forEach((e) => expect(e.totalCostUsd).toBeGreaterThan(0));
  });

  it('ranks routes ascending by total cost', () => {
    const engine = new SorobanRouteCostOptimizer();
    const ranked = engine.rankLowestCost(sampleRoutes);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i].totalCostUsd).toBeGreaterThanOrEqual(ranked[i - 1].totalCostUsd);
    }
  });

  it('accepts per-call weights to override configured weights', () => {
    const engine = new SorobanRouteCostOptimizer();
    const defaultRank = engine.rankLowestCost(sampleRoutes);
    const bridgeHeavyRank = engine.rankLowestCost(sampleRoutes, {
      bridge: 1,
      network: 0,
      gas: 0,
      slippage: 0,
    });
    const defaultIds = defaultRank.map((r) => r.route.id);
    const bridgeIds = bridgeHeavyRank.map((r) => r.route.id);
    expect(bridgeIds).not.toEqual(defaultIds);
  });

  it('updateWeights mutates the configured weights', () => {
    const engine = new SorobanRouteCostOptimizer();
    engine.updateWeights({ bridge: 1 });
    expect(engine.getWeights().bridge).toBe(1);
  });

  it('produces aggregate stats for a route set', () => {
    const engine = new SorobanRouteCostOptimizer();
    const stats = engine.stats(sampleRoutes);
    expect(stats.routeCount).toBe(3);
    expect(stats.cheapestRouteId).toBeTruthy();
    expect(stats.mostExpensiveRouteId).toBeTruthy();
    expect(stats.minCostUsd).toBeLessThanOrEqual(stats.maxCostUsd);
  });

  it('returns zeroed stats for an empty input', () => {
    const engine = new SorobanRouteCostOptimizer();
    const stats = engine.stats([]);
    expect(stats.routeCount).toBe(0);
    expect(stats.cheapestRouteId).toBeNull();
    expect(stats.mostExpensiveRouteId).toBeNull();
    expect(stats.averageCostUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Resource Fee Ceiling Policy Integration (#1331)
// ---------------------------------------------------------------------------

describe('Resource Fee Ceiling Policy Integration (#1331)', () => {
  it('filters out routes exceeding ceiling in evaluate()', () => {
    const ceilingService = createMockCeilingService(false, 100_000);
    const engine = new SorobanRouteCostOptimizer({}, ceilingService);
    const evaluated = engine.evaluate(sampleRoutes);
    // route-a has 100_000 stroops (at ceiling), route-b has 500_000 (exceeds), route-c has 50_000 (below)
    const allowed = evaluated.filter((e) => !e.filteredByCeiling);
    const filtered = evaluated.filter((e) => e.filteredByCeiling);
    expect(allowed).toHaveLength(2); // route-a and route-c
    expect(filtered).toHaveLength(1); // route-b
    expect(filtered[0].route.id).toBe('route-b');
    expect(filtered[0].ceilingViolation).toEqual({
      ceilingStroops: 100_000,
      resourceFeeStroops: 500_000,
    });
  });

  it('excludes ceiling-violating routes from rankLowestCost()', () => {
    const ceilingService = createMockCeilingService(false, 100_000);
    const engine = new SorobanRouteCostOptimizer({}, ceilingService);
    const ranked = engine.rankLowestCost(sampleRoutes);
    expect(ranked).toHaveLength(2);
    expect(ranked.map((r) => r.route.id)).not.toContain('route-b');
  });

  it('includes filteredByCeilingCount in stats()', () => {
    const ceilingService = createMockCeilingService(false, 100_000);
    const engine = new SorobanRouteCostOptimizer({}, ceilingService);
    const stats = engine.stats(sampleRoutes);
    expect(stats.routeCount).toBe(3);
    expect(stats.filteredByCeilingCount).toBe(1);
    expect(stats.cheapestRouteId).not.toBe('route-b');
  });

  it('allows all routes when ceiling service allows all', () => {
    const ceilingService = createMockCeilingService(true, 1_000_000);
    const engine = new SorobanRouteCostOptimizer({}, ceilingService);
    const evaluated = engine.evaluate(sampleRoutes);
    expect(evaluated.every((e) => !e.filteredByCeiling)).toBe(true);
    const ranked = engine.rankLowestCost(sampleRoutes);
    expect(ranked).toHaveLength(3);
    const stats = engine.stats(sampleRoutes);
    expect(stats.filteredByCeilingCount).toBe(0);
  });

  it('uses network field from route for ceiling check', () => {
    const ceilingService = createMockCeilingService(true, 1_000_000);
    const engine = new SorobanRouteCostOptimizer({}, ceilingService);
    engine.evaluate(sampleRoutes);
    expect(ceilingService.check).toHaveBeenCalledWith({
      network: 'stellar-testnet',
      resourceFeeStroops: 100_000,
    });
    expect(ceilingService.check).toHaveBeenCalledWith({
      network: 'stellar-testnet',
      resourceFeeStroops: 500_000,
    });
    expect(ceilingService.check).toHaveBeenCalledWith({
      network: 'stellar-mainnet',
      resourceFeeStroops: 50_000,
    });
  });

  it('skips ceiling check when route has no network field', () => {
    const ceilingService = createMockCeilingService(false, 100);
    const engine = new SorobanRouteCostOptimizer({}, ceilingService);
    const routesWithoutNetwork: CostRoute[] = [
      { ...sampleRoutes[0], network: undefined },
    ];
    const evaluated = engine.evaluate(routesWithoutNetwork);
    expect(evaluated[0].filteredByCeiling).toBe(false);
    expect(ceilingService.check).not.toHaveBeenCalled();
  });

  it('updateCeilingService replaces the ceiling service', () => {
    const ceilingService1 = createMockCeilingService(false, 100_000);
    const ceilingService2 = createMockCeilingService(true, 1_000_000);
    const engine = new SorobanRouteCostOptimizer({}, ceilingService1);
    engine.updateCeilingService(ceilingService2);
    const evaluated = engine.evaluate(sampleRoutes);
    expect(evaluated.every((e) => !e.filteredByCeiling)).toBe(true);
    expect(ceilingService1.check).not.toHaveBeenCalled();
    expect(ceilingService2.check).toHaveBeenCalled();
  });

  it('handles empty routes with ceiling service', () => {
    const ceilingService = createMockCeilingService(false, 100);
    const engine = new SorobanRouteCostOptimizer({}, ceilingService);
    const stats = engine.stats([]);
    expect(stats.routeCount).toBe(0);
    expect(stats.filteredByCeilingCount).toBe(0);
  });
});
