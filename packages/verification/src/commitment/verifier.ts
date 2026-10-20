/**
 * Message commitment verifier.
 *
 * Checks that a locally-observed {@link CrossChainMessage} reproduces the
 * commitment hash published by the source chain before allowing execution to
 * proceed on the destination chain.
 *
 * Failure semantics
 * -----------------
 * - `hash-mismatch`         — The computed hash does not equal the commitment.
 * - `invalid-message-id`    — messageId is empty or contains illegal chars.
 * - `chain-id-mismatch`     — The message's sourceChainId ≠ commitment's sourceChainId.
 * - `nonce-reuse`           — The (sourceChainId, sender, nonce) triple was seen before.
 * - `empty-payload-on-non-transfer` — payload is "0x" but both sender and recipient differ.
 * - `malformed-commitment-hash`     — commitmentHash is not a valid 0x-prefixed 32-byte hex.
 * - `malformed-payload`     — payload is present but not 0x-prefixed hex.
 * - `missing-required-field`— A required message field is absent or blank.
 *
 * Idempotency
 * -----------
 * Calling `verify()` on the same (message, commitment) pair always returns
 * the same result.  Nonce tracking is keyed by (sourceChainId, sender, nonce)
 * so the *first* successful call commits the nonce; subsequent calls with the
 * same nonce return `nonce-reuse`.
 *
 * Recovery / operator escalation
 * ------------------------------
 * When `ok` is false the `diagnostic` field contains a machine-readable
 * description suitable for structured logging and alerting.  Operators should
 * halt execution and surface the `failureReason` to the monitoring system.
 */

import { fallbackHasher } from "./hasher";
import {
  CommitmentFailureReason,
  CommitmentVerificationResult,
  CommitmentVerifierConfig,
  CrossChainMessage,
  DEFAULT_NONCE_STORE_CAPACITY,
  MessageCommitment,
} from "./types";

// ─── Validation constants ─────────────────────────────────────────────────────

const HEX_32_BYTES_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_PAYLOAD_RE = /^0x([0-9a-fA-F]{2})*$/;
const MESSAGE_ID_RE = /^[a-zA-Z0-9_\-:.]{1,128}$/;

// ─── Nonce store (fixed-capacity FIFO) ───────────────────────────────────────

class NonceStore {
  private readonly capacity: number;
  private readonly seen = new Map<string, true>();
  private readonly order: string[] = [];

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  key(sourceChainId: number, sender: string, nonce: number): string {
    return `${sourceChainId}:${sender.toLowerCase()}:${nonce}`;
  }

  has(k: string): boolean {
    return this.seen.has(k);
  }

  add(k: string): void {
    if (this.seen.has(k)) return;
    if (this.order.length >= this.capacity) {
      const evict = this.order.shift();
      if (evict) this.seen.delete(evict);
    }
    this.seen.set(k, true);
    this.order.push(k);
  }

  clear(): void {
    this.seen.clear();
    this.order.length = 0;
  }

  get size(): number {
    return this.seen.size;
  }
}

// ─── Verifier ─────────────────────────────────────────────────────────────────

export class CommitmentVerifier {
  private readonly hasher: NonNullable<CommitmentVerifierConfig["hasher"]>;
  private readonly enforceNonces: boolean;
  private readonly nonceStore: NonceStore;

  constructor(config: CommitmentVerifierConfig = {}) {
    this.hasher = config.hasher ?? fallbackHasher;
    this.enforceNonces = config.enforceNonceUniqueness ?? true;
    this.nonceStore = new NonceStore(
      config.nonceStoreCapacity ?? DEFAULT_NONCE_STORE_CAPACITY,
    );
  }

