/**
 * Unit tests for chain clock skew tolerance checks.
 *
 * All tests use a deterministic injected clock so no real wall-clock
 * dependency exists. Fixtures simulate:
 *   - Messages well within tolerance
 *   - Messages at the exact tolerance boundary (boundary testing)
 *   - Messages that just exceed tolerance
 *   - Messages with future timestamps within the allowed drift
 *   - Messages with implausibly far-future timestamps
 *   - Grace-period activation doubling the effective tolerance
 *   - Invalid configuration rejection
 *   - Multi-chain independence
 *   - Simulated dependency failures (unregistered chain)
 */

import {
  checkClockSkew,
  validateClockSkewConfig,
  ClockSkewChecker,
  createDefaultClockSkewChecker,
  InvalidClockSkewConfigError,
  ClockSkewConfig,
} from './chain-clock-skew';

// ---------------------------------------------------------------------------
// Deterministic fixtures
// ---------------------------------------------------------------------------

const NOW_MS = 1_700_000_000_000; // fixed reference point

const STELLAR_CONFIG: ClockSkewConfig = {
  chainId: 'stellar',
  toleranceMs: 30_000,
  futureDriftMs: 15_000,
  gracePeriodMs: 30_000,
};

const ETH_CONFIG: ClockSkewConfig = {
  chainId: 'ethereum',
  toleranceMs: 60_000,
  futureDriftMs: 30_000,
  gracePeriodMs: 60_000,
};

// ---------------------------------------------------------------------------
// validateClockSkewConfig
// ---------------------------------------------------------------------------
describe('validateClockSkewConfig', () => {
  it('accepts a valid config', () => {
    expect(() => validateClockSkewConfig(STELLAR_CONFIG)).not.toThrow();
  });

  it('throws for empty chainId', () => {
    expect(() =>
      validateClockSkewConfig({ chainId: '', toleranceMs: 30_000 }),
    ).toThrow(InvalidClockSkewConfigError);
  });

  it('throws for blank chainId (whitespace only)', () => {
    expect(() =>
      validateClockSkewConfig({ chainId: '   ', toleranceMs: 30_000 }),
    ).toThrow(InvalidClockSkewConfigError);
  });

  it('throws for zero toleranceMs', () => {
    expect(() =>
      validateClockSkewConfig({ chainId: 'stellar', toleranceMs: 0 }),
    ).toThrow(InvalidClockSkewConfigError);
  });

  it('throws for negative toleranceMs', () => {
    expect(() =>
      validateClockSkewConfig({ chainId: 'stellar', toleranceMs: -1 }),
    ).toThrow(InvalidClockSkewConfigError);
  });

  it('throws for non-finite toleranceMs', () => {
    expect(() =>
      validateClockSkewConfig({ chainId: 'stellar', toleranceMs: Infinity }),
    ).toThrow(InvalidClockSkewConfigError);
  });

  it('throws for negative futureDriftMs', () => {
    expect(() =>
      validateClockSkewConfig({
        chainId: 'stellar',
        toleranceMs: 30_000,
        futureDriftMs: -1,
      }),
    ).toThrow(InvalidClockSkewConfigError);
  });

  it('accepts zero futureDriftMs (no future drift allowed)', () => {
    expect(() =>
      validateClockSkewConfig({
        chainId: 'stellar',
        toleranceMs: 30_000,
        futureDriftMs: 0,
      }),
    ).not.toThrow();
  });

  it('throws for negative gracePeriodMs', () => {
    expect(() =>
      validateClockSkewConfig({
        chainId: 'stellar',
        toleranceMs: 30_000,
        gracePeriodMs: -500,
      }),
    ).toThrow(InvalidClockSkewConfigError);
  });
});

