export interface PoolKey {
  chain: string;
  asset: string;
}

/** Pools never mix chains or assets: every balance and reservation is keyed by chain + asset. */
export const poolKey = (pool: PoolKey): string => `${pool.chain}:${pool.asset}`;

export type ReservationStatus = 'active' | 'released' | 'expired';

export interface Reservation {
  id: string;
  pool: PoolKey;
  amount: bigint;
  expiresAt: number;
  status: ReservationStatus;
}

export class InsufficientLiquidityError extends Error {
  constructor(pool: PoolKey, requested: bigint, available: bigint) {
    super(`insufficient liquidity in ${poolKey(pool)}: requested ${requested}, available ${available}`);
    this.name = 'InsufficientLiquidityError';
  }
}

/**
 * Tracks liquidity reservations against pool totals. Reservations expire after their TTL so
 * abandoned executions cannot lock funds forever. Invariant: available = total - active reservations >= 0.
 */
export class LiquidityReservations {
  private readonly reservations = new Map<string, Reservation>();

  constructor(
    private readonly totals: Map<string, bigint>,
    private readonly now: () => number = Date.now,
  ) {}

  total(pool: PoolKey): bigint {
    return this.totals.get(poolKey(pool)) ?? 0n;
  }

  reserved(pool: PoolKey): bigint {
    let sum = 0n;
    for (const r of this.reservations.values()) {
      if (r.status === 'active' && poolKey(r.pool) === poolKey(pool)) sum += r.amount;
    }
    return sum;
  }

  available(pool: PoolKey): bigint {
    return this.total(pool) - this.reserved(pool);
  }

  /** Idempotent per id: repeating the same reservation returns it; reusing an id for a different one throws. */
  reserve(id: string, pool: PoolKey, amount: bigint, ttlMs: number): Reservation {
    if (amount <= 0n) throw new Error('reservation amount must be positive');
    const existing = this.reservations.get(id);
    if (existing) {
      if (poolKey(existing.pool) !== poolKey(pool) || existing.amount !== amount) {
        throw new Error(`reservation ${id} already exists with different parameters`);
      }
      return existing;
    }
    this.expireDue();
    const available = this.available(pool);
    if (amount > available) throw new InsufficientLiquidityError(pool, amount, available);
    const reservation: Reservation = {
      id,
      pool,
      amount,
      expiresAt: this.now() + ttlMs,
      status: 'active',
    };
    this.reservations.set(id, reservation);
    return reservation;
  }

  /** Returns true if an active reservation was released; releasing twice is a no-op. */
  release(id: string): boolean {
    const r = this.reservations.get(id);
    if (!r || r.status !== 'active') return false;
    r.status = 'released';
    return true;
  }

  /** Marks every reservation past its TTL as expired, returning the funds to the pool. */
  expireDue(): Reservation[] {
    const now = this.now();
    const expired: Reservation[] = [];
    for (const r of this.reservations.values()) {
      if (r.status === 'active' && r.expiresAt <= now) {
        r.status = 'expired';
        expired.push(r);
      }
    }
    return expired;
  }

  list(): Reservation[] {
    return [...this.reservations.values()];
  }
}
