/**
 * File: src/providers/risk-register/dependency-rpc-risk-register.service.ts
 *
 * Dependency and RPC provider risk register (#1382).
 *
 * Maintains an inventory of third-party dependencies and RPC providers,
 * scores each one for operational risk, and reports the register-wide
 * exposure: what is at high/critical risk, what is a single point of
 * failure, and which linked providers go down when an entry fails.
 *
 * Design notes:
 *   - All inputs are untrusted: entries are validated on registration,
 *     endpoint references may not carry credentials/query strings, and
 *     metadata is stored sanitized (secrets redacted, size capped).
 *   - Failure events are idempotent by `eventId`, so replays from queues or
 *     retried operators cannot inflate a score.
 *   - Scoring is a pure function of entry state + retained failure history:
 *     the same state always produces the same score, and every point is
 *     explained by a {@link RiskFactor}.
 *   - Logs and audit params carry ids, codes and counts only — never hosts,
 *     metadata payloads, or raw caller input.
 */

import { randomUUID } from 'crypto';
import { sanitizeParams } from '../../audit/privileged/sanitize';
import type { PrivilegedActionAuditLog } from '../../audit/privileged/privileged-action-audit-log';
import type {
  FailureEvent,
  FailureEventInput,
  RecordFailureResult,
  RegisterRiskEntryInput,
  RiskCriticality,
  RiskEntryKind,
  RiskEntryStatus,
  RiskLevel,
  RiskLogEvent,
  RiskRegisterConfig,
  RiskRegisterEntry,
  RiskRegisterErrorCode,
  RiskRegisterMetrics,
  RiskReport,
  RiskReportEntry,
  RiskScore,
  RiskFactor,
  RiskTrustModel,
  UpdateRiskEntryInput,
} from './dependency-rpc-risk.types';
import { RiskRegisterError } from './dependency-rpc-risk.types';

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const KINDS: readonly RiskEntryKind[] = ['dependency', 'rpc-provider'];
const CRITICALITY: readonly RiskCriticality[] = [
  'critical',
  'high',
  'medium',
  'low',
];
const TRUST_MODELS: readonly RiskTrustModel[] = [
  'self-hosted',
  'multi-vendor',
  'single-vendor',
  'third-party-managed',
];
const STATUSES: readonly RiskEntryStatus[] = [
  'active',
  'degraded',
  'suspended',
  'retired',
];

const DEFAULT_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_FAILURE_EVENTS = 1000;
const MAX_CHAINS = 50;
const MAX_LABEL_LENGTH = 200;
const MAX_FALLBACKS = 20;
const MAX_RETAINED_EVENTS_PER_ENTRY = 100;
const REASON_MIN_LENGTH = 4;
const REASON_MAX_LENGTH = 512;

/** Points contributed by each risk factor at its maximum. */
const CRITICALITY_POINTS: Record<RiskCriticality, number> = {
  critical: 35,
  high: 26,
  medium: 15,
  low: 6,
};
const TRUST_POINTS: Record<RiskTrustModel, number> = {
  'single-vendor': 20,
  'third-party-managed': 12,
  'self-hosted': 6,
  'multi-vendor': 4,
};
const STATUS_POINTS: Record<RiskEntryStatus, number> = {
  active: 0,
  degraded: 10,
  suspended: 18,
  retired: 0,
};
const NO_FALLBACK_POINTS = 20;
const SINGLE_FALLBACK_POINTS = 8;
const RECENT_FAILURE_POINTS = 20;
const RECENT_FAILURE_POINTS_PER_EVENT = 4;
const STALE_POINTS = 8;

const LEVEL_THRESHOLDS: readonly { min: number; level: RiskLevel }[] = [
  { min: 75, level: 'critical' },
  { min: 50, level: 'high' },
  { min: 25, level: 'medium' },
  { min: 0, level: 'low' },
];

export interface RiskRegisterAuditContext {
  /** Identity performing the mutation (operator id, service name). */
  actor?: string;
  correlationId?: string;
}

