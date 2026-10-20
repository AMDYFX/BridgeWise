/**
 * Message commitment verification — unit tests.
 *
 * All tests use the FallbackHasher (deterministic, non-cryptographic) so the
 * suite is fully self-contained with no I/O or external dependencies.
 *
 * Coverage: success path, every failure reason, boundary inputs, idempotency,
 * nonce-reuse detection, batch verification, nonce-store eviction.
 */

import { CommitmentVerifier } from "../verifier";
import { FallbackHasher, encodeMessage } from "../hasher";
import type {
  CrossChainMessage,
  MessageCommitment,
  MessageHasher,
} from "../types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const hasher = new FallbackHasher();

function makeMessage(overrides: Partial<CrossChainMessage> = {}): CrossChainMessage {
  return {
    messageId: "msg-001",
    sourceChainId: 101,
    destinationChainId: 109,
    sender: "0xSenderAddress",
    recipient: "0xRecipientAddress",
    payload: "0xdeadbeef",
    nonce: 1,
    schemaVersion: 1,
    ...overrides,
  };
}

function makeCommitment(
  message: CrossChainMessage,
  overrides: Partial<MessageCommitment> = {},
): MessageCommitment {
  return {
    commitmentHash: hasher.hash(message),
    sourceChainId: message.sourceChainId,
    blockNumber: 100,
    observedAt: Date.now(),
    ...overrides,
  };
}

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("CommitmentVerifier — success path", () => {
  it("returns ok=true when hash matches", () => {
    const verifier = new CommitmentVerifier({ hasher });
    const msg = makeMessage();
    const result = verifier.verify(msg, makeCommitment(msg));
    expect(result.ok).toBe(true);
    expect(result.failureReason).toBeUndefined();
    expect(result.diagnostic).toBeUndefined();
    expect(result.computedHash).toBe(hasher.hash(msg));
  });

  it("records messageId and commitmentHash in a successful result", () => {
    const verifier = new CommitmentVerifier({ hasher });
    const msg = makeMessage();
    const commitment = makeCommitment(msg);
    const result = verifier.verify(msg, commitment);
    expect(result.messageId).toBe(msg.messageId);
    expect(result.commitmentHash).toBe(commitment.commitmentHash);
  });

  it("accepts a message without a nonce", () => {
    const verifier = new CommitmentVerifier({ hasher });
    const msg = makeMessage({ nonce: undefined });
    const result = verifier.verify(msg, makeCommitment(msg));
    expect(result.ok).toBe(true);
  });

  it("accepts a message without a schemaVersion", () => {
    const verifier = new CommitmentVerifier({ hasher });
    const msg = makeMessage({ schemaVersion: undefined });
    const result = verifier.verify(msg, makeCommitment(msg));
    expect(result.ok).toBe(true);
  });

  it("accepts an empty payload (pure value transfer)", () => {
    const verifier = new CommitmentVerifier({ hasher });
    const msg = makeMessage({ payload: "0x" });
    const result = verifier.verify(msg, makeCommitment(msg));
    expect(result.ok).toBe(true);
  });
});

// ─── hash-mismatch ────────────────────────────────────────────────────────────

describe("failure: hash-mismatch", () => {
  it("fails when the commitment hash does not match", () => {
    const verifier = new CommitmentVerifier({ hasher });
    const msg = makeMessage();
    const commitment = makeCommitment(msg, {
      commitmentHash: "0x" + "ab".repeat(32),
    });
    const result = verifier.verify(msg, commitment);
    expect(result.ok).toBe(false);
    expect(result.failureReason).toBe("hash-mismatch");
    expect(result.diagnostic).toMatch(/commitment hash mismatch/);
    expect(result.computedHash).toBe(hasher.hash(msg));
  });

  it("fails when sender case differs from what was hashed", () => {
    const verifier = new CommitmentVerifier({ hasher });
    const msgLower = makeMessage({ sender: "0xsenderaddress" });
    const msgUpper = makeMessage({ sender: "0xSENDERADDRESS" });
    // Both should hash to the same value (canonical encoding lowercases sender)
    expect(hasher.hash(msgLower)).toBe(hasher.hash(msgUpper));
    const result = verifier.verify(msgUpper, makeCommitment(msgLower));
    expect(result.ok).toBe(true);
  });
});

