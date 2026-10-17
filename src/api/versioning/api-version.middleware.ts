import { Injectable, NestMiddleware } from '@nestjs/common';
import { ApiVersionService } from './api-version.service';

export interface RequestLike {
  path?: string;
  originalUrl?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  apiVersion?: string;
}

export interface ResponseLike {
  setHeader(name: string, value: string): this | void;
  header?(name: string, value: string): this | void;
  status(code: number): this;
  json(body: unknown): this | void;
}

@Injectable()
export class ApiVersionMiddleware implements NestMiddleware {
  constructor(private readonly apiVersionService: ApiVersionService) {}

  use(req: RequestLike, res: ResponseLike, next: () => void): void {
    const path = req.path || req.originalUrl || req.url || '';
    const resolution = this.apiVersionService.resolveVersion({
      path,
      headers: req.headers,
      query: req.query,
    });

    if (!resolution.valid) {
      const statusCode = resolution.status === 'sunset' ? 410 : 400;
      res.status(statusCode).json({
        statusCode,
        error: resolution.status === 'sunset' ? 'Gone' : 'Bad Request',
        message: resolution.error,
        version: resolution.version,
      });
      return;
    }

    // Attach resolved version to request object
    req.apiVersion = resolution.version;

    // Set standard response headers
    const headers = this.apiVersionService.getResponseHeaders(resolution);
    for (const [key, value] of Object.entries(headers)) {
      if (typeof res.setHeader === 'function') {
        res.setHeader(key, value);
      } else if (typeof res.header === 'function') {
        res.header(key, value);
      }
    }

    next();
  }
}