export class DependencyRpcRiskRegister {
  private readonly entries = new Map<string, RiskRegisterEntry>();
  private readonly events: FailureEvent[] = [];
  private readonly eventsByEntry = new Map<string, Set<string>>();
  private readonly eventIds = new Set<string>();
  private readonly providers = new Map<string, Set<string>>();

  private readonly now: () => number;
  private readonly failureWindowMs: number;
  private readonly staleAfterMs: number;
  private readonly maxFailureEvents: number;
  private readonly logSink?: (event: RiskLogEvent) => void;

  private counters = {
    registered: 0,
    retired: 0,
    failureEventsRecorded: 0,
    duplicateFailureEvents: 0,
    assessments: 0,
    rejectedInputs: 0,
  };

  constructor(
    config: RiskRegisterConfig = {},
    private readonly audit?: PrivilegedActionAuditLog,
  ) {
    this.now = config.now ?? (() => Date.now());
    this.failureWindowMs = positive(
      config.failureWindowMs,
      DEFAULT_FAILURE_WINDOW_MS,
      'failureWindowMs',
    );
    this.staleAfterMs = positive(
      config.staleAfterMs,
      DEFAULT_STALE_AFTER_MS,
      'staleAfterMs',
    );
    this.maxFailureEvents = positive(
      config.maxFailureEvents,
      DEFAULT_MAX_FAILURE_EVENTS,
      'maxFailureEvents',
    );
    this.logSink = config.log;
  }

  // ─── Registration ─────────────────────────────────────────────────────────

  /**
   * Register an entry. Throws {@link RiskRegisterError} for malformed input
   * (bad id, unknown enum, credential-bearing endpoint) and for duplicate ids.
   */
  register(
    input: RegisterRiskEntryInput,
    context: RiskRegisterAuditContext = {},
  ): RiskRegisterEntry {
    const normalized = this.validateEntryInput(input);
    if (this.entries.has(normalized.id)) {
      this.counters.rejectedInputs += 1;
      throw new RiskRegisterError(
        'DUPLICATE_ENTRY',
        `entry "${normalized.id}" is already registered`,
      );
    }

    const record = (outcome: 'attempted' | 'success' | 'failed') =>
      this.writeAudit(outcome, {
        actor: context.actor ?? 'system',
        action: 'risk.register',
        target: normalized.id,
        correlationId: context.correlationId,
        params: {
          kind: normalized.kind,
          criticality: normalized.criticality,
          trustModel: normalized.trustModel,
          chains: normalized.chains.length,
        },
      });

    record('attempted');
    const at = this.now();
    const entry: RiskRegisterEntry = Object.freeze({
      ...normalized,
      registeredAt: at,
      updatedAt: at,
    });
    this.entries.set(entry.id, entry);
    this.counters.registered += 1;
    record('success');
    this.emit('info', 'ENTRY_REGISTERED', entry.id, 'risk entry registered');
    return entry;
  }

  /** Patch mutable risk attributes of an existing, non-retired entry. */
  update(
    id: string,
    patch: UpdateRiskEntryInput,
    context: RiskRegisterAuditContext = {},
  ): RiskRegisterEntry {
    const existing = this.requireEntry(id);
    if (existing.status === 'retired') {
      throw new RiskRegisterError('ENTRY_RETIRED', `entry "${id}" is retired`);
    }
    const merged = this.validateEntryInput({
      id: existing.id,
      kind: existing.kind,
      label: patch.label ?? existing.label,
      criticality: patch.criticality ?? existing.criticality,
      trustModel: patch.trustModel ?? existing.trustModel,
      chains: patch.chains ?? [...existing.chains],
      version: patch.version ?? existing.version,
      endpointHost: existing.endpointHost,
      fallbackEntryIds: patch.fallbackEntryIds ?? [
        ...existing.fallbackEntryIds,
      ],
      ownerId: patch.ownerId ?? existing.ownerId,
      status: patch.status ?? existing.status,
      metadata: existing.metadata,
    });

    this.writeAudit('attempted', {
      actor: context.actor ?? 'system',
      action: 'risk.update',
      target: id,
      correlationId: context.correlationId,
      params: { fields: Object.keys(patch).sort() },
    });
    const updated: RiskRegisterEntry = Object.freeze({
      ...merged,
      metadata: existing.metadata,
      registeredAt: existing.registeredAt,
      updatedAt: this.now(),
    });
    this.entries.set(id, updated);
    this.writeAudit('success', {
      actor: context.actor ?? 'system',
      action: 'risk.update',
      target: id,
      correlationId: context.correlationId,
      params: { fields: Object.keys(patch).sort() },
    });
    return updated;
  }

