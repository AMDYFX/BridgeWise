import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  CLOCK_SKEW_SECONDS,
  SIGNATURE_PREFIX,
} from './request-signature.constants';

export interface SignatureVerificationResult {
  valid: boolean;
  reason?: string;
}

@Injectable()
export class RequestSignatureService {
  private readonly logger = new Logger(RequestSignatureService.name);

  // ──────────────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Verifies an incoming signed API request.
   *
   * @param method      HTTP method (uppercase, e.g. "POST")
   * @param path        Request path including query string (e.g. "/v1/quotes?chain=stellar")
   * @param timestampHeader  Value of X-BridgeWise-Timestamp header (Unix seconds as string)
   * @param signatureHeader  Value of X-BridgeWise-Signature header ("sha256=<hex>")
   * @param rawBody     Raw request body bytes (Buffer or string); empty string for GET/DELETE
   * @param secret      Shared HMAC secret for this client/partner
   */
  verify(
    method: string,
    path: string,
    timestampHeader: string | undefined,
    signatureHeader: string | undefined,
    rawBody: Buffer | string,
    secret: string,
  ): SignatureVerificationResult {
    if (!timestampHeader) {
      return { valid: false, reason: 'missing X-BridgeWise-Timestamp header' };
    }

    if (!signatureHeader) {
      return { valid: false, reason: 'missing X-BridgeWise-Signature header' };
    }

    // Validate timestamp to prevent replay attacks
    const timestampResult = this.validateTimestamp(timestampHeader);
    if (!timestampResult.valid) {
      return timestampResult;
    }

    // Validate signature format
    if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) {
      return {
        valid: false,
        reason: `signature must begin with "${SIGNATURE_PREFIX}"`,
      };
    }

    const providedHex = signatureHeader.slice(SIGNATURE_PREFIX.length);

    // Compute expected signature
    const canonical = this.buildCanonicalString(
      method,
      path,
      timestampHeader,
      rawBody,
    );
    const expected = this.sign(canonical, secret);

    // Constant-time comparison to prevent timing attacks
    try {
      const expectedBuf = Buffer.from(expected, 'hex');
      const providedBuf = Buffer.from(providedHex, 'hex');

      if (expectedBuf.length !== providedBuf.length) {
        return { valid: false, reason: 'signature length mismatch' };
      }

      const match = timingSafeEqual(expectedBuf, providedBuf);
      if (!match) {
        return { valid: false, reason: 'signature mismatch' };
      }
    } catch {
      return { valid: false, reason: 'malformed signature hex' };
    }

    return { valid: true };
  }

  /**
   * Signs a canonical string and returns only the hex digest (no prefix).
   * Use `buildSignatureHeader()` to get the full header value.
   */
  sign(canonicalString: string, secret: string): string {
    return createHmac('sha256', secret)
      .update(canonicalString, 'utf8')
      .digest('hex');
  }

  /**
   * Builds the full value for the X-BridgeWise-Signature header.
   *
   * @param method     HTTP method (uppercase)
   * @param path       Request path + query string
   * @param timestamp  Unix seconds (string)
   * @param body       Raw body bytes or string
   * @param secret     Shared HMAC secret
   */
  buildSignatureHeader(
    method: string,
    path: string,
    timestamp: string,
    body: Buffer | string,
    secret: string,
  ): string {
    const canonical = this.buildCanonicalString(method, path, timestamp, body);
    const hex = this.sign(canonical, secret);
    return `${SIGNATURE_PREFIX}${hex}`;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Canonical signing string format:
   *   METHOD\nPATH\nTIMESTAMP\nHEX-SHA256(body)
   */
  buildCanonicalString(
    method: string,
    path: string,
    timestamp: string,
    body: Buffer | string,
  ): string {
    const bodyHash = createHash('sha256')
      .update(typeof body === 'string' ? body : body)
      .digest('hex');

    return [method.toUpperCase(), path, timestamp, bodyHash].join('\n');
  }

  private validateTimestamp(
    timestampHeader: string,
  ): SignatureVerificationResult {
    const ts = Number(timestampHeader);

    if (!Number.isFinite(ts) || ts <= 0) {
      return { valid: false, reason: 'X-BridgeWise-Timestamp is not a valid Unix timestamp' };
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const age = nowSeconds - ts;

    if (age > CLOCK_SKEW_SECONDS) {
      return {
        valid: false,
        reason: `request timestamp is too old (${age}s > ${CLOCK_SKEW_SECONDS}s allowed)`,
      };
    }

    if (age < -CLOCK_SKEW_SECONDS) {
      return {
        valid: false,
        reason: `request timestamp is too far in the future (skew: ${-age}s)`,
      };
    }

    return { valid: true };
  }
}
