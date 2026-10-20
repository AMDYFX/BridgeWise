/**
 * Token decimal normalization.
 *
 * Cross-chain token transfers move amounts between networks where the same
 * economic asset is represented at different decimal precisions. For example,
 * USDC on Stellar uses 7 decimals but USDC on Ethereum uses 6. A raw base-unit
 * value from one side is meaningless on the other without normalization.
 *
 * This module defines the configuration surface, normalization algorithm, and
 * failure semantics for that rescaling step. It integrates with
 * `TokenDecimalValidator` to enforce that every normalization is performed
 * against validated (not assumed) precision values.
 *
 * # Chain-specific failure behaviour
 *
 * - If the source and destination decimal counts are equal the input base-unit
 *   value is returned unchanged.
 * - If the destination has fewer decimal places than the source, precision is
 *   lost. The caller must opt in by passing `allowPrecisionLoss: true`; if that
 *   flag is absent the call throws a `PrecisionLossError`.
 * - If either decimal count is outside [0, MAX_DECIMALS] the call throws an
 *   `InvalidDecimalsError`.
 * - If the rescaled value would overflow a signed 64-bit integer a
 *   `NormalizationOverflowError` is thrown so callers can reject the transfer
 *   at the routing layer before it reaches the contract layer.
 *
 * # Idempotency
 *
 * `normalize` is a pure function with no side effects; calling it twice with
 * identical arguments always produces the same result.
 *
 * # Operator escalation
 *
 * When a `PrecisionLossError` is thrown the error carries the dropped residual
 * base-unit value so operators can log and alert on any precision that was
 * silently truncated in permissive call sites.
 */

import { isValidDecimalCount, MAX_DECIMALS } from './token-decimal-validator';

// ---------------------------------------------------------------------------
// Configuration surface
// ---------------------------------------------------------------------------

/**
 * Identifies which side of a cross-chain transfer an amount belongs to.
 */
export type TransferSide = 'source' | 'destination';

/**
 * Decimal configuration for a single side of a cross-chain bridge path.
 */
export interface ChainDecimalConfig {
  /** Human-readable chain or network identifier (used in error messages). */
  chain: string;
  /** Number of decimal places the token uses on this chain. */
  decimals: number;
}

/**
 * Full configuration for a cross-chain normalization operation.
 */
export interface NormalizationConfig {
  source: ChainDecimalConfig;
  destination: ChainDecimalConfig;
  /**
   * When `true`, allow lossy normalization (destination has fewer decimals).
   * The truncated residual is available on the returned `NormalizationResult`.
   * Defaults to `false`.
   */
  allowPrecisionLoss?: boolean;
}

// ---------------------------------------------------------------------------
// Result surface
// ---------------------------------------------------------------------------

/**
 * Outcome of a successful normalization.
 */
export interface NormalizationResult {
  /** Rescaled base-unit amount in destination decimal precision. */
  normalizedAmount: bigint;
  /** Source decimal count used for the conversion. */
  sourceDecimals: number;
  /** Destination decimal count used for the conversion. */
  destinationDecimals: number;
  /**
   * Base-unit residual truncated from the source amount (always 0n when
   * `sourceDecimals <= destinationDecimals`).
   */
  truncatedResidue: bigint;
  /**
   * `true` when `sourceDecimals === destinationDecimals` and no rescaling was
   * needed.
   */
  isPassthrough: boolean;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown when either decimal count is outside [0, MAX_DECIMALS].
 */
export class InvalidDecimalsError extends Error {
  constructor(
    public readonly side: TransferSide,
    public readonly decimals: number,
  ) {
    super(
      `Invalid decimal count for ${side} side: ${decimals}. ` +
        `Must be an integer in [0, ${MAX_DECIMALS}].`,
    );
    this.name = 'InvalidDecimalsError';
  }
}

/**
 * Thrown when normalizing from a higher-precision source to a lower-precision
 * destination would silently truncate value and `allowPrecisionLoss` is not
 * set.
 */
export class PrecisionLossError extends Error {
  constructor(
    public readonly sourceDecimals: number,
    public readonly destinationDecimals: number,
    /** The base-unit residual that would be lost. */
    public readonly truncatedResidue: bigint,
  ) {
    super(
      `Normalization from ${sourceDecimals} to ${destinationDecimals} decimals ` +
        `would truncate ${truncatedResidue} base units. ` +
        `Pass allowPrecisionLoss: true to allow this.`,
    );
    this.name = 'PrecisionLossError';
  }
}

/**
 * Thrown when the rescaled amount would overflow a signed 64-bit integer
 * (i64 max = 2^63 - 1), matching the Stellar/Soroban i128/i64 boundary.
 */
export class NormalizationOverflowError extends Error {
  static readonly I64_MAX = 9_223_372_036_854_775_807n;

