import { assertSnapshotsFresh, checkSnapshot, detectStaleSnapshots, StaleSnapshotError } from './stale-snapshot-detector';
import { RouteLiquidityMetrics } from './route-liquidity-metrics';
import { TreasuryLimitExceededError, TreasuryLimiter } from './treasury-limits';

describe('stale snapshot detection', () => {
  const now = 100_000;

  it('classifies fresh, stale and future-dated snapshots', () => {
    expect(checkSnapshot({ pool: 'a', capturedAt: 99_000 }, now, 5_000).status).toBe('fresh');
    expect(checkSnapshot({ pool: 'a', capturedAt: 90_000 }, now, 5_000)).toEqual({ pool: 'a', ageMs: 10_000, status: 'stale' });
    expect(checkSnapshot({ pool: 'a', capturedAt: 101_000 }, now, 5_000).status).toBe('from_future');
    expect(checkSnapshot({ pool: 'a', capturedAt: 95_000 }, now, 5_000).status).toBe('fresh'); // boundary
  });

  it('lists only the unusable snapshots and throws before acting on them', () => {
    const snaps = [
      { pool: 'fresh', capturedAt: 99_999 },
      { pool: 'old', capturedAt: 1 },
    ];
    expect(detectStaleSnapshots(snaps, now, 5_000).map((c) => c.pool)).toEqual(['old']);
    expect(() => assertSnapshotsFresh(snaps, now, 5_000)).toThrow(StaleSnapshotError);
    expect(() => assertSnapshotsFresh([snaps[0]], now, 5_000)).not.toThrow();
  });
});

describe('route liquidity metrics', () => {
  const route = { fromChain: 'ethereum', toChain: 'stellar', asset: 'USDC' };

  it('computes utilization per route and caps over-reservation at 100%', () => {
    const metrics = new RouteLiquidityMetrics();
    expect(metrics.record(route, 250n, 1_000n).utilizationBps).toBe(2_500);
    expect(metrics.record(route, 2_000n, 1_000n)).toMatchObject({ utilizationBps: 10_000, samples: 2 });
    expect(metrics.record({ ...route, asset: 'DAI' }, 1n, 0n).utilizationBps).toBe(10_000);
  });

  it('lists hot routes and renders Prometheus lines per route and asset', () => {
    const metrics = new RouteLiquidityMetrics();
    metrics.record(route, 900n, 1_000n);
    metrics.record({ ...route, asset: 'DAI' }, 100n, 1_000n);
    expect(metrics.hot(5_000).map((u) => u.route.asset)).toEqual(['USDC']);
    expect(metrics.toPrometheus()).toContain('bridgewise_route_liquidity_utilization_bps{from="ethereum",to="stellar",asset="USDC"} 9000');
    expect(() => metrics.record(route, -1n, 1n)).toThrow('negative');
  });
});

describe('treasury limit enforcement under concurrency', () => {
  const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

  it('never lets concurrent withdrawals exceed the limit', async () => {
    const limiter = new TreasuryLimiter(new Map([['ethereum:USDC', 100n]]));
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () => limiter.withdraw('ethereum:USDC', 10n, async () => delay())),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(15);
    expect(rejected.every((r) => r.reason instanceof TreasuryLimitExceededError)).toBe(true);
    expect(limiter.remaining('ethereum:USDC')).toBe(0n);
  });

  it('gives the amount back when the operation fails and keeps pools independent', async () => {
    const limiter = new TreasuryLimiter(new Map([['a', 50n], ['b', 50n]]));
    await expect(limiter.withdraw('a', 50n, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(limiter.remaining('a')).toBe(50n);
    await limiter.withdraw('a', 50n, async () => undefined);
    expect(limiter.remaining('b')).toBe(50n);
    await expect(limiter.withdraw('a', 1n, async () => undefined)).rejects.toBeInstanceOf(TreasuryLimitExceededError);
  });

  it('rejects non-positive amounts', async () => {
    const limiter = new TreasuryLimiter(new Map([['a', 5n]]));
    await expect(limiter.withdraw('a', 0n, async () => undefined)).rejects.toThrow('positive');
  });
});
