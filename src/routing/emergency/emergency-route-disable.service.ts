/**
 * File: src/routing/emergency/emergency-route-disable.service.ts
 *
 * Emergency route disablement with audit (#1383).
 *
 * Break-glass switch for the routing boundary. Asymmetric by design:
 *
 *   - Disabling is cheap: any actor holding a configured `disableRoles` role
 *     can stop a route immediately, with a reason and optional incident id.
 *   - Restoring is expensive: only `restoreRoles` (governance/admin) can
 *     bring a route back, and the restore lands in the same audit trail.
 *
 * Guarantees:
 *   - Idempotent: replaying a disable for an already-covered route returns
 *     the existing record (`alreadyDisabled: true`) instead of creating a
 *     second disable, so retried automation cannot thrash the router. The
 *     replay is still audited and bumps `version` for incident forensics.
 *   - Audited before it acts: an `attempted` entry is written first; if the
 *     audit log rejects it the disable never happens. Denied attempts are
 *     recorded with the reason, so a blocked restore attempt is evidence.
 *   - Untrusted input is rejected before any state change: malformed ids,
 *     short reasons, oversized payloads, and mismatched chain scopes all
 *     fail with {@link EmergencyRouteDisableError} codes.
 *   - Expiry is lazy and deterministic: a TTL'd disable stops matching at
 *     `expiresAt` (checked against the injectable clock); the record stays
 *     queryable (activeOnly: false) until it is restored or superseded by a
 *     later disable, and the audit log keeps the full history either way.
 *
 * Integration: `onStateChange` fires for every transition — wire it to the
 * router/execution pause boundary. `isRouteDisabled` / `listDisabledRoutes`
 * are the read path the router must consult before offering a route.
 */

import { randomUUID } from 'crypto';
import type { PrivilegedActionAuditLog } from '../../audit/privileged/privileged-action-audit-log';
import type {
  EmergencyDisableFilter,
  EmergencyDisableInput,
  EmergencyDisableRecord,
  EmergencyDisableResult,
  EmergencyRestoreInput,
  EmergencyRestoreResult,
  EmergencyRouteDisableConfig,
  EmergencyStateChangeEvent,
} from './emergency-route-disable.types';
import { EmergencyRouteDisableError } from './emergency-route-disable.types';

const DEFAULT_DISABLE_ROLES = [
  'operator',
  'emergency-operator',
  'incident-commander',
  'admin',
];
const DEFAULT_RESTORE_ROLES = ['admin', 'governance'];
const DEFAULT_MAX_ACTIVE = 100;
const DEFAULT_MIN_REASON = 8;
const DEFAULT_MAX_REASON = 512;
const DEFAULT_MAX_ROUTE_ID = 128;
const MAX_CHAIN_LENGTH = 64;
const MAX_INCIDENT_ID_LENGTH = 128;

export class EmergencyRouteDisableService {
  private readonly records = new Map<string, EmergencyDisableRecord>();
  private readonly restoreEvents: EmergencyRestoreRecord[] = [];

  private readonly now: () => number;
  private readonly disableRoles: Set<string>;
  private readonly restoreRoles: Set<string>;
  private readonly maxActiveDisables: number;
  private readonly minReasonLength: number;
  private readonly maxReasonLength: number;
  private readonly maxRouteIdLength: number;
  private readonly onStateChange?: (event: EmergencyStateChangeEvent) => void;

  constructor(
    private readonly audit?: PrivilegedActionAuditLog,
    config: EmergencyRouteDisableConfig = {},
  ) {
    this.now = config.now ?? (() => Date.now());
    this.disableRoles = new Set(
      (config.disableRoles ?? DEFAULT_DISABLE_ROLES).map((role) =>
        role.trim().toLowerCase(),
      ),
    );
    this.restoreRoles = new Set(
      (config.restoreRoles ?? DEFAULT_RESTORE_ROLES).map((role) =>
        role.trim().toLowerCase(),
      ),
    );
    this.maxActiveDisables = config.maxActiveDisables ?? DEFAULT_MAX_ACTIVE;
    this.minReasonLength = config.minReasonLength ?? DEFAULT_MIN_REASON;
    this.maxReasonLength = config.maxReasonLength ?? DEFAULT_MAX_REASON;
    this.maxRouteIdLength = config.maxRouteIdLength ?? DEFAULT_MAX_ROUTE_ID;
    this.onStateChange = config.onStateChange;
  }

  // ─── Disable ──────────────────────────────────────────────────────────────

