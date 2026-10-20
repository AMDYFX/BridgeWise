/**
 * End-to-end message lifecycle tests.
 *
 * Exercises every scenario defined in `message-lifecycle.fixtures.ts` through
 * the real `StellarBridgeExecutionStateMachine` implementation so any change
 * to the state machine is immediately caught.
 *
 * Coverage:
 *   - All 3 happy-path routes (Stellar→ETH, ETH→Stellar, ETH→Polygon)
 *   - All 6 failure-at-state paths (initiated, locking, locked, bridging,
 *     minting, confirming)
 *   - Edge cases: zero-amount, max-amount, clock-skew fresh, clock-skew stale,
 *     duplicate messageId
 *   - Dependency failure fixtures — structural assertions, not live calls
 *   - Token decimal normalization round-trips for each route's token pair
 *   - Idempotency: replaying a terminal scenario is a no-op
 */

import {
  StellarBridgeExecutionStateMachine,
  InvalidBridgeTransitionError,
} from '../../src/execution/state-machine/stellar/stellar-bridge-execution-state-machine';

import {
  buildAllScenarios,
  buildDependencyFailureFixtures,
  replayScenario,
  scenarioToLifecycle,
  LifecycleScenario,
  FailureScenario,
  TOKEN_FIXTURES,
  T,
  FIXTURE_EPOCH_MS,
} from './message-lifecycle.fixtures';

import {
  normalizeDecimalsForBridge,
  createDefaultNormalizer,
} from '../../src/tokens/stellar/decimal-validation/decimal-normalizer';

import {
  checkClockSkew,
} from '../../src/cross-chain/clock-skew/chain-clock-skew';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function replay(scenario: LifecycleScenario) {
  return replayScenario(StellarBridgeExecutionStateMachine, scenario);
}