// ---------------------------------------------------------------------------
// checkClockSkew — WITHIN_TOLERANCE cases
// ---------------------------------------------------------------------------
describe('checkClockSkew — WITHIN_TOLERANCE', () => {
  it('accepts a message with zero skew', () => {
    const result = checkClockSkew(NOW_MS, NOW_MS, STELLAR_CONFIG);
    expect(result.status).toBe('WITHIN_TOLERANCE');
    expect(result.accepted).toBe(true);
    expect(result.skewMs).toBe(0);
  });

  it('accepts a message slightly older than local time', () => {
    const messageTs = NOW_MS - 10_000; // 10s old — well within 30s
    const result = checkClockSkew(messageTs, NOW_MS, STELLAR_CONFIG);
    expect(result.status).toBe('WITHIN_TOLERANCE');
    expect(result.accepted).toBe(true);
  });

  it('accepts a message at the exact tolerance boundary', () => {
    // exactly at 30 000 ms — should be accepted (not strictly greater)
    const messageTs = NOW_MS - STELLAR_CONFIG.toleranceMs;
    const result = checkClockSkew(messageTs, NOW_MS, STELLAR_CONFIG);
    expect(result.status).toBe('WITHIN_TOLERANCE');
    expect(result.accepted).toBe(true);
  });

  it('accepts a message with a small future timestamp within drift', () => {
    // 5 000 ms in the future — within futureDriftMs of 15 000
    const messageTs = NOW_MS + 5_000;
    const result = checkClockSkew(messageTs, NOW_MS, STELLAR_CONFIG);
    expect(result.status).toBe('WITHIN_TOLERANCE');
    expect(result.accepted).toBe(true);
  });

  it('accepts a message at the exact future drift boundary', () => {
    const messageTs = NOW_MS + (STELLAR_CONFIG.futureDriftMs as number);
    const result = checkClockSkew(messageTs, NOW_MS, STELLAR_CONFIG);
    expect(result.status).toBe('WITHIN_TOLERANCE');
    expect(result.accepted).toBe(true);
  });

  it('populates skewMs correctly (positive = older)', () => {
    const messageTs = NOW_MS - 12_345;
    const result = checkClockSkew(messageTs, NOW_MS, STELLAR_CONFIG);
    expect(result.skewMs).toBe(12_345);
  });

  it('populates skewMs correctly (negative = future)', () => {
    const messageTs = NOW_MS + 5_000;
    const result = checkClockSkew(messageTs, NOW_MS, STELLAR_CONFIG);
    expect(result.skewMs).toBe(-5_000);
  });

  it('includes the chain ID in the result', () => {
    const result = checkClockSkew(NOW_MS, NOW_MS, STELLAR_CONFIG);
    expect(result.chainId).toBe('stellar');
  });
});

