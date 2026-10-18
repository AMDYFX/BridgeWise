/**
 * File: src/audit/privileged/privileged-action-audit.types.ts
 *
 * Type definitions for privileged action audit logs.
 *
 * A privileged action is any operation that changes who can do what or moves
 * protocol-controlled value: multisig proposals/executions, timelock
 * operations, treasury movements, configuration changes, access grants and
 * emergency controls. Every attempt and its outcome is recorded in an
 * append-only, hash-chained log so tampering or deletion is detectable.
 */

export type PrivilegedActionCategory =
  | 'governance'
  | 'treasury'
  | 'configuration'
  | 'access-control'
  | 'emergency'
  | 'other';

/**
 * - attempted: the action was requested (recorded *before* it runs)
 * - success:   the action completed
 * - denied:    the action was refused (authorization, threshold, expiry...)
 * - failed:    the action errored unexpectedly
 */
export type PrivilegedActionOutcome = 'attempted' | 'success' | 'denied' | 'failed';

/** What a caller supplies to record an event. */
export interface PrivilegedActionInput {
  /** Identity performing the action (address, user id, service name). */
  actor: string;
  /** Stable action name, e.g. 'multisig.execute'. */
  action: string;
  category?: PrivilegedActionCategory;
  /** What the action operates on (contract, proposal id, config key...). */
  target?: string;
  /** Defaults to 'success'. */
  outcome?: PrivilegedActionOutcome;
  /** Why it was denied/failed, or free-form justification. */
  reason?: string;
  /** Action parameters. Secrets are redacted and size is capped before storage. */
  params?: Record<string, unknown>;
  /** Ties together the records of one action (attempt → outcome). */
  correlationId?: string;
}

/** A stored, immutable audit entry. */
export interface PrivilegedActionAuditEntry {
  /** Monotonic position in the log, starting at 1. */
  readonly sequence: number;
  readonly id: string;
  readonly timestamp: number;
  readonly actor: string;
  readonly action: string;
  readonly category: PrivilegedActionCategory;
  readonly target: string | null;
  readonly outcome: PrivilegedActionOutcome;
  readonly reason: string | null;
  readonly correlationId: string;
  /** Sanitized parameters (redacted, size-capped, JSON-safe). */
  readonly params: Record<string, unknown>;
  /** Hash of the previous entry (or the anchor/genesis hash). */
  readonly prevHash: string;
  /** SHA-256 over this entry's canonical content and `prevHash`. */
  readonly hash: string;
}

/** Destination for durable/external persistence of entries. */
export type PrivilegedAuditSink = (entry: PrivilegedActionAuditEntry) => void | Promise<void>;

export interface PrivilegedActionAuditConfig {
  /** Maximum entries kept in memory; oldest are evicted first (default 10000). */
  maxEntries?: number;
  /** Maximum serialized size of `params` before it is replaced (default 8192). */
  maxParamsBytes?: number;
  /** Extra key patterns to redact, in addition to the built-in secret patterns. */
  redactKeys?: RegExp[];
  /** Sinks that receive every entry after it is appended. */
  sinks?: PrivilegedAuditSink[];
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export interface PrivilegedActionQuery {
  actor?: string;
  action?: string;
  category?: PrivilegedActionCategory;
  outcome?: PrivilegedActionOutcome;
  target?: string;
  correlationId?: string;
  /** Inclusive lower bound (epoch ms). */
  from?: number;
  /** Exclusive upper bound (epoch ms). */
  to?: number;
  /** Sort order by sequence (default 'asc'). */
  order?: 'asc' | 'desc';
  offset?: number;
  limit?: number;
}

export interface PrivilegedActionQueryResult {
  /** Total matches before pagination. */
  total: number;
  items: PrivilegedActionAuditEntry[];
}

export interface AuditIntegrityReport {
  valid: boolean;
  /** Number of entries checked. */
  checked: number;
  /** Sequence of the first entry that failed verification. */
  brokenAtSequence?: number;
  reason?: 'HASH_MISMATCH' | 'CHAIN_BROKEN' | 'SEQUENCE_GAP';
}

export interface PrivilegedAuditStats {
  retained: number;
  evicted: number;
  sinkFailures: number;
  lastSequence: number;
}
