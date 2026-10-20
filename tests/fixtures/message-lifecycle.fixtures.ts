/**
 * End-to-end message lifecycle fixtures for BridgeWise.
 *
 * This module provides deterministic, reusable fixtures that represent every
 * meaningful stage of a cross-chain message's lifecycle — from source-chain
 * lock through cross-chain relay to destination-chain mint/release, plus all
 * failure and recovery paths.
 *
 * # Design principles
 *
 * 1. DETERMINISTIC — All timestamps are anchored to a fixed epoch so test
 *    output is reproducible regardless of when the test runs.
 *
 * 2. COMPOSABLE — Each fixture is a plain data object. Builder functions
 *    produce complete scenarios by composing them. Tests pick the scenario
 *    they need without duplicating setup.
 *
 * 3. BOUNDARY-COVERING — The fixture set explicitly covers:
 *    - Success path (all 8 happy-path states)
 *    - Failure at each in-flight state (6 failure entry points)
 *    - Rollback and refund recovery
 *    - Zero-amount edge case
 *    - Maximum-amount edge case
 *    - Clock skew edge case (message timestamp near tolerance boundary)
 *    - Duplicate message ID (idempotency)
 *    - Simulated dependency failures (relay timeout, mint revert)
 *
 * 4. CHAIN-BOUNDARY PRESERVING — Each fixture records the source and
 *    destination chain so tests can verify that assets never cross chain
 *    boundaries unless explicitly modelled.
 *
 * # Idempotency expectations
 *
 * Message IDs are deterministic: `keccak256(sourceChain + destChain + sender
 * + nonce)`. The same (sourceChain, destChain, sender, nonce) tuple always
 * produces the same messageId. Fixtures model the full idempotency surface:
 * submitting a messageId that is already in a terminal state must be a no-op.
 *
 * # Operator escalation paths
 *
 * Each `FailureFixture` carries an `escalationRequired` flag and a `reason`
 * string. Tests verify that:
 *   - `escalationRequired: true` fixtures emit the correct error code.
 *   - `escalationRequired: false` fixtures are safe to auto-retry.
 */

import {
  BridgeExecutionState,
  BridgeExecutionLifecycle,
  BridgeTransitionRecord,
} from '../../src/execution/types/bridge-execution-state-machine.types';

// ---------------------------------------------------------------------------
// Fixed epoch — all timestamps relative to this value
// ---------------------------------------------------------------------------

export const FIXTURE_EPOCH_MS = 1_700_000_000_000;

// Time helpers (all in milliseconds)
export const T = {
  epoch:      FIXTURE_EPOCH_MS,
  plus1s:     FIXTURE_EPOCH_MS + 1_000,
  plus5s:     FIXTURE_EPOCH_MS + 5_000,
  plus10s:    FIXTURE_EPOCH_MS + 10_000,
  plus30s:    FIXTURE_EPOCH_MS + 30_000,
  plus60s:    FIXTURE_EPOCH_MS + 60_000,
  plus90s:    FIXTURE_EPOCH_MS + 90_000,
  plus120s:   FIXTURE_EPOCH_MS + 120_000,
  plus300s:   FIXTURE_EPOCH_MS + 300_000,
  minus31s:   FIXTURE_EPOCH_MS - 31_000,  // just outside Stellar 30 s tolerance
  minus29s:   FIXTURE_EPOCH_MS - 29_000,  // just inside Stellar 30 s tolerance
};

// ---------------------------------------------------------------------------
// Chain identifiers
// ---------------------------------------------------------------------------

export type FixtureChain = 'stellar' | 'ethereum' | 'polygon' | 'arbitrum' | 'soroban';

export const CHAINS: Record<string, FixtureChain> = {
  STELLAR:  'stellar',
  ETH:      'ethereum',
  POLYGON:  'polygon',
  ARBITRUM: 'arbitrum',
  SOROBAN:  'soroban',
};

// ---------------------------------------------------------------------------
// Token fixtures
// ---------------------------------------------------------------------------

export interface TokenFixture {
  symbol: string;
  decimalsOnSource: number;
  decimalsOnDestination: number;
  sourceChain: FixtureChain;
  destinationChain: FixtureChain;
}

