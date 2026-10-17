import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

export interface ProviderResponseCaptureRecord {
  id: string;
  providerId: string;
  endpoint: string;
  method: string;
  statusCode: number;
  latencyMs: number;
  requestHeaders?: Record<string, string>;
  requestBody?: unknown;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  error?: string;
  capturedAt: Date;
}

export interface CaptureOptions {
  providerId: string;
  endpoint: string;
  method: string;
  statusCode: number;
  latencyMs: number;
  requestHeaders?: Record<string, string>;
  requestBody?: unknown;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  error?: string;
}

export interface ProviderResponseFilter {
  providerId?: string;
  endpoint?: string;
  minStatusCode?: number;
  maxStatusCode?: number;
  from?: Date;
  to?: Date;
  hasError?: boolean;
  limit?: number;
}

export interface ProviderResponseCaptureStats {
  totalCaptured: number;
  successCount: number;
  failureCount: number;
  averageLatencyMs: number;
  statusCodes: Record<number, number>;
}

const SENSITIVE_KEYS = new Set([
  'authorization',
  'auth',
  'apikey',
  'api_key',
  'secret',
  'privatekey',
  'private_key',
  'token',
  'access_token',
  'password',
  'secret_key',
  'secretkey',
]);

function redactSensitiveData<T>(data: T): T {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(item => redactSensitiveData(item)) as unknown as T;
  }

  if (typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if (SENSITIVE_KEYS.has(lower) || lower.includes('secret') || lower.includes('token') || lower.includes('password')) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = redactSensitiveData(value);
      }
    }
    return result as T;
  }

  return data;
}

@Injectable()
export class ProviderResponseCaptureService {
  private records: ProviderResponseCaptureRecord[] = [];
  private maxRecords: number;

  constructor(maxRecords = 1000) {
    this.maxRecords = maxRecords;
  }

  /**
   * Captures and sanitizes raw provider request and response telemetry.
   */
  captureResponse(options: CaptureOptions): ProviderResponseCaptureRecord {
    const sanitizedRequestHeaders = options.requestHeaders
      ? redactSensitiveData(options.requestHeaders)
      : undefined;
    const sanitizedRequestBody = options.requestBody !== undefined
      ? redactSensitiveData(options.requestBody)
      : undefined;
    const sanitizedResponseHeaders = options.responseHeaders
      ? redactSensitiveData(options.responseHeaders)
      : undefined;
    const sanitizedResponseBody = options.responseBody !== undefined
      ? redactSensitiveData(options.responseBody)
      : undefined;

    const record: ProviderResponseCaptureRecord = {
      id: crypto.randomUUID(),
      providerId: options.providerId,
      endpoint: options.endpoint,
      method: options.method.toUpperCase(),
      statusCode: options.statusCode,
      latencyMs: Math.max(0, options.latencyMs),
      requestHeaders: sanitizedRequestHeaders,
      requestBody: sanitizedRequestBody,
      responseHeaders: sanitizedResponseHeaders,
      responseBody: sanitizedResponseBody,
      error: options.error,
      capturedAt: new Date(),
    };

    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.shift();
    }

    return record;
  }

  /**
   * Wraps an asynchronous provider execution, measures latency, captures outcomes, and records errors.
   */
  async wrapRequest<T>(
    providerId: string,
    endpoint: string,
    method: string,
    requestFn: () => Promise<{ statusCode: number; body: T; headers?: Record<string, string> }>,
    metadata?: { requestBody?: unknown; requestHeaders?: Record<string, string> },
  ): Promise<{ result: T; record: ProviderResponseCaptureRecord }> {
    const startTime = Date.now();
    try {
      const response = await requestFn();
      const latencyMs = Date.now() - startTime;
      const record = this.captureResponse({
        providerId,
        endpoint,
        method,
        statusCode: response.statusCode,
        latencyMs,
        requestBody: metadata?.requestBody,
        requestHeaders: metadata?.requestHeaders,
        responseHeaders: response.headers,
        responseBody: response.body,
      });
      return { result: response.body, record };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);
      const record = this.captureResponse({
        providerId,
        endpoint,
        method,
        statusCode: 500,
        latencyMs,
        requestBody: metadata?.requestBody,
        requestHeaders: metadata?.requestHeaders,
        error: errorMessage,
      });
      throw err;
    }
  }

  /**
   * Retrieves records matching optional filtering criteria.
   */
  getRecords(filter?: ProviderResponseFilter): ProviderResponseCaptureRecord[] {
    let result = [...this.records];

    if (!filter) {
      return result;
    }

    if (filter.providerId) {
      result = result.filter(r => r.providerId === filter.providerId);
    }

    if (filter.endpoint) {
      result = result.filter(r => r.endpoint.includes(filter.endpoint!));
    }

    if (filter.minStatusCode !== undefined) {
      result = result.filter(r => r.statusCode >= filter.minStatusCode!);
    }

    if (filter.maxStatusCode !== undefined) {
      result = result.filter(r => r.statusCode <= filter.maxStatusCode!);
    }

    if (filter.hasError !== undefined) {
      result = result.filter(r => (filter.hasError ? Boolean(r.error || r.statusCode >= 400) : !r.error && r.statusCode < 400));
    }

    if (filter.from) {
      result = result.filter(r => r.capturedAt >= filter.from!);
    }

    if (filter.to) {
      result = result.filter(r => r.capturedAt <= filter.to!);
    }

    if (filter.limit !== undefined && filter.limit > 0) {
      result = result.slice(-filter.limit);
    }

    return result;
  }

  /**
   * Aggregates metrics for captured responses.
   */
  getStats(providerId?: string): ProviderResponseCaptureStats {
    const list = providerId ? this.records.filter(r => r.providerId === providerId) : this.records;
    if (list.length === 0) {
      return {
        totalCaptured: 0,
        successCount: 0,
        failureCount: 0,
        averageLatencyMs: 0,
        statusCodes: {},
      };
    }

    let totalLatency = 0;
    let successCount = 0;
    let failureCount = 0;
    const statusCodes: Record<number, number> = {};

    for (const r of list) {
      totalLatency += r.latencyMs;
      statusCodes[r.statusCode] = (statusCodes[r.statusCode] || 0) + 1;
      if (r.statusCode >= 200 && r.statusCode < 400 && !r.error) {
        successCount++;
      } else {
        failureCount++;
      }
    }

    return {
      totalCaptured: list.length,
      successCount,
      failureCount,
      averageLatencyMs: Math.round(totalLatency / list.length),
      statusCodes,
    };
  }

  /**
   * Clears captured records.
   */
  clear(): void {
    this.records = [];
  }
}
