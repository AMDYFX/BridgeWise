import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import {
  TransferTrace,
  TransferTraceEvent,
  TransferTraceQuery,
} from './transfer-trace.types';

@Injectable()
export class TransferTraceService {
  private readonly logger = new Logger(TransferTraceService.name);
  private readonly traces = new Map<string, TransferTrace>();

  /**
   * Creates a new transfer trace with initial event.
   */
  createTrace(
    transferId: string,
    sourceAccount: string,
    destinationAccount: string,
    asset: string,
    amount: string,
    sourceChain: string,
    destinationChain: string,
  ): TransferTrace {
    const now = new Date();
    const trace: TransferTrace = {
      transferId,
      sourceAccount,
      destinationAccount,
      asset,
      amount,
      sourceChain,
      destinationChain,
      status: 'pending',
      events: [
        {
          eventId: uuidv4(),
          transferId,
          eventType: 'initiated',
          timestamp: now,
          chain: sourceChain,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };

    this.traces.set(transferId, trace);
    this.logger.debug(`Created trace for transfer ${transferId}`);
    return trace;
  }

  /**
   * Adds an event to an existing transfer trace.
   */
  addEvent(
    transferId: string,
    eventType: TransferTraceEvent['eventType'],
    chain: string,
    transactionHash?: string,
    blockNumber?: number,
    metadata?: Record<string, unknown>,
  ): TransferTrace | null {
    const trace = this.traces.get(transferId);
    if (!trace) {
      this.logger.warn(`Trace not found for transfer ${transferId}`);
      return null;
    }

    const event: TransferTraceEvent = {
      eventId: uuidv4(),
      transferId,
      eventType,
      timestamp: new Date(),
      chain,
      transactionHash,
      blockNumber,
      metadata,
    };

    trace.events.push(event);
    trace.updatedAt = new Date();

    // Update status based on event type
    if (eventType === 'source_confirmed' || eventType === 'bridge_submit') {
      trace.status = 'in_progress';
    } else if (eventType === 'completed') {
      trace.status = 'completed';
    } else if (eventType === 'failed') {
      trace.status = 'failed';
    }

    this.logger.debug(`Added event ${eventType} to trace ${transferId}`);
    return trace;
  }

  /**
   * Retrieves a transfer trace by ID.
   */
  getTrace(transferId: string): TransferTrace | null {
    return this.traces.get(transferId) || null;
  }

  /**
   * Queries transfer traces based on filter criteria.
   */
  queryTraces(query: TransferTraceQuery): TransferTrace[] {
    const results: TransferTrace[] = [];

    for (const trace of this.traces.values()) {
      let matches = true;

      if (query.transferId && trace.transferId !== query.transferId) {
        matches = false;
      }
      if (query.sourceAccount && trace.sourceAccount !== query.sourceAccount) {
        matches = false;
      }
      if (query.destinationAccount && trace.destinationAccount !== query.destinationAccount) {
        matches = false;
      }
      if (query.status && trace.status !== query.status) {
        matches = false;
      }
      if (query.startTime && trace.createdAt < query.startTime) {
        matches = false;
      }
      if (query.endTime && trace.createdAt > query.endTime) {
        matches = false;
      }

      if (matches) {
        results.push(trace);
      }
    }

    return results;
  }

  /**
   * Returns all traces.
   */
  getAllTraces(): TransferTrace[] {
    return Array.from(this.traces.values());
  }

  /**
   * Deletes a transfer trace.
   */
  deleteTrace(transferId: string): boolean {
    return this.traces.delete(transferId);
  }

  /**
   * Clears all traces.
   */
  clearAll(): void {
    this.traces.clear();
  }
}
