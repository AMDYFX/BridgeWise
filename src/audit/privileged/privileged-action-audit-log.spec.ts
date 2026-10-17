/**
 * File: src/audit/privileged/privileged-action-audit-log.spec.ts
 *
 * Unit tests for the privileged action audit log.
 */

import {
  GENESIS_HASH,
  PrivilegedActionAuditError,
  PrivilegedActionAuditLog,
  PrivilegedActionDeniedError,
} from './privileged-action-audit-log';
import { REDACTED } from './sanitize';
import type { PrivilegedActionInput } from './privileged-action-audit.types';

const T0 = 1_700_000_000_000;

describe('PrivilegedActionAuditLog', () => {
  let clock = T0;
  const make = (config = {}) => new PrivilegedActionAuditLog({ now: () => clock, ...config });
  const event = (partial: Partial<PrivilegedActionInput> = {}): PrivilegedActionInput => ({
    actor: 'admin-1',
    action: 'config.update',
    ...partial,
  });

  beforeEach(() => {
    clock = T0;
  });

  describe('record', () => {
    it('stores an entry with defaults and starts the hash chain at genesis', () => {
      const log = make();
      const entry = log.record(event({ target: 'fee-config', params: { fee: '0.3' } }));

      expect(entry).toMatchObject({
        sequence: 1,
        timestamp: T0,
        actor: 'admin-1',
        action: 'config.update',
        category: 'other',
        outcome: 'success',
        target: 'fee-config',
        reason: null,
        params: { fee: '0.3' },
        prevHash: GENESIS_HASH,
      });
      expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.correlationId).toBeTruthy();
    });

    it('links each entry to the previous one', () => {
      const log = make();
      const first = log.record(event());
      const second = log.record(event());

      expect(second.sequence).toBe(2);
      expect(second.prevHash).toBe(first.hash);
      expect(log.getHead()).toEqual({ sequence: 2, hash: second.hash });
    });

    it('rejects invalid input instead of recording it', () => {
      const log = make();
      const code = (input: unknown) => {
        try {
          log.record(input as PrivilegedActionInput);
        } catch (error) {
          expect(error).toBeInstanceOf(PrivilegedActionAuditError);
          return (error as PrivilegedActionAuditError).code;
        }
        return 'NO_ERROR';
      };

      expect(code(event({ actor: '  ' }))).toBe('INVALID_ACTOR');
      expect(code(event({ actor: 'a'.repeat(257) }))).toBe('INVALID_ACTOR');
      expect(code(event({ action: '' }))).toBe('INVALID_ACTION');
      expect(code(event({ category: 'bogus' as never }))).toBe('INVALID_CATEGORY');
      expect(code(event({ outcome: 'maybe' as never }))).toBe('INVALID_OUTCOME');
      expect(code(null)).toBe('INVALID_ACTOR');

      expect(log.getStats().lastSequence).toBe(0);
    });

    it('accepts an actor of exactly the maximum length (boundary)', () => {
      const log = make();
      expect(() => log.record(event({ actor: 'a'.repeat(256) }))).not.toThrow();
    });

    it('makes stored entries immutable', () => {
      const log = make();
      const entry = log.record(event({ params: { nested: { a: 1 } } }));

      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.params)).toBe(true);
      expect(Object.isFrozen(entry.params.nested)).toBe(true);
    });
  });

  describe('parameter sanitization', () => {
    it('redacts secrets by key name, including nested ones', () => {
      const log = make({ redactKeys: [/pin/i] });
      const entry = log.record(
        event({
          params: {
            amount: '100',
            apiKey: 'abc',
            privateKey: 'xyz',
            nested: { password: 'hunter2', ok: true },
            userPin: '1234',
            auth: { Authorization: 'Bearer t' },
          },
        }),
      );

      expect(entry.params).toEqual({
        amount: '100',
        apiKey: REDACTED,
        privateKey: REDACTED,
        nested: { password: REDACTED, ok: true },
        userPin: REDACTED,
        auth: { Authorization: REDACTED },
      });
    });

    it('converts values to JSON-safe forms and bounds hostile input', () => {
      const log = make();
      const deep: Record<string, unknown> = {};
      let cursor = deep;
      for (let i = 0; i < 10; i++) {
        cursor.next = {};
        cursor = cursor.next as Record<string, unknown>;
      }
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;

      const entry = log.record(
        event({
          params: {
            big: 10n ** 20n,
            when: new Date(T0),
            set: new Set([1, 2]),
            map: new Map([['k', 'v']]),
            fn: () => 1,
            nan: Number.NaN,
            long: 'x'.repeat(2000),
            deep,
            cyclic,
          },
        }),
      );

      const params = entry.params as Record<string, any>;
      expect(params.big).toBe('100000000000000000000');
      expect(params.when).toBe(new Date(T0).toISOString());
      expect(params.set).toEqual([1, 2]);
      expect(params.map).toEqual({ k: 'v' });
      expect(params.fn).toBe('[Unserializable]');
      expect(params.nan).toBe('NaN');
      expect(params.long.length).toBeLessThan(2000);
      expect(JSON.stringify(params.deep)).toContain('[Truncated]');
      expect(JSON.stringify(params.cyclic)).toContain('[Truncated]');
    });

    it('replaces oversized params with a truncation marker', () => {
      const log = make({ maxParamsBytes: 64 });
      const entry = log.record(event({ params: { blob: 'y'.repeat(500) } }));

      expect(entry.params).toMatchObject({ _truncated: true });
      expect((entry.params as { originalBytes: number }).originalBytes).toBeGreaterThan(64);
    });
  });

  describe('integrity', () => {
    const fill = (log: PrivilegedActionAuditLog, count = 4) => {
      for (let i = 0; i < count; i++) {
        clock = T0 + i;
        log.record(event({ target: `t${i}`, params: { i } }));
      }
    };

    it('verifies an untouched chain, including an empty one', () => {
      const log = make();
      expect(log.verifyIntegrity()).toEqual({ valid: true, checked: 0 });

      fill(log);
      expect(log.verifyIntegrity()).toEqual({ valid: true, checked: 4 });
    });

    it('detects a modified entry (HASH_MISMATCH)', () => {
      const log = make();
      fill(log);
      const copy = log.exportEntries();
      (copy[1] as { actor: string }).actor = 'someone-else';

      expect(PrivilegedActionAuditLog.verifyChain(copy)).toEqual({
        valid: false,
        checked: 2,
        brokenAtSequence: 2,
        reason: 'HASH_MISMATCH',
      });
    });

    it('detects a removed entry (SEQUENCE_GAP)', () => {
      const log = make();
      fill(log);
      const copy = log.exportEntries();
      copy.splice(1, 1);

      expect(PrivilegedActionAuditLog.verifyChain(copy)).toMatchObject({
        valid: false,
        brokenAtSequence: 3,
        reason: 'SEQUENCE_GAP',
      });
    });

    it('detects a re-pointed link (CHAIN_BROKEN)', () => {
      const log = make();
      fill(log);
      const copy = log.exportEntries();
      (copy[1] as { prevHash: string }).prevHash = GENESIS_HASH;

      expect(PrivilegedActionAuditLog.verifyChain(copy)).toMatchObject({
        valid: false,
        brokenAtSequence: 2,
        reason: 'CHAIN_BROKEN',
      });
    });

    it('detects reordered entries', () => {
      const log = make();
      fill(log);
      const copy = log.exportEntries();
      [copy[1], copy[2]] = [copy[2], copy[1]];

      expect(PrivilegedActionAuditLog.verifyChain(copy).valid).toBe(false);
    });

    it('detects truncation of the head only when compared with an anchored head', () => {
      const log = make();
      fill(log);
      const anchoredHead = log.getHead();
      const copy = log.exportEntries().slice(0, 3);

      // A shortened chain still verifies on its own...
      expect(PrivilegedActionAuditLog.verifyChain(copy).valid).toBe(true);
      // ...but its head no longer matches the externally anchored one.
      expect(copy[copy.length - 1].hash).not.toBe(anchoredHead.hash);
    });

    it('evicts the oldest entries past maxEntries but keeps the chain verifiable', () => {
      const log = make({ maxEntries: 3 });
      const hashes: string[] = [];
      for (let i = 0; i < 5; i++) hashes.push(log.record(event({ params: { i } })).hash);

      expect(log.getStats()).toMatchObject({ retained: 3, evicted: 2, lastSequence: 5 });
      expect(log.getAnchorHash()).toBe(hashes[1]);
      expect(log.query().items.map((e) => e.sequence)).toEqual([3, 4, 5]);
      expect(log.verifyIntegrity()).toEqual({ valid: true, checked: 3 });

      const exported = log.exportEntries();
      expect(PrivilegedActionAuditLog.verifyChain(exported, hashes[1]).valid).toBe(true);
      expect(PrivilegedActionAuditLog.verifyChain(exported).reason).toBe('CHAIN_BROKEN');
    });
  });

  describe('query', () => {
    const seed = () => {
      const log = make();
      const rows: Array<[number, Partial<PrivilegedActionInput>]> = [
        [0, { actor: 'Alice', action: 'multisig.propose', category: 'governance', target: 'P1' }],
        [10, { actor: 'bob', action: 'treasury.withdraw', category: 'treasury', outcome: 'denied' }],
        [20, { actor: 'alice', action: 'multisig.execute', category: 'governance', target: 'p1' }],
        [30, { actor: 'carol', action: 'config.update', category: 'configuration' }],
      ];
      for (const [offset, partial] of rows) {
        clock = T0 + offset;
        log.record(event(partial));
      }
      return log;
    };

    it('filters by actor and target case-insensitively, and by other fields', () => {
      const log = seed();

      expect(log.query({ actor: 'ALICE' }).total).toBe(2);
      expect(log.query({ target: 'p1' }).total).toBe(2);
      expect(log.query({ category: 'governance' }).total).toBe(2);
      expect(log.query({ outcome: 'denied' }).items.map((e) => e.actor)).toEqual(['bob']);
      expect(log.query({ action: 'config.update' }).total).toBe(1);
      expect(log.query({ actor: 'nobody' })).toEqual({ total: 0, items: [] });
    });

    it('treats `from` as inclusive and `to` as exclusive (boundary)', () => {
      const log = seed();

      expect(log.query({ from: T0 + 10, to: T0 + 30 }).items.map((e) => e.sequence)).toEqual([2, 3]);
    });

    it('orders, paginates and caps results', () => {
      const log = seed();

      expect(log.query({ order: 'desc' }).items.map((e) => e.sequence)).toEqual([4, 3, 2, 1]);
      expect(log.query({ offset: 1, limit: 2 })).toMatchObject({ total: 4 });
      expect(log.query({ offset: 1, limit: 2 }).items.map((e) => e.sequence)).toEqual([2, 3]);
      expect(log.query({ limit: 0 }).items).toEqual([]);
      expect(log.query({ offset: -5 }).items).toHaveLength(4);
    });
  });

  describe('run', () => {
    it('records attempted then success and returns the action result', async () => {
      const log = make();
      const result = await log.run(
        event({ category: 'treasury', action: 'treasury.withdraw', params: { amount: '5' } }),
        async () => 'done',
      );

      expect(result).toBe('done');
      const { items } = log.query();
      expect(items.map((e) => e.outcome)).toEqual(['attempted', 'success']);
      expect(items[0].correlationId).toBe(items[1].correlationId);
    });

    it('records failed and rethrows the original error', async () => {
      const log = make();
      const boom = new Error('rpc timeout');

      await expect(
        log.run(event(), () => {
          throw boom;
        }),
      ).rejects.toBe(boom);

      const outcomes = log.query().items;
      expect(outcomes.map((e) => e.outcome)).toEqual(['attempted', 'failed']);
      expect(outcomes[1].reason).toBe('rpc timeout');
    });

    it('records denied when the action signals a denial', async () => {
      const log = make();

      await expect(
        log.run(event(), () => {
          throw new PrivilegedActionDeniedError('not authorized');
        }),
      ).rejects.toThrow('not authorized');

      expect(log.query().items.map((e) => e.outcome)).toEqual(['attempted', 'denied']);
    });

    it('never runs the action when the attempt cannot be recorded (fail closed)', async () => {
      const log = make();
      const action = jest.fn();

      await expect(log.run(event({ actor: '' }), action)).rejects.toBeInstanceOf(
        PrivilegedActionAuditError,
      );

      expect(action).not.toHaveBeenCalled();
      expect(log.getStats().lastSequence).toBe(0);
    });
  });

  describe('sinks', () => {
    it('delivers every entry and isolates failing sinks', async () => {
      const received: number[] = [];
      const log = make({
        sinks: [
          (entry: { sequence: number }) => {
            received.push(entry.sequence);
          },
          () => {
            throw new Error('sync sink down');
          },
          async () => {
            throw new Error('async sink down');
          },
        ],
      });

      log.record(event());
      log.record(event());
      await log.flush();

      expect(received).toEqual([1, 2]);
      expect(log.getStats().sinkFailures).toBe(4);
      expect(log.getStats().retained).toBe(2);
    });

    it('supports adding a sink after construction', async () => {
      const log = make();
      const sink = jest.fn();
      log.record(event());
      log.addSink(sink);
      log.record(event());
      await log.flush();

      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink.mock.calls[0][0].sequence).toBe(2);
    });
  });

  it('fails fast on invalid configuration', () => {
    expect(() => make({ maxEntries: 0 })).toThrow(/maxEntries/);
    expect(() => make({ maxParamsBytes: 1.5 })).toThrow(/maxParamsBytes/);
  });
});
