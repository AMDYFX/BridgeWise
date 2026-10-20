import { LiquidityReservations, PoolKey, poolKey } from './liquidity-reservation';

export type ReconciliationStatus = 'match' | 'book_exceeds_external' | 'external_exceeds_book';

export interface ReconciliationLine {
  pool: PoolKey;
  bookReserved: bigint;
  externalReserved: bigint;
  delta: bigint;
  status: ReconciliationStatus;
  /** True when more is reserved than the pool holds, which must never happen. */
  overReserved: boolean;
}

/**
 * Compares reserved funds in the reservation book against an external source (e.g. on-chain escrow
 * balances) per chain + asset pool. `delta = book - external`.
 */
export function reconcileReserved(
  book: LiquidityReservations,
  pools: PoolKey[],
  externalReserved: Map<string, bigint>,
): ReconciliationLine[] {
  return pools.map((pool) => {
    const bookReserved = book.reserved(pool);
    const external = externalReserved.get(poolKey(pool)) ?? 0n;
    const delta = bookReserved - external;
    return {
      pool,
      bookReserved,
      externalReserved: external,
      delta,
      status: delta === 0n ? 'match' : delta > 0n ? 'book_exceeds_external' : 'external_exceeds_book',
      overReserved: bookReserved > book.total(pool),
    };
  });
}