// ─── malformed-commitment-hash ────────────────────────────────────────────────

describe("failure: malformed-commitment-hash", () => {
  it.each([
    ["too short", "0xabcdef"],
    ["no 0x prefix", "ab".repeat(32)],
    ["odd length", "0x" + "a".repeat(63)],
    ["non-hex chars", "0x" + "zz".repeat(32)],
  ])("rejects %s", (_label, badHash) => {
    const verifier = new CommitmentVerifier({ hasher });
    const msg = makeMessage();
    const commitment = makeCommitment(msg, { commitmentHash: badHash });
    const result = verifier.verify(msg, commitment);
    expect(result.ok).toBe(false);
    expect(result.failureReason).toBe("malformed-commitment-hash");
  });
});

// ─── missing-required-field ───────────────────────────────────────────────────

describe("failure: missing-required-field", () => {
  it.each([
    ["messageId missing", { messageId: "" }],
    ["sender missing", { sender: "" }],
    ["recipient missing", { recipient: "" }],
  ] as Array<[string, Partial<CrossChainMessage>]>)("rejects when %s", (_label, override) => {
    const verifier = new CommitmentVerifier({ hasher });
    const msg = makeMessage(override);
    const result = verifier.verify(msg, makeCommitment(makeMessage()));
    expect(result.ok).toBe(false);
    expect(result.failureReason).toBe("missing-required-field");
  });
});

// ─── invalid-message-id ──────────────────────────────────────────────────────

describe("failure: invalid-message-id", () => {
  it("rejects a messageId with illegal characters", () => {
    const verifier = new CommitmentVerifier({ hasher });
    const msg = makeMessage({ messageId: "msg with spaces!" });
    const result = verifier.verify(msg, makeCommitment(makeMessage()));
    expect(result.ok).toBe(false);
    expect(result.failureReason).toBe("invalid-message-id");
  });

  it("rejects a messageId that exceeds 128 characters", () => {
    const verifier = new CommitmentVerifier({ hasher });
    const msg = makeMessage({ messageId: "a".repeat(129) });
    const result = verifier.verify(msg, makeCommitment(makeMessage()));
    expect(result.ok).toBe(false);
    expect(result.failureReason).toBe("invalid-message-id");
  });

  it("accepts a messageId exactly 128 characters long", () => {
    const verifier = new CommitmentVerifier({ hasher });
    const msg = makeMessage({ messageId: "a".repeat(128) });
    const result = verifier.verify(msg, makeCommitment(msg));
    expect(result.ok).toBe(true);
  });
});

// ─── chain-id-mismatch ───────────────────────────────────────────────────────

describe("failure: chain-id-mismatch", () => {
  it("rejects when message.sourceChainId ≠ commitment.sourceChainId", () => {
    const verifier = new CommitmentVerifier({ hasher });
    const msg = makeMessage({ sourceChainId: 101 });
    const commitment = makeCommitment(msg, { sourceChainId: 102 });
    const result = verifier.verify(msg, commitment);
    expect(result.ok).toBe(false);
    expect(result.failureReason).toBe("chain-id-mismatch");
    expect(result.diagnostic).toMatch(/101.*102/);
  });
});

// ─── malformed-payload ───────────────────────────────────────────────────────

describe("failure: malformed-payload", () => {
  it.each([
    ["no 0x prefix", "deadbeef"],
    ["odd hex digits", "0xdeadbee"],
    ["non-hex chars", "0xgggg"],
  ])("rejects payload: %s", (_label, payload) => {
    const verifier = new CommitmentVerifier({ hasher });
    const msg = makeMessage({ payload });
    const commitment = makeCommitment(makeMessage()); // valid commitment for a different payload
    const result = verifier.verify(msg, commitment);
    expect(result.ok).toBe(false);
    expect(result.failureReason).toBe("malformed-payload");
  });
});

