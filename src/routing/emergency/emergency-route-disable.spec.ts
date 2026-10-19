/**
 * File: src/routing/emergency/emergency-route-disable.spec.ts
 *
 * Tests for emergency route disablement with audit (#1383).
 * Deterministic clock and fixtures; covers success, boundary, invalid-input,
 * and failure cases, idempotent replays, TTL expiry boundaries, authorization
 * asymmetry (cheap disable, expensive restore), audit integrity, and the
 * router-facing state-change integration.
 */

import { PrivilegedActionAuditLog } from '../../audit/privileged/privileged-action-audit-log';
import { EmergencyRouteDisableService } from './emergency-route-disable.service';
import type {
  EmergencyStateChangeEvent,
  EmergencyRouteDisableConfig,
} from './emergency-route-disable.types';
import { EmergencyRouteDisableError } from './emergency-route-disable.types';

const T0 = 1_700_000_000_000;

const OPERATOR = { actor: 'op-1', actorRoles: ['operator'] };
const ADMIN = { actor: 'root-1', actorRoles: ['admin'] };

function makeService(config: Omit<EmergencyRouteDisableConfig, 'now'> = {}) {
  let clock = T0;
  const events: EmergencyStateChangeEvent[] = [];
  const audit = new PrivilegedActionAuditLog({ now: () => clock });
  const service = new EmergencyRouteDisableService(audit, {
    now: () => clock,
    onStateChange: (event) => events.push(event),
    ...config,
  });
  return {
    service,
    audit,
    events,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

function expectDisableError(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(EmergencyRouteDisableError);
    expect((error as EmergencyRouteDisableError).code).toBe(code);
    return;
  }
  throw new Error(`expected EmergencyRouteDisableError with code "${code}" to be thrown`);
}

const disable = (overrides: Record<string, unknown> = {}) => ({
  routeId: 'route-eth-polygon-usdc',
  reason: 'suspected bridge contract exploit',
  incidentId: 'INC-4411',
  ...OPERATOR,
  ...overrides,
});

describe('EmergencyRouteDisableService', () => {
  describe('disable (success and invalid input)', () => {
    it('disables a route and exposes it on the router read path', () => {
      const { service, events, audit } = makeService();

      const result = service.disableRoute(disable());

      expect(result.alreadyDisabled).toBe(false);
      expect(result.record).toMatchObject({
        routeId: 'route-eth-polygon-usdc',
        disabled: true,
        disabledBy: 'op-1',
        incidentId: 'INC-4411',
        requestCount: 1,
        version: 1,
      });
      expect(Object.isFrozen(result.record)).toBe(true);
      expect(service.isRouteDisabled('route-eth-polygon-usdc')).toBe(true);
      expect(service.getActiveDisable('route-eth-polygon-usdc')).toEqual(result.record);
      expect(service.listDisabledRoutes().map((record) => record.routeId)).toEqual([
        'route-eth-polygon-usdc',
      ]);
      expect(events.map((event) => event.type)).toEqual(['route-disabled']);
      expect(audit.query({ action: 'emergency.route.disable' }).total).toBe(2); // attempted + success
      expect(audit.verifyIntegrity().valid).toBe(true);
    });

    it('rejects malformed input before touching state or the audit log', () => {
      const { service, audit } = makeService();

      expectDisableError(() => service.disableRoute(disable({ routeId: '  ' })), 'INVALID_INPUT');
      expectDisableError(() => service.disableRoute(disable({ reason: 'short' })), 'INVALID_INPUT');
      expectDisableError(
        () => service.disableRoute(disable({ reason: 'a'.repeat(600) })),
        'INVALID_INPUT',
      );
      expectDisableError(
        () => service.disableRoute(disable({ routeId: 'route\u0000evil' })),
        'INVALID_INPUT',
      );
      expectDisableError(() => service.disableRoute(disable({ actor: '' })), 'INVALID_INPUT');
      expectDisableError(() => service.disableRoute(disable({ ttlMs: 0 })), 'INVALID_INPUT');
      expectDisableError(() => service.disableRoute(disable({ ttlMs: -5 })), 'INVALID_INPUT');
      expectDisableError(
        () => service.disableRoute(disable({ ttlMs: 1.5 })),
        'INVALID_INPUT',
      );
      expectDisableError(
        () => service.disableRoute(disable({ sourceChain: 'eth/mainnet' })),
        'INVALID_INPUT',
      );
      expectDisableError(() => service.disableRoute(disable({ incidentId: '' })), 'INVALID_INPUT');

      expect(service.listDisabledRoutes({ activeOnly: false })).toHaveLength(0);
      expect(audit.query().total).toBe(0);
    });

    it('denies and audits an unauthorized disable, leaving the route live', () => {
      const { service, audit } = makeService();

      expectDisableError(
        () => service.disableRoute(disable({ actor: 'mallory', actorRoles: ['viewer'] })),
        'UNAUTHORIZED',
      );

      expect(service.isRouteDisabled('route-eth-polygon-usdc')).toBe(false);
      const { items } = audit.query({ action: 'emergency.route.disable' });
      expect(items.map((entry) => entry.outcome)).toEqual(['attempted', 'denied']);
      expect(items[1].reason).toContain('authorized disable role');
      expect(items[1].actor).toBe('mallory');
      expect(audit.verifyIntegrity().valid).toBe(true);
    });

    it('treats role checks case-insensitively and accepts any listed role', () => {
      const { service } = makeService();

      service.disableRoute(disable({ actor: 'op-2', actorRoles: ['  Incident-Commander '] }));

      expect(service.isRouteDisabled('route-eth-polygon-usdc')).toBe(true);
    });
  });

  describe('idempotency (replays must not thrash the router)', () => {
    it('returns the existing record on replay and counts the request', () => {
      const { service, events, audit } = makeService();

      const first = service.disableRoute(disable());
      const replay = service.disableRoute(disable({ reason: 'confirmed: still exploited' }));

      expect(replay.alreadyDisabled).toBe(true);
      expect(replay.record.routeId).toBe(first.record.routeId);
      expect(replay.record.disabledAt).toBe(first.record.disabledAt);
      expect(replay.record.requestCount).toBe(2);
      expect(replay.record.version).toBe(2);
      expect(service.listDisabledRoutes()).toHaveLength(1);
      expect(events.map((event) => event.type)).toEqual(['route-disabled', 'disable-replayed']);

      const successes = audit.query({ action: 'emergency.route.disable', outcome: 'success' });
      expect(successes.total).toBe(2);
      expect(successes.items[1].reason).toContain('idempotent replay');
    });

    it('rejects a replay scoped to a different corridor (chain boundary)', () => {
      const { service } = makeService();
      service.disableRoute(disable({ sourceChain: 'ethereum', destinationChain: 'polygon' }));

      expectDisableError(
        () =>
          service.disableRoute(
            disable({ sourceChain: 'ethereum', destinationChain: 'arbitrum' }),
          ),
        'CHAIN_MISMATCH',
      );
      // Same corridor replays fine.
      const replay = service.disableRoute(
        disable({ sourceChain: 'ethereum', destinationChain: 'polygon' }),
      );
      expect(replay.alreadyDisabled).toBe(true);
    });
  });

  describe('expiry (TTL boundary)', () => {
    it('stops matching exactly at expiresAt and stays queryable as history', () => {
      const { service, advance } = makeService();
      const { record } = service.disableRoute(disable({ ttlMs: 15 * 60 * 1000 }));

      expect(record.expiresAt).toBe(T0 + 15 * 60 * 1000);
      expect(service.isRouteDisabled(record.routeId, record.expiresAt! - 1)).toBe(true);

      advance(15 * 60 * 1000); // now === expiresAt → expired
      expect(service.isRouteDisabled(record.routeId)).toBe(false);
      expect(service.getActiveDisable(record.routeId)).toBeUndefined();
      expect(service.listDisabledRoutes()).toHaveLength(0);
      expect(service.listDisabledRoutes({ activeOnly: false })).toHaveLength(1);
    });

    it('a re-disable after expiry creates a fresh record', () => {
      const { service, advance } = makeService();
      service.disableRoute(disable({ ttlMs: 1000 }));
      advance(1000);

      const second = service.disableRoute(disable());

      expect(second.alreadyDisabled).toBe(false);
      expect(second.record.version).toBe(1);
      expect(service.isRouteDisabled('route-eth-polygon-usdc')).toBe(true);
    });
  });

  describe('restore (elevated authority and audit)', () => {
    it('refuses to let a plain operator restore their own emergency disable', () => {
      const { service, audit } = makeService();
      service.disableRoute(disable());

      expectDisableError(
        () =>
          service.restoreRoute({
            ...OPERATOR,
            routeId: 'route-eth-polygon-usdc',
            reason: 'looks fine again now',
          }),
        'UNAUTHORIZED',
      );
      expect(service.isRouteDisabled('route-eth-polygon-usdc')).toBe(true);

      const denied = audit.query({ action: 'emergency.route.restore', outcome: 'denied' });
      expect(denied.total).toBe(1);
      expect(denied.items[0].reason).toContain('authorized restore role');
    });

    it('restores with an admin role, audits it, and notifies the router', () => {
      const { service, events, audit } = makeService();
      service.disableRoute(disable());

      const result = service.restoreRoute({
        ...ADMIN,
        routeId: 'route-eth-polygon-usdc',
        reason: 'bridge paused upstream, verified fix deployed',
        incidentId: 'INC-4411',
      });

      expect(result).toMatchObject({ restored: true, restoredBy: 'root-1' });
      expect(service.isRouteDisabled('route-eth-polygon-usdc')).toBe(false);
      expect(service.listDisabledRoutes({ activeOnly: false })).toHaveLength(0);
      expect(service.getRestoreHistory()).toHaveLength(1);
      expect(events.map((event) => event.type)).toEqual(['route-disabled', 'route-restored']);

      const { items } = audit.query({ action: 'emergency.route.restore' });
      expect(items.map((entry) => entry.outcome)).toEqual(['attempted', 'success']);
      expect(items[1].params).toMatchObject({ restored: true, incidentId: 'INC-4411' });
      expect(audit.verifyIntegrity().valid).toBe(true);
    });

    it('restoring a route that is not disabled is an audited no-op', () => {
      const { service, audit } = makeService();

      const result = service.restoreRoute({
        ...ADMIN,
        routeId: 'route-eth-polygon-usdc',
        reason: 'routine check complete',
      });

      expect(result).toEqual({
        restored: false,
        routeId: 'route-eth-polygon-usdc',
        code: 'NOT_DISABLED',
      });
      expect(audit.query({ action: 'emergency.route.restore', outcome: 'success' }).total).toBe(1);
    });

    it('rejects malformed restore input', () => {
      const { service } = makeService();

      expectDisableError(
        () => service.restoreRoute({ ...ADMIN, routeId: 'route-x', reason: 'ok' }),
        'INVALID_INPUT',
      );
      expectDisableError(
        () => service.restoreRoute({ ...ADMIN, routeId: '', reason: 'long enough reason' }),
        'INVALID_INPUT',
      );
      expectDisableError(
        () =>
          service.restoreRoute({
            actor: 'root-1',
            actorRoles: ['admin'],
            routeId: 'route-x',
          }),
        'INVALID_INPUT',
      );
    });
  });

  describe('capacity and filtering (operator boundaries)', () => {
    it('enforces the active-disable cap and audits the denial', () => {
      const { service, audit } = makeService({ maxActiveDisables: 2 });
      service.disableRoute(disable({ routeId: 'route-a' }));
      service.disableRoute(disable({ routeId: 'route-b' }));

      expectDisableError(() => service.disableRoute(disable({ routeId: 'route-c' })), 'LIMIT_EXCEEDED');

      expect(service.isRouteDisabled('route-c')).toBe(false);
      expect(service.listDisabledRoutes()).toHaveLength(2);
      expect(
        audit.query({ action: 'emergency.route.disable', outcome: 'denied', target: 'route-c' }).total,
      ).toBe(1);
    });

    it('filters by corridor and incident id', () => {
      const { service } = makeService();
      service.disableRoute(
        disable({ routeId: 'route-a', sourceChain: 'ethereum', destinationChain: 'polygon' }),
      );
      service.disableRoute(
        disable({
          routeId: 'route-b',
          sourceChain: 'stellar',
          destinationChain: 'polygon',
          incidentId: 'INC-9999',
        }),
      );

      expect(service.listDisabledRoutes({ sourceChain: 'stellar' }).map((r) => r.routeId)).toEqual([
        'route-b',
      ]);
      expect(
        service.listDisabledRoutes({ destinationChain: 'polygon', sourceChain: 'ethereum' }),
      ).toHaveLength(1);
      expect(service.listDisabledRoutes({ incidentId: 'INC-9999' }).map((r) => r.routeId)).toEqual([
        'route-b',
      ]);
    });

    it('supports custom role sets for stricter deployments', () => {
      const { service } = makeService({
        disableRoles: ['incident-commander'],
        restoreRoles: ['governance'],
      });

      expectDisableError(() => service.disableRoute(disable()), 'UNAUTHORIZED');
      service.disableRoute(disable({ actorRoles: ['incident-commander'] }));
      expectDisableError(
        () =>
          service.restoreRoute({
            ...ADMIN,
            routeId: 'route-eth-polygon-usdc',
            reason: 'safe again, verified',
          }),
        'UNAUTHORIZED',
      );
      expect(
        service.restoreRoute({
          actor: 'dao-3',
          actorRoles: ['governance'],
          routeId: 'route-eth-polygon-usdc',
          reason: 'safe again, verified by governance vote',
        }).restored,
      ).toBe(true);
    });
  });

  describe('audit trail (incident evidence)', () => {
    it('exposes the full per-route emergency trail, oldest first, without secrets', () => {
      const { service, audit } = makeService();
      service.disableRoute(disable());
      service.restoreRoute({ ...ADMIN, routeId: 'route-eth-polygon-usdc', reason: 'verified fix deployed upstream' });

      const trail = service.getAuditTrail('route-eth-polygon-usdc');
      expect(trail.total).toBe(4);
      expect(trail.items.map((entry) => `${entry.action}:${entry.outcome}`)).toEqual([
        'emergency.route.disable:attempted',
        'emergency.route.disable:success',
        'emergency.route.restore:attempted',
        'emergency.route.restore:success',
      ]);
      expect(trail.items.every((entry) => entry.category === 'emergency')).toBe(true);
      expect(trail.items[0].correlationId).toBe(trail.items[1].correlationId);
      // The audit params hold identifiers and reasons, never credentials.
      expect(JSON.stringify(trail.items)).not.toMatch(/password|api[-_]?key|private[-_]?key/i);
      expect(audit.verifyIntegrity().valid).toBe(true);
    });

    it('works without an audit log configured (fails open on logging, not on safety)', () => {
      const service = new EmergencyRouteDisableService(undefined, { now: () => T0 });

      expect(service.getAuditTrail('route-x')).toEqual({ total: 0, items: [] });
      service.disableRoute(disable());
      expect(service.isRouteDisabled('route-eth-polygon-usdc')).toBe(true);
    });
  });
});
