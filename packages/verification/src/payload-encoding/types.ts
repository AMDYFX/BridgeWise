/**
 * Types for canonical payload encoding.
 *
 * "Canonical" means a single, deterministic byte-level representation of a
 * cross-chain message that every participant (source chain, relayer, destination
 * chain verifier) can independently reproduce and compare.
 *
 * Design goals
 * ------------
 * - Deterministic across runtimes, locales, and JS engines.
 * - Append-only versioning: new fields are added at the end; old decoders
 *   continue to work on payloads they understand.
 * - Strict input validation: malformed fields are rejected before encoding
 *   so bad data never reaches the hash layer.
 * - Chain-boundary safe: the encoding explicitly includes both chain IDs so
 *   a payload cannot be replayed on a different route.
 */

// ─── Raw fields ───────────────────────────────────────────────────────────────

/**
 * The subset of a cross-chain message that must appear in the canonical
 * encoding.  Optional fields, when present, are appended in a fixed order so
 * the encoding remains deterministic.
 */
export interface EncodableMessage {
  messageId: string;
  sourceChainId: number;
  destinationChainId: number;
  sender: string;
  recipient: string;
  /** ABI-encoded or raw transfer data as a 0x-prefixed hex string. */
  payload: string;
  /** Replay-protection nonce per (sourceChainId, sender). */
  nonce?: number;
  /** Schema version used to select the decoder on the destination side. */
  schemaVersion?: number;
}

// ─── Encoding result ──────────────────────────────────────────────────────────

export interface EncodingResult {
  /** The canonical, colon-delimited string ready to be passed to a hasher. */
  encoded: string;
  /** Byte length of the encoded string (UTF-8). */
  byteLength: number;
  /** Schema version used (always 1 for the current encoder). */
  encoderVersion: number;
}

// ─── Validation errors ────────────────────────────────────────────────────────

export type EncodingErrorKind =
  | "empty-message-id"
  | "message-id-too-long"
  | "message-id-illegal-chars"
  | "same-chain"
  | "invalid-chain-id"
  | "empty-sender"
  | "empty-recipient"
  | "invalid-payload-hex"
  | "negative-nonce"
  | "invalid-schema-version";

export class PayloadEncodingError extends Error {
  constructor(
    public readonly kind: EncodingErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "PayloadEncodingError";
  }
}

// ─── Codec interface ──────────────────────────────────────────────────────────

/**
 * A payload codec encodes a message to its canonical string and decodes
 * that string back to a validated `EncodableMessage`.
 *
 * Implementations must be stateless and pure (no I/O, no side effects).
 */
export interface PayloadCodec {
  readonly version: number;
  encode(message: EncodableMessage): EncodingResult;
  decode(encoded: string): EncodableMessage;
}
