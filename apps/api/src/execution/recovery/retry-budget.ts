export type FailureClass = 'network' | 'timeout' | 'rpc_error' | 'insufficient_funds' | 'validation' | 'unknown';

export interface RetryBudget {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/** Transient failures get a bounded budget; deterministic failures (validation, funds) never retry. */
export const DEFAULT_RETRY_BUDGETS: Record<FailureClass, RetryBudget> = {
  network: { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 30_000 },
  timeout: { maxAttempts: 3, baseDelayMs: 2_000, maxDelayMs: 60_000 },
  rpc_error: { maxAttempts: 4, baseDelayMs: 1_000, maxDelayMs: 30_000 },
  insufficient_funds: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0 },
  validation: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0 },
  unknown: { maxAttempts: 1, baseDelayMs: 5_000, maxDelayMs: 5_000 },
};

export interface RetryDecision {
  allowed: boolean;
  /** Number of retries consumed in this class, including this one when allowed. */
  attempt: number;
  remaining: number;
  /** Exponential backoff delay before the retry; 0 when not allowed. */
  delayMs: number;
  exhausted: boolean;
}

/** Tracks retries per execution and failure class so one failure type cannot consume another's budget. */
export class RetryBudgetTracker {
  private readonly used = new Map<string, number>();

  constructor(private readonly budgets: Record<FailureClass, RetryBudget> = DEFAULT_RETRY_BUDGETS) {}

  consume(executionId: string, failureClass: FailureClass): RetryDecision {
    const budget = this.budgets[failureClass];
    const key = `${executionId}:${failureClass}`;
    const used = this.used.get(key) ?? 0;
    if (used >= budget.maxAttempts) {
      return { allowed: false, attempt: used, remaining: 0, delayMs: 0, exhausted: true };
    }
    this.used.set(key, used + 1);
    const delayMs = Math.min(budget.baseDelayMs * 2 ** used, budget.maxDelayMs);
    return {
      allowed: true,
      attempt: used + 1,
      remaining: budget.maxAttempts - used - 1,
      delayMs,
      exhausted: false,
    };
  }

  reset(executionId: string): void {
    for (const key of [...this.used.keys()]) {
      if (key.startsWith(`${executionId}:`)) this.used.delete(key);
    }
  }
}
