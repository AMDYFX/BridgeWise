/**
 * Constants for API request signature verification.
 *
 * Incoming requests must supply:
 *   X-BridgeWise-Timestamp  – Unix seconds (string); rejected if > CLOCK_SKEW_SECONDS old
 *   X-BridgeWise-Signature  – "sha256=<hex>" HMAC-SHA256 over the canonical string
 *
 * Canonical signing string (newline-separated, no trailing newline):
 *   <METHOD>\n<PATH>\n<TIMESTAMP>\n<HEX-SHA256-OF-BODY>
 */

export const SIGNATURE_HEADER = 'x-bridgewise-signature';
export const TIMESTAMP_HEADER = 'x-bridgewise-timestamp';

/** Maximum age (seconds) of a signed request before it is rejected. */
export const CLOCK_SKEW_SECONDS = 300; // 5 minutes

export const SIGNATURE_PREFIX = 'sha256=';

/**
 * Metadata key used by @SkipSignatureCheck() decorator.
 * Routes decorated with it bypass signature verification.
 */
export const SKIP_SIGNATURE_CHECK_KEY = 'skipSignatureCheck';
