/**
 * Chain clock skew tolerance checks.
 *
 * Cross-chain bridge messages carry a timestamp produced by the source chain.
 * That timestamp is compared against the destination chain's wall clock when
 * the message is relayed. Because no two independent chains share the same
 * clock, there is always a drift — the "clock skew". An unbounded skew is
 * exploitable: an attacker can replay a very old signed message whose
 * deadline has already passed on one chain but is still valid on another.
 *
 * This module defines the configuration surface for skew tolerance, the
 * check algorithm, and the failure / escalation semantics.
 *
 * # Definitions
 *
 *   messageTimestampMs   — Timestamp embedded in the cross-chain message,
 *                          in milliseconds (Unix epoch), sourced from the
 *                          source chain's block time.
 *   localNowMs           — Current wall-clock time on the relayer / destination
 *                          chain (injected so it is deterministically testable).
 *   skewMs               — localNowMs - messageTimestampMs. Positive means the
 *                          message is older than local time; negative means the
 *                          source chain is ahead of local time.
 *   toleranceMs          — Maximum absolute skew the system will accept.
 *   gracePeriodMs        — Extra tolerance applied during chain congestion or
 *                          scheduled maintenance windows.
 *
 * # Chain-specific failure behaviour
 *
 *   CLOCK_SKEW_EXCEEDED   — |skewMs| > toleranceMs (+ gracePeriodMs if active).
 *                           The message MUST be rejected. The relayer should NOT
 *                           retry without operator approval; the deadline on the
 *                           source chain may have already expired.
 *
 *   MESSAGE_FROM_FUTURE   — skewMs < 0 && |skewMs| > futureDriftMs. The source
 *                           chain's block time is implausibly far ahead of local
 *                           time. This could indicate a misconfigured RPC node.
 *                           The message is held pending re-check, not dropped.
 *
 *   WITHIN_TOLERANCE      — The skew is acceptable; the relayer may proceed.
 *
 * # Idempotency
 *
 * `checkClockSkew` is a pure function with no side effects. It can be called
 * multiple times with the same arguments and always returns the same result.
 *
 * # Recovery / operator escalation
 *
 * When a `CLOCK_SKEW_EXCEEDED` result is returned the caller should:
 *   1. Emit a monitoring event with the full `ClockSkewCheckResult`.
 *   2. Park the message in a dead-letter queue with a TTL equal to
 *      `toleranceMs` so it can be re-evaluated after the relay delay.
 *   3. Page the on-call operator if the skew exceeds 2 × toleranceMs,
 *      which indicates a systematic drift rather than a transient spike.
 */

// ---------------------------------------------------------------------------
// Configuration surface
// ---------------------------------------------------------------------------

/**
 * Per-chain or global clock skew tolerance configuration.
 */
export interface ClockSkewConfig {
  /**
   * Human-readable chain identifier (used in diagnostics / error messages).
   * E.g. `"stellar"`, `"ethereum"`, `"polygon"`.
   */
  chainId: string;

  /**
   * Maximum allowed absolute clock skew in milliseconds.
   * Messages with |skew| > toleranceMs are rejected.
   *
   * Recommended defaults:
   *   - Stellar (5-second ledger): 30 000 ms
   *   - Ethereum (12-second block): 60 000 ms
   *   - High-latency rollups:      120 000 ms
   */
  toleranceMs: number;

  /**
   * Maximum future drift permitted before treating the message timestamp as
   * implausible (source RPC returning a future block time).
   * Defaults to `toleranceMs / 2` when omitted.
   */
  futureDriftMs?: number;

  /**
   * Extra milliseconds of tolerance applied when the chain is in a grace period
   * (e.g. scheduled maintenance, known congestion).
   * Added to `toleranceMs` for the duration of the grace window.
   * Defaults to 0.
   */
  gracePeriodMs?: number;