  constructor(
    public readonly normalizedAmount: bigint,
  ) {
    super(
      `Normalized amount ${normalizedAmount} exceeds i64 max ` +
        `(${NormalizationOverflowError.I64_MAX}). Reject this transfer.`,
    );
    this.name = 'NormalizationOverflowError';
  }
}

// ---------------------------------------------------------------------------
// Core normalization function
// ---------------------------------------------------------------------------

/**
 * Rescale `sourceAmount` from source decimal precision to destination decimal
 * precision.
 *
 * @param sourceAmount  Base-unit amount at source decimal precision.
 * @param config        Normalization configuration including chain decimal
 *                      configs and precision-loss policy.
 * @returns             A `NormalizationResult` with the rescaled amount and
 *                      diagnostic metadata.
 * @throws {InvalidDecimalsError}        If either decimal count is invalid.
 * @throws {PrecisionLossError}          If precision would be lost and the
 *                                       caller has not opted in.
 * @throws {NormalizationOverflowError}  If the result exceeds i64 max.
 */
export function normalizeDecimalsForBridge(
  sourceAmount: bigint,
  config: NormalizationConfig,
): NormalizationResult {
  const { source, destination, allowPrecisionLoss = false } = config;

  // Validate both decimal counts
  if (!isValidDecimalCount(source.decimals)) {
    throw new InvalidDecimalsError('source', source.decimals);
  }
  if (!isValidDecimalCount(destination.decimals)) {
    throw new InvalidDecimalsError('destination', destination.decimals);
  }

  // Fast path: same precision
  if (source.decimals === destination.decimals) {
    return {
      normalizedAmount: sourceAmount,
      sourceDecimals: source.decimals,
      destinationDecimals: destination.decimals,
      truncatedResidue: 0n,
      isPassthrough: true,
    };
  }

  let normalizedAmount: bigint;
  let truncatedResidue = 0n;

  if (destination.decimals > source.decimals) {
    // Scale up: multiply by 10^(dest - src)
    const factor = 10n ** BigInt(destination.decimals - source.decimals);
    normalizedAmount = sourceAmount * factor;
  } else {
    // Scale down: divide by 10^(src - dest) — potential precision loss
    const factor = 10n ** BigInt(source.decimals - destination.decimals);
    truncatedResidue = sourceAmount % factor;

    if (truncatedResidue !== 0n && !allowPrecisionLoss) {
      throw new PrecisionLossError(
        source.decimals,
        destination.decimals,
        truncatedResidue,
      );
    }

    normalizedAmount = sourceAmount / factor;
  }

  // Overflow guard for i64 boundary (relevant for Soroban i128 → i64 paths)
  if (normalizedAmount > NormalizationOverflowError.I64_MAX) {
    throw new NormalizationOverflowError(normalizedAmount);
  }

  return {
    normalizedAmount,
    sourceDecimals: source.decimals,
    destinationDecimals: destination.decimals,
    truncatedResidue,
    isPassthrough: false,
  };
}

// ---------------------------------------------------------------------------
// Stateful normalizer class
// ---------------------------------------------------------------------------

/**
 * Stateful normalizer that holds registered chain-decimal profiles and
 * exposes a convenient `normalize` method by chain pair.
 *
 * Profiles are keyed by `{chain}:{asset}` so the same asset can have
 * different decimal counts on different chains.
 *
 * ## Gas / upgrade notes
 *
 * This class lives entirely off-chain (TypeScript routing layer). No
 * contract interaction is required for normalization itself. When on-chain
 * decimal values change (e.g. a wrapped token redeployment) the profile
 * registry should be updated via `register` and the off-chain service
 * restarted; no contract upgrade is needed.
 */
export class DecimalNormalizer {
  private readonly profiles = new Map<string, ChainDecimalConfig>();

