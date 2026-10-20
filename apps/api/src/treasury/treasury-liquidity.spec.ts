import {
  InsufficientLiquidityError,
  LiquidityReservations,
  PoolKey,
  poolKey,
} from './liquidity-reservation';
import { reconcileReserved } from './reserve-reconciliation';
import { EmergencyLiquidityInjection } from './emergency-liquidity-injection';
import { simulateRebalance } from './rebalance-simulation';

const eth: PoolKey = { chain: 'ethereum', asset: 'USDC' };
const stellar: PoolKey = { chain: 'stellar', asset: 'USDC' };
const ethDai: PoolKey = { chain: 'ethereum', asset: 'DAI' };

describe('liquidity reservations', () => {
  let clock = 1_000;
  const totals = () => new Map([[poolKey(eth), 1_000n], [poolKey(stellar), 500n]]);

  beforeEach(() => (clock = 1_000));

  it('reserves, rejects over-reservation and keeps chains/assets separate', () => {
    const book = new LiquidityReservations(totals(), () => clock);
    book.reserve('a', eth, 700n, 5_000);
    expect(book.available(eth)).toBe(300n);
    expect(book.available(stellar)).toBe(500n);
    expect(book.available(ethDai)).toBe(0n);
    expect(() => book.reserve('b', eth, 400n, 5_000)).toThrow(InsufficientLiquidityError);
  });

  it('is idempotent per reservation id', () => {
    const book = new LiquidityReservations(totals(), () => clock);
    const first = book.reserve('a', eth, 100n, 5_000);
    expect(book.reserve('a', eth, 100n, 5_000)).toBe(first);
    expect(book.reserved(eth)).toBe(100n);
    expect(() => book.reserve('a', eth, 200n, 5_000)).toThrow('different parameters');
  });

  it('expires reservations after their TTL and returns the funds', () => {
    const book = new LiquidityReservations(totals(), () => clock);
    book.reserve('a', eth, 600n, 1_000);
    clock = 2_000;
    expect(book.expireDue().map((r) => r.id)).toEqual(['a']);
    expect(book.available(eth)).toBe(1_000n);
    expect(book.release('a')).toBe(false);
    expect(book.expireDue()).toEqual([]);
  });

  it('frees funds on release exactly once', () => {
    const book = new LiquidityReservations(totals(), () => clock);
    book.reserve('a', eth, 600n, 5_000);
    expect(book.release('a')).toBe(true);
    expect(book.release('a')).toBe(false);
    expect(book.available(eth)).toBe(1_000n);
  });
});

describe('reserved vs available reconciliation', () => {
  it('flags mismatches in both directions per pool', () => {
    const book = new LiquidityReservations(new Map([[poolKey(eth), 1_000n], [poolKey(stellar), 500n]]));
    book.reserve('a', eth, 300n, 10_000);
    book.reserve('b', stellar, 100n, 10_000);
    const lines = reconcileReserved(
      book,
      [eth, stellar],
      new Map([[poolKey(eth), 250n], [poolKey(stellar), 150n]]),
    );
    expect(lines.map((l) => [l.status, l.delta])).toEqual([
      ['book_exceeds_external', 50n],
      ['external_exceeds_book', -50n],
    ]);
    expect(lines.every((l) => !l.overReserved)).toBe(true);
  });

  it('reports a match when books agree', () => {
    const book = new LiquidityReservations(new Map([[poolKey(eth), 1_000n]]));
    book.reserve('a', eth, 300n, 10_000);
    const [line] = reconcileReserved(book, [eth], new Map([[poolKey(eth), 300n]]));
    expect(line.status).toBe('match');
  });
});

describe('emergency liquidity injection', () => {
  it('requires a different approver and credits the pool exactly once', () => {
    const totals = new Map([[poolKey(eth), 100n]]);
    const injection = new EmergencyLiquidityInjection(totals, () => 42);
    injection.request('r1', eth, 400n, 'bridge surge', 'alice');

    expect(() => injection.approve('r1', 'alice')).toThrow('differ');
    injection.approve('r1', 'bob');
    injection.approve('r1', 'bob');
    expect(totals.get(poolKey(eth))).toBe(500n);
    expect(injection.audit.map((a) => a.action)).toEqual(['requested', 'approved']);
  });

  it('validates the request and blocks decisions on rejected requests', () => {
    const injection = new EmergencyLiquidityInjection(new Map());
    expect(() => injection.request('r', eth, 0n, 'x', 'a')).toThrow('bounds');
    expect(() => injection.request('r', eth, 1n, ' ', 'a')).toThrow('reason');
    injection.request('r2', eth, 1n, 'why', 'a');
    injection.reject('r2', 'b');
    expect(() => injection.approve('r2', 'c')).toThrow('rejected');
  });
});

describe('rebalance simulation', () => {
  it('moves surplus to deficit per asset and conserves totals', () => {
    const [report] = simulateRebalance([
      { pool: eth, balance: 900n, targetBps: 5_000 },
      { pool: stellar, balance: 100n, targetBps: 5_000 },
    ]);
    expect(report.total).toBe(1_000n);
    expect(report.moves).toEqual([{ asset: 'USDC', fromChain: 'ethereum', toChain: 'stellar', amount: 400n }]);
    expect(report.after.reduce((s, p) => s + p.balance, 0n)).toBe(1_000n);
  });

  it('never mixes assets and rejects targets that do not sum to 100%', () => {
    const reports = simulateRebalance([
      { pool: eth, balance: 10n, targetBps: 10_000 },
      { pool: ethDai, balance: 20n, targetBps: 10_000 },
    ]);
    expect(reports.map((r) => [r.asset, r.moves.length])).toEqual([['USDC', 0], ['DAI', 0]]);
    expect(() => simulateRebalance([{ pool: eth, balance: 1n, targetBps: 9_000 }])).toThrow('10000');
  });

  it('gives rounding dust to the first pool so the sum is exact', () => {
    const [report] = simulateRebalance([
      { pool: eth, balance: 100n, targetBps: 3_333 },
      { pool: stellar, balance: 0n, targetBps: 3_333 },
      { pool: { chain: 'base', asset: 'USDC' }, balance: 0n, targetBps: 3_334 },
    ]);
    expect(report.after.reduce((s, p) => s + p.balance, 0n)).toBe(100n);
  });
});