  /**
   * Whether a grace period is currently active for this chain.
   * When `true`, `gracePeriodMs` is added to `toleranceMs`.
   * Defaults to `false`.
   */
  gracePeriodActive?: boolean;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ClockSkewStatus =
  | 'WITHIN_TOLERANCE'
  | 'CLOCK_SKEW_EXCEEDED'
  | 'MESSAGE_FROM_FUTURE';

export interface ClockSkewCheckResult {
  /** Chain the message originated from. */
  chainId: string;
  /** Status code. */
  status: ClockSkewStatus;
  /** Whether the message may proceed. */
  accepted: boolean;
  /** Computed skew: localNowMs - messageTimestampMs. */
  skewMs: number;
  /** Effective tolerance applied (including grace period if active). */
  effectiveToleranceMs: number;
  /** Whether the grace period was applied for this check. */
  gracePeriodApplied: boolean;
  /** Message timestamp as supplied by the caller. */
  messageTimestampMs: number;
  /** Wall-clock time used for the check. */
  localNowMs: number;
  /** Human-readable summary for operator logs. */
  message: string;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown when the `ClockSkewConfig` itself is invalid (misconfigured tolerance
 * values etc.). Distinct from a check failure so callers can differentiate
 * configuration errors from runtime skew violations.
 */
export class InvalidClockSkewConfigError extends Error {
  constructor(
    public readonly chainId: string,
    reason: string,
  ) {
    super(`Invalid clock skew config for chain "${chainId}": ${reason}`);
    this.name = 'InvalidClockSkewConfigError';
  }
}

// ---------------------------------------------------------------------------
// Core check function
// ---------------------------------------------------------------------------

/**
 * Validate the config and throw if it is malformed.
 */
export function validateClockSkewConfig(config: ClockSkewConfig): void {
  if (!config.chainId || config.chainId.trim() === '') {
    throw new InvalidClockSkewConfigError(config.chainId, 'chainId is required');
  }
  if (!Number.isFinite(config.toleranceMs) || config.toleranceMs <= 0) {
    throw new InvalidClockSkewConfigError(
      config.chainId,
      `toleranceMs must be a positive finite number, got ${config.toleranceMs}`,
    );
  }
  if (
    config.futureDriftMs !== undefined &&
    (!Number.isFinite(config.futureDriftMs) || config.futureDriftMs < 0)
  ) {
    throw new InvalidClockSkewConfigError(
      config.chainId,
      `futureDriftMs must be a non-negative finite number, got ${config.futureDriftMs}`,
    );
  }
  if (
    config.gracePeriodMs !== undefined &&
    (!Number.isFinite(config.gracePeriodMs) || config.gracePeriodMs < 0)
  ) {
    throw new InvalidClockSkewConfigError(
      config.chainId,
      `gracePeriodMs must be a non-negative finite number, got ${config.gracePeriodMs}`,
    );
  }
}

/**
 * Check whether the clock skew between a cross-chain message timestamp and the
 * local clock is within the configured tolerance.
 *
 * @param messageTimestampMs  Timestamp embedded in the cross-chain message (ms).
 * @param localNowMs          Current local wall-clock time (ms). Injected so
 *                            tests can provide deterministic values.
 * @param config              Chain-specific skew tolerance configuration.
 * @returns                   A `ClockSkewCheckResult` with the verdict and
 *                            full diagnostic metadata.
 * @throws {InvalidClockSkewConfigError}  If `config` is malformed.
 */
export function checkClockSkew(
  messageTimestampMs: number,
  localNowMs: number,
  config: ClockSkewConfig,
): ClockSkewCheckResult {
  validateClockSkewConfig(config);

  const gracePeriodApplied = config.gracePeriodActive === true;
  const gracePeriodMs = config.gracePeriodMs ?? 0;
  const effectiveToleranceMs =
    config.toleranceMs + (gracePeriodApplied ? gracePeriodMs : 0);

  const futureDriftMs = config.futureDriftMs ?? config.toleranceMs / 2;

  // skewMs > 0: message is older than local time (normal case)
  // skewMs < 0: source chain clock is ahead of local clock
  const skewMs = localNowMs - messageTimestampMs;

  // Check for implausible future timestamp
  if (skewMs < 0 && Math.abs(skewMs) > futureDriftMs) {
    return {
      chainId: config.chainId,
      status: 'MESSAGE_FROM_FUTURE',
      accepted: false,
      skewMs,
      effectiveToleranceMs,
      gracePeriodApplied,
      messageTimestampMs,
      localNowMs,
      message:
        `Message from "${config.chainId}" has a future timestamp: ` +
        `skew=${skewMs}ms exceeds futureDriftMs=${futureDriftMs}ms. ` +
        `Hold and re-check; do NOT drop.`,
    };
  }

  // Check absolute skew against effective tolerance
  if (Math.abs(skewMs) > effectiveToleranceMs) {
    return {
      chainId: config.chainId,
      status: 'CLOCK_SKEW_EXCEEDED',
      accepted: false,
      skewMs,
      effectiveToleranceMs,
      gracePeriodApplied,
      messageTimestampMs,
      localNowMs,
      message:
        `Clock skew for "${config.chainId}" exceeds tolerance: ` +
        `|skew|=${Math.abs(skewMs)}ms > effectiveTolerance=${effectiveToleranceMs}ms. ` +
        `Reject message and alert operator if |skew| > ${2 * effectiveToleranceMs}ms.`,
    };
  }

  return {
    chainId: config.chainId,
    status: 'WITHIN_TOLERANCE',
    accepted: true,
    skewMs,
    effectiveToleranceMs,
    gracePeriodApplied,
    messageTimestampMs,
    localNowMs,
    message:
      `Clock skew for "${config.chainId}" is within tolerance: ` +
      `|skew|=${Math.abs(skewMs)}ms ≤ ${effectiveToleranceMs}ms.`,
  };
}

// ---------------------------------------------------------------------------
// Multi-chain skew checker
// ---------------------------------------------------------------------------

/**
 * Stateful registry that holds per-chain `ClockSkewConfig` entries and
 * exposes a `check` method keyed by chain identifier.
 *
 * Designed for injection into the relayer service so each inbound message
 * can be validated against the chain it originated from.
 *
 * ## Integration with routing boundary
 *
 * The relayer calls `ClockSkewChecker.check(messageTimestampMs, chainId)`
 * before forwarding a message to the execution layer. If the result is not
 * `accepted`, the relayer parks the message and the routing layer never
 * receives it, preserving the asset-boundary invariant.
 *
 * ## Gas / upgrade notes
 *
 * This class is entirely off-chain (TypeScript). No contract interaction is
 * needed. When chain block times change (e.g. an EVM chain switches to a
 * faster slot time) update the registered config via `register` and restart
 * the relayer process; no contract upgrade is required.
 */
export class ClockSkewChecker {
  private readonly configs = new Map<string, ClockSkewConfig>();
  private readonly nowFn: () => number;

