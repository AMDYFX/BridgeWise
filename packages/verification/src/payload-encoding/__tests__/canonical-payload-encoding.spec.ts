/**
 * Canonical payload encoding tests.
 *
 * Every test uses deterministic fixtures — no I/O, no clock, no randomness.
 * Coverage:
 *   - Happy path: encode, decode, round-trip
 *   - Determinism: identical input always produces identical output
 *   - Address normalisation: case-folding of sender/recipient
 *   - Payload normalisation: hex case-folding
 *   - Optional fields: nonce and schemaVersion inclusion/omission
 *   - Chain-boundary: same-chain rejection, chain-id in output
 *   - Boundary inputs: max-length messageId, zero-byte payload, large nonce
 *   - Invalid inputs: every EncodingErrorKind is exercised at least once
 *   - Decode: version-prefix detection, field-count check, re-validation
 *   - byteLength: matches actual buffer size
 *   - Simulated dependency failure: codec survives a thrown encode attempt
 */

import { CanonicalPayloadCodec, canonicalPayloadCodec } from "../codec";
import { PayloadEncodingError } from "../types";
import type { EncodableMessage } from "../types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function msg(overrides: Partial<EncodableMessage> = {}): EncodableMessage {
  return {
    messageId: "msg-001",
    sourceChainId: 101,
    destinationChainId: 109,
    sender: "0xSenderABCDEF",
    recipient: "0xRecipient123456",
    payload: "0xdeadbeef",
    ...overrides,
  };
}

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("CanonicalPayloadCodec.encode — happy path", () => {
  const codec = new CanonicalPayloadCodec();

  it("returns an EncodingResult with a non-empty string", () => {
    const result = codec.encode(msg());
    expect(typeof result.encoded).toBe("string");
    expect(result.encoded.length).toBeGreaterThan(0);
  });

  it("encoderVersion is 1", () => {
    expect(codec.encode(msg()).encoderVersion).toBe(1);
  });

  it("encoded string starts with 'v1:'", () => {
    expect(codec.encode(msg()).encoded.startsWith("v1:")).toBe(true);
  });

  it("byteLength equals the actual UTF-8 byte length", () => {
    const result = codec.encode(msg());
    expect(result.byteLength).toBe(Buffer.byteLength(result.encoded, "utf8"));
  });

  it("includes all required fields in the encoded string", () => {
    const m = msg();
    const { encoded } = codec.encode(m);
    expect(encoded).toContain(m.messageId);
    expect(encoded).toContain(String(m.sourceChainId));
    expect(encoded).toContain(String(m.destinationChainId));
    expect(encoded).toContain(m.sender.toLowerCase());
    expect(encoded).toContain(m.recipient.toLowerCase());
    expect(encoded).toContain(m.payload.toLowerCase());
  });

  it("includes nonce when provided", () => {
    const { encoded } = codec.encode(msg({ nonce: 42 }));
    expect(encoded).toContain(":42");
  });

  it("omits nonce segment when nonce is undefined", () => {
    const { encoded } = codec.encode(msg({ nonce: undefined }));
    // Split and count parts: v1 + 6 required = 7 parts, no nonce → 7
    const parts = encoded.split(":");
    expect(parts.length).toBe(7);
  });

  it("includes schemaVersion when provided", () => {
    const { encoded } = codec.encode(msg({ nonce: 1, schemaVersion: 2 }));
    expect(encoded.endsWith(":2")).toBe(true);
  });

  it("both nonce and schemaVersion present → 9 colon-separated parts", () => {
    const { encoded } = codec.encode(msg({ nonce: 5, schemaVersion: 3 }));
    expect(encoded.split(":").length).toBe(9);
  });

  it("nonce present, schemaVersion absent → 8 parts", () => {
    const { encoded } = codec.encode(msg({ nonce: 5, schemaVersion: undefined }));
    expect(encoded.split(":").length).toBe(8);
  });
});

// ─── Determinism ──────────────────────────────────────────────────────────────

