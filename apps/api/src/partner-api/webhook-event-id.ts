import { createHash } from 'node:crypto';

/**
 * Deterministic event id: the same logical event (partner, type, resource, sequence) always gets the same
 * id, so every delivery retry carries an identical id and consumers can dedupe on it.
 */
export function createWebhookEventId(partnerId: string, type: string, resourceId: string, sequence: number): string {
  const digest = createHash('sha256').update(`${partnerId}|${type}|${resourceId}|${sequence}`).digest('hex');
  return `evt_${digest.slice(0, 32)}`;
}

export type DeliveryVerdict = 'accept' | 'duplicate' | 'stale' | 'from_future';

/**
 * Consumer-side replay protection: rejects events whose timestamp is outside the tolerance window and
 * events whose id was already accepted inside that window. Seen ids are pruned once they can no longer
 * be replayed, so memory stays bounded.
 */
export class WebhookReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(private readonly toleranceMs = 5 * 60_000) {}

  check(eventId: string, eventTimestamp: number, now: number): DeliveryVerdict {
    this.prune(now);
    const age = now - eventTimestamp;
    if (age > this.toleranceMs) return 'stale';
    if (age < -this.toleranceMs) return 'from_future';
    if (this.seen.has(eventId)) return 'duplicate';
    this.seen.set(eventId, eventTimestamp);
    return 'accept';
  }

  private prune(now: number): void {
    for (const [id, ts] of this.seen) {
      if (now - ts > this.toleranceMs) this.seen.delete(id);
    }
  }

  get size(): number {
    return this.seen.size;
  }
}