  /**
   * @param nowFn  Injectable clock — defaults to `Date.now`. Override in
   *               tests to produce deterministic results.
   */
  constructor(nowFn: () => number = Date.now) {
    this.nowFn = nowFn;
  }

  /**
   * Register (or overwrite) the skew tolerance config for `chainId`.
   *
   * @throws {InvalidClockSkewConfigError}  If the config is malformed.
   */
  register(config: ClockSkewConfig): void {
    validateClockSkewConfig(config);
    this.configs.set(config.chainId.toLowerCase(), { ...config });
  }

  /**
   * Retrieve the registered config for `chainId`. Returns `undefined` when
   * no config has been registered.
   */
  getConfig(chainId: string): ClockSkewConfig | undefined {
    const found = this.configs.get(chainId.toLowerCase());
    return found ? { ...found } : undefined;
  }

  /**
   * Activate or deactivate the grace period for `chainId`.
   *
   * @throws {Error}  When no config is registered for `chainId`.
   */
  setGracePeriod(chainId: string, active: boolean): void {
    const key = chainId.toLowerCase();
    const cfg = this.configs.get(key);
    if (!cfg) {
      throw new Error(
        `No clock skew config registered for chain "${chainId}"`,
      );
    }
    this.configs.set(key, { ...cfg, gracePeriodActive: active });
  }

  /**
   * Check the clock skew of a message from `chainId` against the registered
   * tolerance.
   *
   * @param messageTimestampMs  Message timestamp in milliseconds.
   * @param chainId             Chain the message originated from.
   * @throws {Error}            When no config is registered for `chainId`.
   */
  check(messageTimestampMs: number, chainId: string): ClockSkewCheckResult {
    const cfg = this.configs.get(chainId.toLowerCase());
    if (!cfg) {
      throw new Error(
        `No clock skew config registered for chain "${chainId}"`,
      );
    }
    return checkClockSkew(messageTimestampMs, this.nowFn(), cfg);
  }
}

// ---------------------------------------------------------------------------
// Well-known defaults
// ---------------------------------------------------------------------------

/**
 * Sensible starting tolerances for the chains BridgeWise supports at launch.
 * Operators SHOULD tune these based on observed block-time jitter in production.
 */
export const DEFAULT_CHAIN_CLOCK_SKEW_CONFIGS: ClockSkewConfig[] = [
  {
    chainId: 'stellar',
    toleranceMs: 30_000,     // 6 × 5s ledger close time
    futureDriftMs: 15_000,   // 3 × 5s
    gracePeriodMs: 30_000,   // double tolerance during maintenance
  },
  {
    chainId: 'soroban',
    toleranceMs: 30_000,
    futureDriftMs: 15_000,
    gracePeriodMs: 30_000,
  },
  {
    chainId: 'ethereum',
    toleranceMs: 60_000,     // 5 × 12s slot
    futureDriftMs: 30_000,
    gracePeriodMs: 60_000,
  },
  {
    chainId: 'polygon',
    toleranceMs: 60_000,
    futureDriftMs: 30_000,
    gracePeriodMs: 60_000,
  },
  {
    chainId: 'arbitrum',
    toleranceMs: 120_000,    // rollup sequencer can batch-delay up to 2 min
    futureDriftMs: 60_000,
    gracePeriodMs: 120_000,
  },
];

/**
 * Build a `ClockSkewChecker` pre-populated with the default chain configs.
 */
export function createDefaultClockSkewChecker(
  nowFn: () => number = Date.now,
): ClockSkewChecker {
  const checker = new ClockSkewChecker(nowFn);
  for (const config of DEFAULT_CHAIN_CLOCK_SKEW_CONFIGS) {
    checker.register(config);
  }
  return checker;
}