  /**
   * Retire an entry: it stops counting toward risk scores but stays queryable
   * for history. Requires an actor so the state transition is attributable.
   */
  retire(
    id: string,
    actor: string,
    reason: string,
    context: RiskRegisterAuditContext = {},
  ): RiskRegisterEntry {
    const existing = this.requireEntry(id);
    if (!actor || !actor.trim()) {
      this.counters.rejectedInputs += 1;
      throw new RiskRegisterError(
        'INVALID_ACTOR',
        'retiring an entry requires an actor',
      );
    }
    const why = requireReason(reason, 'retirement reason', 'INVALID_ENTRY');
    if (existing.status === 'retired') {
      // Idempotent: retiring twice is a no-op, still attributable.
      return existing;
    }

    const base = {
      actor: actor.trim(),
      action: 'risk.retire',
      target: id,
      correlationId: context.correlationId,
      params: { reason: why, previousStatus: existing.status },
    };
    this.writeAudit('attempted', base);
    const retired: RiskRegisterEntry = Object.freeze({
      ...existing,
      status: 'retired' as const,
      updatedAt: this.now(),
    });
    this.entries.set(id, retired);
    this.counters.retired += 1;
    this.writeAudit('success', base);
    this.emit('warn', 'ENTRY_RETIRED', id, 'risk entry retired');
    return retired;
  }

  // ─── Failure history ──────────────────────────────────────────────────────

  /**
   * Record an observed or simulated dependency failure.
   *
   * Idempotent: replaying the same `eventId` returns `{ recorded: false,
   * duplicate: true }` and does not change any state, so queue redeliveries
   * and operator retries cannot double-count an outage.
   */
  recordFailure(input: FailureEventInput): RecordFailureResult {
    const event = this.validateFailureEvent(input);
    if (this.eventIds.has(event.eventId)) {
      this.counters.duplicateFailureEvents += 1;
      return { recorded: false, duplicate: true };
    }

    this.eventIds.add(event.eventId);
    this.events.push(event);
    const perEntry = this.eventsByEntry.get(event.entryId) ?? new Set<string>();
    perEntry.add(event.eventId);
    this.eventsByEntry.set(event.entryId, perEntry);
    this.counters.failureEventsRecorded += 1;
    this.evictOverflow();

    this.emit(
      'warn',
      'FAILURE_RECORDED',
      event.entryId,
      `failure event recorded (eventId=${event.eventId})`,
    );

    // Reflect the failure on the entry so status-driven scoring sees it.
    const entry = this.entries.get(event.entryId);
    if (entry && entry.status === 'active') {
      this.entries.set(
        event.entryId,
        Object.freeze({ ...entry, status: 'degraded', updatedAt: this.now() }),
      );
    }

    return { recorded: true, duplicate: false, event };
  }