  /**
   * Register (or overwrite) the decimal configuration for `asset` on `chain`.
   *
   * @throws {InvalidDecimalsError} if `config.decimals` is out of range.
   */
  register(asset: string, config: ChainDecimalConfig): void {
    if (!isValidDecimalCount(config.decimals)) {
      throw new InvalidDecimalsError(
        'source', // side is irrelevant here; the error carries the value
        config.decimals,
      );
    }
    const key = profileKey(config.chain, asset);
    this.profiles.set(key, { ...config });
  }

  /**
   * Look up the registered configuration for `asset` on `chain`.
   * Returns `undefined` when no profile has been registered.
   */
  getProfile(chain: string, asset: string): ChainDecimalConfig | undefined {
    const found = this.profiles.get(profileKey(chain, asset));
    return found ? { ...found } : undefined;
  }

  /**
   * Normalize `sourceAmount` from the registered decimal precision of `asset`
   * on `sourceChain` to its registered precision on `destinationChain`.
   *
   * @throws {Error}                     If no profile is registered for
   *                                     either chain.
   * @throws {InvalidDecimalsError}      If a stored profile has an invalid
   *                                     decimal count (should not happen if
   *                                     `register` was used).
   * @throws {PrecisionLossError}        If precision would be lost and
   *                                     `allowPrecisionLoss` is not set.
   * @throws {NormalizationOverflowError} If the result exceeds i64 max.
   */
  normalize(
    sourceAmount: bigint,
    asset: string,
    sourceChain: string,
    destinationChain: string,
    allowPrecisionLoss = false,
  ): NormalizationResult {
    const src = this.profiles.get(profileKey(sourceChain, asset));
    const dst = this.profiles.get(profileKey(destinationChain, asset));

    if (!src) {
      throw new Error(
        `No decimal profile registered for asset "${asset}" on chain "${sourceChain}"`,
      );
    }
    if (!dst) {
      throw new Error(
        `No decimal profile registered for asset "${asset}" on chain "${destinationChain}"`,
      );
    }

    return normalizeDecimalsForBridge(sourceAmount, {
      source: src,
      destination: dst,
      allowPrecisionLoss,
    });
  }
}

// ---------------------------------------------------------------------------
// Well-known bridge route profiles
// ---------------------------------------------------------------------------

/**
 * Pre-populated profiles for the token pairs BridgeWise supports at launch.
 * Callers can obtain a ready-to-use normalizer without manual registration.
 */
export const DEFAULT_BRIDGE_DECIMAL_PROFILES: Array<{
  asset: string;
  chain: string;
  decimals: number;
}> = [
  // Stellar / Soroban: all classic assets and XLM use 7 decimals
  { asset: 'XLM', chain: 'stellar', decimals: 7 },
  { asset: 'XLM', chain: 'soroban', decimals: 7 },
  { asset: 'USDC', chain: 'stellar', decimals: 7 },
  { asset: 'USDC', chain: 'soroban', decimals: 7 },
  { asset: 'USDT', chain: 'stellar', decimals: 7 },
  { asset: 'USDT', chain: 'soroban', decimals: 7 },
  // EVM canonical values
  { asset: 'USDC', chain: 'ethereum', decimals: 6 },
  { asset: 'USDC', chain: 'polygon', decimals: 6 },
  { asset: 'USDC', chain: 'arbitrum', decimals: 6 },
  { asset: 'USDT', chain: 'ethereum', decimals: 6 },
  { asset: 'USDT', chain: 'polygon', decimals: 6 },
  { asset: 'USDT', chain: 'arbitrum', decimals: 6 },
  { asset: 'WETH', chain: 'ethereum', decimals: 18 },
  { asset: 'WETH', chain: 'arbitrum', decimals: 18 },
  { asset: 'WETH', chain: 'polygon', decimals: 18 },
  // Wrapped Stellar assets bridged to EVM carry Stellar precision
  { asset: 'bwUSDC', chain: 'ethereum', decimals: 7 },
  { asset: 'bwUSDC', chain: 'polygon', decimals: 7 },
  { asset: 'bwXLM', chain: 'ethereum', decimals: 7 },
];

/**
 * Build a `DecimalNormalizer` pre-populated with the default bridge profiles.
 */
export function createDefaultNormalizer(): DecimalNormalizer {
  const normalizer = new DecimalNormalizer();
  for (const { asset, chain, decimals } of DEFAULT_BRIDGE_DECIMAL_PROFILES) {
    normalizer.register(asset, { chain, decimals });
  }
  return normalizer;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function profileKey(chain: string, asset: string): string {
  return `${chain.toLowerCase()}:${asset.trim().toUpperCase()}`;
}
