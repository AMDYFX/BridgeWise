/**
 * File: src/audit/privileged/privileged-action-audit-log.ts
 *
 * Privileged action audit log.
 *
 * An append-only, hash-chained record of privileged operations. Each entry
 * stores the SHA-256 of its canonical content plus the previous entry's hash,
 * so editing, reordering or removing a retained entry is detected by
 * {@link PrivilegedActionAuditLog.verifyIntegrity}. Truncating the *tail* of a
 * chain cannot be detected locally; publish {@link getHead} or attach a sink
 * to external write-once storage to anchor it.
 *
 * Secure defaults:
 *   - There is no update, delete or reset API; stored entries are deep-frozen.
 *   - Secrets in `params` are redacted by key name, and params are size-capped.
 *   - `record()` throws on invalid input so an unauditable action is never
 *     silently accepted, and `run()` records the attempt *before* executing the
 *     action, so the action cannot happen without a log entry.
 *   - Memory is bounded; evicted entries leave an anchor hash so the retained
 *     chain still verifies. Sink failures are isolated and counted.
 */

import { createHash, randomUUID } from 'crypto';
import { canonicalize, deepFreeze, sanitizeParams } from './sanitize';
import type {
  AuditIntegrityReport,
  PrivilegedActionAuditConfig,
  PrivilegedActionAuditEntry,
  PrivilegedActionCategory,
  PrivilegedActionInput,
  PrivilegedActionOutcome,
  PrivilegedActionQuery,
  PrivilegedActionQueryResult,
  PrivilegedAuditSink,
  PrivilegedAuditStats,
} from './privileged-action-audit.types';

/** Hash that precedes the very first entry of a chain. */
export const GENESIS_HASH = '0'.repeat(64);

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_PARAMS_BYTES = 8192;
const MAX_IDENTITY_LENGTH = 256;
const MAX_TARGET_LENGTH = 512;
const MAX_REASON_LENGTH = 1024;
const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_LIMIT = 1000;

const CATEGORIES: readonly PrivilegedActionCategory[] = [
  'governance',
  'treasury',
  'configuration',
  'access-control',
  'emergency',
  'other',
];
const OUTCOMES: readonly PrivilegedActionOutcome[] = ['attempted', 'success', 'denied', 'failed'];

export type PrivilegedAuditErrorCode =
  | 'INVALID_ACTOR'
  | 'INVALID_ACTION'
  | 'INVALID_CATEGORY'
  | 'INVALID_OUTCOME';

/** Thrown when an event cannot be recorded because its input is invalid. */
export class PrivilegedActionAuditError extends Error {
  constructor(
    public readonly code: PrivilegedAuditErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PrivilegedActionAuditError';
  }
}

/** Throw from an audited action to have it logged as `denied` rather than `failed`. */
export class PrivilegedActionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivilegedActionDeniedError';
  }
}

export class PrivilegedActionAuditLog {
  private entries: PrivilegedActionAuditEntry[] = [];
  private anchorHash = GENESIS_HASH;
  private lastSequence = 0;
  private evicted = 0;
  private sinkFailures = 0;
  private readonly pending = new Set<Promise<void>>();

  private readonly maxEntries: number;
  private readonly maxParamsBytes: number;
  private readonly redactKeys: RegExp[];
  private readonly sinks: PrivilegedAuditSink[];
  private readonly now: () => number;

  constructor(config: PrivilegedActionAuditConfig = {}) {
    this.now = config.now ?? (() => Date.now());
    this.maxEntries = positiveInteger('maxEntries', config.maxEntries, DEFAULT_MAX_ENTRIES);
    this.maxParamsBytes = positiveInteger(
      'maxParamsBytes',
      config.maxParamsBytes,
      DEFAULT_MAX_PARAMS_BYTES,
    );
    this.redactKeys = [...(config.redactKeys ?? [])];
    this.sinks = [...(config.sinks ?? [])];
  }