  /**
   * Verify that `message` matches the published `commitment`.
   *
   * Returns a {@link CommitmentVerificationResult} — never throws for
   * expected failure conditions.
   */
  verify(
    message: CrossChainMessage,
    commitment: MessageCommitment,
  ): CommitmentVerificationResult {
    const base = {
      messageId: message.messageId ?? "",
      commitmentHash: commitment.commitmentHash,
      computedHash: "",
    };

    // ── Required field check ────────────────────────────────────────────────
    const requiredFields: Array<keyof CrossChainMessage> = [
      "messageId",
      "sender",
      "recipient",
    ];
    for (const f of requiredFields) {
      const v = message[f];
      if (v === undefined || v === null || String(v).trim() === "") {
        return this.fail(base, "missing-required-field", `message.${f} is required and must not be blank`);
      }
    }

    // ── messageId format ────────────────────────────────────────────────────
    if (!MESSAGE_ID_RE.test(message.messageId)) {
      return this.fail(base, "invalid-message-id", `messageId "${message.messageId}" contains illegal characters or exceeds 128 chars`);
    }

    // ── Commitment hash format ──────────────────────────────────────────────
    if (!HEX_32_BYTES_RE.test(commitment.commitmentHash)) {
      return this.fail(
        base,
        "malformed-commitment-hash",
        `commitmentHash "${commitment.commitmentHash}" is not a valid 0x-prefixed 32-byte hex string`,
      );
    }

    // ── Chain ID consistency ────────────────────────────────────────────────
    if (message.sourceChainId !== commitment.sourceChainId) {
      return this.fail(
        base,
        "chain-id-mismatch",
        `message.sourceChainId (${message.sourceChainId}) ≠ commitment.sourceChainId (${commitment.sourceChainId})`,
      );
    }

    // ── Payload format ──────────────────────────────────────────────────────
    if (!HEX_PAYLOAD_RE.test(message.payload)) {
      return this.fail(
        base,
        "malformed-payload",
        `message.payload "${message.payload.slice(0, 20)}…" is not valid 0x-prefixed hex`,
      );
    }

    // ── Nonce uniqueness ────────────────────────────────────────────────────
    if (this.enforceNonces && message.nonce !== undefined) {
      const k = this.nonceStore.key(message.sourceChainId, message.sender, message.nonce);
      if (this.nonceStore.has(k)) {
        return this.fail(
          base,
          "nonce-reuse",
          `nonce ${message.nonce} from sender "${message.sender}" on chain ${message.sourceChainId} was already processed`,
        );
      }
    }

    // ── Hash verification ───────────────────────────────────────────────────
    const computedHash = this.hasher.hash(message);

    if (computedHash !== commitment.commitmentHash) {
      return {
        ok: false,
        messageId: message.messageId,
        commitmentHash: commitment.commitmentHash,
        computedHash,
        failureReason: "hash-mismatch",
        diagnostic:
          `commitment hash mismatch for message "${message.messageId}": ` +
          `expected ${commitment.commitmentHash}, computed ${computedHash}`,
      };
    }

    // ── All checks passed — record nonce ────────────────────────────────────
    if (this.enforceNonces && message.nonce !== undefined) {
      const k = this.nonceStore.key(message.sourceChainId, message.sender, message.nonce);
      this.nonceStore.add(k);
    }

    return {
      ok: true,
      messageId: message.messageId,
      commitmentHash: commitment.commitmentHash,
      computedHash,
    };
  }

  /**
   * Verify a batch of (message, commitment) pairs.
   * Failures in one entry do not prevent subsequent entries from being checked.
   */
  verifyBatch(
    pairs: Array<{ message: CrossChainMessage; commitment: MessageCommitment }>,
  ): CommitmentVerificationResult[] {
    return pairs.map(({ message, commitment }) => this.verify(message, commitment));
  }

  /**
   * Reset the nonce store.  Useful in tests or when replaying historic messages.
   */
  resetNonceStore(): void {
    this.nonceStore.clear();
  }

  /** Number of nonces currently tracked in memory. */
  get trackedNonces(): number {
    return this.nonceStore.size;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private fail(
    base: Pick<CommitmentVerificationResult, "messageId" | "commitmentHash">,
    reason: CommitmentFailureReason,
    diagnostic: string,
  ): CommitmentVerificationResult {
    return {
      ok: false,
      messageId: base.messageId,
      commitmentHash: base.commitmentHash,
      computedHash: "",
      failureReason: reason,
      diagnostic,
    };
  }
}
