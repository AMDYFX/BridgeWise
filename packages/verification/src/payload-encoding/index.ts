/**
 * Canonical payload encoding — public API.
 *
 * @example
 * ```ts
 * import { canonicalPayloadCodec, CanonicalPayloadCodec } from '@bridgewise/verification/payload-encoding';
 * import type { EncodableMessage, EncodingResult, PayloadCodec } from '@bridgewise/verification/payload-encoding';
 *
 * const result = canonicalPayloadCodec.encode(message);
 * const roundTripped = canonicalPayloadCodec.decode(result.encoded);
 * ```
 */

export { CanonicalPayloadCodec, canonicalPayloadCodec } from "./codec";
export { PayloadEncodingError } from "./types";
export type {
  EncodableMessage,
  EncodingResult,
  EncodingErrorKind,
  PayloadCodec,
} from "./types";
