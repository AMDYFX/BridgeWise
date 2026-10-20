/**
 * File: src/operations/mainnet/signer-availability-readiness.types.ts
 *
 * Types for signer availability readiness checks (#1379).
 *
 * Probes only report liveness, latency, and opaque reason codes. Signing
 * material, private keys, and signed payloads never cross this boundary.
 */

export type SignerReadinessStatus = 'ready' | 'degraded' | 'unavailable';

export type ChainSignerReadinessStatus = 'ready' | 'degraded' | 'unavailable';

/**
 * Result returned by a signer availability probe. `reasonCode` must be a
 * low-cardinality, non-secret code such as `hsm_unreachable` or `rpc_timeout`.
 */
export interface SignerProbeResult {
  available: boolean;
  latencyMs?: number;
  reasonCode?: string;
}

/**
 * Implementation boundary that checks whether a signer can serve a chain.
 * Implementations must never return or log private key material.
 */
export interface SignerAvailabilityProbe {
  check(signerId: string, chain: string): Promise<SignerProbeResult>;
}

export interface SignerChainRequirement {
  /** Normalized chain identifier, e.g. `stellar-mainnet`. */
  chain: string;
  signerIds: string[];
  /** Minimum signers that must be reachable to originate transactions. */
  minAvailable: number;
  /** Signers slower than this are reachable but reported as degraded. */
  maxLatencyMs: number;
}

export interface SignerReadinessCheckOptions {
  /** Per-signer probe timeout. Defaults to 2,000 ms. */
  timeoutMs?: number;
}

export interface SignerReadinessResult {
  signerId: string;
  status: SignerReadinessStatus;
  latencyMs?: number;
  reasonCode: string;
  checkedAt: number;
}

export interface ChainSignerReadiness {
  chain: string;
  status: ChainSignerReadinessStatus;
  checkedAt: number;
  requiredAvailable: number;
  ready: number;
  degraded: number;
  unavailable: number;
  signers: SignerReadinessResult[];
  /** Operator-facing, non-secret explanation of the chain verdict. */
  reasons: string[];
}
