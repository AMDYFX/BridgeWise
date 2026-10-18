/**
 * File: src/execution/quotes/quote-expiry-enforcement.types.ts
 *
 * Types for quote expiry enforcement and execution idempotency (#1285).
 * Enforces strict quote time-to-live boundaries, prevents double-spend/duplicate
 * submissions via atomic in-flight locking, and tracks execution outcomes.
 */

export type QuoteStatus =
  | 'ACTIVE'
  | 'IN_FLIGHT'
  | 'EXECUTED'
  | 'EXPIRED'
  | 'CANCELLED';

export interface RouteQuoteRecord {
  quoteId: string;
  routeId: string;
  sourceChainId: number;
  destinationChainId: number;
  sourceAsset: string;
  destinationAsset: string;
  amountIn: string;
  expectedAmountOut: string;
  minAmountOut: string;
  createdAt: number; // ms timestamp
  expiresAt: number; // ms timestamp
  status: QuoteStatus;
  executionLockId?: string;
  executionLockAcquiredAt?: number;
  completedAt?: number;
  txHash?: string;
  idempotencyKey?: string;
}

export interface QuoteExecutionRequest {
  quoteId: string;
  idempotencyKey: string;
  callerAddress: string;
  submittedAt?: number;
}

export type QuoteRejectionCode =
  | 'QUOTE_NOT_FOUND'
  | 'QUOTE_EXPIRED'
  | 'QUOTE_ALREADY_EXECUTED'
  | 'QUOTE_IN_FLIGHT_CONFLICT'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'EXECUTION_BUFFER_VIOLATED';

export interface QuoteExecutionVerificationResult {
  quoteId: string;
  allowed: boolean;
  lockAcquired: boolean;
  status: QuoteStatus;
  rejectionCode?: QuoteRejectionCode;
  rejectionMessage?: string;
  remainingTtlMs: number;
  quote?: RouteQuoteRecord;
}

export interface QuoteExpiryConfig {
  defaultTtlMs: number; // e.g. 60,000 ms = 1 minute
  executionBufferMs: number; // buffer to account for on-chain submission & mining latency (e.g. 5,000 ms)
  lockTtlMs: number; // max lock duration before releasing stale in-flight execution (e.g. 120,000 ms)
}