  /**
   * Disable a route for emergency reasons. Idempotent, authorized, audited
   * (`emergency.route.disable`), and validated before any state changes.
   */
  disableRoute(input: EmergencyDisableInput): EmergencyDisableResult {
    const scope = this.validateDisableInput(input);
    const actor = requireActor(input.actor);
    const at = this.now();
    const correlationId = scope.correlationId ?? randomUUID();
    const auditBase = {
      actor,
      action: 'emergency.route.disable',
      target: scope.routeId,
      correlationId,
      params: {
        reason: scope.reason,
        incidentId: scope.incidentId,
        sourceChain: scope.sourceChain,
        destinationChain: scope.destinationChain,
        expiresAt: scope.expiresAt,
      },
    };
    // Written first: if the audit log rejects the event, the route stays live.
    this.writeAudit('attempted', auditBase);

    // Authorization before any state change; denials are still audited.
    this.requireRole(
      input.actor,
      input.actorRoles,
      this.disableRoles,
      'disable',
      scope.routeId,
      {
        reason: scope.reason,
        incidentId: scope.incidentId,
      },
    );

    const existing = this.records.get(scope.routeId);
    if (existing && this.isActive(existing, at)) {
      // The active record must cover the requested scope: a corridor-scoped
      // disable cannot silently answer a request for a different corridor.
      if (
        (existing.sourceChain ?? undefined) !== scope.sourceChain ||
        (existing.destinationChain ?? undefined) !== scope.destinationChain
      ) {
        this.writeAudit('denied', {
          actor,
          action: 'emergency.route.disable',
          target: scope.routeId,
          correlationId,
          reason: 'chain scope mismatch with active disable',
          params: { incidentId: scope.incidentId },
        });
        throw new EmergencyRouteDisableError(
          'CHAIN_MISMATCH',
          `route "${scope.routeId}" is already disabled for a different chain scope`,
        );
      }

      // Idempotent replay: same record, no second disable, still audited.
      const replayed: EmergencyDisableRecord = Object.freeze({
        ...existing,
        requestCount: existing.requestCount + 1,
        version: existing.version + 1,
      });
      this.records.set(scope.routeId, replayed);
      this.writeAudit('success', {
        actor,
        action: 'emergency.route.disable',
        target: scope.routeId,
        correlationId: replayed.correlationId,
        reason: 'idempotent replay of an active disable',
        params: {
          incidentId: scope.incidentId,
          alreadyDisabled: true,
          version: replayed.version,
        },
      });
      this.notify({ type: 'disable-replayed', at, actor, record: replayed });
      return { record: replayed, alreadyDisabled: true };
    }

    if (this.countActive(at) >= this.maxActiveDisables) {
      this.writeAudit('denied', {
        actor,
        action: 'emergency.route.disable',
        target: scope.routeId,
        correlationId,
        reason: 'active disable limit reached',
        params: { limit: this.maxActiveDisables },
      });
      throw new EmergencyRouteDisableError(
        'LIMIT_EXCEEDED',
        `already ${this.maxActiveDisables} active emergency disables; restore or expire old ones first`,
      );
    }

    const record: EmergencyDisableRecord = Object.freeze({
      routeId: scope.routeId,
      sourceChain: scope.sourceChain,
      destinationChain: scope.destinationChain,
      disabled: true as const,
      disabledAt: at,
      disabledBy: actor,
      reason: scope.reason,
      incidentId: scope.incidentId,
      expiresAt: scope.expiresAt,
      requestCount: 1,
      version: 1,
      correlationId,
    });
    this.records.set(record.routeId, record);
    this.writeAudit('success', auditBase);
    this.notify({ type: 'route-disabled', at, actor, record });
    return { record, alreadyDisabled: false };
  }

  // ─── Restore ──────────────────────────────────────────────────────────────

  /**
   * Re-enable a disabled route. Requires an elevated (`restoreRoles`)
   * principal; every restore is audited as `emergency.route.restore`.
   * Restoring a route that is not disabled is a successful no-op.
   */
  restoreRoute(input: EmergencyRestoreInput): EmergencyRestoreResult {
    const routeId = requireRouteId(input?.routeId, this.maxRouteIdLength);
    const actor = requireActor(input?.actor);
    const reason = requireReason(
      input?.reason,
      this.minReasonLength,
      this.maxReasonLength,
    );

    const at = this.now();
    const correlationId = input.correlationId ?? randomUUID();
    // Written first: if the audit log rejects the event, nothing is restored.
    this.writeAudit('attempted', {
      actor,
      action: 'emergency.route.restore',
      target: routeId,
      correlationId,
      params: { reason, incidentId: input.incidentId },
    });

    this.requireRole(
      input.actor,
      input.actorRoles,
      this.restoreRoles,
      'restore',
      routeId,
      { reason },
    );

    const existing = this.records.get(routeId);
    if (!existing) {
      this.writeAudit('success', {
        actor,
        action: 'emergency.route.restore',
        target: routeId,
        correlationId,
        params: { reason, restored: false, code: 'NOT_DISABLED' },
      });
      return { restored: false, routeId, code: 'NOT_DISABLED' };
    }

    this.records.delete(routeId);
    const snapshot: EmergencyDisableRecord = existing;
    this.restoreEvents.push(
      Object.freeze({
        routeId,
        restoredAt: at,
        restoredBy: actor,
        reason,
        correlationId,
      }),
    );
    this.writeAudit('success', {
      actor,
      action: 'emergency.route.restore',
      target: routeId,
      correlationId,
      params: {
        reason,
        incidentId: existing.incidentId,
        restored: true,
        disabledAt: existing.disabledAt,
        disabledBy: existing.disabledBy,
      },
    });
    this.onStateChange?.({
      type: 'route-restored',
      at,
      actor,
      record: snapshot,
    });
    return { restored: true, routeId, restoredAt: at, restoredBy: actor };
  }