  /** Retained failure events for an entry, newest first. */
  getFailureHistory(entryId: string, limit = 50): FailureEvent[] {
    const capped = Math.max(1, Math.min(limit, MAX_RETAINED_EVENTS_PER_ENTRY));
    return this.events
      .filter((event) => event.entryId === entryId)
      .sort((a, b) => b.observedAt - a.observedAt)
      .slice(0, capped);
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  getEntry(id: string): RiskRegisterEntry {
    return this.requireEntry(id);
  }

  hasEntry(id: string): boolean {
    return this.entries.has(id);
  }

  listEntries(
    filter: {
      kind?: RiskEntryKind;
      status?: RiskEntryStatus;
      chain?: string;
    } = {},
  ): RiskRegisterEntry[] {
    return [...this.entries.values()]
      .filter((entry) => (filter.kind ? entry.kind === filter.kind : true))
      .filter((entry) =>
        filter.status ? entry.status === filter.status : true,
      )
      .filter((entry) =>
        filter.chain ? entry.chains.includes(filter.chain) : true,
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Declare that a provider leans on these entries (routing boundary link). */
  linkProvider(providerId: string, entryIds: string[]): void {
    const id = requireIdentifier(providerId, 'providerId');
    const set = this.providers.get(id) ?? new Set<string>();
    for (const entryId of entryIds) {
      const entry = this.requireEntry(entryId);
      set.add(entry.id);
    }
    this.providers.set(id, set);
  }

  /** Entries the given entry failure would take down, provider ids first. */
  providersAffectedBy(entryId: string): string[] {
    this.requireEntry(entryId);
    return [...this.providers.entries()]
      .filter(([, entries]) => entries.has(entryId))
      .map(([providerId]) => providerId)
      .sort();
  }

  // ─── Scoring and reporting ────────────────────────────────────────────────

  /** Deterministic, explained risk score for one entry. */
  score(entryId: string, at: number = this.now()): RiskScore {
    const entry = this.requireEntry(entryId);
    const factors: RiskFactor[] = [];

    const criticality = CRITICALITY_POINTS[entry.criticality];
    factors.push({
      id: 'criticality',
      weight: CRITICALITY_POINTS.critical,
      contribution: criticality,
      detail: `criticality is ${entry.criticality}`,
    });

    const trust = TRUST_POINTS[entry.trustModel];
    factors.push({
      id: 'trust-model',
      weight: TRUST_POINTS['single-vendor'],
      contribution: trust,
      detail: `trust model is ${entry.trustModel}`,
    });

    const fallbacks = this.resolveFallbacks(entry);
    const fallbackContribution =
      fallbacks.length === 0
        ? NO_FALLBACK_POINTS
        : fallbacks.length === 1
          ? SINGLE_FALLBACK_POINTS
          : 0;
    factors.push({
      id: 'fallback-coverage',
      weight: NO_FALLBACK_POINTS,
      contribution: fallbackContribution,
      detail:
        fallbacks.length === 0
          ? 'no registered fallback entry'
          : fallbacks.length === 1
            ? 'a single registered fallback entry'
            : `${fallbacks.length} registered fallback entries`,
    });

    const status = STATUS_POINTS[entry.status];
    factors.push({
      id: 'status',
      weight: STATUS_POINTS.suspended,
      contribution: status,
      detail: `status is ${entry.status}`,
    });

    const recentFailures = this.recentFailures(entry.id, at).length;
    const failureContribution = Math.min(
      RECENT_FAILURE_POINTS,
      recentFailures * RECENT_FAILURE_POINTS_PER_EVENT,
    );
    factors.push({
      id: 'recent-failures',
      weight: RECENT_FAILURE_POINTS,
      contribution: failureContribution,
      detail: `${recentFailures} failure event(s) in the last ${Math.round(this.failureWindowMs / 3600000)}h`,
    });

    const lastFailureAt = this.lastFailureAt(entry.id);
    const stale =
      lastFailureAt !== undefined && at - lastFailureAt > this.staleAfterMs;
    const staleContribution = stale ? STALE_POINTS : 0;
    factors.push({
      id: 'verification-staleness',
      weight: STALE_POINTS,
      contribution: staleContribution,
      detail: stale
        ? `last verified more than ${Math.round(this.staleAfterMs / 86400000)}d ago`
        : 'verified within the freshness window',
    });

    const score = clamp(
      factors.reduce((sum, factor) => sum + factor.contribution, 0),
      0,
      100,
    );
    return {
      entryId: entry.id,
      kind: entry.kind,
      score,
      level: levelFor(score),
      factors: Object.freeze(factors),
      computedAt: at,
    };
  }

  /** Register-wide assessment: worst first, with exposure and data defects. */
  assess(at: number = this.now()): RiskReport {
    this.counters.assessments += 1;

    const scored: RiskReportEntry[] = this.listEntries({ status: 'active' })
      .concat(
        this.listEntries({ status: 'degraded' }),
        this.listEntries({ status: 'suspended' }),
      )
      .map((entry) => ({ entry, score: this.score(entry.id, at) }))
      .sort(
        (a, b) =>
          b.score.score - a.score.score ||
          (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0),
      );

    const counts: Record<RiskLevel, number> = {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    };
    for (const item of scored) counts[item.score.level] += 1;

    const activeIds = new Set(scored.map((item) => item.entry.id));
    const dangling = new Set<string>();
    for (const item of scored) {
      for (const fallbackId of item.entry.fallbackEntryIds) {
        if (!this.entries.has(fallbackId) || !activeIds.has(fallbackId))
          dangling.add(fallbackId);
      }
    }

    const providerExposure: Record<string, string[]> = {};
    for (const [providerId, entryIds] of this.providers) {
      const linked = [...entryIds]
        .filter((entryId) => activeIds.has(entryId))
        .sort();
      if (linked.length > 0) providerExposure[providerId] = linked;
    }

    return {
      generatedAt: at,
      failureWindowMs: this.failureWindowMs,
      total: scored.length,
      counts,
      entries: Object.freeze(scored),
      highRisk: Object.freeze(
        scored
          .filter(
            (item) =>
              item.score.level === 'high' || item.score.level === 'critical',
          )
          .map((item) => item.entry.id),
      ),
      singlePointsOfFailure: Object.freeze(
        scored
          .filter(
            (item) =>
              (item.entry.criticality === 'critical' ||
                item.entry.criticality === 'high') &&
              item.entry.fallbackEntryIds.length === 0,
          )
          .map((item) => item.entry.id),
      ),
      danglingFallbacks: Object.freeze([...dangling].sort()),
      providerExposure: Object.freeze(providerExposure),
    };
  }

  metrics(): RiskRegisterMetrics {
    return { ...this.counters };
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private validateEntryInput(
    input: RegisterRiskEntryInput,
  ): Omit<RiskRegisterEntry, 'registeredAt' | 'updatedAt'> {
    const reject = (message: string): never => {
      this.counters.rejectedInputs += 1;
      throw new RiskRegisterError('INVALID_ENTRY', message);
    };

    if (!input || typeof input !== 'object') reject('entry must be an object');
    const id = requireIdentifier(
      input.id,
      'id',
      () => this.counters.rejectedInputs++,
    );
    if (!KINDS.includes(input.kind))
      reject(`unknown kind "${String(input.kind)}"`);
    const label = (input.label ?? '').trim();
    if (!label || label.length > MAX_LABEL_LENGTH) {
      reject(`label must be 1..${MAX_LABEL_LENGTH} characters`);
    }
    if (!CRITICALITY.includes(input.criticality)) {
      reject(`unknown criticality "${String(input.criticality)}"`);
    }
    if (!TRUST_MODELS.includes(input.trustModel)) {
      reject(`unknown trust model "${String(input.trustModel)}"`);
    }
    if (input.status !== undefined && !STATUSES.includes(input.status)) {
      reject(`unknown status "${String(input.status)}"`);
    }
    if ((input.status as string | undefined) === 'retired')
      reject('entries cannot be registered as retired; retire() instead');

    const chains = normalizeChains(input.chains, reject);
    const fallbackEntryIds = normalizeIds(
      input.fallbackEntryIds,
      MAX_FALLBACKS,
      'fallbackEntryIds',
      () => {
        this.counters.rejectedInputs += 1;
      },
    );
    const endpointHost =
      input.endpointHost === undefined
        ? undefined
        : normalizeHost(input.endpointHost, reject);

    return {
      id,
      kind: input.kind,
      label,
      criticality: input.criticality,
      trustModel: input.trustModel,
      chains: Object.freeze(chains),
      version:
        input.version === undefined
          ? undefined
          : String(input.version).slice(0, 64),
      endpointHost,
      fallbackEntryIds: Object.freeze(fallbackEntryIds),
      ownerId:
        input.ownerId === undefined
          ? undefined
          : requireIdentifier(
              input.ownerId,
              'ownerId',
              () => this.counters.rejectedInputs++,
            ),
      status: input.status ?? 'active',
      metadata: sanitizeParams(input.metadata),
    };
  }

  private validateFailureEvent(input: FailureEventInput): FailureEvent {
    const reject = (message: string): never => {
      this.counters.rejectedInputs += 1;
      throw new RiskRegisterError('INVALID_FAILURE_EVENT', message);
    };
    if (!input || typeof input !== 'object')
      reject('failure event must be an object');
    const entryId = requireIdentifier(
      input.entryId,
      'entryId',
      () => this.counters.rejectedInputs++,
      'INVALID_FAILURE_EVENT',
    );
    if (!this.entries.has(entryId)) {
      this.counters.rejectedInputs += 1;
      throw new RiskRegisterError(
        'ENTRY_NOT_FOUND',
        `entry "${entryId}" is not registered`,
      );
    }
    if (
      typeof input.observedAt !== 'number' ||
      !Number.isFinite(input.observedAt)
    ) {
      reject('observedAt must be a finite epoch-ms number');
    }
    const reason = (input.reason ?? '').trim();
    if (
      reason.length < REASON_MIN_LENGTH ||
      reason.length > REASON_MAX_LENGTH
    ) {
      reject(
        `reason must be ${REASON_MIN_LENGTH}..${REASON_MAX_LENGTH} characters`,
      );
    }
    const observedBy = requireIdentifier(
      input.observedBy,
      'observedBy',
      () => this.counters.rejectedInputs++,
      'INVALID_FAILURE_EVENT',
    );
    const eventId =
      input.eventId === undefined
        ? randomUUID()
        : requireIdentifier(
            input.eventId,
            'eventId',
            () => this.counters.rejectedInputs++,
            'INVALID_FAILURE_EVENT',
          );

    return {
      eventId,
      entryId,
      observedAt: input.observedAt,
      // Reason is caller text: strip control chars, cap length, no newlines.
      reason: stripControlCharacters(reason).slice(0, REASON_MAX_LENGTH),
      observedBy,
      durationMs:
        input.durationMs === undefined
          ? undefined
          : validateDuration(input.durationMs, reject),
    };
  }

  private requireEntry(id: string): RiskRegisterEntry {
    const entry = this.entries.get(id);
    if (!entry)
      throw new RiskRegisterError(
        'ENTRY_NOT_FOUND',
        `entry "${id}" is not registered`,
      );
    return entry;
  }

  private resolveFallbacks(entry: RiskRegisterEntry): RiskRegisterEntry[] {
    return entry.fallbackEntryIds
      .map((fallbackId) => this.entries.get(fallbackId))
      .filter(
        (fallback): fallback is RiskRegisterEntry =>
          fallback !== undefined && fallback.status !== 'retired',
      );
  }

  private recentFailures(entryId: string, at: number): FailureEvent[] {
    const since = at - this.failureWindowMs;
    return this.events.filter(
      (event) => event.entryId === entryId && event.observedAt >= since,
    );
  }

  private lastFailureAt(entryId: string): number | undefined {
    let latest: number | undefined;
    for (const event of this.events) {
      if (
        event.entryId === entryId &&
        (latest === undefined || event.observedAt > latest)
      ) {
        latest = event.observedAt;
      }
    }
    return latest;
  }

  private evictOverflow(): void {
    while (this.events.length > this.maxFailureEvents) {
      const evicted = this.events.shift();
      if (!evicted) break;
      this.eventIds.delete(evicted.eventId);
      this.eventsByEntry.get(evicted.entryId)?.delete(evicted.eventId);
    }
  }

  private writeAudit(
    outcome: 'attempted' | 'success' | 'failed',
    input: {
      actor: string;
      action: string;
      target: string;
      correlationId?: string;
      params?: Record<string, unknown>;
    },
  ): void {
    if (!this.audit) return;
    this.audit.record({
      actor: input.actor,
      action: input.action,
      category: 'configuration',
      target: input.target,
      outcome,
      correlationId: input.correlationId,
      params: input.params,
    });
  }

  private emit(
    level: RiskLogEvent['level'],
    code: string,
    entryId: string,
    message: string,
  ): void {
    this.logSink?.({ level, code, entryId, at: this.now(), message });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function levelFor(score: number): RiskLevel {
  return LEVEL_THRESHOLDS.find((threshold) => score >= threshold.min).level;
}

function positive(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RiskRegisterError(
      'INVALID_ENTRY',
      `${name} must be a positive number`,
    );
  }
  return value;
}

function requireIdentifier(
  value: unknown,
  name: string,
  onReject?: () => void,
  code: RiskRegisterErrorCode = 'INVALID_ENTRY',
): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!ID_PATTERN.test(id)) {
    onReject?.();
    throw new RiskRegisterError(
      code,
      `${name} must match ${ID_PATTERN} (got ${JSON.stringify(typeof value === 'string' ? value.slice(0, 80) : value)})`,
    );
  }
  return id;
}

function requireReason(
  value: unknown,
  label: string,
  code: RiskRegisterErrorCode = 'INVALID_FAILURE_EVENT',
): string {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason.length < REASON_MIN_LENGTH || reason.length > REASON_MAX_LENGTH) {
    throw new RiskRegisterError(
      code,
      `${label} must be ${REASON_MIN_LENGTH}..${REASON_MAX_LENGTH} characters`,
    );
  }
  return stripControlCharacters(reason);
}

/**
 * Replace C0/DEL control characters with spaces. Caller-supplied text is
 * untrusted: control characters are a common way to smuggle content past
 * log viewers and terminals.
 */
function stripControlCharacters(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    result += code < 0x20 || code === 0x7f ? ' ' : character;
  }
  return result;
}

function normalizeChains(
  chains: string[] | undefined,
  reject: (message: string) => never,
): string[] {
  if (chains === undefined) return [];
  if (!Array.isArray(chains)) reject('chains must be an array of strings');
  if (chains.length > MAX_CHAINS)
    reject(`chains must contain at most ${MAX_CHAINS} items`);
  const seen = new Set<string>();
  for (const chain of chains) {
    if (typeof chain !== 'string' || !chain.trim())
      reject('chains must contain non-empty strings');
    const normalized = chain.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(normalized)) {
      reject(`chain "${chain}" has an invalid format`);
    }
    seen.add(normalized);
  }
  return [...seen].sort();
}

