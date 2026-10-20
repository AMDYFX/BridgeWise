/** Serialises work per key so check-then-commit sequences cannot interleave. */
class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => (release = resolve));
    this.tails.set(key, previous.then(() => next));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class TreasuryLimitExceededError extends Error {
  constructor(pool: string, requested: bigint, remaining: bigint) {
    super(`limit exceeded for ${pool}: requested ${requested}, remaining ${remaining}`);
    this.name = 'TreasuryLimitExceededError';
  }
}

/**
 * Enforces a per-pool outflow limit. The limit check and the commit happen under a per-pool lock, so
 * concurrent requests can never jointly exceed the limit; failed operations give their amount back.
 */
export class TreasuryLimiter {
  private readonly used = new Map<string, bigint>();
  private readonly mutex = new KeyedMutex();

  constructor(private readonly limits: Map<string, bigint>) {}

  remaining(pool: string): bigint {
    return (this.limits.get(pool) ?? 0n) - (this.used.get(pool) ?? 0n);
  }

  async withdraw<T>(pool: string, amount: bigint, operation: () => Promise<T>): Promise<T> {
    if (amount <= 0n) throw new Error('amount must be positive');
    await this.mutex.run(pool, async () => {
      const remaining = this.remaining(pool);
      if (amount > remaining) throw new TreasuryLimitExceededError(pool, amount, remaining);
      this.used.set(pool, (this.used.get(pool) ?? 0n) + amount);
    });
    try {
      return await operation();
    } catch (err) {
      await this.mutex.run(pool, async () => {
        this.used.set(pool, (this.used.get(pool) ?? 0n) - amount);
      });
      throw err;
    }
  }
}
