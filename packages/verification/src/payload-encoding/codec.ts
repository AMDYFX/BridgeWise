/**
 * Canonical payload encoder / decoder (schema version 1).
 *
 * Encoding format (colon-delimited, all lowercase where applicable):
 *
 *   v1:<messageId>:<sourceChainId>:<destinationChainId>:<sender>:<recipient>:<payload>[:<nonce>][:<schemaVersion>]
 *
 * Rules
 * -----
 * - The leading "v1:" prefix lets future versions be detected unambiguously.
 * - Addresses (sender, recipient) are lowercased for case-insensitive comparison.
 * - Payload hex is lowercased and must be 0x-prefixed with an even number of
 *   hex digits (may be "0x" for pure value transfers).
 * - Optional fields (nonce, schemaVersion) are included only when defined,
 *   always in the same order, so the encoding is deterministic.
 * - Decoding validates every field before returning; any malformed input
 *   throws a {@link PayloadEncodingError}.
 */

import {
  EncodableMessage,
  EncodingErrorKind,
  EncodingResult,
  PayloadCodec,
  PayloadEncodingError,
} from "./types";

// ─── Validation constants ─────────────────────────────────────────────────────

const MESSAGE_ID_MAX = 128;
const MESSAGE_ID_RE = /^[a-zA-Z0-9_\-:.]{1,128}$/;
const HEX_PAYLOAD_RE = /^0x([0-9a-fA-F]{2})*$/;
const ENCODER_VERSION = 1;
const VERSION_PREFIX = `v${ENCODER_VERSION}`;
const SEPARATOR = ":";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fail(kind: EncodingErrorKind, msg: string): never {
  throw new PayloadEncodingError(kind, msg);
}

function validateMessage(m: EncodableMessage): void {
  if (!m.messageId || m.messageId.trim() === "") {
    fail("empty-message-id", "messageId must not be empty");
  }
  if (m.messageId.length > MESSAGE_ID_MAX) {
    fail("message-id-too-long", `messageId must be at most ${MESSAGE_ID_MAX} characters, got ${m.messageId.length}`);
  }
  if (!MESSAGE_ID_RE.test(m.messageId)) {
    fail("message-id-illegal-chars", `messageId "${m.messageId}" contains illegal characters (allowed: a-z A-Z 0-9 _ - : .)`);
  }

  if (!Number.isInteger(m.sourceChainId) || m.sourceChainId <= 0) {
    fail("invalid-chain-id", `sourceChainId must be a positive integer, got ${m.sourceChainId}`);
  }
  if (!Number.isInteger(m.destinationChainId) || m.destinationChainId <= 0) {
    fail("invalid-chain-id", `destinationChainId must be a positive integer, got ${m.destinationChainId}`);
  }
  if (m.sourceChainId === m.destinationChainId) {
    fail("same-chain", `sourceChainId and destinationChainId must differ (both are ${m.sourceChainId})`);
  }

  if (!m.sender || m.sender.trim() === "") {
    fail("empty-sender", "sender must not be empty");
  }
  if (!m.recipient || m.recipient.trim() === "") {
    fail("empty-recipient", "recipient must not be empty");
  }

  if (!HEX_PAYLOAD_RE.test(m.payload)) {
    fail(
      "invalid-payload-hex",
      `payload must be 0x-prefixed hex with an even number of digits, got "${m.payload.slice(0, 24)}${m.payload.length > 24 ? "…" : ""}"`,
    );
  }

  if (m.nonce !== undefined) {
    if (!Number.isInteger(m.nonce) || m.nonce < 0) {
      fail("negative-nonce", `nonce must be a non-negative integer, got ${m.nonce}`);
    }
  }

  if (m.schemaVersion !== undefined) {
    if (!Number.isInteger(m.schemaVersion) || m.schemaVersion < 1) {
      fail("invalid-schema-version", `schemaVersion must be a positive integer, got ${m.schemaVersion}`);
    }
  }
}

// ─── Codec ────────────────────────────────────────────────────────────────────

/**
 * Version-1 canonical payload codec.
 *
 * Stateless and pure — safe to share across calls and threads.
 */
export class CanonicalPayloadCodec implements PayloadCodec {
  readonly version = ENCODER_VERSION;

  /**
   * Validate and encode a message to its canonical colon-delimited string.
   *
   * @throws {PayloadEncodingError} on any validation failure.
   */
  encode(message: EncodableMessage): EncodingResult {
    validateMessage(message);

    const parts: string[] = [
      VERSION_PREFIX,
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

    const encoded = parts.join(SEPARATOR);
    return {
      encoded,
      byteLength: Buffer.byteLength(encoded, "utf8"),
      encoderVersion: ENCODER_VERSION,
    };
  }

  /**
   * Decode a canonical encoded string back to a validated message.
   *
   * @throws {PayloadEncodingError} if the string is malformed or fails
   *   field-level validation.
   */
  decode(encoded: string): EncodableMessage {
    if (!encoded || encoded.trim() === "") {
      fail("empty-message-id", "encoded string must not be empty");
    }

    // Detect version prefix
    if (!encoded.startsWith(`${VERSION_PREFIX}${SEPARATOR}`)) {
      fail(
        "invalid-schema-version",
        `encoded string must start with "${VERSION_PREFIX}:", got "${encoded.slice(0, 10)}…"`,
      );
    }

    // Strip the version prefix and split on separators.
    // We split with a max of 8 parts (7 separators after prefix strip) so that
    // a payload containing ":" characters would still need to be hex-encoded.
    const body = encoded.slice(VERSION_PREFIX.length + SEPARATOR.length);
    const parts = body.split(SEPARATOR);

    // Minimum required: messageId, srcChain, dstChain, sender, recipient, payload = 6
    if (parts.length < 6) {
      fail(
        "empty-message-id",
        `encoded string has ${parts.length} field(s) after version prefix, expected at least 6`,
      );
    }

    const [messageId, srcRaw, dstRaw, sender, recipient, payload, nonceRaw, schemaRaw] = parts;

    const sourceChainId = parseInt(srcRaw, 10);
    const destinationChainId = parseInt(dstRaw, 10);

    if (!Number.isInteger(sourceChainId)) {
      fail("invalid-chain-id", `cannot parse sourceChainId from "${srcRaw}"`);
    }
    if (!Number.isInteger(destinationChainId)) {
      fail("invalid-chain-id", `cannot parse destinationChainId from "${dstRaw}"`);
    }

    const msg: EncodableMessage = {
      messageId,
      sourceChainId,
      destinationChainId,
      sender,
      recipient,
      payload,
    };

    if (nonceRaw !== undefined) {
      const nonce = parseInt(nonceRaw, 10);
      if (!Number.isInteger(nonce)) {
        fail("negative-nonce", `cannot parse nonce from "${nonceRaw}"`);
      }
      msg.nonce = nonce;
    }

    if (schemaRaw !== undefined) {
      const sv = parseInt(schemaRaw, 10);
      if (!Number.isInteger(sv)) {
        fail("invalid-schema-version", `cannot parse schemaVersion from "${schemaRaw}"`);
      }
      msg.schemaVersion = sv;
    }

    // Re-validate the decoded message to catch any field that survived parsing
    // but violates business rules.
    validateMessage(msg);

    return msg;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

/** Shared codec instance — stateless, safe to reuse. */
export const canonicalPayloadCodec = new CanonicalPayloadCodec();
