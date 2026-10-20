/**
 * Message commitment verification — public API.
 *
 * @example
 * ```ts
 * import { CommitmentVerifier, encodeMessage } from '@bridgewise/verification/commitment';
 * import type { CrossChainMessage, MessageCommitment } from '@bridgewise/verification/commitment';
 *
 * const verifier = new CommitmentVerifier({ hasher: myKeccak256Hasher });
 * const result = verifier.verify(message, commitment);
 * if (!result.ok) {
 *   logger.error('commitment check failed', { reason: result.failureReason, diagnostic: result.diagnostic });
 * }
 * ```
 */

export { CommitmentVerifier } from "./verifier";
export { FallbackHasher, fallbackHasher, encodeMessage } from "./hasher";
export type {
  CrossChainMessage,
  MessageCommitment,
  CommitmentVerificationResult,
  CommitmentFailureReason,
  CommitmentVerifierConfig,
  MessageHasher,
} from "./types";
export { DEFAULT_NONCE_STORE_CAPACITY } from "./types";
