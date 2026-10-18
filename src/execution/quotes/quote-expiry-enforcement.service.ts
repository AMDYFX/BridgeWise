/**
 * File: src/execution/quotes/quote-expiry-enforcement.service.ts
 *
 * Implements quote expiry enforcement at execution time (#1285).
 * Validates quote validity, enforces execution buffers to prevent stale execution
 * during block inclusion delays, guarantees idempotency against concurrent submissions,
 * and manages atomic in-flight execution locks.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  QuoteExecutionRequest,
  QuoteExecutionVerificationResult,
  QuoteExpiryConfig,
  RouteQuoteRecord,
} from './quote-expiry-enforcement.types';

@Injectable()
export class QuoteExpiryEnforcementService {
  private readonly logger = new Logger(QuoteExpiryEnforcementService.name);
  private config: QuoteExpiryConfig;
  private readonly quotes = new Map<string, RouteQuoteRecord>();

  constructor(config?: Partial<QuoteExpiryConfig>) {
    this.config = {
      defaultTtlMs: config?.defaultTtlMs ?? 60_000, // 60 seconds
      executionBufferMs: config?.executionBufferMs ?? 5_000, // 5 seconds buffer
      lockTtlMs: config?.lockTtlMs ?? 120_000, // 2 minutes lock timeout
    };
  }

  /**
   * Register a new quote with TTL and status ACTIVE.
   */
  public registerQuote(
    params: Omit<RouteQuoteRecord, 'createdAt' | 'expiresAt' | 'status'> & {
      ttlMs?: number;
      createdAt?: number;
    },
  ): RouteQuoteRecord {
    const createdAt = params.createdAt ?? Date.now();
    const ttlMs = params.ttlMs ?? this.config.defaultTtlMs;
    const expiresAt = createdAt + ttlMs;

    const record: RouteQuoteRecord = {
      ...params,
      createdAt,
      expiresAt,
      status: 'ACTIVE',
    };

    this.quotes.set(record.quoteId, record);
    return record;
  }

  /**
   * Retrieve a quote by ID, updating status to EXPIRED if TTL passed.
   */
  public getQuote(quoteId: string, currentTime?: number): RouteQuoteRecord | undefined {
    const quote = this.quotes.get(quoteId);
    if (!quote) return undefined;

    const now = currentTime ?? Date.now();
    if (quote.status === 'ACTIVE' && now >= quote.expiresAt) {
      quote.status = 'EXPIRED';
    }

    return quote;
  }

  /**
   * Verifies quote validity and atomically acquires an in-flight execution lock.
   * If a previous execution with the identical idempotencyKey already succeeded, returns idempotency success.
   */
  public acquireExecutionLock(
    request: QuoteExecutionRequest,
  ): QuoteExecutionVerificationResult {
    const now = request.submittedAt ?? Date.now();
    const quote = this.quotes.get(request.quoteId);

    if (!quote) {
      return {
        quoteId: request.quoteId,
        allowed: false,
        lockAcquired: false,
        status: 'EXPIRED',
        rejectionCode: 'QUOTE_NOT_FOUND',
        rejectionMessage: `Quote with ID ${request.quoteId} was not found.`,
        remainingTtlMs: 0,
      };
    }

    // 1. Check idempotency if already executed with identical idempotencyKey
    if (quote.status === 'EXECUTED') {
      if (quote.idempotencyKey === request.idempotencyKey) {
        return {
          quoteId: quote.quoteId,
          allowed: true,
          lockAcquired: false,
          status: 'EXECUTED',
          remainingTtlMs: Math.max(0, quote.expiresAt - now),
          quote,
        };
      }
      return {
        quoteId: quote.quoteId,
        allowed: false,
        lockAcquired: false,
        status: 'EXECUTED',
        rejectionCode: 'QUOTE_ALREADY_EXECUTED',
        rejectionMessage: `Quote ${quote.quoteId} has already been executed with different credentials.`,
        remainingTtlMs: 0,
        quote,
      };
    }

    // 2. Check if quote is already in flight
    if (quote.status === 'IN_FLIGHT') {
      const lockAge = now - (quote.executionLockAcquiredAt ?? 0);
      if (lockAge < this.config.lockTtlMs) {
        if (quote.idempotencyKey === request.idempotencyKey) {
          // In-flight retry with same idempotency key
          return {
            quoteId: quote.quoteId,
            allowed: true,
            lockAcquired: false,
            status: 'IN_FLIGHT',
            remainingTtlMs: Math.max(0, quote.expiresAt - now),
            quote,
          };
        }
        return {
          quoteId: quote.quoteId,
          allowed: false,
          lockAcquired: false,
          status: 'IN_FLIGHT',
          rejectionCode: 'QUOTE_IN_FLIGHT_CONFLICT',
          rejectionMessage: `Quote ${quote.quoteId} is currently being executed in an in-flight transaction.`,
          remainingTtlMs: Math.max(0, quote.expiresAt - now),
          quote,
        };
      }
      // Lock timed out, allow reclaim
      this.logger.warn(`Stale in-flight lock timed out on quote ${quote.quoteId}, reclaiming lock.`);
    }

    // 3. Expiry and buffer check
    const remainingTtlMs = quote.expiresAt - now;
    if (remainingTtlMs <= 0) {
      quote.status = 'EXPIRED';
      return {
        quoteId: quote.quoteId,
        allowed: false,
        lockAcquired: false,
        status: 'EXPIRED',
        rejectionCode: 'QUOTE_EXPIRED',
        rejectionMessage: `Quote ${quote.quoteId} expired ${Math.abs(remainingTtlMs)}ms ago.`,
        remainingTtlMs: 0,
        quote,
      };
    }

    if (remainingTtlMs < this.config.executionBufferMs) {
      return {
        quoteId: quote.quoteId,
        allowed: false,
        lockAcquired: false,
        status: quote.status,
        rejectionCode: 'EXECUTION_BUFFER_VIOLATED',
        rejectionMessage: `Quote remaining TTL (${remainingTtlMs}ms) is less than required execution safety buffer (${this.config.executionBufferMs}ms).`,
        remainingTtlMs,
        quote,
      };
    }

    // 4. Atomically acquire lock
    quote.status = 'IN_FLIGHT';
    quote.idempotencyKey = request.idempotencyKey;
    quote.executionLockId = `lock-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    quote.executionLockAcquiredAt = now;

    return {
      quoteId: quote.quoteId,
      allowed: true,
      lockAcquired: true,
      status: 'IN_FLIGHT',
      remainingTtlMs,
      quote,
    };
  }

  /**
   * Commit execution as completed.
   */
  public commitExecution(quoteId: string, txHash: string): RouteQuoteRecord {
    const quote = this.quotes.get(quoteId);
    if (!quote) {
      throw new Error(`Cannot commit non-existent quote: ${quoteId}`);
    }

    quote.status = 'EXECUTED';
    quote.txHash = txHash;
    quote.completedAt = Date.now();
    return quote;
  }

  /**
   * Release in-flight lock if execution fails or is aborted.
   */
  public releaseExecutionLock(
    quoteId: string,
    reason?: string,
    releasedAt?: number,
  ): RouteQuoteRecord {
    const quote = this.quotes.get(quoteId);
    if (!quote) {
      throw new Error(`Cannot release non-existent quote: ${quoteId}`);
    }

    if (quote.status === 'IN_FLIGHT') {
      const now = releasedAt ?? Date.now();
      quote.status = now >= quote.expiresAt ? 'EXPIRED' : 'ACTIVE';
      quote.executionLockId = undefined;
      quote.executionLockAcquiredAt = undefined;
      this.logger.log(`Released lock for quote ${quoteId}. Reason: ${reason ?? 'none'}`);
    }

    return quote;
  }
}
