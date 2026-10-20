/**
 * Webhook delivery retry policy.
 *
 * Centralises the retry/backoff configuration so it is defined once
 * and shared between WebhookService (queue options) and
 * WebhookProcessor (failure handling).
 */

export interface RetryPolicy {
  /** Maximum delivery attempts (initial + retries). */
  maxAttempts: number;
  /** Initial backoff delay in milliseconds. */
  initialDelayMs: number;
  /** Backoff strategy. */
  strategy: 'exponential' | 'linear' | 'fixed';
  /** Cap on delay growth (ms). Only applies to exponential/linear. */
  maxDelayMs: number;
}

/** Default policy applied to every webhook unless overridden. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  initialDelayMs: 5_000,   // 5 s → 10 s → 20 s → 40 s → 80 s (capped)
  strategy: 'exponential',
  maxDelayMs: 3_600_000,   // 1 hour ceiling
};

/**
 * Returns the BullMQ-compatible `backoff` option for a given policy.
 */
export function toBullMqBackoff(
  policy: RetryPolicy,
): { type: string; delay: number } {
  return {
    type: policy.strategy === 'fixed' ? 'fixed' : policy.strategy,
    delay: policy.initialDelayMs,
  };
}

/**
 * Computes the delay (ms) before attempt number `attemptIndex` (0-based).
 * Used for logging / testing without BullMQ.
 */
export function computeDelay(policy: RetryPolicy, attemptIndex: number): number {
  let delay: number;

  switch (policy.strategy) {
    case 'fixed':
      delay = policy.initialDelayMs;
      break;
    case 'linear':
      delay = policy.initialDelayMs * (attemptIndex + 1);
      break;
    case 'exponential':
    default:
      delay = policy.initialDelayMs * Math.pow(2, attemptIndex);
  }

  return Math.min(delay, policy.maxDelayMs);
}