// ---------------------------------------------------------------------------
// checkClockSkew — CLOCK_SKEW_EXCEEDED cases
// ---------------------------------------------------------------------------
describe('checkClockSkew — CLOCK_SKEW_EXCEEDED', () => {
  it('rejects a message one millisecond past the tolerance boundary', () => {
    const messageTs = NOW_MS - STELLAR_CONFIG.toleranceMs - 1;
    const result = checkClockSkew(messageTs, NOW_MS, STELLAR_CONFIG);
    expect(result.status).toBe('CLOCK_SKEW_EXCEEDED');
    expect(result.accepted).toBe(false);
  });

  it('rejects a message that is significantly older than tolerance', () => {
    const messageTs = NOW_MS - 300_000; // 5 minutes old
    const result = checkClockSkew(messageTs, NOW_MS, STELLAR_CONFIG);
    expect(result.status).toBe('CLOCK_SKEW_EXCEEDED');
    expect(result.accepted).toBe(false);
  });

  it('result carries the effectiveToleranceMs', () => {
    const messageTs = NOW_MS - 60_000;
    const result = checkClockSkew(messageTs, NOW_MS, STELLAR_CONFIG);
    expect(result.effectiveToleranceMs).toBe(STELLAR_CONFIG.toleranceMs);
  });

  it('gracePeriodApplied is false when grace period is inactive', () => {
    const messageTs = NOW_MS - 60_000;
    const result = checkClockSkew(messageTs, NOW_MS, STELLAR_CONFIG);
    expect(result.gracePeriodApplied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkClockSkew — MESSAGE_FROM_FUTURE cases
// ---------------------------------------------------------------------------
describe('checkClockSkew — MESSAGE_FROM_FUTURE', () => {
  it('rejects a message one millisecond past the future drift boundary', () => {
    const messageTs = NOW_MS + (STELLAR_CONFIG.futureDriftMs as number) + 1;
    const result = checkClockSkew(messageTs, NOW_MS, STELLAR_CONFIG);
    expect(result.status).toBe('MESSAGE_FROM_FUTURE');
    expect(result.accepted).toBe(false);
  });

  it('rejects a message very far in the future', () => {
    const messageTs = NOW_MS + 3_600_000; // 1 hour ahead
    const result = checkClockSkew(messageTs, NOW_MS, STELLAR_CONFIG);
    expect(result.status).toBe('MESSAGE_FROM_FUTURE');
    expect(result.accepted).toBe(false);
  });

  it('defaults futureDriftMs to toleranceMs/2 when not provided', () => {
    const configNoFutureDrift: ClockSkewConfig = {
      chainId: 'test',
      toleranceMs: 60_000,
      // futureDriftMs not set → defaults to 30 000
    };
    // 25 000 ms future should be accepted (< 30 000 default drift)
    const within = checkClockSkew(NOW_MS + 25_000, NOW_MS, configNoFutureDrift);
    expect(within.status).toBe('WITHIN_TOLERANCE');

    // 35 000 ms future should be rejected (> 30 000 default drift)
    const beyond = checkClockSkew(NOW_MS + 35_000, NOW_MS, configNoFutureDrift);
    expect(beyond.status).toBe('MESSAGE_FROM_FUTURE');
  });
});

// ---------------------------------------------------------------------------
// checkClockSkew — grace period
// ---------------------------------------------------------------------------
describe('checkClockSkew — grace period', () => {
  it('accepts a message that would normally be rejected when grace period is active', () => {
    // 50 000 ms old — exceeds 30 000 ms tolerance but within 30+30=60 000 ms with grace
    const messageTs = NOW_MS - 50_000;
    const configWithGrace: ClockSkewConfig = {
      ...STELLAR_CONFIG,
      gracePeriodActive: true,
    };
    const result = checkClockSkew(messageTs, NOW_MS, configWithGrace);
    expect(result.status).toBe('WITHIN_TOLERANCE');
    expect(result.accepted).toBe(true);
    expect(result.gracePeriodApplied).toBe(true);
    expect(result.effectiveToleranceMs).toBe(60_000);
  });

  it('still rejects a message that exceeds the grace-extended tolerance', () => {
    // 70 000 ms old — exceeds 30+30=60 000 ms grace tolerance
    const messageTs = NOW_MS - 70_000;
    const configWithGrace: ClockSkewConfig = {
      ...STELLAR_CONFIG,
      gracePeriodActive: true,
    };
    const result = checkClockSkew(messageTs, NOW_MS, configWithGrace);
    expect(result.status).toBe('CLOCK_SKEW_EXCEEDED');
    expect(result.accepted).toBe(false);
  });

  it('uses gracePeriodMs of 0 when not set (no extra tolerance)', () => {
    const configNoGrace: ClockSkewConfig = {
      chainId: 'test',
      toleranceMs: 30_000,
      gracePeriodActive: true,
      // gracePeriodMs not set → defaults to 0
    };
    const messageTs = NOW_MS - 40_000;
    const result = checkClockSkew(messageTs, NOW_MS, configNoGrace);
    expect(result.status).toBe('CLOCK_SKEW_EXCEEDED');
  });
});

// ---------------------------------------------------------------------------
// ClockSkewChecker class
// ---------------------------------------------------------------------------
describe('ClockSkewChecker', () => {
  function makeChecker(fixedNow = NOW_MS): ClockSkewChecker {
    return new ClockSkewChecker(() => fixedNow);
  }

  it('throws when checking an unregistered chain', () => {
    const checker = makeChecker();
    expect(() => checker.check(NOW_MS, 'unknown-chain')).toThrow(
      /No clock skew config registered/,
    );
  });

  it('returns WITHIN_TOLERANCE for a fresh message after registration', () => {
    const checker = makeChecker();
    checker.register(STELLAR_CONFIG);
    const result = checker.check(NOW_MS - 5_000, 'stellar');
    expect(result.status).toBe('WITHIN_TOLERANCE');
    expect(result.accepted).toBe(true);
  });

  it('returns CLOCK_SKEW_EXCEEDED for a stale message', () => {
    const checker = makeChecker();
    checker.register(STELLAR_CONFIG);
    const result = checker.check(NOW_MS - 60_000, 'stellar');
    expect(result.status).toBe('CLOCK_SKEW_EXCEEDED');
  });

  it('chain lookup is case-insensitive', () => {
    const checker = makeChecker();
    checker.register(STELLAR_CONFIG); // registered as 'stellar'
    const result = checker.check(NOW_MS, 'STELLAR');
    expect(result.status).toBe('WITHIN_TOLERANCE');
  });

  it('getConfig returns a copy of the registered config', () => {
    const checker = makeChecker();
    checker.register(STELLAR_CONFIG);
    const cfg = checker.getConfig('stellar');
    expect(cfg?.toleranceMs).toBe(30_000);
    // Mutating the returned copy does not affect the internal state
    cfg!.toleranceMs = 1;
    expect(checker.getConfig('stellar')?.toleranceMs).toBe(30_000);
  });

  it('getConfig returns undefined for an unregistered chain', () => {
    const checker = makeChecker();
    expect(checker.getConfig('polygon')).toBeUndefined();
  });

  it('setGracePeriod activates grace for a registered chain', () => {
    const checker = makeChecker();
    checker.register(STELLAR_CONFIG);
    checker.setGracePeriod('stellar', true);
    // 50 000 ms old — exceeds 30 000 tolerance but within 60 000 with grace
    const result = checker.check(NOW_MS - 50_000, 'stellar');
    expect(result.status).toBe('WITHIN_TOLERANCE');
    expect(result.gracePeriodApplied).toBe(true);
  });

  it('setGracePeriod deactivates grace', () => {
    const checker = makeChecker();
    checker.register({ ...STELLAR_CONFIG, gracePeriodActive: true });
    checker.setGracePeriod('stellar', false);
    // 50 000 ms old — now exceeds tolerance again
    const result = checker.check(NOW_MS - 50_000, 'stellar');
    expect(result.status).toBe('CLOCK_SKEW_EXCEEDED');
  });

  it('setGracePeriod throws for an unregistered chain', () => {
    const checker = makeChecker();
    expect(() => checker.setGracePeriod('nothere', true)).toThrow(
      /No clock skew config registered/,
    );
  });

  it('register validates the config and throws on invalid input', () => {
    const checker = makeChecker();
    expect(() =>
      checker.register({ chainId: 'bad', toleranceMs: -1 }),
    ).toThrow(InvalidClockSkewConfigError);
  });

  it('multiple chains are independent', () => {
    const checker = makeChecker();
    checker.register(STELLAR_CONFIG);   // 30 000 ms tolerance
    checker.register(ETH_CONFIG);       // 60 000 ms tolerance

    // 50 000 ms old — rejected by Stellar, accepted by Ethereum
    const stellarResult = checker.check(NOW_MS - 50_000, 'stellar');
    const ethResult     = checker.check(NOW_MS - 50_000, 'ethereum');

    expect(stellarResult.status).toBe('CLOCK_SKEW_EXCEEDED');
    expect(ethResult.status).toBe('WITHIN_TOLERANCE');
  });

  it('uses the injected clock correctly', () => {
    let fakeNow = NOW_MS;
    const checker = new ClockSkewChecker(() => fakeNow);
    checker.register(STELLAR_CONFIG);

    const messageTs = NOW_MS - 20_000; // 20s old at NOW_MS → accepted
    expect(checker.check(messageTs, 'stellar').status).toBe('WITHIN_TOLERANCE');

    // Advance clock 20 000 ms → total age 40 000 ms → rejected
    fakeNow = NOW_MS + 20_000;
    expect(checker.check(messageTs, 'stellar').status).toBe('CLOCK_SKEW_EXCEEDED');
  });
});

// ---------------------------------------------------------------------------
// createDefaultClockSkewChecker
// ---------------------------------------------------------------------------
describe('createDefaultClockSkewChecker', () => {
  it('registers stellar with 30 000 ms tolerance', () => {
    const checker = createDefaultClockSkewChecker(() => NOW_MS);
    expect(checker.getConfig('stellar')?.toleranceMs).toBe(30_000);
  });

  it('registers ethereum with 60 000 ms tolerance', () => {
    const checker = createDefaultClockSkewChecker(() => NOW_MS);
    expect(checker.getConfig('ethereum')?.toleranceMs).toBe(60_000);
  });

  it('registers arbitrum with 120 000 ms tolerance', () => {
    const checker = createDefaultClockSkewChecker(() => NOW_MS);
    expect(checker.getConfig('arbitrum')?.toleranceMs).toBe(120_000);
  });

  it('accepts a fresh Stellar message', () => {
    const checker = createDefaultClockSkewChecker(() => NOW_MS);
    const result = checker.check(NOW_MS - 1_000, 'stellar');
    expect(result.accepted).toBe(true);
  });

  it('rejects a stale Stellar message (35 s old, tolerance 30 s)', () => {
    const checker = createDefaultClockSkewChecker(() => NOW_MS);
    const result = checker.check(NOW_MS - 35_000, 'stellar');
    expect(result.accepted).toBe(false);
    expect(result.status).toBe('CLOCK_SKEW_EXCEEDED');
  });
});

// ---------------------------------------------------------------------------
// Boundary conditions
// ---------------------------------------------------------------------------
describe('boundary conditions', () => {
  it('accepts a message timestamp equal to localNowMs (zero skew)', () => {
    const result = checkClockSkew(NOW_MS, NOW_MS, STELLAR_CONFIG);
    expect(result.status).toBe('WITHIN_TOLERANCE');
  });

  it('handles very large timestamps without overflow', () => {
    const farFuture = Number.MAX_SAFE_INTEGER;
    // Should return MESSAGE_FROM_FUTURE, not throw
    const result = checkClockSkew(farFuture, NOW_MS, STELLAR_CONFIG);
    expect(result.status).toBe('MESSAGE_FROM_FUTURE');
  });

  it('handles message timestamp of 1 (very old) without throwing', () => {
    const result = checkClockSkew(1, NOW_MS, STELLAR_CONFIG);
    expect(result.status).toBe('CLOCK_SKEW_EXCEEDED');
    expect(result.accepted).toBe(false);
  });
});
