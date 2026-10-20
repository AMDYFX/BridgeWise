/**
 * File: src/providers/risk-register/dependency-rpc-risk-register.spec.ts
 *
 * Tests for the dependency and RPC provider risk register (#1382).
 * Covers success, boundary, invalid-input, and failure paths, idempotent
 * failure recording, deterministic scoring, provider exposure links, and
 * audit-log integration with a deterministic clock and fixtures.
 */

import { PrivilegedActionAuditLog } from '../../audit/privileged/privileged-action-audit-log';
import { DependencyRpcRiskRegister } from './dependency-rpc-risk-register.service';
import type { RiskLogEvent } from './dependency-rpc-risk.types';
import { RiskRegisterError } from './dependency-rpc-risk.types';

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function expectRiskError(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(RiskRegisterError);
    expect((error as RiskRegisterError).code).toBe(code);
    return;
  }
  throw new Error(`expected RiskRegisterError with code "${code}" to be thrown`);
}

function makeRegister(overrides: { now?: () => number; log?: (e: RiskLogEvent) => void } = {}) {
  let clock = T0;
  const now = overrides.now ?? (() => clock);
  const logs: RiskLogEvent[] = [];
  const audit = new PrivilegedActionAuditLog({ now });
  const register = new DependencyRpcRiskRegister(
    {
      now,
      log: (event) => {
        logs.push(event);
        overrides.log?.(event);
      },
    },
    audit,
  );
  return {
    register,
    audit,
    logs,
    advance: (ms: number) => {
      clock += ms;
    },
    setClock: (value: number) => {
      clock = value;
    },
    now: () => clock,
  };
}

const rpcEntry = {
  id: 'rpc-alchemy-mainnet',
  kind: 'rpc-provider' as const,
  label: 'Alchemy mainnet RPC',
  criticality: 'critical' as const,
  trustModel: 'single-vendor' as const,
  chains: ['Ethereum', 'ethereum'],
  endpointHost: 'eth-mainnet.g.alchemy.com',
  ownerId: 'platform-team',
};

const depEntry = {
  id: 'pkg-stellar-sdk',
  kind: 'dependency' as const,
  label: 'stellar-sdk npm package',
  criticality: 'medium' as const,
  trustModel: 'multi-vendor' as const,
  version: '13.3.0',
};

