import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import {
  SIGNATURE_HEADER,
  SKIP_SIGNATURE_CHECK_KEY,
  TIMESTAMP_HEADER,
} from './request-signature.constants';
import { RequestSignatureService } from './request-signature.service';

/**
 * RequestSignatureGuard
 * ─────────────────────
 * Validates HMAC-SHA256 request signatures on incoming API calls.
 *
 * Expected headers:
 *   X-BridgeWise-Timestamp  – Unix epoch seconds (string)
 *   X-BridgeWise-Signature  – "sha256=<hex>" over canonical signing string
 *
 * Canonical string format (newline-joined):
 *   METHOD\nPATH\nTIMESTAMP\nSHA256(rawBody)
 *
 * Routes can opt out via the @SkipSignatureCheck() decorator.
 *
 * The guard reads the raw body from `req.rawBody` (Buffer).  To populate
 * that field add the raw-body middleware in main.ts:
 *
 *   app.use((req, _res, next) => {
 *     express.raw({ type: '*\/*' })(req, _res, (err) => {
 *       if (!err) (req as any).rawBody = req.body;
 *       next(err);
 *     });
 *   });
 *
 * Or set `verify` on the `bodyParser.json()` middleware.
 */
@Injectable()
export class RequestSignatureGuard implements CanActivate {
  private readonly logger = new Logger(RequestSignatureGuard.name);

  constructor(
    private readonly signatureService: RequestSignatureService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    // Allow routes that explicitly opt out
    const skip = this.reflector.getAllAndOverride<boolean>(
      SKIP_SIGNATURE_CHECK_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (skip) return true;

    const request = context.switchToHttp().getRequest<Request>();

    // Retrieve the raw body captured before JSON parsing
    const rawBody: Buffer | string = (request as any).rawBody ?? '';

    const timestampHeader = request.headers[TIMESTAMP_HEADER] as string | undefined;
    const signatureHeader = request.headers[SIGNATURE_HEADER] as string | undefined;

    // Secret is expected to be attached to the request by prior auth middleware/guard
    const secret: string | undefined = (request as any).signatureSecret;
    if (!secret) {
      this.logger.warn(
        `No signature secret available for ${request.method} ${request.path}. ` +
          'Ensure auth middleware populates req.signatureSecret before this guard runs.',
      );
      throw new UnauthorizedException('API signature secret not configured for this client');
    }

    const result = this.signatureService.verify(
      request.method,
      request.originalUrl || request.url,
      timestampHeader,
      signatureHeader,
      rawBody,
      secret,
    );

    if (!result.valid) {
      this.logger.warn(
        `Invalid request signature [${request.method} ${request.path}]: ${result.reason}`,
      );
      throw new UnauthorizedException(`Invalid request signature: ${result.reason}`);
    }

    return true;
  }
}
