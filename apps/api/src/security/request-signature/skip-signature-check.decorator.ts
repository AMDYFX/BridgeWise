import { SetMetadata } from '@nestjs/common';
import { SKIP_SIGNATURE_CHECK_KEY } from './request-signature.constants';

/**
 * Decorator that marks a route as exempt from HMAC signature verification.
 *
 * Usage:
 *   @SkipSignatureCheck()
 *   @Get('health')
 *   healthCheck() { ... }
 */
export const SkipSignatureCheck = () =>
  SetMetadata(SKIP_SIGNATURE_CHECK_KEY, true);
