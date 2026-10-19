/**
 * File: src/routing/emergency/emergency-route-disable.types.ts
 *
 * Types for emergency route disablement with audit (#1383).
 *
 * When an operator suspects a route is unsafe — exploited bridge contract,
 * poisoned liquidity, compromised relayer — they need to stop new executions
 * on that route *now*, without waiting for governance. This feature is the
 * break-glass switch: disabling is deliberately cheap (any authorized
 * operator role), restoring is deliberately expensive (governance/admin
 * roles only), and every transition lands in the privileged action audit log
 * under the `emergency` category so the incident record is complete.
 *
 * The disable record is the routing-boundary input: routing and execution
 * consult {@link EmergencyRouteDisableResult} through the service's
 * `isRouteDisabled` / `listDisabledRoutes` and stop offering the route.
 */

/** Who requested the disable, and what they were allowed to do. */
export interface EmergencyDisableInput {
  /** Route identifier as used by the router (opaque, non-empty). */
  routeId: string;
  /** Optional chain scope; when given, the disable is corridor-specific. */
  sourceChain?: string;
  destinationChain?: string;
  /** Operator identity (user id, service name, or wallet address). */
  actor: string;
  /** Roles the actor holds. Checked against the configured role sets. */
  actorRoles: string[];
  /** Why the route is being disabled. Minimum 8 characters. */
  reason: string;
  /** Incident/ticket reference, echoed into the audit trail. */
  incidentId?: string;
  /** Auto-restore after this many ms; omitted means until restored. */
  ttlMs?: number;
  /** Ties the disable's audit entries together; generated when omitted. */
  correlationId?: string;
}

export interface EmergencyDisableRecord {
  readonly routeId: string;
  readonly sourceChain?: string;
  readonly destinationChain?: string;
  readonly disabled: true;
  readonly disabledAt: number;
  readonly disabledBy: string;
  readonly reason: string;
  readonly incidentId?: string;
  readonly expiresAt?: number;
  /** How many disable requests produced this record (idempotent replays count). */
  readonly requestCount: number;
  /** Incremented on every replay so operators can see repeated reports. */
  readonly version: number;
  readonly correlationId: string;
}

export interface EmergencyDisableResult {
  readonly record: EmergencyDisableRecord;
  /** True when a previous disable already covered this request. */
  readonly alreadyDisabled: boolean;
}

export interface EmergencyRestoreInput {
  routeId: string;
  actor: string;
  actorRoles: string[];
  /** Why the route is safe again. Minimum 8 characters. */
  reason: string;
  incidentId?: string;
  correlationId?: string;
}

export interface EmergencyRestoreResult {
  readonly restored: boolean;
  readonly routeId: string;
  /** Set when nothing was disabled; the call is a successful no-op. */
  readonly code?: 'NOT_DISABLED';
  readonly restoredAt?: number;
  readonly restoredBy?: string;
}

export interface EmergencyDisableFilter {
  sourceChain?: string;
  destinationChain?: string;
  incidentId?: string;
  /** Default true: only currently-active (unexpired) disables. */
  activeOnly?: boolean;
}

export interface EmergencyRouteDisableConfig {
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Roles that may disable a route in an emergency (default below). */
  disableRoles?: string[];
  /** Roles that may restore a disabled route (default below). */
  restoreRoles?: string[];
  /** Maximum simultaneously-active disables (default 100). */
  maxActiveDisables?: number;
  /** Minimum reason length (default 8). */
  minReasonLength?: number;
  /** Maximum reason length (default 512). */
  maxReasonLength?: number;
  /** Maximum routeId length (default 128). */
  maxRouteIdLength?: number;
  /**
   * Notified on every state transition (disable, replay, restore, expiry).
   * Receives only frozen records — wire it to the router/execution pause
   * boundary, never to a logger that prints payloads.
   */
  onStateChange?: (event: EmergencyStateChangeEvent) => void;
}

export type EmergencyStateChangeType =
  'route-disabled' | 'disable-replayed' | 'route-restored';

export interface EmergencyStateChangeEvent {
  readonly type: EmergencyStateChangeType;
  readonly at: number;
  readonly actor: string;
  readonly record: EmergencyDisableRecord;
}

export type EmergencyDisableErrorCode =
  | 'INVALID_INPUT'
  | 'UNAUTHORIZED'
  | 'ROUTE_ALREADY_DISABLED'
  | 'CHAIN_MISMATCH'
  | 'NOT_DISABLED'
  | 'LIMIT_EXCEEDED';

/** Thrown for malformed input, authorization failures, and scope conflicts. */
export class EmergencyRouteDisableError extends Error {
  constructor(
    public readonly code: EmergencyDisableErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EmergencyRouteDisableError';
  }
}