describe("determinism", () => {
  const codec = new CanonicalPayloadCodec();

  it("same input always produces the same encoded string", () => {
    const m = msg({ nonce: 7, schemaVersion: 1 });
    expect(codec.encode(m).encoded).toBe(codec.encode(m).encoded);
  });

  it("different messageId produces a different encoded string", () => {
    const a = codec.encode(msg({ messageId: "msg-aaa" }));
    const b = codec.encode(msg({ messageId: "msg-bbb" }));
    expect(a.encoded).not.toBe(b.encoded);
  });

  it("different sourceChainId produces a different encoded string", () => {
    const a = codec.encode(msg({ sourceChainId: 101 }));
    const b = codec.encode(msg({ sourceChainId: 102 }));
    expect(a.encoded).not.toBe(b.encoded);
  });

  it("different payload produces a different encoded string", () => {
    const a = codec.encode(msg({ payload: "0xdeadbeef" }));
    const b = codec.encode(msg({ payload: "0xcafebabe" }));
    expect(a.encoded).not.toBe(b.encoded);
  });

  it("nonce 0 differs from nonce undefined", () => {
    const withZero = codec.encode(msg({ nonce: 0 }));
    const withUndefined = codec.encode(msg({ nonce: undefined }));
    expect(withZero.encoded).not.toBe(withUndefined.encoded);
  });
});

// ─── Address / payload normalisation ─────────────────────────────────────────

describe("normalisation", () => {
  const codec = new CanonicalPayloadCodec();

  it("lowercases sender regardless of input case", () => {
    const upper = codec.encode(msg({ sender: "0xABCDEF123456" }));
    const lower = codec.encode(msg({ sender: "0xabcdef123456" }));
    expect(upper.encoded).toBe(lower.encoded);
  });

  it("lowercases recipient regardless of input case", () => {
    const upper = codec.encode(msg({ recipient: "0xFEDCBA654321" }));
    const lower = codec.encode(msg({ recipient: "0xfedcba654321" }));
    expect(upper.encoded).toBe(lower.encoded);
  });

  it("lowercases payload hex regardless of input case", () => {
    const upper = codec.encode(msg({ payload: "0xDEADBEEF" }));
    const lower = codec.encode(msg({ payload: "0xdeadbeef" }));
    expect(upper.encoded).toBe(lower.encoded);
  });

  it("encoded sender is lowercase in the output", () => {
    const { encoded } = codec.encode(msg({ sender: "0xMixedCASE" }));
    const senderInEncoded = encoded.split(":")[4];
    expect(senderInEncoded).toBe(senderInEncoded?.toLowerCase());
  });
});

// ─── Chain-boundary enforcement ───────────────────────────────────────────────

describe("chain-boundary", () => {
  const codec = new CanonicalPayloadCodec();

  it("chain IDs are present in the encoded output", () => {
    const { encoded } = codec.encode(msg({ sourceChainId: 101, destinationChainId: 109 }));
    const parts = encoded.split(":");
    expect(parts[2]).toBe("101");
    expect(parts[3]).toBe("109");
  });

  it("swapping chain IDs produces a different encoding", () => {
    const forward = codec.encode(msg({ sourceChainId: 101, destinationChainId: 109 }));
    const reverse = codec.encode(msg({ sourceChainId: 109, destinationChainId: 101 }));
    expect(forward.encoded).not.toBe(reverse.encoded);
  });
});

// ─── Boundary inputs ──────────────────────────────────────────────────────────

describe("boundary inputs", () => {
  const codec = new CanonicalPayloadCodec();

  it("accepts a messageId exactly 128 characters long", () => {
    const id = "a".repeat(128);
    expect(() => codec.encode(msg({ messageId: id }))).not.toThrow();
  });

  it("accepts an empty payload (0x) — pure value transfer", () => {
    expect(() => codec.encode(msg({ payload: "0x" }))).not.toThrow();
    expect(codec.encode(msg({ payload: "0x" })).encoded).toContain(":0x");
  });

  it("accepts a large nonce (Number.MAX_SAFE_INTEGER)", () => {
    expect(() =>
      codec.encode(msg({ nonce: Number.MAX_SAFE_INTEGER })),
    ).not.toThrow();
  });

  it("accepts nonce=0", () => {
    expect(() => codec.encode(msg({ nonce: 0 }))).not.toThrow();
  });

  it("accepts schemaVersion=1 (minimum)", () => {
    expect(() => codec.encode(msg({ schemaVersion: 1 }))).not.toThrow();
  });

  it("accepts a long payload hex string", () => {
    const longPayload = "0x" + "ab".repeat(1000);
    expect(() => codec.encode(msg({ payload: longPayload }))).not.toThrow();
  });
});

// ─── Invalid inputs ───────────────────────────────────────────────────────────