  /** Attach another sink; it receives entries appended from now on. */
  addSink(sink: PrivilegedAuditSink): void {
    this.sinks.push(sink);
  }

  /**
   * Append an event. Throws {@link PrivilegedActionAuditError} for invalid
   * input; callers that must not act without an audit trail should let it
   * propagate.
   */
  record(input: PrivilegedActionInput): PrivilegedActionAuditEntry {
    const actor = requireIdentity(input?.actor, 'INVALID_ACTOR', 'actor');
    const action = requireIdentity(input?.action, 'INVALID_ACTION', 'action');
    const category = input.category ?? 'other';
    if (!CATEGORIES.includes(category)) {
      throw new PrivilegedActionAuditError('INVALID_CATEGORY', `unknown category "${category}"`);
    }
    const outcome = input.outcome ?? 'success';
    if (!OUTCOMES.includes(outcome)) {
      throw new PrivilegedActionAuditError('INVALID_OUTCOME', `unknown outcome "${outcome}"`);
    }

    const sequence = this.lastSequence + 1;
    const unsigned = {
      sequence,
      id: randomUUID(),
      timestamp: this.now(),
      actor,
      action,
      category,
      target: input.target ? truncate(String(input.target).trim(), MAX_TARGET_LENGTH) : null,
      outcome,
      reason: input.reason ? truncate(String(input.reason).trim(), MAX_REASON_LENGTH) : null,
      correlationId: input.correlationId ? String(input.correlationId) : randomUUID(),
      params: this.boundParams(sanitizeParams(input.params, this.redactKeys)),
      prevHash: this.headHash(),
    };
    const entry = deepFreeze<PrivilegedActionAuditEntry>({
      ...unsigned,
      hash: computeHash(unsigned),
    });

    this.entries.push(entry);
    this.lastSequence = sequence;
    this.evictOverflow();
    this.dispatch(entry);
    return entry;
  }

