import { PoolKey } from './liquidity-reservation';

export interface PoolPosition {
  pool: PoolKey;
  balance: bigint;
  /** Desired share of the asset's total across chains, in basis points. */
  targetBps: number;
}

export interface SimulatedMove {
  asset: string;
  fromChain: string;
  toChain: string;
  amount: bigint;
}

export interface RebalanceReport {
  asset: string;
  total: bigint;
  moves: SimulatedMove[];
  /** Balances after applying all moves; the sum always equals `total`. */
  after: Array<{ pool: PoolKey; balance: bigint }>;
}

/**
 * Dry-run of a rebalance per asset: moves surplus chains' funds to deficit chains until each pool is at
 * its target share. Assets are never mixed and the asset total is conserved. Nothing is executed.
 */
export function simulateRebalance(positions: PoolPosition[]): RebalanceReport[] {
  const byAsset = new Map<string, PoolPosition[]>();
  for (const p of positions) byAsset.set(p.pool.asset, [...(byAsset.get(p.pool.asset) ?? []), p]);

  return [...byAsset.entries()].map(([asset, group]) => {
    const bpsSum = group.reduce((s, p) => s + p.targetBps, 0);
    if (bpsSum !== 10_000) throw new Error(`targets for ${asset} must sum to 10000 bps, got ${bpsSum}`);
    const total = group.reduce((s, p) => s + p.balance, 0n);

    // Floor each target; give the rounding dust to the first pool so the sum is exactly `total`.
    const targets = group.map((p) => (total * BigInt(p.targetBps)) / 10_000n);
    targets[0] += total - targets.reduce((s, t) => s + t, 0n);

    const surplus = group.map((p, i) => ({ chain: p.pool.chain, amount: p.balance - targets[i] }));
    const givers = surplus.filter((s) => s.amount > 0n).map((s) => ({ ...s }));
    const takers = surplus.filter((s) => s.amount < 0n).map((s) => ({ chain: s.chain, amount: -s.amount }));

    const moves: SimulatedMove[] = [];
    for (const taker of takers) {
      for (const giver of givers) {
        if (taker.amount === 0n) break;
        const amount = giver.amount < taker.amount ? giver.amount : taker.amount;
        if (amount === 0n) continue;
        moves.push({ asset, fromChain: giver.chain, toChain: taker.chain, amount });
        giver.amount -= amount;
        taker.amount -= amount;
      }
    }

    return {
      asset,
      total,
      moves,
      after: group.map((p, i) => ({ pool: p.pool, balance: targets[i] })),
    };
  });
}