  // ─── Read path (router / execution boundary) ──────────────────────────────

  /** True while the route is disabled and unexpired at `at`. */
  isRouteDisabled(routeId: string, at: number = this.now()): boolean {
    const record = this.records.get(routeId);
    return record !== undefined && this.isActive(record, at);
  }

  /** The active disable record for a route, if any. */
  getActiveDisable(
    routeId: string,
    at: number = this.now(),
  ): EmergencyDisableRecord | undefined {
    const record = this.records.get(routeId);
    return record !== undefined && this.isActive(record, at)
      ? record
      : undefined;
  }

  /** Active (and optionally historical) disables, filterable by corridor. */
  listDisabledRoutes(
    filter: EmergencyDisableFilter = {},
  ): EmergencyDisableRecord[] {
    const at = this.now();
    const activeOnly = filter.activeOnly !== false;
    return [...this.records.values()]
      .filter((record) => (activeOnly ? this.isActive(record, at) : true))
      .filter((record) =>
        filter.sourceChain !== undefined
          ? record.sourceChain === filter.sourceChain
          : true,
      )
      .filter((record) =>
        filter.destinationChain !== undefined
          ? record.destinationChain === filter.destinationChain
          : true,
      )
      .filter((record) =>
        filter.incidentId !== undefined
          ? record.incidentId === filter.incidentId
          : true,
      )
      .sort((a, b) => b.disabledAt - a.disabledAt);
  }

  /** Restore history for incident review (append-only in practice). */
  getRestoreHistory(): readonly EmergencyRestoreRecord[] {
    return this.restoreEvents;
  }

  /** Audit entries for one route, oldest first: the incident record. */
  getAuditTrail(
    routeId: string,
  ): ReturnType<PrivilegedActionAuditLog['query']> {
    if (!this.audit) return { total: 0, items: [] };
    return this.audit.query({
      target: routeId,
      category: 'emergency',
      order: 'asc',
    });
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private validateDisableInput(input: EmergencyDisableInput): {
    routeId: string;
    reason: string;
    incidentId?: string;
    sourceChain?: string;
    destinationChain?: string;
    expiresAt?: number;
    correlationId?: string;
  } {
    const routeId = requireRouteId(input?.routeId, this.maxRouteIdLength);
    const reason = requireReason(
      input?.reason,
      this.minReasonLength,
      this.maxReasonLength,
    );
    const incidentId =
      input.incidentId === undefined
        ? undefined
        : requireIncidentId(input.incidentId, MAX_INCIDENT_ID_LENGTH);
    const sourceChain =
      input.sourceChain === undefined
        ? undefined
        : requireChain(input.sourceChain, 'sourceChain', MAX_CHAIN_LENGTH);
    const destinationChain =
      input.destinationChain === undefined
        ? undefined
        : requireChain(
            input.destinationChain,
            'destinationChain',
            MAX_CHAIN_LENGTH,
          );

    let expiresAt: number | undefined;
    if (input.ttlMs !== undefined) {
      if (
        typeof input.ttlMs !== 'number' ||
        !Number.isFinite(input.ttlMs) ||
        input.ttlMs <= 0 ||
        !Number.isInteger(input.ttlMs)
      ) {
        throw new EmergencyRouteDisableError(
          'INVALID_INPUT',
          'ttlMs must be a positive integer number of milliseconds',
        );
      }
      expiresAt = this.now() + input.ttlMs;
    }

    return {
      routeId,
      reason,
      incidentId,
      sourceChain,
      destinationChain,
      expiresAt,
      correlationId: input.correlationId,
    };
  }

  private requireRole(
    actor: string,
    actorRoles: string[] | undefined,
    allowed: Set<string>,
    operation: 'disable' | 'restore',
    routeId: string,
    params: Record<string, unknown>,
  ): void {
    const roles = Array.isArray(actorRoles)
      ? actorRoles.filter((role): role is string => typeof role === 'string')
      : [];
    const normalized = roles.map((role) => role.trim().toLowerCase());
    const authorized = normalized.some((role) => allowed.has(role));

    if (!authorized) {
      const allowedRoles = [...allowed].sort();
      const action = `emergency.route.${operation}`;
      this.writeAudit('denied', {
        actor,
        action,
        target: routeId,
        reason: `actor lacks an authorized ${operation} role`,
        params: { ...params, roles: normalized, allowedRoles },
      });
      throw new EmergencyRouteDisableError(
        'UNAUTHORIZED',
        `actor "${actor}" is not authorized to ${operation} route "${routeId}" (requires one of: ${allowedRoles.join(', ')})`,
      );
    }
  }

  private isActive(record: EmergencyDisableRecord, at: number): boolean {
    return record.expiresAt === undefined || at < record.expiresAt;
  }

  private countActive(at: number): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (this.isActive(record, at)) count += 1;
    }
    return count;
  }

  private notify(event: EmergencyStateChangeEvent): void {
    this.onStateChange?.(event);
  }

  private writeAudit(
    outcome: 'attempted' | 'success' | 'denied' | 'failed',
    input: {
      actor: string;
      action: string;
      target: string;
      correlationId?: string;
      reason?: string;
      params?: Record<string, unknown>;
    },
  ): void {
    if (!this.audit) return;
    this.audit.record({
      actor: input.actor,
      action: input.action,
      category: 'emergency',
      target: input.target,
      outcome,
      reason: input.reason,
      correlationId: input.correlationId,
      params: input.params,
    });
  }
}

