import { IdempotencyStorage } from './idempotency.storage';
import { IdempotencyRecord } from './idempotency.types';

describe('IdempotencyStorage Retention Policy', () => {
  let storage: IdempotencyStorage;

  beforeEach(() => {
    storage = new IdempotencyStorage();
  });

  const createRecord = (key: string, ttlMs: number): IdempotencyRecord => ({
    key,
    status: 'completed',
    requestFingerprint: 'test-fingerprint',
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
  });

  it('should not return expired records', () => {
    const now = Date.now();
    const expiredRecord: IdempotencyRecord = {
      key: 'expired-key',
      status: 'completed',
      requestFingerprint: 'fingerprint',
      createdAt: now - 10000,
      expiresAt: now - 1000,
    };

    storage.set(expiredRecord);
    const retrieved = storage.get('expired-key');

    expect(retrieved).toBeUndefined();
  });

  it('should return non-expired records', () => {
    const record = createRecord('valid-key', 60000);
    storage.set(record);

    const retrieved = storage.get('valid-key');
    expect(retrieved).toBeDefined();
    expect(retrieved?.key).toBe('valid-key');
  });

  it('should prune expired records when calling size()', () => {
    const now = Date.now();
    storage.set(createRecord('valid-1', 60000));
    storage.set(createRecord('valid-2', 60000));
    storage.set({
      key: 'expired-1',
      status: 'completed',
      requestFingerprint: 'fingerprint',
      createdAt: now - 10000,
      expiresAt: now - 1000,
    });
    storage.set({
      key: 'expired-2',
      status: 'completed',
      requestFingerprint: 'fingerprint',
      createdAt: now - 10000,
      expiresAt: now - 1000,
    });

    const size = storage.size();
    expect(size).toBe(2);
  });

  it('should prune expired records when calling pruneExpired()', () => {
    const now = Date.now();
    storage.set(createRecord('valid-1', 60000));
    storage.set({
      key: 'expired-1',
      status: 'completed',
      requestFingerprint: 'fingerprint',
      createdAt: now - 10000,
      expiresAt: now - 1000,
    });

    storage.pruneExpired();

    expect(storage.get('valid-1')).toBeDefined();
    expect(storage.get('expired-1')).toBeUndefined();
  });

  it('should handle records expiring at exact current time', () => {
    const now = Date.now();
    const record: IdempotencyRecord = {
      key: 'boundary-key',
      status: 'completed',
      requestFingerprint: 'fingerprint',
      createdAt: now - 1000,
      expiresAt: now,
    };

    storage.set(record);
    const retrieved = storage.get('boundary-key');

    expect(retrieved).toBeUndefined();
  });

  it('should clear all records including expired ones', () => {
    const now = Date.now();
    storage.set(createRecord('valid-1', 60000));
    storage.set({
      key: 'expired-1',
      status: 'completed',
      requestFingerprint: 'fingerprint',
      createdAt: now - 10000,
      expiresAt: now - 1000,
    });

    storage.clear();

    expect(storage.size()).toBe(0);
    expect(storage.get('valid-1')).toBeUndefined();
  });

  it('should handle bulk retention policy operations without errors', () => {
    const now = Date.now();
    const records: IdempotencyRecord[] = [];

    for (let i = 0; i < 100; i++) {
      const isExpired = i % 2 === 0;
      records.push({
        key: `key-${i}`,
        status: 'completed',
        requestFingerprint: `fingerprint-${i}`,
        createdAt: now - 10000,
        expiresAt: isExpired ? now - 1000 : now + 60000,
      });
    }

    records.forEach(r => storage.set(r));

    const size = storage.size();
    expect(size).toBe(50);
  });
});
