export type Fault = 'ok' | 'timeout_after_send' | 'error_before_send' | 'drop';

/**
 * Deterministic fault plan: the Nth call of an operation gets the Nth scripted fault, then `ok`.
 * No randomness, so every failing scenario is reproducible.
 */
export class FaultInjector {
  private readonly calls = new Map<string, number>();

  constructor(private readonly plan: Record<string, Fault[]>) {}

  next(operation: string): Fault {
    const n = this.calls.get(operation) ?? 0;
    this.calls.set(operation, n + 1);
    return this.plan[operation]?.[n] ?? 'ok';
  }

  callCount(operation: string): number {
    return this.calls.get(operation) ?? 0;
  }
}

/** Minimal chain double: records every distinct transaction that actually landed. */
export class SimulatedChain {
  readonly landed = new Map<string, number>();

  constructor(private readonly faults: FaultInjector) {}

  /** Submits `idempotencyKey`. Returns what the caller observes; `landed` records what really happened. */
  submit(idempotencyKey: string): 'confirmed' | 'timeout' | 'error' {
    const fault = this.faults.next('submit');
    if (fault === 'error_before_send') return 'error';
    if (fault === 'drop') return 'timeout'; // the request was lost, nothing landed
    this.landed.set(idempotencyKey, (this.landed.get(idempotencyKey) ?? 0) + 1);
    return fault === 'timeout_after_send' ? 'timeout' : 'confirmed';
  }

  lookup(idempotencyKey: string): 'found' | 'not_found' {
    return this.landed.has(idempotencyKey) ? 'found' : 'not_found';
  }
}