// ─── nonce-reuse ─────────────────────────────────────────────────────────────

describe("nonce-reuse detection", () => {
  it("rejects a duplicate (sourceChainId, sender, nonce) triple", () => {
    const verifier = new CommitmentVerifier({ hasher });
    const msg1 = makeMessage({ messageId: "msg-001", nonce: 1 });
    const msg2 = makeMessage({ messageId: "msg-002", nonce: 1 }); // same nonce, different messageId

    verifier.verify(msg1, makeCommitment(msg1));
    const result = verifier.verify(msg2, makeCommitment(msg2));

    expect(result.ok).toBe(false);
    expect(result.failureReason).toBe("nonce-reuse");
    expect(result.diagnostic).toMatch(/nonce 1/);
  });

  it("allows the same nonce on a different sourceChainId", () => {
    const verifier = new CommitmentVerifier({ hasher });
    const msg1 = makeMessage({ sourceChainId: 101, nonce: 1 });
    const msg2 = makeMessage({ sourceChainId: 102, nonce: 1, messageId: "msg-002" });

    verifier.verify(msg1, makeCommitment(msg1));
    const result = verifier.verify(msg2, makeCommitment(msg2));

    expect(result.ok).toBe(true);
  });

  it("allows the same nonce from a different sender", () => {
    const verifier = new CommitmentVerifier({ hasher });
    const msg1 = makeMessage({ sender: "0xAlice", nonce: 1, messageId: "msg-001" });
    const msg2 = makeMessage({ sender: "0xBob", nonce: 1, messageId: "msg-002" });

    verifier.verify(msg1, makeCommitment(msg1));
    const result = verifier.verify(msg2, makeCommitment(msg2));

    expect(result.ok).toBe(true);
  });

  it("does not track nonces when enforceNonceUniqueness is false", () => {
    const verifier = new CommitmentVerifier({ hasher, enforceNonceUniqueness: false });
    const msg1 = makeMessage({ messageId: "msg-001", nonce: 1 });
    const msg2 = makeMessage({ messageId: "msg-002", nonce: 1 });

    verifier.verify(msg1, makeCommitment(msg1));
    const result = verifier.verify(msg2, makeCommitment(msg2));

    expect(result.ok).toBe(true);
  });

  it("reports trackedNonces count after successful verifications", () => {
    const verifier = new CommitmentVerifier({ hasher });
    expect(verifier.trackedNonces).toBe(0);

    const msg1 = makeMessage({ messageId: "msg-001", nonce: 1 });
    const msg2 = makeMessage({ messageId: "msg-002", nonce: 2 });

    verifier.verify(msg1, makeCommitment(msg1));
    expect(verifier.trackedNonces).toBe(1);
    verifier.verify(msg2, makeCommitment(msg2));
    expect(verifier.trackedNonces).toBe(2);
  });

  it("resetNonceStore clears tracked nonces", () => {
    const verifier = new CommitmentVerifier({ hasher });
    const msg = makeMessage({ nonce: 5, messageId: "msg-005" });
    verifier.verify(msg, makeCommitment(msg));
    expect(verifier.trackedNonces).toBe(1);

    verifier.resetNonceStore();
    expect(verifier.trackedNonces).toBe(0);
  });

  it("evicts old nonces when nonceStoreCapacity is reached", () => {
    const verifier = new CommitmentVerifier({ hasher, nonceStoreCapacity: 3 });

    for (let i = 1; i <= 3; i++) {
      const msg = makeMessage({ messageId: `msg-00${i}`, nonce: i });
      verifier.verify(msg, makeCommitment(msg));
    }
    expect(verifier.trackedNonces).toBe(3);

    // Adding a 4th evicts nonce 1
    const msg4 = makeMessage({ messageId: "msg-004", nonce: 4 });
    verifier.verify(msg4, makeCommitment(msg4));
    expect(verifier.trackedNonces).toBe(3); // still 3 — oldest evicted

    // Nonce 1 was evicted: reusing it should now succeed (no reuse detection)
    const msgReuse = makeMessage({ messageId: "msg-reuse", nonce: 1 });
    const result = verifier.verify(msgReuse, makeCommitment(msgReuse));
    expect(result.ok).toBe(true);
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe("idempotency", () => {
  it("returns identical results when verify is called twice on a failing pair", () => {
    const verifier = new CommitmentVerifier({ hasher });
    const msg = makeMessage();
    const commitment = makeCommitment(msg, { commitmentHash: "0x" + "cd".repeat(32) });

    const r1 = verifier.verify(msg, commitment);
    const r2 = verifier.verify(msg, commitment);

    expect(r1).toEqual(r2);
  });
});

// ─── Batch verification ───────────────────────────────────────────────────────

describe("verifyBatch", () => {
  it("verifies each pair independently", () => {
    const verifier = new CommitmentVerifier({ hasher });
    const msg1 = makeMessage({ messageId: "batch-1", nonce: 10 });
    const msg2 = makeMessage({ messageId: "batch-2", nonce: 11 });
    const badMsg = makeMessage({ messageId: "batch-3", nonce: 12 });

    const results = verifier.verifyBatch([
      { message: msg1, commitment: makeCommitment(msg1) },
      { message: msg2, commitment: makeCommitment(msg2) },
      { message: badMsg, commitment: makeCommitment(msg1) }, // wrong commitment
    ]);

    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(true);
    expect(results[2].ok).toBe(false);
    expect(results[2].failureReason).toBe("hash-mismatch");
  });

  it("a failure in one batch entry does not prevent subsequent entries being checked", () => {
    const verifier = new CommitmentVerifier({ hasher });
    const good = makeMessage({ messageId: "batch-good", nonce: 20 });
    const bad = makeMessage({ messageId: "" }); // missing messageId

    const results = verifier.verifyBatch([
      { message: bad, commitment: makeCommitment(makeMessage()) },
      { message: good, commitment: makeCommitment(good) },
    ]);

    expect(results[0].ok).toBe(false);
    expect(results[1].ok).toBe(true);
  });
});

// ─── Custom hasher ────────────────────────────────────────────────────────────

describe("custom hasher injection", () => {
  it("uses the injected hasher for hash computation", () => {
    const fixedHash = "0x" + "ff".repeat(32);
    const customHasher: MessageHasher = { hash: () => fixedHash };
    const verifier = new CommitmentVerifier({ hasher: customHasher });

    const msg = makeMessage();
    const commitment = makeCommitment(msg, { commitmentHash: fixedHash });
    const result = verifier.verify(msg, commitment);

    expect(result.ok).toBe(true);
    expect(result.computedHash).toBe(fixedHash);
  });
});

// ─── encodeMessage ────────────────────────────────────────────────────────────

describe("encodeMessage", () => {
  it("is deterministic across calls", () => {
    const msg = makeMessage();
    expect(encodeMessage(msg)).toBe(encodeMessage(msg));
  });

  it("differs when messageId changes", () => {
    const a = makeMessage({ messageId: "msg-a" });
    const b = makeMessage({ messageId: "msg-b" });
    expect(encodeMessage(a)).not.toBe(encodeMessage(b));
  });

  it("lowercases sender and recipient", () => {
    const upper = makeMessage({ sender: "0xABCDEF", recipient: "0xFEDCBA" });
    const lower = makeMessage({ sender: "0xabcdef", recipient: "0xfedcba" });
    expect(encodeMessage(upper)).toBe(encodeMessage(lower));
  });

  it("includes nonce and schemaVersion when present", () => {
    const without = encodeMessage(makeMessage({ nonce: undefined, schemaVersion: undefined }));
    const withNonce = encodeMessage(makeMessage({ nonce: 5, schemaVersion: undefined }));
    const withBoth = encodeMessage(makeMessage({ nonce: 5, schemaVersion: 2 }));
    expect(without).not.toBe(withNonce);
    expect(withNonce).not.toBe(withBoth);
  });
});