  /**
   * Run a privileged action with a full audit trail. The `attempted` record is
   * written first — if it cannot be written the action does not run. The
   * outcome (`success`, `denied` or `failed`) is recorded afterwards and the
   * original result or error is passed through unchanged.
   */
  async run<T>(
    meta: Omit<PrivilegedActionInput, 'outcome' | 'reason'>,
    action: () => T | Promise<T>,
  ): Promise<T> {
    const correlationId = meta.correlationId ?? randomUUID();
    const base = { ...meta, correlationId };
    this.record({ ...base, outcome: 'attempted' });

    try {
      const result = await action();
      this.record({ ...base, outcome: 'success' });
      return result;
    } catch (error) {
      this.record({
        ...base,
        outcome: error instanceof PrivilegedActionDeniedError ? 'denied' : 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** Search retained entries. */
  query(query: PrivilegedActionQuery = {}): PrivilegedActionQueryResult {
    const actor = query.actor?.trim().toLowerCase();
    const target = query.target?.trim().toLowerCase();

    const matches = this.entries.filter(
      (e) =>
        (actor === undefined || e.actor.toLowerCase() === actor) &&
        (query.action === undefined || e.action === query.action) &&
        (query.category === undefined || e.category === query.category) &&
        (query.outcome === undefined || e.outcome === query.outcome) &&
        (target === undefined || e.target?.toLowerCase() === target) &&
        (query.correlationId === undefined || e.correlationId === query.correlationId) &&
        (query.from === undefined || e.timestamp >= query.from) &&
        (query.to === undefined || e.timestamp < query.to),
    );
    if (query.order === 'desc') matches.reverse();

    const offset = Math.max(0, Math.trunc(query.offset ?? 0));
    const limit = Math.min(
      MAX_QUERY_LIMIT,
      Math.max(0, Math.trunc(query.limit ?? DEFAULT_QUERY_LIMIT)),
    );
    return { total: matches.length, items: matches.slice(offset, offset + limit) };
  }

  /** Verify the retained chain. */
  verifyIntegrity(): AuditIntegrityReport {
    return PrivilegedActionAuditLog.verifyChain(this.entries, this.anchorHash);
  }

  /**
   * Verify any chain of entries (for example one exported earlier or read back
   * from external storage). `anchorHash` is the hash preceding the first entry.
   */
  static verifyChain(
    entries: readonly PrivilegedActionAuditEntry[],
    anchorHash: string = GENESIS_HASH,
  ): AuditIntegrityReport {
    let expectedPrev = anchorHash;
    let previousSequence: number | undefined;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const fail = (reason: NonNullable<AuditIntegrityReport['reason']>): AuditIntegrityReport => ({
        valid: false,
        checked: i + 1,
        brokenAtSequence: entry.sequence,
        reason,
      });

      if (previousSequence !== undefined && entry.sequence !== previousSequence + 1) {
        return fail('SEQUENCE_GAP');
      }
      if (entry.prevHash !== expectedPrev) return fail('CHAIN_BROKEN');

      const { hash, ...unsigned } = entry;
      if (computeHash(unsigned) !== hash) return fail('HASH_MISMATCH');

      expectedPrev = hash;
      previousSequence = entry.sequence;
    }
    return { valid: true, checked: entries.length };
  }

  /** Mutable deep copies of the retained entries, e.g. for export or testing. */
  exportEntries(): PrivilegedActionAuditEntry[] {
    return JSON.parse(JSON.stringify(this.entries)) as PrivilegedActionAuditEntry[];
  }

  /** Hash hand-off points: anchoring the head externally detects tail truncation. */
  getHead(): { sequence: number; hash: string } {
    return { sequence: this.lastSequence, hash: this.headHash() };
  }

  /** Hash that precedes the oldest retained entry (changes as entries are evicted). */
  getAnchorHash(): string {
    return this.anchorHash;
  }

  getStats(): PrivilegedAuditStats {
    return {
      retained: this.entries.length,
      evicted: this.evicted,
      sinkFailures: this.sinkFailures,
      lastSequence: this.lastSequence,
    };
  }

  /** Resolve once every sink delivery started so far has settled. */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private headHash(): string {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1].hash : this.anchorHash;
  }

  private boundParams(params: Record<string, unknown>): Record<string, unknown> {
    const bytes = Buffer.byteLength(canonicalize(params), 'utf8');
    return bytes > this.maxParamsBytes ? { _truncated: true, originalBytes: bytes } : params;
  }

  private evictOverflow(): void {
    while (this.entries.length > this.maxEntries) {
      const removed = this.entries.shift()!;
      this.anchorHash = removed.hash;
      this.evicted += 1;
    }
  }

  private dispatch(entry: PrivilegedActionAuditEntry): void {
    for (const sink of this.sinks) {
      const delivery: Promise<void> = Promise.resolve()
        .then(() => sink(entry))
        .catch(() => {
          this.sinkFailures += 1;
        })
        .finally(() => {
          this.pending.delete(delivery);
        });
      this.pending.add(delivery);
    }
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function computeHash(unsigned: Omit<PrivilegedActionAuditEntry, 'hash'>): string {
  return createHash('sha256')
    .update(
      canonicalize({
        sequence: unsigned.sequence,
        id: unsigned.id,
        timestamp: unsigned.timestamp,
        actor: unsigned.actor,
        action: unsigned.action,
        category: unsigned.category,
        target: unsigned.target,
        outcome: unsigned.outcome,
        reason: unsigned.reason,
        correlationId: unsigned.correlationId,
        params: unsigned.params,
        prevHash: unsigned.prevHash,
      }),
    )
    .digest('hex');
}

function requireIdentity(
  value: unknown,
  code: PrivilegedAuditErrorCode,
  field: string,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PrivilegedActionAuditError(code, `${field} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_IDENTITY_LENGTH) {
    throw new PrivilegedActionAuditError(
      code,
      `${field} must be at most ${MAX_IDENTITY_LENGTH} characters`,
    );
  }
  return trimmed;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function positiveInteger(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
