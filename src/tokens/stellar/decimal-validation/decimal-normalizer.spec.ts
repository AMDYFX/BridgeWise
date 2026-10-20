/**
 * Unit tests for the off-chain decimal normalizer.
 *
 * Covers:
 *   - normalizeDecimalsForBridge: scale-up, scale-down, passthrough,
 *     precision loss errors, overflow errors, invalid decimal errors
 *   - DecimalNormalizer class: registration, lookup, normalize
 *   - createDefaultNormalizer factory
 */

import {
  normalizeDecimalsForBridge,
  DecimalNormalizer,
  createDefaultNormalizer,
  InvalidDecimalsError,
  PrecisionLossError,
  NormalizationOverflowError,
} from './decimal-normalizer';
import { MAX_DECIMALS } from './token-decimal-validator';

// ---------------------------------------------------------------------------
// normalizeDecimalsForBridge
// ---------------------------------------------------------------------------
describe('normalizeDecimalsForBridge', () => {
  it('is a passthrough when source and destination decimals are equal', () => {
    const result = normalizeDecimalsForBridge(10_000_000n, {
      source: { chain: 'stellar', decimals: 7 },
      destination: { chain: 'soroban', decimals: 7 },
    });

    expect(result.normalizedAmount).toBe(10_000_000n);
    expect(result.isPassthrough).toBe(true);
    expect(result.truncatedResidue).toBe(0n);
  });

  it('scales up correctly from 6 to 7 decimals (EVM USDC → Stellar USDC)', () => {
    // 1 USDC at 6 decimals = 1_000_000
    // 1 USDC at 7 decimals = 10_000_000
    const result = normalizeDecimalsForBridge(1_000_000n, {
      source: { chain: 'ethereum', decimals: 6 },
      destination: { chain: 'stellar', decimals: 7 },
    });

    expect(result.normalizedAmount).toBe(10_000_000n);
    expect(result.isPassthrough).toBe(false);
    expect(result.truncatedResidue).toBe(0n);
    expect(result.sourceDecimals).toBe(6);
    expect(result.destinationDecimals).toBe(7);
  });

  it('scales up from 7 to 18 decimals', () => {
    const result = normalizeDecimalsForBridge(10_000_000n, {
      source: { chain: 'stellar', decimals: 7 },
      destination: { chain: 'ethereum', decimals: 18 },
    });

    expect(result.normalizedAmount).toBe(10_000_000n * 10n ** 11n);
    expect(result.isPassthrough).toBe(false);
  });

  it('scales down losslessly from 7 to 6', () => {
    // 10_000_000 at 7 dec = 1.0000000 → 1.000000 at 6 dec = 1_000_000
    const result = normalizeDecimalsForBridge(10_000_000n, {
      source: { chain: 'stellar', decimals: 7 },
      destination: { chain: 'ethereum', decimals: 6 },
    });

    expect(result.normalizedAmount).toBe(1_000_000n);
    expect(result.truncatedResidue).toBe(0n);
  });

  it('throws PrecisionLossError on lossy scale-down without opt-in', () => {
    // 1_000_001 at 7 dec → 6 dec: residual = 1
    expect(() =>
      normalizeDecimalsForBridge(1_000_001n, {
        source: { chain: 'stellar', decimals: 7 },
        destination: { chain: 'ethereum', decimals: 6 },
      }),
    ).toThrow(PrecisionLossError);
  });

  it('PrecisionLossError carries the truncated residual', () => {
    try {
      normalizeDecimalsForBridge(1_000_003n, {
        source: { chain: 'stellar', decimals: 7 },
        destination: { chain: 'ethereum', decimals: 6 },
      });
      fail('expected PrecisionLossError');
    } catch (err) {
      expect(err).toBeInstanceOf(PrecisionLossError);
      expect((err as PrecisionLossError).truncatedResidue).toBe(3n);
    }
  });

  it('allows lossy scale-down when allowPrecisionLoss is true', () => {
    const result = normalizeDecimalsForBridge(1_000_003n, {
      source: { chain: 'stellar', decimals: 7 },
      destination: { chain: 'ethereum', decimals: 6 },
      allowPrecisionLoss: true,
    });

    expect(result.normalizedAmount).toBe(100_000n);
    expect(result.truncatedResidue).toBe(3n);
  });

  it('throws NormalizationOverflowError when result exceeds i64 max', () => {
    // 9_223_372_036_854_775_807n is i64 max; multiply by 10 exceeds it
    const i64Max = NormalizationOverflowError.I64_MAX;
    expect(() =>
      normalizeDecimalsForBridge(i64Max, {
        source: { chain: 'ethereum', decimals: 0 },
        destination: { chain: 'stellar', decimals: 1 },
      }),
    ).toThrow(NormalizationOverflowError);
  });

  it('throws InvalidDecimalsError for a negative source decimal count', () => {
    expect(() =>
      normalizeDecimalsForBridge(100n, {
        source: { chain: 'ethereum', decimals: -1 },
        destination: { chain: 'stellar', decimals: 7 },
      }),
    ).toThrow(InvalidDecimalsError);
  });

  it('throws InvalidDecimalsError for a destination decimal count above MAX_DECIMALS', () => {
    expect(() =>
      normalizeDecimalsForBridge(100n, {
        source: { chain: 'ethereum', decimals: 6 },
        destination: { chain: 'stellar', decimals: MAX_DECIMALS + 1 },
      }),
    ).toThrow(InvalidDecimalsError);
  });

  it('handles zero amount passthrough', () => {
    const result = normalizeDecimalsForBridge(0n, {
      source: { chain: 'stellar', decimals: 7 },
      destination: { chain: 'stellar', decimals: 7 },
    });
    expect(result.normalizedAmount).toBe(0n);
    expect(result.isPassthrough).toBe(true);
  });

  it('handles zero amount scale-up', () => {
    const result = normalizeDecimalsForBridge(0n, {
      source: { chain: 'ethereum', decimals: 6 },
      destination: { chain: 'stellar', decimals: 7 },
    });
    expect(result.normalizedAmount).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// DecimalNormalizer class
// ---------------------------------------------------------------------------
describe('DecimalNormalizer', () => {
  it('can register and retrieve a profile', () => {
    const norm = new DecimalNormalizer();
    norm.register('USDC', { chain: 'stellar', decimals: 7 });

    const profile = norm.getProfile('stellar', 'USDC');
    expect(profile?.decimals).toBe(7);
    expect(profile?.chain).toBe('stellar');
  });

  it('returns undefined for an unregistered profile', () => {
    const norm = new DecimalNormalizer();
    expect(norm.getProfile('ethereum', 'USDC')).toBeUndefined();
  });

  it('normalizes between two registered chains', () => {
    const norm = new DecimalNormalizer();
    norm.register('USDC', { chain: 'ethereum', decimals: 6 });
    norm.register('USDC', { chain: 'stellar', decimals: 7 });

    const result = norm.normalize(1_000_000n, 'USDC', 'ethereum', 'stellar');
    expect(result.normalizedAmount).toBe(10_000_000n);
  });

  it('throws when the source chain has no registered profile', () => {
    const norm = new DecimalNormalizer();
    norm.register('USDC', { chain: 'stellar', decimals: 7 });

    expect(() => norm.normalize(1_000_000n, 'USDC', 'polygon', 'stellar')).toThrow(
      /No decimal profile registered for asset "USDC" on chain "polygon"/,
    );
  });

  it('throws when the destination chain has no registered profile', () => {
    const norm = new DecimalNormalizer();
    norm.register('USDC', { chain: 'ethereum', decimals: 6 });

    expect(() => norm.normalize(1_000_000n, 'USDC', 'ethereum', 'polygon')).toThrow(
      /No decimal profile registered for asset "USDC" on chain "polygon"/,
    );
  });

  it('passes allowPrecisionLoss through to normalizeDecimalsForBridge', () => {
    const norm = new DecimalNormalizer();
    norm.register('USDC', { chain: 'stellar', decimals: 7 });
    norm.register('USDC', { chain: 'ethereum', decimals: 6 });

    // 1_000_001 has residual → default should throw
    expect(() => norm.normalize(1_000_001n, 'USDC', 'stellar', 'ethereum')).toThrow(
      PrecisionLossError,
    );

    // With opt-in it should succeed
    const result = norm.normalize(1_000_001n, 'USDC', 'stellar', 'ethereum', true);
    expect(result.truncatedResidue).toBe(1n);
  });

  it('register throws InvalidDecimalsError for out-of-range decimal count', () => {
    const norm = new DecimalNormalizer();
    expect(() =>
      norm.register('BAD', { chain: 'ethereum', decimals: -5 }),
    ).toThrow(InvalidDecimalsError);
  });

  it('profile lookup is case-insensitive for asset name', () => {
    const norm = new DecimalNormalizer();
    norm.register('USDC', { chain: 'stellar', decimals: 7 });

    expect(norm.getProfile('stellar', 'usdc')?.decimals).toBe(7);
    expect(norm.getProfile('stellar', 'Usdc')?.decimals).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// createDefaultNormalizer
// ---------------------------------------------------------------------------
describe('createDefaultNormalizer', () => {
  it('creates a normalizer with Stellar USDC registered at 7 decimals', () => {
    const norm = createDefaultNormalizer();
    expect(norm.getProfile('stellar', 'USDC')?.decimals).toBe(7);
  });

  it('creates a normalizer with EVM USDC registered at 6 decimals', () => {
    const norm = createDefaultNormalizer();
    expect(norm.getProfile('ethereum', 'USDC')?.decimals).toBe(6);
  });

  it('creates a normalizer with EVM WETH registered at 18 decimals', () => {
    const norm = createDefaultNormalizer();
    expect(norm.getProfile('ethereum', 'WETH')?.decimals).toBe(18);
  });

  it('can normalize USDC from Ethereum to Stellar using default profiles', () => {
    const norm = createDefaultNormalizer();
    const result = norm.normalize(1_000_000n, 'USDC', 'ethereum', 'stellar');
    expect(result.normalizedAmount).toBe(10_000_000n);
  });

  it('can normalize USDC from Stellar to Ethereum losslessly', () => {
    const norm = createDefaultNormalizer();
    const result = norm.normalize(10_000_000n, 'USDC', 'stellar', 'ethereum');
    expect(result.normalizedAmount).toBe(1_000_000n);
  });
});
