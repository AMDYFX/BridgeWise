/**
 * Event Replay Service
 * Supports replay of missing source-chain events with idempotency guarantees
 */

export interface ReplayRequest {
  eventId: string;
  sourceChain: string;
  targetChain: string;
  blockNumber: number;
  txHash: string;
}

export interface ReplayResult {
  success: boolean;
  eventId: string;
  error?: string;
}

export class EventReplayService {
  private processedEvents = new Set<string>();

  /**
   * Replay a missing source-chain event
   * Ensures idempotency by tracking processed events
   */
  async replayEvent(request: ReplayRequest): Promise<ReplayResult> {
    const eventKey = `${request.sourceChain}:${request.eventId}`;

    // Idempotency check - skip if already processed
    if (this.processedEvents.has(eventKey)) {
      return {
        success: true,
        eventId: request.eventId,
      };
    }

    try {
      // Simulate event replay logic
      // In production, this would interact with the event processor
      this.processedEvents.add(eventKey);

      return {
        success: true,
        eventId: request.eventId,
      };
    } catch (error) {
      return {
        success: false,
        eventId: request.eventId,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Batch replay multiple events
   */
  async replayEvents(requests: ReplayRequest[]): Promise<ReplayResult[]> {
    return Promise.all(requests.map((req) => this.replayEvent(req)));
  }

  /**
   * Check if an event has been processed
   */
  isEventProcessed(eventId: string, sourceChain: string): boolean {
    const eventKey = `${sourceChain}:${eventId}`;
    return this.processedEvents.has(eventKey);
  }

  /**
   * Clear processed events (for testing/admin use)
   */
  clearProcessedEvents(): void {
    this.processedEvents.clear();
  }
}