function normalizeIds(
  ids: string[] | undefined,
  max: number,
  name: string,
  onReject: () => void,
): string[] {
  if (ids === undefined) return [];
  if (!Array.isArray(ids)) {
    onReject();
    throw new RiskRegisterError(
      'INVALID_ENTRY',
      `${name} must be an array of ids`,
    );
  }
  if (ids.length > max) {
    onReject();
    throw new RiskRegisterError(
      'INVALID_ENTRY',
      `${name} must contain at most ${max} items`,
    );
  }
  const unique = new Set<string>();
  for (const id of ids) unique.add(requireIdentifier(id, name, onReject));
  return [...unique].sort();
}

/**
 * Endpoint references are untrusted: accept a bare hostname or an http(s)
 * origin, and reject anything that could smuggle credentials or keys into
 * the register (`user:pass@host`, `?apiKey=...`, `#...`, non-http schemes).
 */
function normalizeHost(
  raw: string,
  reject: (message: string) => never,
): string {
  const value = String(raw).trim();
  if (!value || value.length > 255)
    reject('endpointHost must be 1..255 characters');
  if (/\s/.test(value)) reject('endpointHost must not contain whitespace');

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    ? value
    : `https://${value}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    reject(`endpointHost "${raw}" is not a valid host or URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    reject('endpointHost must use http or https');
  }
  if (url.username || url.password) {
    reject('endpointHost must not contain credentials');
  }
  if (url.search || url.hash) {
    reject(
      'endpointHost must not contain a query string or fragment (possible API key)',
    );
  }
  return url.hostname.toLowerCase();
}

function validateDuration(
  value: number,
  reject: (message: string) => never,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    reject('durationMs must be a non-negative finite number');
  }
  return value;
}