describe('DependencyRpcRiskRegister', () => {
  describe('registration (success and invalid input)', () => {
    it('registers an RPC provider and normalizes host, chains, and defaults', () => {
      const { register } = makeRegister();

      const entry = register.register(rpcEntry, { actor: 'ops' });

      expect(entry.id).toBe('rpc-alchemy-mainnet');
      expect(entry.endpointHost).toBe('eth-mainnet.g.alchemy.com');
      expect(entry.chains).toEqual(['ethereum']); // deduped + lowercased + sorted
      expect(entry.status).toBe('active');
      expect(entry.registeredAt).toBe(T0);
      expect(Object.isFrozen(entry)).toBe(true);
      expect(register.getEntry('rpc-alchemy-mainnet').label).toBe('Alchemy mainnet RPC');
    });

    it('registers a dependency without an endpoint and sanitizes metadata secrets', () => {
      const { register } = makeRegister();

      const entry = register.register({
        ...depEntry,
        metadata: { apiKey: 'secret-value', homepage: 'https://example.test' },
      });

      expect(entry.endpointHost).toBeUndefined();
      expect(entry.metadata.homepage).toBe('https://example.test');
      expect(entry.metadata.apiKey).toBe('[REDACTED]');
      expect(JSON.stringify(entry.metadata)).not.toContain('secret-value');
      expect(register.metrics().registered).toBe(1);
    });

    it('rejects duplicate ids', () => {
      const { register } = makeRegister();
      register.register(rpcEntry);

      expectRiskError(() => register.register(rpcEntry), 'DUPLICATE_ENTRY');
      expect(register.metrics().registered).toBe(1);
    });

    it.each([
      ['bad id casing', { ...rpcEntry, id: 'RPC-Alchemy' }],
      ['id too long', { ...rpcEntry, id: `a${'b'.repeat(70)}` }],
      ['unknown kind', { ...rpcEntry, kind: 'database' as never }],
      ['unknown criticality', { ...rpcEntry, criticality: 'catastrophic' as never }],
      ['empty label', { ...rpcEntry, label: '   ' }],
      ['registered as retired', { ...rpcEntry, status: 'retired' as never }],
      ['unknown chain format', { ...rpcEntry, chains: ['ethereum/mainnet'] }],
      ['too many fallbacks', { ...rpcEntry, fallbackEntryIds: Array.from({ length: 21 }, (_, i) => `fb-${i}`) }],
    ])('rejects invalid input: %s', (_name, input) => {
      const { register } = makeRegister();

      expect(() => register.register(input as never)).toThrow(RiskRegisterError);
      expect(register.metrics().registered).toBe(0);
      expect(register.metrics().rejectedInputs).toBeGreaterThan(0);
    });

    it.each([
      ['credentials in the URL', 'https://user:pass@rpc.example.com'],
      ['API key in the query string', 'https://rpc.example.com/v2/abc123?apiKey=xyz'],
      ['API key in the fragment', 'https://rpc.example.com#apiKey=xyz'],
      ['non-http scheme', 'ws://rpc.example.com'],
      ['whitespace', 'rpc.example.com ' + 'x'],
    ])('rejects credential- or malformed-bearing endpoint: %s', (_name, endpointHost) => {
      const { register } = makeRegister();

      expectRiskError(
        () => register.register({ ...rpcEntry, id: 'rpc-x', endpointHost }),
        'INVALID_ENTRY',
      );
    });

    it('rejects a failure event for an unregistered entry (chain-boundary failure path)', () => {
      const { register } = makeRegister();

      expectRiskError(
        () =>
          register.recordFailure({
            entryId: 'rpc-unknown',
            observedAt: T0,
            reason: 'HTTP 503',
            observedBy: 'monitor',
          }),
        'ENTRY_NOT_FOUND',
      );
    });
  });

  describe('failure recording (idempotency and boundaries)', () => {
    it('records a failure, marks the entry degraded, and is idempotent by eventId', () => {
      const { register } = makeRegister();
      register.register(rpcEntry);

      const first = register.recordFailure({
        eventId: 'evt-1',
        entryId: 'rpc-alchemy-mainnet',
        observedAt: T0 + HOUR,
        reason: 'HTTP 503 from load balancer',
        observedBy: 'monitor-1',
        durationMs: 120_000,
      });
      const replay = register.recordFailure({
        eventId: 'evt-1',
        entryId: 'rpc-alchemy-mainnet',
        observedAt: T0 + HOUR,
        reason: 'HTTP 503 from load balancer',
        observedBy: 'monitor-1',
      });

      expect(first).toMatchObject({ recorded: true, duplicate: false });
      expect(replay).toMatchObject({ recorded: false, duplicate: true });
      expect(replay.event).toBeUndefined();
      expect(register.getFailureHistory('rpc-alchemy-mainnet')).toHaveLength(1);
      expect(register.getEntry('rpc-alchemy-mainnet').status).toBe('degraded');
      expect(register.metrics()).toMatchObject({
        failureEventsRecorded: 1,
        duplicateFailureEvents: 1,
      });
    });

    it('rejects malformed failure events', () => {
      const { register } = makeRegister();
      register.register(rpcEntry);

      expectRiskError(
        () =>
          register.recordFailure({
            entryId: 'rpc-alchemy-mainnet',
            observedAt: Number.NaN,
            reason: 'HTTP 503',
            observedBy: 'monitor',
          }),
        'INVALID_FAILURE_EVENT',
      );
      expectRiskError(
        () =>
          register.recordFailure({
            entryId: 'rpc-alchemy-mainnet',
            observedAt: T0,
            reason: 'no',
            observedBy: 'monitor',
          }),
        'INVALID_FAILURE_EVENT',
      );
      expect(register.metrics().failureEventsRecorded).toBe(0);
    });

    it('returns newest-first history bounded by the caller limit', () => {
      const { register, advance } = makeRegister();
      register.register(rpcEntry);

      for (let i = 0; i < 5; i++) {
        register.recordFailure({
          eventId: `evt-${i}`,
          entryId: 'rpc-alchemy-mainnet',
          observedAt: T0 + i,
          reason: `transient error ${i}`,
          observedBy: 'monitor',
        });
        advance(1);
      }

      const history = register.getFailureHistory('rpc-alchemy-mainnet', 3);
      expect(history).toHaveLength(3);
      expect(history[0].eventId).toBe('evt-4'); // newest first
      expect(history[2].eventId).toBe('evt-2');
    });
  });

  describe('scoring (deterministic, explained, boundary)', () => {
    it('scores a critical single-vendor entry with no fallback as high risk with factor breakdown', () => {
      const { register } = makeRegister();
      register.register(rpcEntry);

      const score = register.score('rpc-alchemy-mainnet', T0);

      // 35 criticality + 20 single-vendor + 20 no fallback + 0 status
      // + 0 recent failures + 0 stale = 75 → critical threshold boundary
      expect(score.score).toBe(75);
      expect(score.level).toBe('critical');
      expect(score.factors.map((f) => f.id)).toEqual([
        'criticality',
        'trust-model',
        'fallback-coverage',
        'status',
        'recent-failures',
        'verification-staleness',
      ]);
      const sum = score.factors.reduce((total, factor) => total + factor.contribution, 0);
      expect(sum).toBe(score.score);
      expect(score.factors.every((factor) => factor.contribution >= 0 && factor.contribution <= factor.weight)).toBe(true);
    });

    it('is deterministic: same state and clock produce identical scores', () => {
      const { register } = makeRegister();
      register.register(rpcEntry);
      register.register(depEntry);

      const first = register.assess(T0 + 5 * HOUR);
      const second = register.assess(T0 + 5 * HOUR);

      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });

    it('crosses level thresholds at the documented boundaries', () => {
      const { register } = makeRegister();
      // medium + self-hosted + 1 fallback + active = 15 + 6 + 8 + 0 = 29 → medium
      register.register({
        id: 'dep-mid',
        kind: 'dependency',
        label: 'mid dependency',
        criticality: 'medium',
        trustModel: 'self-hosted',
        fallbackEntryIds: ['dep-fallback'],
      });
      register.register({
        id: 'dep-fallback',
        kind: 'dependency',
        label: 'fallback dependency',
        criticality: 'low',
        trustModel: 'self-hosted',
      });

      expect(register.score('dep-mid', T0).level).toBe('medium');

      // Four failures inside the window: +16; the failure factor caps at 20.
      for (let i = 0; i < 4; i++) {
        register.recordFailure({
          eventId: `mid-${i}`,
          entryId: 'dep-mid',
          observedAt: T0 + i * 1000,
          reason: 'transient failure',
          observedBy: 'monitor',
        });
      }
      const score = register.score('dep-mid', T0 + 5000);
      const failureFactor = score.factors.find((factor) => factor.id === 'recent-failures')!;
      expect(failureFactor.contribution).toBe(16); // 4 events × 4 points

      // Recording failures also degraded the status (+10): 15+6+8+16+10 = 55 → high.
      expect(score.score).toBe(55);
      expect(score.level).toBe('high');
    });

    it('stops counting failures outside the failure window', () => {
      const { register } = makeRegister();
      register.register(rpcEntry);
      register.recordFailure({
        eventId: 'old-1',
        entryId: 'rpc-alchemy-mainnet',
        observedAt: T0 - 25 * HOUR,
        reason: 'ancient outage',
        observedBy: 'monitor',
      });

      const score = register.score('rpc-alchemy-mainnet', T0);
      expect(score.factors.find((factor) => factor.id === 'recent-failures')!.contribution).toBe(0);
    });
  });

  describe('register-wide assessment (report and exposure)', () => {
    it('reports worst-first entries, single points of failure, and provider exposure', () => {
      const { register } = makeRegister();
      register.register(rpcEntry);
      register.register(depEntry);
      register.register({
        id: 'rpc-fallback',
        kind: 'rpc-provider',
        label: 'Backup RPC',
        criticality: 'low',
        trustModel: 'multi-vendor',
        fallbackEntryIds: ['rpc-alchemy-mainnet'],
      });
      register.linkProvider('relayer-1', ['rpc-alchemy-mainnet', 'pkg-stellar-sdk']);
      register.linkProvider('relayer-2', ['rpc-fallback']);

      const report = register.assess(T0);

      expect(report.total).toBe(3);
      expect(report.entries[0].entry.id).toBe('rpc-alchemy-mainnet'); // worst first
      expect(report.highRisk).toEqual(['rpc-alchemy-mainnet']);
      expect(report.singlePointsOfFailure).toEqual(['rpc-alchemy-mainnet']);
      expect(report.providerExposure).toEqual({
        'relayer-1': ['pkg-stellar-sdk', 'rpc-alchemy-mainnet'],
        'relayer-2': ['rpc-fallback'],
      });
      expect(report.danglingFallbacks).toEqual([]);
      expect(report.counts.critical + report.counts.high + report.counts.medium + report.counts.low).toBe(3);
    });

    it('flags dangling fallbacks as a data-quality defect and excludes retired entries', () => {
      const { register } = makeRegister();
      register.register({ ...rpcEntry, fallbackEntryIds: ['rpc-ghost'] });

      expect(register.assess(T0).danglingFallbacks).toEqual(['rpc-ghost']);

      register.retire('rpc-alchemy-mainnet', 'ops-lead', 'vendor decommissioned');
      const report = register.assess(T0);
      expect(report.total).toBe(0);
      expect(register.getEntry('rpc-alchemy-mainnet').status).toBe('retired');
    });

    it('links providers to entries and answers blast radius per entry', () => {
      const { register } = makeRegister();
      register.register(rpcEntry);
      register.register(depEntry);
      register.linkProvider('relayer-1', ['rpc-alchemy-mainnet']);
      register.linkProvider('relayer-2', ['rpc-alchemy-mainnet', 'pkg-stellar-sdk']);

      expect(register.providersAffectedBy('rpc-alchemy-mainnet')).toEqual([
        'relayer-1',
        'relayer-2',
      ]);
      expect(register.providersAffectedBy('pkg-stellar-sdk')).toEqual(['relayer-2']);
      expectRiskError(() => register.linkProvider('relayer-3', ['rpc-missing']), 'ENTRY_NOT_FOUND');
      expect(() => register.linkProvider('bad provider id', [])).toThrow(RiskRegisterError);
    });
  });

  describe('mutations (update, retire, audit)', () => {
    it('updates risk attributes and rejects patches on retired entries', () => {
      const { register } = makeRegister();
      register.register(rpcEntry);

      const updated = register.update(
        'rpc-alchemy-mainnet',
        { criticality: 'high', status: 'degraded' },
        { actor: 'ops' },
      );

      expect(updated.criticality).toBe('high');
      expect(updated.status).toBe('degraded');
      expect(updated.registeredAt).toBe(T0);

      register.retire('rpc-alchemy-mainnet', 'ops-lead', 'moved to backup vendor');
      expectRiskError(() => register.update('rpc-alchemy-mainnet', { label: 'x' }), 'ENTRY_RETIRED');
    });

    it('audits registration, update, and retirement with an intact hash chain', () => {
      const { register, audit } = makeRegister();
      register.register(rpcEntry, { actor: 'ops' });
      register.update('rpc-alchemy-mainnet', { criticality: 'high' }, { actor: 'ops' });
      register.retire('rpc-alchemy-mainnet', 'ops-lead', 'vendor decommissioned');

      const { items } = audit.query({ target: 'rpc-alchemy-mainnet' });
      expect(items.map((entry) => `${entry.action}:${entry.outcome}`)).toEqual([
        'risk.register:attempted',
        'risk.register:success',
        'risk.update:attempted',
        'risk.update:success',
        'risk.retire:attempted',
        'risk.retire:success',
      ]);
      expect(items.every((entry) => entry.category === 'configuration')).toBe(true);
      expect(audit.verifyIntegrity().valid).toBe(true);
      // No secrets or endpoint payloads in audit params.
      expect(JSON.stringify(items)).not.toContain('secret-value');
      expect(JSON.stringify(items)).not.toContain('g.alchemy.com');
    });

    it('requires an attributable actor and a reason to retire', () => {
      const { register, audit } = makeRegister();
      register.register(rpcEntry);

      expectRiskError(() => register.retire('rpc-alchemy-mainnet', '  ', 'reason text'), 'INVALID_ACTOR');
      expectRiskError(() => register.retire('rpc-alchemy-mainnet', 'ops', 'no'), 'INVALID_ENTRY');
      expect(audit.query({ action: 'risk.retire' }).total).toBe(0);
    });

    it('retiring twice is idempotent and does not double count', () => {
      const { register } = makeRegister();
      register.register(rpcEntry);

      const first = register.retire('rpc-alchemy-mainnet', 'ops-lead', 'first reason');
      const second = register.retire('rpc-alchemy-mainnet', 'ops-lead', 'first reason');

      expect(second).toBe(first);
      expect(register.metrics().retired).toBe(1);
    });
  });

  describe('logging and metrics (secret-free)', () => {
    it('emits structured events without hosts, metadata, or raw payloads', () => {
      const { register, logs } = makeRegister();
      register.register({
        ...rpcEntry,
        metadata: { apiKey: 'very-secret-token' },
      });
      register.recordFailure({
        eventId: 'evt-log',
        entryId: 'rpc-alchemy-mainnet',
        observedAt: T0,
        reason: 'HTTP 503',
        observedBy: 'monitor',
      });
      register.retire('rpc-alchemy-mainnet', 'ops-lead', 'decommission');

      expect(logs.map((entry) => entry.code)).toEqual([
        'ENTRY_REGISTERED',
        'FAILURE_RECORDED',
        'ENTRY_RETIRED',
      ]);
      const serialized = JSON.stringify(logs);
      expect(serialized).not.toContain('very-secret-token');
      expect(serialized).not.toContain('g.alchemy.com');
      expect(logs.every((entry) => typeof entry.at === 'number' && entry.message.length > 0)).toBe(true);
      expect(register.metrics().assessments).toBe(0);
      register.assess();
      expect(register.metrics().assessments).toBe(1);
    });

    it('filters the register by kind, status, and chain', () => {
      const { register } = makeRegister();
      register.register(rpcEntry);
      register.register(depEntry);

      expect(register.listEntries({ kind: 'dependency' }).map((entry) => entry.id)).toEqual([
        'pkg-stellar-sdk',
      ]);
      expect(register.listEntries({ chain: 'ethereum' }).map((entry) => entry.id)).toEqual([
        'rpc-alchemy-mainnet',
      ]);
      expect(register.listEntries({ status: 'retired' })).toHaveLength(0);
      expectRiskError(() => register.getEntry('rpc-missing'), 'ENTRY_NOT_FOUND');
    });
  });
});
