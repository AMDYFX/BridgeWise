import { Injectable } from '@nestjs/common';
import { IdempotencyRecord } from './idempotency.types';

@Injectable()
export class IdempotencyStorage {
  private store: Map<string, IdempotencyRecord> = new Map();

  get(key: string): IdempotencyRecord | undefined {
    const record = this.store.get(key);
    if (!record) {
      return undefined;
    }
    if (Date.now() > record.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return record;
  }

  set(record: IdempotencyRecord): void {
    this.store.set(record.key, record);
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    this.pruneExpired();
    return this.store.size;
  }

  pruneExpired(): void {
    const now = Date.now();
    for (const [key, record] of this.store.entries()) {
      if (now > record.expiresAt) {
        this.store.delete(key);
      }
    }
  }
}