export const TOKEN_FIXTURES: Record<string, TokenFixture> = {
  USDC_STELLAR_TO_ETH: {
    symbol: 'USDC',
    decimalsOnSource:      7,   // Stellar classic asset
    decimalsOnDestination: 6,   // EVM USDC
    sourceChain:      'stellar',
    destinationChain: 'ethereum',
  },
  USDC_ETH_TO_STELLAR: {
    symbol: 'USDC',
    decimalsOnSource:      6,
    decimalsOnDestination: 7,
    sourceChain:      'ethereum',
    destinationChain: 'stellar',
  },
  WETH_ETH_TO_POLYGON: {
    symbol: 'WETH',
    decimalsOnSource:      18,
    decimalsOnDestination: 18,
    sourceChain:      'ethereum',
    destinationChain: 'polygon',
  },
  XLM_STELLAR_TO_ETH: {
    symbol: 'XLM',
    decimalsOnSource:      7,
    decimalsOnDestination: 18,  // wrapped XLM on EVM uses 18 dec
    sourceChain:      'stellar',
    destinationChain: 'ethereum',
  },
};

// ---------------------------------------------------------------------------
// Message fixture types
// ---------------------------------------------------------------------------

/**
 * Core message envelope — mirrors the BridgeWise on-chain message struct.
 */
export interface MessageFixture {
  messageId:           string;
  sourceChain:         FixtureChain;
  destinationChain:    FixtureChain;
  sender:              string;
  recipient:           string;
  token:               TokenFixture;
  /** Amount in source-chain base units. */
  amountSourceUnits:   bigint;
  nonce:               number;
  /** Unix epoch in milliseconds (used for clock skew checks). */
  messageTimestampMs:  number;
}

/**
 * A complete lifecycle scenario: the message plus the ordered sequence of
 * state transitions that define how this message moves through the system.
 */
export interface LifecycleScenario {
  label:       string;
  message:     MessageFixture;
  transitions: BridgeTransitionRecord[];
  finalState:  BridgeExecutionState;
  isTerminal:  boolean;
  /** Whether operator intervention is required to resolve this scenario. */
  escalationRequired: boolean;
  /** Human-readable description for test output. */
  description: string;
}

/**
 * A failure scenario includes the failure reason and the expected error code
 * that the system should surface.
 */
export interface FailureScenario extends LifecycleScenario {
  failureReason:  string;
  /** Whether the failure is safe to auto-retry (false = manual escalation). */
  autoRetryable:  boolean;
  /** State at which the failure occurred. */
  failedAtState:  BridgeExecutionState;
}

// ---------------------------------------------------------------------------
// Address constants (deterministic test addresses)
// ---------------------------------------------------------------------------

export const ADDRESSES = {
  // Stellar G-addresses (mock)
  SENDER_STELLAR:    'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
  RECIPIENT_STELLAR: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  // EVM addresses
  SENDER_EVM:        '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  RECIPIENT_EVM:     '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
};

// ---------------------------------------------------------------------------
// Message ID derivation (deterministic, no crypto dependency)
// ---------------------------------------------------------------------------

