export type IdempotencyRecordStatus = 'pending' | 'completed';

export interface IdempotencyRecord {
  key: string;
  status: IdempotencyRecordStatus;
  requestFingerprint: string;
  statusCode?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  createdAt: number;
  expiresAt: number;
}

export interface IdempotencyOptions {
  headerNames?: string[]; // e.g. ['idempotency-key', 'x-idempotency-key']
  ttlMs?: number; // default: 24h (86,400,000 ms)
  enforcePayloadMatch?: boolean; // default: true
  methods?: string[]; // default: ['POST', 'PUT', 'PATCH', 'DELETE']
  maxKeyLength?: number; // default: 128
}
