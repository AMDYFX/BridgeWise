import { Injectable, NestMiddleware } from '@nestjs/common';
import * as crypto from 'crypto';
import { IdempotencyStorage } from './idempotency.storage';
import { IdempotencyOptions } from './idempotency.types';

export interface IdempotencyRequest {
  method?: string;
  path?: string;
  originalUrl?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface IdempotencyResponse {
  statusCode?: number;
  status(code: number): this;
  setHeader(name: string, value: string): this | void;
  header?(name: string, value: string): this | void;
  getHeaders?(): Record<string, string | string[] | number | undefined>;
  send?(body: unknown): this | void;
  json(body: unknown): this | void;
  end?(chunk?: unknown): this | void;
}

@Injectable()
export class IdempotencyMiddleware implements NestMiddleware {
  private headerNames: string[];
  private ttlMs: number;
  private enforcePayloadMatch: boolean;
  private methods: Set<string>;
  private maxKeyLength: number;

  constructor(
    private readonly storage: IdempotencyStorage,
    options?: IdempotencyOptions,
  ) {
    this.headerNames = (options?.headerNames ?? ['idempotency-key', 'x-idempotency-key']).map(h =>
      h.toLowerCase(),
    );
    this.ttlMs = options?.ttlMs ?? 24 * 60 * 60 * 1000; // 24 hours
    this.enforcePayloadMatch = options?.enforcePayloadMatch ?? true;
    this.methods = new Set((options?.methods ?? ['POST', 'PUT', 'PATCH', 'DELETE']).map(m => m.toUpperCase()));
    this.maxKeyLength = options?.maxKeyLength ?? 128;
  }

  generateFingerprint(method: string, path: string, body: unknown): string {
    const payloadStr = body !== undefined && body !== null ? JSON.stringify(body) : '';
    const hash = crypto.createHash('sha256');
    hash.update(`${method.toUpperCase()}:${path}:${payloadStr}`);
    return hash.digest('hex');
  }

  extractKey(headers?: Record<string, string | string[] | undefined>): string | undefined {
    if (!headers) return undefined;
    for (const h of this.headerNames) {
      const val = headers[h];
      if (val) {
        const key = Array.isArray(val) ? val[0] : val;
        if (typeof key === 'string' && key.trim()) {
          return key.trim();
        }
      }
    }
    return undefined;
  }

  use(req: IdempotencyRequest, res: IdempotencyResponse, next: () => void): void {
    const method = (req.method || 'GET').toUpperCase();

    // Only apply to mutating requests by default
    if (!this.methods.has(method)) {
      next();
      return;
    }

    const idempotencyKey = this.extractKey(req.headers);
    if (!idempotencyKey) {
      next();
      return;
    }

    // Validate key length
    if (idempotencyKey.length > this.maxKeyLength) {
      res.status(400).json({
        statusCode: 400,
        error: 'Bad Request',
        message: `Idempotency key exceeds maximum allowed length of ${this.maxKeyLength} characters`,
      });
      return;
    }

    const path = req.path || req.originalUrl || req.url || '';
    const fingerprint = this.generateFingerprint(method, path, req.body);
    const existing = this.storage.get(idempotencyKey);

    if (existing) {
      // 1. Verify payload match
      if (this.enforcePayloadMatch && existing.requestFingerprint !== fingerprint) {
        res.status(422).json({
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: 'Idempotency key reused with mismatched request method, path, or payload',
        });
        return;
      }

      // 2. Concurrent in-flight request
      if (existing.status === 'pending') {
        if (typeof res.setHeader === 'function') {
          res.setHeader('Retry-After', '1');
        }
        res.status(409).json({
          statusCode: 409,
          error: 'Conflict',
          message: 'A request with this idempotency key is currently being processed',
        });
        return;
      }

      // 3. Completed: return cached response
      if (typeof res.setHeader === 'function') {
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('Idempotent-Replayed', 'true');
        if (existing.responseHeaders) {
          for (const [k, v] of Object.entries(existing.responseHeaders)) {
            if (k.toLowerCase() !== 'x-cache' && k.toLowerCase() !== 'idempotent-replayed') {
              res.setHeader(k, v);
            }
          }
        }
      }

      res.status(existing.statusCode || 200).json(existing.responseBody);
      return;
    }

    // Mark as pending
    const now = Date.now();
    this.storage.set({
      key: idempotencyKey,
      status: 'pending',
      requestFingerprint: fingerprint,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    });

    if (typeof res.setHeader === 'function') {
      res.setHeader('X-Cache', 'MISS');
    }

    // Intercept response completion
    const originalJson = res.json.bind(res);
    const originalSend = res.send ? res.send.bind(res) : undefined;

    const captureAndSave = (body: unknown) => {
      const statusCode = res.statusCode || 200;
      let headersToStore: Record<string, string> | undefined;
      if (typeof res.getHeaders === 'function') {
        const rawHeaders = res.getHeaders();
        headersToStore = {};
        for (const [k, v] of Object.entries(rawHeaders)) {
          if (v !== undefined) {
            headersToStore[k] = String(v);
          }
        }
      }

      this.storage.set({
        key: idempotencyKey,
        status: 'completed',
        requestFingerprint: fingerprint,
        statusCode,
        responseHeaders: headersToStore,
        responseBody: body,
        createdAt: now,
        expiresAt: now + this.ttlMs,
      });
    };

    res.json = (body: unknown) => {
      captureAndSave(body);
      return originalJson(body);
    };

    if (originalSend) {
      res.send = (body: unknown) => {
        captureAndSave(body);
        return originalSend(body);
      };
    }

    next();
  }
}
