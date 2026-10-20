/**
 * Types for cross-chain message commitment verification.
 *
 * A "commitment" is a cryptographic binding (hash or Merkle root) that a
 * source chain publishes on-chain to attest that a particular message was
 * sent.  The verifier checks that the locally-observed message reproduces
 * the same commitment before allowing execution to proceed.
 *
 * Design constraints
 * ------------------
 * - Pure TypeScript; no native crypto dependency — hash primitives are
 *   injected so callers can swap in a real SHA-256 / keccak implementation.
 * - Every failure surface is typed; callers never need to parse error strings.
 * - Idempotent: verifying the same (message, commitment) pair twice returns
 *   an identical result.
 */

// ─── Message ──────────────────────────────────────────────────────────────────

/**
 * A normalised cross-chain message.  Fields mirror the intersection of
 * LayerZero's `LayerZeroMessage` and BridgeWise's internal transfer model so
 * that both can be adapted to this type without information loss.
 */
export interface CrossChainMessage {
  /** Protocol-level unique identifier (e.g. nonce string or UUID). */
  messageId: string;
  /** Numeric chain ID of the originating chain. */
  sourceChainId: number;
  /** Numeric chain ID of the destination chain. */
  destinationChainId: number;
  /** Sender address on the source chain (0x-prefixed hex or bech32). */
  sender: string;
  /** Recipient address on the destination chain. */
  recipient: string;
  /**
   * ABI-encoded or raw payload bytes as a 0x-prefixed hex string.
   * May be empty ("0x") for pure value transfers.
   */
  payload: string;
  /**
   * Optional nonce providing replay-protection per (sourceChainId, sender)
   * pair.  When present, the verifier checks for nonce reuse.
   */
  nonce?: number;
  /**
   * Schema version of the message encoding.  Used by the versioned adapter
   * layer to select the correct decoder before hashing.
   */
  schemaVersion?: number;
}

// ─── Commitment ───────────────────────────────────────────────────────────────

/**
 * A commitment published by the source chain (or a relayer acting on its
 * behalf) attesting to the existence of a sent message.
 */
export interface MessageCommitment {
  /** The commitment value itself — a 0x-prefixed hex hash. */
  commitmentHash: string;
  /** Chain that produced this commitment. */
  sourceChainId: number;
  /** Block number at which the commitment was included. */
  blockNumber: number;
  /**
   * Unix timestamp (milliseconds) when the commitment was observed.
   * Used only for diagnostics; not part of the hash computation.
   */
  observedAt: number;
}

// ─── Verification result ──────────────────────────────────────────────────────

/** Structured reason codes for commitment verification failures. */
export type CommitmentFailureReason =
  | "hash-mismatch"
  | "invalid-message-id"
  | "chain-id-mismatch"
  | "nonce-reuse"
  | "empty-payload-on-non-transfer"
  | "malformed-commitment-hash"
  | "malformed-payload"
  | "missing-required-field";

export interface CommitmentVerificationResult {
  /** Whether the message matches the published commitment. */
  ok: boolean;
  /** The message ID that was verified. */
  messageId: string;
  /** The commitment hash that was checked against. */
  commitmentHash: string;
  /** The hash the verifier computed from the message. */
  computedHash: string;
  /** Set when `ok` is false. */
  failureReason?: CommitmentFailureReason;
  /** Human-readable diagnostic (always set when `ok` is false). */
  diagnostic?: string;
}

// ─── Hasher interface ─────────────────────────────────────────────────────────

/**
 * Minimal hasher interface.  Inject a real keccak256 or SHA-256 implementation
 * in production; the built-in `FallbackHasher` uses a deterministic but
 * non-cryptographic substitute for testing.
 */
export interface MessageHasher {
  /**
   * Compute a 0x-prefixed 32-byte hex hash of the canonical message encoding.
   * Must be pure and deterministic.
   */
  hash(message: CrossChainMessage): string;
}

// ─── Verifier configuration ───────────────────────────────────────────────────

export interface CommitmentVerifierConfig {
  /**
   * Hasher implementation.  Defaults to `FallbackHasher` which is suitable
   * only for tests; replace with a keccak256 implementation in production.
   */
  hasher?: MessageHasher;
  /**
   * When true, the verifier tracks all verified nonces and rejects duplicates.
   * Defaults to true.
   */
  enforceNonceUniqueness?: boolean;
  /**
   * Maximum number of nonces tracked in memory before the oldest entry is
   * evicted (prevents unbounded growth).  Defaults to 10_000.
   */
  nonceStoreCapacity?: number;
}

export const DEFAULT_NONCE_STORE_CAPACITY = 10_000;