function makeMessageId(
  sourceChain: string,
  destChain: string,
  sender: string,
  nonce: number,
): string {
  // Deterministic hex string — mirrors keccak256(abi.encode(...)) semantics
  // without requiring a crypto library in the fixture file itself.
  const raw = `${sourceChain}:${destChain}:${sender}:${nonce}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = (Math.imul(31, hash) + raw.charCodeAt(i)) | 0;
  }
  return '0x' + Math.abs(hash).toString(16).padStart(64, '0');
}

// ---------------------------------------------------------------------------
// Transition record builders
// ---------------------------------------------------------------------------

function tr(
  from: BridgeExecutionState,
  to: BridgeExecutionState,
  atMs: number,
): BridgeTransitionRecord {
  return { from, to, at: atMs };
}

// ---------------------------------------------------------------------------
// Scenario builders
// ---------------------------------------------------------------------------

/**
 * Build a base `MessageFixture` from named parameters.
 */
export function buildMessage(overrides: Partial<MessageFixture> & {
  sourceChain: FixtureChain;
  destinationChain: FixtureChain;
  token: TokenFixture;
}): MessageFixture {
  const {
    sourceChain,
    destinationChain,
    token,
    sender        = ADDRESSES.SENDER_EVM,
    recipient     = ADDRESSES.RECIPIENT_EVM,
    amountSourceUnits = 10_000_000n,   // 1.0000000 (7-decimal token)
    nonce         = 1,
    messageTimestampMs = T.epoch,
    ...rest
  } = overrides;

  return {
    messageId: makeMessageId(sourceChain, destinationChain, sender, nonce),
    sourceChain,
    destinationChain,
    sender,
    recipient,
    token,
    amountSourceUnits,
    nonce,
    messageTimestampMs,
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// Happy-path scenarios
// ---------------------------------------------------------------------------

/**
 * Build the full 7-transition happy-path lifecycle for a message.
 */
export function happyPathScenario(message: MessageFixture): LifecycleScenario {
  return {
    label: `happy-path:${message.sourceChain}->${message.destinationChain}`,
    message,
    transitions: [
      tr('idle',      'initiated',  T.epoch),
      tr('initiated', 'locking',    T.plus1s),
      tr('locking',   'locked',     T.plus5s),
      tr('locked',    'bridging',   T.plus10s),
      tr('bridging',  'minting',    T.plus30s),
      tr('minting',   'confirming', T.plus60s),
      tr('confirming','completed',  T.plus90s),
    ],
    finalState: 'completed',
    isTerminal: true,
    escalationRequired: false,
    description:
      `Message ${message.messageId} from ${message.sourceChain} to ` +
      `${message.destinationChain} completes the full happy path.`,
  };
}

// ---------------------------------------------------------------------------
// Failure scenarios — one per in-flight state
// ---------------------------------------------------------------------------

function failureScenario(
  message: MessageFixture,
  failedAt: BridgeExecutionState,
  leadingTransitions: BridgeTransitionRecord[],
  reason: string,
  autoRetryable: boolean,
): FailureScenario {
  return {
    label: `failure-at-${failedAt}:${message.sourceChain}->${message.destinationChain}`,
    message,
    transitions: [
      ...leadingTransitions,
      tr(failedAt,       'failed',       T.plus60s),
      tr('failed',       'rolling_back', T.plus90s),
      tr('rolling_back', 'refunded',     T.plus120s),
    ],
    finalState: 'refunded',
    isTerminal: true,
    escalationRequired: !autoRetryable,
    failureReason: reason,
    autoRetryable,
    failedAtState: failedAt,
    description:
      `Message ${message.messageId} fails at "${failedAt}" ` +
      `(autoRetryable=${autoRetryable}): ${reason}`,
  };
}

// ---------------------------------------------------------------------------
// All standard fixture scenarios
// ---------------------------------------------------------------------------

/** Complete catalogue of message lifecycle scenarios. */
export function buildAllScenarios(): {
  happy:    LifecycleScenario[];
  failures: FailureScenario[];
  edge:     LifecycleScenario[];
} {
  // Base messages for each common route
  const msgStellarToEth = buildMessage({
    sourceChain:      'stellar',
    destinationChain: 'ethereum',
    token:            TOKEN_FIXTURES.USDC_STELLAR_TO_ETH,
    amountSourceUnits: 10_000_000n, // 1.0000000 USDC
    nonce: 1,
  });

  const msgEthToStellar = buildMessage({
    sourceChain:      'ethereum',
    destinationChain: 'stellar',
    token:            TOKEN_FIXTURES.USDC_ETH_TO_STELLAR,
    amountSourceUnits: 1_000_000n,  // 1.000000 USDC (6 dec)
    nonce: 2,
  });

  const msgEthToPoly = buildMessage({
    sourceChain:      'ethereum',
    destinationChain: 'polygon',
    token:            TOKEN_FIXTURES.WETH_ETH_TO_POLYGON,
    amountSourceUnits: 1_000_000_000_000_000_000n, // 1 WETH (18 dec)
    nonce: 3,
  });

  // ── Happy paths ──────────────────────────────────────────────────
  const happy: LifecycleScenario[] = [
    happyPathScenario(msgStellarToEth),
    happyPathScenario(msgEthToStellar),
    happyPathScenario(msgEthToPoly),
  ];

  // ── Failure paths (one per in-flight state) ──────────────────────
  const failures: FailureScenario[] = [
    failureScenario(
      buildMessage({ ...msgStellarToEth, nonce: 10 }),
      'initiated',
      [tr('idle', 'initiated', T.epoch)],
      'Signer rejected the lock transaction',
      true,
    ),
    failureScenario(
      buildMessage({ ...msgStellarToEth, nonce: 11 }),
      'locking',
      [
        tr('idle',      'initiated', T.epoch),
        tr('initiated', 'locking',   T.plus1s),
      ],
      'Source-chain lock transaction reverted (insufficient balance)',
      false,
    ),
    failureScenario(
      buildMessage({ ...msgStellarToEth, nonce: 12 }),
      'locked',
      [
        tr('idle',      'initiated', T.epoch),
        tr('initiated', 'locking',   T.plus1s),
        tr('locking',   'locked',    T.plus5s),
      ],
      'Relay timeout: message not picked up within deadline',
      true,
    ),
    failureScenario(
      buildMessage({ ...msgStellarToEth, nonce: 13 }),
      'bridging',
      [
        tr('idle',      'initiated', T.epoch),
        tr('initiated', 'locking',   T.plus1s),
        tr('locking',   'locked',    T.plus5s),
        tr('locked',    'bridging',  T.plus10s),
      ],
      'Cross-chain message relay failed: RPC node returned 5xx',
      true,
    ),
    failureScenario(
      buildMessage({ ...msgStellarToEth, nonce: 14 }),
      'minting',
      [
        tr('idle',      'initiated',  T.epoch),
        tr('initiated', 'locking',    T.plus1s),
        tr('locking',   'locked',     T.plus5s),
        tr('locked',    'bridging',   T.plus10s),
        tr('bridging',  'minting',    T.plus30s),
      ],
      'Destination-chain mint reverted: vault at capacity',
      false,
    ),
    failureScenario(
      buildMessage({ ...msgStellarToEth, nonce: 15 }),
      'confirming',
      [
        tr('idle',      'initiated',  T.epoch),
        tr('initiated', 'locking',    T.plus1s),
        tr('locking',   'locked',     T.plus5s),
        tr('locked',    'bridging',   T.plus10s),
        tr('bridging',  'minting',    T.plus30s),
        tr('minting',   'confirming', T.plus60s),
      ],
      'Finality check timed out: destination chain reorg suspected',
      false,
    ),
  ];

  // ── Edge-case scenarios ──────────────────────────────────────────

  // Zero-amount message
  const zeroAmountMsg = buildMessage({
    sourceChain:      'stellar',
    destinationChain: 'ethereum',
    token:            TOKEN_FIXTURES.USDC_STELLAR_TO_ETH,
    amountSourceUnits: 0n,
    nonce: 20,
  });

  // Maximum-amount message (i64 max in Stellar base units)
  const maxAmountMsg = buildMessage({
    sourceChain:      'stellar',
    destinationChain: 'ethereum',
    token:            TOKEN_FIXTURES.USDC_STELLAR_TO_ETH,
    amountSourceUnits: 9_223_372_036_854_775_807n, // i64 max
    nonce: 21,
  });

  // Message with timestamp just inside clock skew tolerance (fresh)
  const freshSkewMsg = buildMessage({
    sourceChain:      'stellar',
    destinationChain: 'ethereum',
    token:            TOKEN_FIXTURES.USDC_STELLAR_TO_ETH,
    messageTimestampMs: T.minus29s, // 29 s old — within 30 s Stellar tolerance
    nonce: 22,
  });

  // Message with timestamp just outside clock skew tolerance (stale)
  const staleSkewMsg = buildMessage({
    sourceChain:      'stellar',
    destinationChain: 'ethereum',
    token:            TOKEN_FIXTURES.USDC_STELLAR_TO_ETH,
    messageTimestampMs: T.minus31s, // 31 s old — outside 30 s Stellar tolerance
    nonce: 23,
  });

  // Duplicate message ID (same as msgStellarToEth nonce=1)
  const duplicateMsg: MessageFixture = {
    ...msgStellarToEth,
    // Deliberately identical to the first happy-path message
  };

  const edge: LifecycleScenario[] = [
    // Zero amount — lifecycle proceeds but escrow receives nothing
    {
      label: 'edge:zero-amount',
      message: zeroAmountMsg,
      transitions: [
        tr('idle',      'initiated',  T.epoch),
        tr('initiated', 'locking',    T.plus1s),
        tr('locking',   'locked',     T.plus5s),
        tr('locked',    'bridging',   T.plus10s),
        tr('bridging',  'minting',    T.plus30s),
        tr('minting',   'confirming', T.plus60s),
        tr('confirming','completed',  T.plus90s),
      ],
      finalState: 'completed',
      isTerminal: true,
      escalationRequired: false,
      description:
        'Zero-amount message completes lifecycle; no tokens transferred.',
    },

    // Maximum amount — lifecycle completes, overflow guard must pass
    {
      label: 'edge:max-amount',
      message: maxAmountMsg,
      transitions: [
        tr('idle',      'initiated',  T.epoch),
        tr('initiated', 'locking',    T.plus1s),
        tr('locking',   'locked',     T.plus5s),
        tr('locked',    'bridging',   T.plus10s),
        tr('bridging',  'minting',    T.plus30s),
        tr('minting',   'confirming', T.plus60s),
        tr('confirming','completed',  T.plus90s),
      ],
      finalState: 'completed',
      isTerminal: true,
      escalationRequired: false,
      description:
        'Max-amount (i64 max) message completes; normalization overflow guard holds.',
    },

    // Fresh timestamp (within tolerance) — message should proceed
    {
      label: 'edge:clock-skew-fresh',
      message: freshSkewMsg,
      transitions: [
        tr('idle',      'initiated',  T.minus29s),
        tr('initiated', 'locking',    T.minus29s + 1_000),
        tr('locking',   'locked',     T.epoch),
        tr('locked',    'bridging',   T.plus1s),
        tr('bridging',  'minting',    T.plus5s),
        tr('minting',   'confirming', T.plus10s),
        tr('confirming','completed',  T.plus30s),
      ],
      finalState: 'completed',
      isTerminal: true,
      escalationRequired: false,
      description:
        'Message timestamp 29 s old (within 30 s Stellar tolerance) proceeds normally.',
    },

    // Stale timestamp (outside tolerance) — message must be rejected before locking
    {
      label: 'edge:clock-skew-stale',
      message: staleSkewMsg,
      transitions: [
        tr('idle',     'initiated', T.minus31s),
        tr('initiated','failed',    T.epoch),
        tr('failed',   'rolling_back', T.plus1s),
        tr('rolling_back','refunded',  T.plus5s),
      ],
      finalState: 'refunded',
      isTerminal: true,
      escalationRequired: false,
      description:
        'Message timestamp 31 s old (outside 30 s Stellar tolerance) is rejected ' +
        'at the initiated → locking gate and refunded.',
    },

    // Duplicate message — terminal after first completion, second submission no-op
    {
      label: 'edge:duplicate-message-id',
      message: duplicateMsg,
      transitions: [
        // The second submission of the same messageId sees the completed state
        // and takes no new transitions — represented as an empty transition list.
      ],
      finalState: 'completed', // already completed from first submission
      isTerminal: true,
      escalationRequired: false,
      description:
        'Re-submitting a messageId that is already in state "completed" is a no-op.',
    },
  ];

  return { happy, failures, edge };
}

// ---------------------------------------------------------------------------
// Lifecycle snapshot builders — for use in unit tests
// ---------------------------------------------------------------------------

/**
 * Build a complete `BridgeExecutionLifecycle` from a `LifecycleScenario`.
 */
export function scenarioToLifecycle(
  scenario: LifecycleScenario,
): BridgeExecutionLifecycle {
  return {
    transferId:  scenario.message.messageId,
    current:     scenario.finalState,
    history:     scenario.transitions,
    isTerminal:  scenario.isTerminal,
    nextStates:  scenario.isTerminal ? [] : [],
  };
}

/**
 * Replay `scenario.transitions` through a `StellarBridgeExecutionStateMachine`
 * using a fixed clock, and return the final lifecycle snapshot.
 *
 * @param StateMachineClass  The class to instantiate (injected to avoid
 *                           circular imports in the fixture file).
 */
export function replayScenario<T extends {
  transition: (s: BridgeExecutionState) => BridgeExecutionState;
  toLifecycle: (id: string) => BridgeExecutionLifecycle;
}>(
  StateMachineClass: new (
    initial: BridgeExecutionState,
    clock: () => number,
  ) => T,
  scenario: LifecycleScenario,
): BridgeExecutionLifecycle {
  if (scenario.transitions.length === 0) {
    // Edge case: no transitions means we start already at finalState
    const sm = new StateMachineClass(scenario.finalState, () => T.epoch);
    return sm.toLifecycle(scenario.message.messageId);
  }

  const initialState = scenario.transitions[0].from;
  let idx = 0;
  const sm = new StateMachineClass(initialState, () => {
    const record = scenario.transitions[idx];
    return record ? record.at : T.epoch;
  });

  for (const record of scenario.transitions) {
    idx++;
    sm.transition(record.to);
  }

  return sm.toLifecycle(scenario.message.messageId);
}

// ---------------------------------------------------------------------------
// Simulated dependency-failure fixtures
// ---------------------------------------------------------------------------

/**
 * Dependency failure types that can interrupt the message lifecycle.
 */
export type DependencyFailureKind =
  | 'relay_timeout'
  | 'rpc_unavailable'
  | 'mint_reverted'
  | 'escrow_full'
  | 'clock_skew_exceeded'
  | 'duplicate_message';

export interface DependencyFailureFixture {
  kind:           DependencyFailureKind;
  description:    string;
  /** State the message was in when the dependency failed. */
  failedAtState:  BridgeExecutionState;
  /** Whether the system can auto-recover without operator action. */
  autoRecovery:   boolean;
  /** Maximum number of automatic retries before escalation. */
  maxRetries:     number;
  /** Message that was in-flight when the failure occurred. */
  message:        MessageFixture;
}

export function buildDependencyFailureFixtures(): DependencyFailureFixture[] {
  const base = buildMessage({
    sourceChain:      'stellar',
    destinationChain: 'ethereum',
    token:            TOKEN_FIXTURES.USDC_STELLAR_TO_ETH,
  });

  return [
    {
      kind:          'relay_timeout',
      description:   'Relay service did not pick up the locked message within the SLA window.',
      failedAtState: 'locked',
      autoRecovery:  true,
      maxRetries:    3,
      message:       buildMessage({ ...base, nonce: 100 }),
    },
    {
      kind:          'rpc_unavailable',
      description:   'Destination-chain RPC node returned a 503 during the minting step.',
      failedAtState: 'minting',
      autoRecovery:  true,
      maxRetries:    5,
      message:       buildMessage({ ...base, nonce: 101 }),
    },
    {
      kind:          'mint_reverted',
      description:   'Destination-chain mint transaction reverted — vault capacity exceeded.',
      failedAtState: 'minting',
      autoRecovery:  false,
      maxRetries:    0,
      message:       buildMessage({ ...base, nonce: 102 }),
    },
    {
      kind:          'escrow_full',
      description:   'FallbackEscrow balance at maximum; tokens cannot be held pending retry.',
      failedAtState: 'bridging',
      autoRecovery:  false,
      maxRetries:    0,
      message:       buildMessage({ ...base, nonce: 103 }),
    },
    {
      kind:          'clock_skew_exceeded',
      description:   'Message timestamp outside clock skew tolerance; relay rejected the message.',
      failedAtState: 'initiated',
      autoRecovery:  false,
      maxRetries:    0,
      message:       buildMessage({
        ...base,
        nonce: 104,
        messageTimestampMs: T.minus31s,  // outside 30 s Stellar tolerance
      }),
    },
    {
      kind:          'duplicate_message',
      description:   'MessageId already exists in a terminal state; second submission is a no-op.',
      failedAtState: 'initiated',
      autoRecovery:  true,
      maxRetries:    0,  // no retry needed — just discard
      message:       buildMessage({ ...base, nonce: 1 }), // same nonce as happy-path
    },
  ];
}