describe("invalid inputs — encode", () => {
  const codec = new CanonicalPayloadCodec();

  function expectKind(m: EncodableMessage, kind: string) {
    try {
      codec.encode(m);
      throw new Error("expected PayloadEncodingError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PayloadEncodingError);
      expect((err as PayloadEncodingError).kind).toBe(kind);
    }
  }

  it("rejects empty messageId", () => expectKind(msg({ messageId: "" }), "empty-message-id"));

  it("rejects messageId over 128 chars", () =>
    expectKind(msg({ messageId: "x".repeat(129) }), "message-id-too-long"));

  it("rejects messageId with spaces", () =>
    expectKind(msg({ messageId: "has space" }), "message-id-illegal-chars"));

  it("rejects messageId with special chars", () =>
    expectKind(msg({ messageId: "msg!@#" }), "message-id-illegal-chars"));

  it("rejects sourceChainId=0", () =>
    expectKind(msg({ sourceChainId: 0 }), "invalid-chain-id"));

  it("rejects negative sourceChainId", () =>
    expectKind(msg({ sourceChainId: -1 }), "invalid-chain-id"));

  it("rejects fractional sourceChainId", () =>
    expectKind(msg({ sourceChainId: 1.5 }), "invalid-chain-id"));

  it("rejects destinationChainId=0", () =>
    expectKind(msg({ destinationChainId: 0 }), "invalid-chain-id"));

  it("rejects same source and destination chain", () =>
    expectKind(msg({ sourceChainId: 101, destinationChainId: 101 }), "same-chain"));

  it("rejects empty sender", () => expectKind(msg({ sender: "" }), "empty-sender"));

  it("rejects whitespace-only sender", () =>
    expectKind(msg({ sender: "   " }), "empty-sender"));

  it("rejects empty recipient", () =>
    expectKind(msg({ recipient: "" }), "empty-recipient"));

  it("rejects payload without 0x prefix", () =>
    expectKind(msg({ payload: "deadbeef" }), "invalid-payload-hex"));

  it("rejects payload with odd number of hex digits", () =>
    expectKind(msg({ payload: "0xabc" }), "invalid-payload-hex"));

  it("rejects payload with non-hex characters", () =>
    expectKind(msg({ payload: "0xgggg" }), "invalid-payload-hex"));

  it("rejects negative nonce", () =>
    expectKind(msg({ nonce: -1 }), "negative-nonce"));

  it("rejects fractional nonce", () =>
    expectKind(msg({ nonce: 1.5 }), "negative-nonce"));

  it("rejects schemaVersion=0", () =>
    expectKind(msg({ schemaVersion: 0 }), "invalid-schema-version"));

  it("rejects negative schemaVersion", () =>
    expectKind(msg({ schemaVersion: -1 }), "invalid-schema-version"));
});

// ─── Round-trip ───────────────────────────────────────────────────────────────

describe("round-trip (encode → decode)", () => {
  const codec = new CanonicalPayloadCodec();

  function roundTrip(m: EncodableMessage): EncodableMessage {
    return codec.decode(codec.encode(m).encoded);
  }

  it("round-trips a message with all fields", () => {
    const m = msg({ nonce: 7, schemaVersion: 2 });
    const rt = roundTrip(m);
    // Addresses are normalised to lowercase during encoding
    expect(rt.messageId).toBe(m.messageId);
    expect(rt.sourceChainId).toBe(m.sourceChainId);
    expect(rt.destinationChainId).toBe(m.destinationChainId);
    expect(rt.sender).toBe(m.sender.toLowerCase());
    expect(rt.recipient).toBe(m.recipient.toLowerCase());
    expect(rt.payload).toBe(m.payload.toLowerCase());
    expect(rt.nonce).toBe(m.nonce);
    expect(rt.schemaVersion).toBe(m.schemaVersion);
  });

  it("round-trips a minimal message (no nonce, no schemaVersion)", () => {
    const m = msg({ nonce: undefined, schemaVersion: undefined });
    const rt = roundTrip(m);
    expect(rt.nonce).toBeUndefined();
    expect(rt.schemaVersion).toBeUndefined();
  });

  it("round-trips a message with nonce only", () => {
    const m = msg({ nonce: 99, schemaVersion: undefined });
    const rt = roundTrip(m);
    expect(rt.nonce).toBe(99);
    expect(rt.schemaVersion).toBeUndefined();
  });

  it("round-trips an empty payload", () => {
    const m = msg({ payload: "0x" });
    expect(roundTrip(m).payload).toBe("0x");
  });

  it("decoded message re-encodes to the same string (full idempotency)", () => {
    const m = msg({ nonce: 3, schemaVersion: 1 });
    const first = codec.encode(m).encoded;
    const decoded = codec.decode(first);
    const second = codec.encode(decoded).encoded;
    expect(first).toBe(second);
  });
});

// ─── Decode — invalid inputs ──────────────────────────────────────────────────

describe("decode — invalid inputs", () => {
  const codec = new CanonicalPayloadCodec();

  it("rejects an empty string", () => {
    expect(() => codec.decode("")).toThrow(PayloadEncodingError);
  });

  it("rejects a string without 'v1:' prefix", () => {
    expect(() => codec.decode("v2:msg-001:101:109:0xsender:0xrecipient:0x")).toThrow(
      PayloadEncodingError,
    );
  });

  it("rejects a string with too few fields", () => {
    expect(() => codec.decode("v1:msg-001:101:109:0xsender")).toThrow(PayloadEncodingError);
  });

  it("rejects a string with a non-numeric sourceChainId", () => {
    expect(() => codec.decode("v1:msg-001:abc:109:0xsender:0xrecipient:0x")).toThrow(
      PayloadEncodingError,
    );
  });

  it("rejects decoded content that fails re-validation (invalid payload hex)", () => {
    // Manually craft a string that parses but fails validation
    const bad = "v1:msg-001:101:109:0xsender:0xrecipient:notHex";
    expect(() => codec.decode(bad)).toThrow(PayloadEncodingError);
  });

  it("rejects decoded content with same-chain IDs", () => {
    const bad = "v1:msg-001:101:101:0xsender:0xrecipient:0x";
    expect(() => codec.decode(bad)).toThrow(PayloadEncodingError);
  });
});

// ─── Simulated dependency failure ─────────────────────────────────────────────

describe("simulated dependency failure", () => {
  it("codec instance is unaffected by a previous thrown encode", () => {
    const codec = new CanonicalPayloadCodec();

    // First call: deliberately bad input
    expect(() => codec.encode(msg({ messageId: "" }))).toThrow(PayloadEncodingError);

    // Second call: valid input — codec must still work correctly
    const result = codec.encode(msg({ messageId: "msg-recovery" }));
    expect(result.encoded).toContain("msg-recovery");
  });

  it("codec instance is unaffected by a previous thrown decode", () => {
    const codec = new CanonicalPayloadCodec();

    expect(() => codec.decode("garbage")).toThrow(PayloadEncodingError);

    // Shared singleton also remains functional
    const result = canonicalPayloadCodec.encode(msg());
    expect(result.encoderVersion).toBe(1);
  });
});

// ─── PayloadEncodingError ─────────────────────────────────────────────────────

describe("PayloadEncodingError", () => {
  it("name is 'PayloadEncodingError'", () => {
    const codec = new CanonicalPayloadCodec();
    try {
      codec.encode(msg({ messageId: "" }));
    } catch (err) {
      expect((err as PayloadEncodingError).name).toBe("PayloadEncodingError");
    }
  });

  it("exposes the kind on the thrown error", () => {
    const codec = new CanonicalPayloadCodec();
    try {
      codec.encode(msg({ sourceChainId: 5, destinationChainId: 5 }));
    } catch (err) {
      expect((err as PayloadEncodingError).kind).toBe("same-chain");
    }
  });

  it("message is human-readable", () => {
    const codec = new CanonicalPayloadCodec();
    try {
      codec.encode(msg({ nonce: -3 }));
    } catch (err) {
      expect((err as Error).message).toMatch(/-3/);
    }
  });
});

// ─── Shared singleton ─────────────────────────────────────────────────────────

describe("canonicalPayloadCodec singleton", () => {
  it("is a CanonicalPayloadCodec instance", () => {
    expect(canonicalPayloadCodec).toBeInstanceOf(CanonicalPayloadCodec);
  });

  it("produces the same output as a fresh instance for the same input", () => {
    const fresh = new CanonicalPayloadCodec();
    const m = msg({ nonce: 1, schemaVersion: 1 });
    expect(canonicalPayloadCodec.encode(m).encoded).toBe(fresh.encode(m).encoded);
  });
});
