import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

/**
 * RawBodyMiddleware
 * ─────────────────
 * Captures the raw request body as a Buffer on `req.rawBody` before
 * the JSON body-parser discards the original bytes.
 *
 * Must be registered before NestJS's built-in body parsers.
 * In main.ts, disable the default body parser and apply this middleware:
 *
 *   const app = await NestFactory.create(AppModule, { bodyParser: false });
 *   app.use(new RawBodyMiddleware().use);
 *   app.use(express.json());
 *   app.use(express.urlencoded({ extended: true }));
 *
 * After registration `req.rawBody` (Buffer) is available throughout the
 * request lifecycle, including inside guards and interceptors.
 */
@Injectable()
export class RawBodyMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => chunks.push(chunk));

    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      (req as any).rawBody = raw;

      // Re-hydrate req.body from the raw bytes so the JSON body-parser
      // still works for downstream handlers.
      if (raw.length > 0) {
        const contentType = req.headers['content-type'] ?? '';
        if (contentType.includes('application/json')) {
          try {
            req.body = JSON.parse(raw.toString('utf8'));
          } catch {
            // Leave req.body unparsed; ValidationPipe will handle the error
          }
        }
      }

      next();
    });

    req.on('error', (err) => next(err));
  }
}
