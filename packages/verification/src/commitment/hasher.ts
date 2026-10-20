/**
 * Canonical message encoding and built-in hasher.
 *
 * Production deployments MUST replace `FallbackHasher` with a real
 * cryptographic hash (keccak256 or SHA-256) by implementing `MessageHasher`
 * and passing it to `CommitmentVerifier`.
 *
 * The canonical encoding is:
 *   "<messageId>:<sourceChainId>:<destinationChainId>:<sender>:<recipient>:<payload>[:<nonce>][:<schemaVersion>]"
 *
 * The encoding is intentionally human-readable so that log output is
 * self-describing and operators can reproduce a hash manually.  In
 * production the string should be passed to keccak256 or SHA-256 before
 * being compared with an on-chain commitment.
 */

import { CrossChainMessage, MessageHasher } from "./types";

// ─── Canonical encoding ───────────────────────────────────────────────────────

/**
 * Produce the canonical string encoding of a message.
 *
 * The encoding is deterministic: given the same `CrossChainMessage` the
 * function always returns the same string regardless of insertion order of
 * optional fields.
 */
export function encodeMessage(message: CrossChainMessage): string {
  const parts: string[] = [
    message.messageId,
    String(message.sourceChainId),
    String(message.destinationChainId),
    message.sender.toLowerCase(),
    message.recipient.toLowerCase(),
    message.payload.toLowerCase(),
  ];

  if (message.nonce !== undefined) {
    parts.push(String(message.nonce));
  }

  if (message.schemaVersion !== undefined) {
    parts.push(String(message.schemaVersion));
  }

  return parts.join(":");
}

// ─── Fallback hasher (test-only) ──────────────────────────────────────────────

/**
 * A deterministic but NON-CRYPTOGRAPHIC hasher used only in tests and
 * development environments.
 *
 * Algorithm: djb2 variant over the canonical encoding, returned as a
 * 0x-prefixed 64-character hex string padded with the source/destination
 * chain IDs for easier visual inspection.
 *
 * NEVER use this in production — it is not collision-resistant.
 */
export class FallbackHasher implements MessageHasher {
  hash(message: CrossChainMessage): string {
    const encoded = encodeMessage(message);
    let h = 5381;
    for (let i = 0; i < encoded.length; i++) {
      h = ((h << 5) + h + encoded.charCodeAt(i)) >>> 0;
    }
    const core = h.toString(16).padStart(8, "0");
    // Pad to 64 hex chars (32 bytes) using chain IDs for visual disambiguation.
    const srcHex = message.sourceChainId.toString(16).padStart(8, "0");
    const dstHex = message.destinationChainId.toString(16).padStart(8, "0");
    const msgIdHash = this.djb2Short(message.messageId).toString(16).padStart(8, "0");
    const rest = "0".repeat(32);
    return `0x${core}${srcHex}${dstHex}${msgIdHash}${rest}`.slice(0, 66);
  }

  private djb2Short(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    }
    return h;
  }
}

// ─── Shared singleton ─────────────────────────────────────────────────────────

/** Default hasher instance; suitable for tests only. */
export const fallbackHasher = new FallbackHasher();