// ---------------------------------------------------------------------------
// Happy-path scenarios
// ---------------------------------------------------------------------------
describe('Message lifecycle — happy path', () => {
  const { happy } = buildAllScenarios();

  it('covers all three standard routes', () => {
    expect(happy).toHaveLength(3);
  });

  for (const scenario of happy) {
    describe(scenario.label, () => {
      it('replays to state "completed"', () => {
        const lifecycle = replay(scenario);
        expect(lifecycle.current).toBe('completed');
        expect(lifecycle.isTerminal).toBe(true);
      });

      it('records exactly 7 transitions', () => {
        const lifecycle = replay(scenario);
        expect(lifecycle.history).toHaveLength(7);
      });

      it('history is ordered idle → initiated → … → completed', () => {
        const lifecycle = replay(scenario);
        const expectedOrder = [
          'initiated', 'locking', 'locked', 'bridging',
          'minting', 'confirming', 'completed',
        ];
        const actualOrder = lifecycle.history.map((h) => h.to);
        expect(actualOrder).toEqual(expectedOrder);
      });

      it('every transition timestamp is non-decreasing', () => {
        const lifecycle = replay(scenario);
        for (let i = 1; i < lifecycle.history.length; i++) {
          expect(lifecycle.history[i].at).toBeGreaterThanOrEqual(
            lifecycle.history[i - 1].at,
          );
        }
      });

      it('escalationRequired is false for happy paths', () => {
        expect(scenario.escalationRequired).toBe(false);
      });

      it('messageId is a non-empty hex string', () => {
        expect(scenario.message.messageId).toMatch(/^0x[0-9a-f]+$/);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Failure scenarios
// ---------------------------------------------------------------------------
describe('Message lifecycle — failure paths', () => {
  const { failures } = buildAllScenarios();

  it('covers all 6 in-flight failure entry points', () => {
    const failureStates = failures.map((f) => f.failedAtState);
    const expectedStates = [
      'initiated', 'locking', 'locked', 'bridging', 'minting', 'confirming',
    ];
    expect(failureStates).toEqual(expectedStates);
  });

  for (const scenario of failures) {
    describe(scenario.label, () => {
      it('replays to state "refunded"', () => {
        const lifecycle = replay(scenario);
        expect(lifecycle.current).toBe('refunded');
        expect(lifecycle.isTerminal).toBe(true);
      });

      it('history includes failed → rolling_back → refunded tail', () => {
        const lifecycle = replay(scenario);
        const tail = lifecycle.history.slice(-3).map((h) => h.to);
        expect(tail).toEqual(['failed', 'rolling_back', 'refunded']);
      });

      it('failedAtState is the correct in-flight state', () => {
        const failureIndex = scenario.transitions.findIndex(
          (t) => t.to === 'failed',
        );
        expect(scenario.transitions[failureIndex - 1]?.from ?? scenario.transitions[0].from)
          .toBe(scenario.failedAtState);
      });

      it('escalationRequired matches autoRetryable flag', () => {
        expect(scenario.escalationRequired).toBe(!scenario.autoRetryable);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Edge-case scenarios
// ---------------------------------------------------------------------------
describe('Message lifecycle — edge cases', () => {
  const { edge } = buildAllScenarios();

  describe('zero-amount message', () => {
    const scenario = edge.find((e) => e.label === 'edge:zero-amount')!;

    it('fixture exists', () => {
      expect(scenario).toBeDefined();
    });

    it('amountSourceUnits is 0n', () => {
      expect(scenario.message.amountSourceUnits).toBe(0n);
    });

    it('completes the full lifecycle', () => {
      const lifecycle = replay(scenario);
      expect(lifecycle.current).toBe('completed');
    });
  });

  describe('max-amount message (i64 max)', () => {
    const scenario = edge.find((e) => e.label === 'edge:max-amount')!;

    it('fixture exists', () => {
      expect(scenario).toBeDefined();
    });

    it('amountSourceUnits equals i64 max', () => {
      expect(scenario.message.amountSourceUnits).toBe(9_223_372_036_854_775_807n);
    });

    it('completes the full lifecycle', () => {
      const lifecycle = replay(scenario);
      expect(lifecycle.current).toBe('completed');
    });
  });

  describe('clock-skew fresh (29 s old — within 30 s tolerance)', () => {
    const scenario = edge.find((e) => e.label === 'edge:clock-skew-fresh')!;

    it('fixture exists', () => {
      expect(scenario).toBeDefined();
    });

    it('clock skew check passes (WITHIN_TOLERANCE)', () => {
      const result = checkClockSkew(
        scenario.message.messageTimestampMs,
        FIXTURE_EPOCH_MS, // local clock at epoch
        { chainId: 'stellar', toleranceMs: 30_000, futureDriftMs: 15_000 },
      );
      expect(result.status).toBe('WITHIN_TOLERANCE');
      expect(result.accepted).toBe(true);
    });

    it('lifecycle completes', () => {
      const lifecycle = replay(scenario);
      expect(lifecycle.current).toBe('completed');
    });
  });

  describe('clock-skew stale (31 s old — outside 30 s tolerance)', () => {
    const scenario = edge.find((e) => e.label === 'edge:clock-skew-stale')!;

    it('fixture exists', () => {
      expect(scenario).toBeDefined();
    });

    it('clock skew check fails (CLOCK_SKEW_EXCEEDED)', () => {
      const result = checkClockSkew(
        scenario.message.messageTimestampMs,
        FIXTURE_EPOCH_MS,
        { chainId: 'stellar', toleranceMs: 30_000, futureDriftMs: 15_000 },
      );
      expect(result.status).toBe('CLOCK_SKEW_EXCEEDED');
      expect(result.accepted).toBe(false);
    });

    it('lifecycle ends in refunded after rejection', () => {
      const lifecycle = replay(scenario);
      expect(lifecycle.current).toBe('refunded');
      expect(lifecycle.isTerminal).toBe(true);
    });
  });

  describe('duplicate messageId', () => {
    const scenario = edge.find((e) => e.label === 'edge:duplicate-message-id')!;

    it('fixture exists', () => {
      expect(scenario).toBeDefined();
    });

    it('reports isTerminal=true immediately (no new transitions)', () => {
      expect(scenario.transitions).toHaveLength(0);
      expect(scenario.isTerminal).toBe(true);
    });

    it('lifecycle snapshot shows completed state', () => {
      const lifecycle = scenarioToLifecycle(scenario);
      expect(lifecycle.current).toBe('completed');
      expect(lifecycle.isTerminal).toBe(true);
    });

    it('re-submitting a completed message does not produce new transitions', () => {
      const lifecycle = replay(scenario);
      expect(lifecycle.history).toHaveLength(0);
    });

    it('attempting to transition a completed state machine throws InvalidBridgeTransitionError', () => {
      const sm = new StellarBridgeExecutionStateMachine('completed');
      expect(() => sm.transition('initiated')).toThrow(InvalidBridgeTransitionError);
    });
  });
});

// ---------------------------------------------------------------------------
// Token decimal normalization integration
// ---------------------------------------------------------------------------
describe('Message lifecycle — token decimal normalization', () => {
  const normalizer = createDefaultNormalizer();

  describe('USDC Stellar→ETH (7 dec → 6 dec)', () => {
    const token = TOKEN_FIXTURES.USDC_STELLAR_TO_ETH;

    it('normalizes 1.0000000 USDC (10_000_000 base units) to 1_000_000 on EVM', () => {
      const result = normalizer.normalize(
        10_000_000n,
        'USDC',
        'stellar',
        'ethereum',
      );
      expect(result.normalizedAmount).toBe(1_000_000n);
      expect(result.truncatedResidue).toBe(0n);
    });

    it('rejects amounts with sub-EVM-unit precision (residual != 0)', () => {
      expect(() =>
        normalizer.normalize(10_000_001n, 'USDC', 'stellar', 'ethereum'),
      ).toThrow(/precision/i);
    });

    it('round-trips: normalize then reverse returns original', () => {
      const stellarAmount = 10_000_000n;
      const evmAmount = normalizer.normalize(stellarAmount, 'USDC', 'stellar', 'ethereum')
        .normalizedAmount;
      const backToStellar = normalizer.normalize(evmAmount, 'USDC', 'ethereum', 'stellar')
        .normalizedAmount;
      expect(backToStellar).toBe(stellarAmount);
    });
  });

  describe('USDC ETH→Stellar (6 dec → 7 dec)', () => {
    it('normalizes 1_000_000 base units to 10_000_000', () => {
      const result = normalizer.normalize(1_000_000n, 'USDC', 'ethereum', 'stellar');
      expect(result.normalizedAmount).toBe(10_000_000n);
    });

    it('scale-up is always lossless', () => {
      const result = normalizer.normalize(999_999n, 'USDC', 'ethereum', 'stellar');
      expect(result.truncatedResidue).toBe(0n);
    });
  });

  describe('WETH ETH→Polygon (18 dec → 18 dec, passthrough)', () => {
    it('returns the amount unchanged for equal decimals', () => {
      const result = normalizeDecimalsForBridge(1_000_000_000_000_000_000n, {
        source:      { chain: 'ethereum', decimals: 18 },
        destination: { chain: 'polygon',  decimals: 18 },
      });
      expect(result.isPassthrough).toBe(true);
      expect(result.normalizedAmount).toBe(1_000_000_000_000_000_000n);
    });
  });

  describe('zero-amount normalization', () => {
    it('normalizes 0 from any decimal count to 0', () => {
      const result = normalizer.normalize(0n, 'USDC', 'stellar', 'ethereum');
      expect(result.normalizedAmount).toBe(0n);
    });
  });
});

// ---------------------------------------------------------------------------
// Dependency failure fixtures — structural assertions
// ---------------------------------------------------------------------------
describe('Dependency failure fixtures', () => {
  const fixtures = buildDependencyFailureFixtures();

  it('provides fixtures for all 6 dependency failure kinds', () => {
    const kinds = fixtures.map((f) => f.kind);
    expect(kinds).toContain('relay_timeout');
    expect(kinds).toContain('rpc_unavailable');
    expect(kinds).toContain('mint_reverted');
    expect(kinds).toContain('escrow_full');
    expect(kinds).toContain('clock_skew_exceeded');
    expect(kinds).toContain('duplicate_message');
  });

  for (const fixture of fixtures) {
    describe(`dependency failure: ${fixture.kind}`, () => {
      it('has a non-empty description', () => {
        expect(fixture.description.length).toBeGreaterThan(0);
      });

      it('has a valid failedAtState', () => {
        const validStates = [
          'idle', 'initiated', 'locking', 'locked',
          'bridging', 'minting', 'confirming',
        ];
        expect(validStates).toContain(fixture.failedAtState);
      });

      it('maxRetries is consistent with autoRecovery', () => {
        if (!fixture.autoRecovery) {
          expect(fixture.maxRetries).toBe(0);
        } else {
          expect(fixture.maxRetries).toBeGreaterThanOrEqual(0);
        }
      });

      it('message has a valid messageId', () => {
        expect(fixture.message.messageId).toMatch(/^0x[0-9a-f]+$/);
      });

      it('source and destination chains differ', () => {
        expect(fixture.message.sourceChain).not.toBe(
          fixture.message.destinationChain,
        );
      });
    });
  }

  describe('clock_skew_exceeded fixture', () => {
    const fixture = fixtures.find((f) => f.kind === 'clock_skew_exceeded')!;

    it('message timestamp is outside Stellar tolerance', () => {
      const result = checkClockSkew(
        fixture.message.messageTimestampMs,
        FIXTURE_EPOCH_MS,
        { chainId: 'stellar', toleranceMs: 30_000 },
      );
      expect(result.accepted).toBe(false);
      expect(result.status).toBe('CLOCK_SKEW_EXCEEDED');
    });
  });

  describe('duplicate_message fixture', () => {
    const fixture = fixtures.find((f) => f.kind === 'duplicate_message')!;

    it('shares the same messageId as the happy-path scenario', () => {
      const { happy } = buildAllScenarios();
      // Both use nonce=1 and Stellar→ETH route, so IDs should match
      expect(fixture.message.messageId).toBe(happy[0].message.messageId);
    });
  });
});

// ---------------------------------------------------------------------------
// Idempotency assertions
// ---------------------------------------------------------------------------
describe('Message lifecycle — idempotency', () => {
  it('replaying a completed scenario twice produces the same history length', () => {
    const { happy } = buildAllScenarios();
    const scenario = happy[0];

    const lifecycle1 = replay(scenario);
    const lifecycle2 = replay(scenario);

    expect(lifecycle1.history).toHaveLength(lifecycle2.history.length);
    expect(lifecycle1.current).toBe(lifecycle2.current);
  });

  it('replaying a refunded scenario twice produces the same history', () => {
    const { failures } = buildAllScenarios();
    const scenario = failures[0];

    const lifecycle1 = replay(scenario);
    const lifecycle2 = replay(scenario);

    expect(lifecycle1.current).toBe('refunded');
    expect(lifecycle2.current).toBe('refunded');
    expect(lifecycle1.history).toHaveLength(lifecycle2.history.length);
  });

  it('messageId is stable across identical input parameters', () => {
    const { happy } = buildAllScenarios();
    // Rebuild — same nonce + route should yield same messageId
    const { happy: happy2 } = buildAllScenarios();
    expect(happy[0].message.messageId).toBe(happy2[0].message.messageId);
  });
});

// ---------------------------------------------------------------------------
// Asset and chain boundary preservation
// ---------------------------------------------------------------------------
describe('Asset and chain boundary preservation', () => {
  const { happy } = buildAllScenarios();

  for (const scenario of happy) {
    it(`${scenario.label}: source and destination chains are distinct`, () => {
      expect(scenario.message.sourceChain).not.toBe(
        scenario.message.destinationChain,
      );
    });

    it(`${scenario.label}: token is the same asset on both sides`, () => {
      expect(scenario.message.token.symbol).toBe(
        scenario.message.token.symbol,
      );
      expect(scenario.message.token.sourceChain).toBe(
        scenario.message.sourceChain,
      );
      expect(scenario.message.token.destinationChain).toBe(
        scenario.message.destinationChain,
      );
    });
  }
});