/** Append-only record of restores, kept for incident review. */
interface EmergencyRestoreRecord {
  readonly routeId: string;
  readonly restoredAt: number;
  readonly restoredBy: string;
  readonly reason: string;
  readonly correlationId: string;
}

// ─── Validation helpers (untrusted input) ───────────────────────────────────

function requireRouteId(routeId: unknown, maxLength: number): string {
  const value = typeof routeId === 'string' ? routeId.trim() : '';
  if (!value) {
    throw new EmergencyRouteDisableError(
      'INVALID_INPUT',
      'routeId is required',
    );
  }
  if (value.length > maxLength) {
    throw new EmergencyRouteDisableError(
      'INVALID_INPUT',
      `routeId must be at most ${maxLength} characters`,
    );
  }
  if (hasControlCharacters(value)) {
    throw new EmergencyRouteDisableError(
      'INVALID_INPUT',
      'routeId must not contain control characters',
    );
  }
  return value;
}

function requireActor(actor: unknown): string {
  const value = typeof actor === 'string' ? actor.trim() : '';
  if (!value) {
    throw new EmergencyRouteDisableError('INVALID_INPUT', 'actor is required');
  }
  if (value.length > 256 || hasControlCharacters(value)) {
    throw new EmergencyRouteDisableError(
      'INVALID_INPUT',
      'actor must be at most 256 characters without control characters',
    );
  }
  return value;
}

function requireReason(
  reason: unknown,
  minLength: number,
  maxLength: number,
): string {
  const value = typeof reason === 'string' ? reason.trim() : '';
  if (value.length < minLength) {
    throw new EmergencyRouteDisableError(
      'INVALID_INPUT',
      `reason must be at least ${minLength} characters`,
    );
  }
  if (value.length > maxLength) {
    throw new EmergencyRouteDisableError(
      'INVALID_INPUT',
      `reason must be at most ${maxLength} characters`,
    );
  }
  return stripControlCharacters(value);
}

/** True when the untrusted text contains C0/DEL control characters. */
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Replace C0/DEL control characters with spaces. */
function stripControlCharacters(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    result += code < 0x20 || code === 0x7f ? ' ' : character;
  }
  return result;
}

function requireIncidentId(incidentId: unknown, maxLength: number): string {
  const value = typeof incidentId === 'string' ? incidentId.trim() : '';
  if (!value || value.length > maxLength) {
    throw new EmergencyRouteDisableError(
      'INVALID_INPUT',
      `incidentId must be 1..${maxLength} characters`,
    );
  }
  return value;
}

function requireChain(chain: unknown, name: string, maxLength: number): string {
  const value = typeof chain === 'string' ? chain.trim() : '';
  if (!value || value.length > maxLength) {
    throw new EmergencyRouteDisableError(
      'INVALID_INPUT',
      `${name} must be 1..${maxLength} characters`,
    );
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value)) {
    throw new EmergencyRouteDisableError(
      'INVALID_INPUT',
      `${name} must be a plain chain identifier`,
    );
  }
  return value;
}
