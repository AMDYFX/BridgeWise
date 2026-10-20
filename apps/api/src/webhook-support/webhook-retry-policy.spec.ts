import {
  computeDelay,
  DEFAULT_RETRY_POLICY,
  RetryPolicy,
  toBullMqBackoff,
} from './webhook-retry-policy';

describe('webhook retry policy', () => {
  describe('DEFAULT_RETRY_POLICY', () => {
    it('has sensible defaults', () => {
      expect(DEFAULT_RETRY_POLICY.maxAttempts).toBeGreaterThan(0);
      expect(DEFAULT_RETRY_POLICY.initialDelayMs).toBeGreaterThan(0);
      expect(DEFAULT_RETRY_POLICY.strategy).toBe('exponential');
    });
  });

  describe('toBullMqBackoff', () => {
    it('returns type and delay for exponential', () => {
      const b = toBullMqBackoff(DEFAULT_RETRY_POLICY);
      expect(b.type).toBe('exponential');
      expect(b.delay).toBe(DEFAULT_RETRY_POLICY.initialDelayMs);
    });

    it('maps fixed strategy to fixed type', () => {
      const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, strategy: 'fixed' };
      expect(toBullMqBackoff(policy).type).toBe('fixed');
    });
  });

  describe('computeDelay', () => {
    it('doubles each attempt for exponential', () => {
      const p: RetryPolicy = { ...DEFAULT_RETRY_POLICY, initialDelayMs: 1_000, maxDelayMs: 999_999 };
      expect(computeDelay(p, 0)).toBe(1_000);
      expect(computeDelay(p, 1)).toBe(2_000);
      expect(computeDelay(p, 2)).toBe(4_000);
    });

    it('is constant for fixed strategy', () => {
      const p: RetryPolicy = { ...DEFAULT_RETRY_POLICY, strategy: 'fixed', initialDelayMs: 3_000 };
      expect(computeDelay(p, 0)).toBe(3_000);
      expect(computeDelay(p, 5)).toBe(3_000);
    });

    it('grows linearly for linear strategy', () => {
      const p: RetryPolicy = { ...DEFAULT_RETRY_POLICY, strategy: 'linear', initialDelayMs: 2_000, maxDelayMs: 999_999 };
      expect(computeDelay(p, 0)).toBe(2_000);
      expect(computeDelay(p, 1)).toBe(4_000);
    });

    it('never exceeds maxDelayMs', () => {
      const p: RetryPolicy = { ...DEFAULT_RETRY_POLICY, initialDelayMs: 1_000, maxDelayMs: 5_000 };
      expect(computeDelay(p, 10)).toBe(5_000);
    });
  });
});
