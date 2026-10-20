import {
  DEFAULT_WEBHOOK_VERSION,
  UnsupportedSchemaVersionError,
  negotiateWebhookVersion,
  parseVersionHeader,
} from './webhook-schema-version';
import { WebhookReplayGuard, createWebhookEventId } from './webhook-event-id';
import { buildSandboxFixtures } from './sandbox-fixtures';
import { DEFAULT_REQUEST_LIMITS, RequestLimitError, assertWithinRequestLimits } from './request-limits';

describe('webhook schema version negotiation', () => {
  it('defaults when nothing is requested and picks the first supported preference', () => {
    expect(negotiateWebhookVersion(undefined)).toBe(DEFAULT_WEBHOOK_VERSION);
    expect(negotiateWebhookVersion([])).toBe(DEFAULT_WEBHOOK_VERSION);
    expect(negotiateWebhookVersion('2025-09-01')).toBe('2025-09-01');
    expect(negotiateWebhookVersion(['2030-01-01', '2025-09-01', '2025-01-15'])).toBe('2025-09-01');
  });

  it('rejects unsupported or malformed versions and lists what is supported', () => {
    try {
      negotiateWebhookVersion('2030-01-01');
      fail('expected error');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedSchemaVersionError);
      expect((err as UnsupportedSchemaVersionError).supported).toContain('2025-09-01');
    }
    expect(() => negotiateWebhookVersion('latest')).toThrow(UnsupportedSchemaVersionError);
  });

  it('parses a preference header', () => {
    expect(parseVersionHeader(' 2025-09-01 , 2025-01-15,')).toEqual(['2025-09-01', '2025-01-15']);
    expect(parseVersionHeader(undefined)).toEqual([]);
  });
});

describe('replay-safe webhook event identifiers', () => {
  it('derives the same id for the same event and different ids otherwise', () => {
    const id = createWebhookEventId('p1', 'execution.confirmed', 'e1', 1);
    expect(id).toBe(createWebhookEventId('p1', 'execution.confirmed', 'e1', 1));
    expect(id).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(id).not.toBe(createWebhookEventId('p1', 'execution.confirmed', 'e1', 2));
    expect(id).not.toBe(createWebhookEventId('p2', 'execution.confirmed', 'e1', 1));
  });

  it('accepts once, flags duplicates, and rejects stale and future events', () => {
    const guard = new WebhookReplayGuard(1_000);
    expect(guard.check('a', 10_000, 10_000)).toBe('accept');
    expect(guard.check('a', 10_000, 10_500)).toBe('duplicate');
    expect(guard.check('b', 5_000, 10_000)).toBe('stale');
    expect(guard.check('c', 20_000, 10_000)).toBe('from_future');
  });

  it('prunes ids that can no longer be replayed', () => {
    const guard = new WebhookReplayGuard(1_000);
    guard.check('a', 10_000, 10_000);
    expect(guard.size).toBe(1);
    guard.check('b', 20_000, 20_000);
    expect(guard.size).toBe(1);
  });
});

describe('partner sandbox fixtures', () => {
  const fixtures = buildSandboxFixtures();

  it('is deterministic', () => {
    expect(buildSandboxFixtures()).toEqual(fixtures);
  });

  it('covers every lifecycle state per partner and flags everything as sandbox', () => {
    for (const partner of fixtures.partners) {
      const states = fixtures.executions.filter((e) => e.partnerId === partner.id).map((e) => e.state);
      expect(states.sort()).toEqual(['cancelled', 'confirmed', 'created', 'failed', 'quoted', 'reserved', 'submitted']);
    }
    for (const item of [...fixtures.partners, ...fixtures.executions, ...fixtures.webhookEvents]) {
      expect(item.sandbox).toBe(true);
    }
  });

  it('is internally consistent: unique ids, valid amounts, events reference real executions', () => {
    const ids = [...fixtures.partners, ...fixtures.executions, ...fixtures.webhookEvents].map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of fixtures.executions) expect(e.amount).toMatch(/^[1-9]\d*$/);
    const executionIds = new Set(fixtures.executions.map((e) => e.id));
    for (const ev of fixtures.webhookEvents) expect(executionIds.has(ev.executionId)).toBe(true);
    expect(JSON.stringify(fixtures)).not.toMatch(/0x[0-9a-fA-F]{40}|secret|private/i);
  });
});

describe('request size and nesting limits', () => {
  const nested = (depth: number) => {
    let value: unknown = 'leaf';
    for (let i = 0; i < depth; i++) value = { child: value };
    return value;
  };

  it('accepts ordinary bodies', () => {
    expect(() => assertWithinRequestLimits({ amount: '10', route: { from: 'a', to: 'b' }, tags: [1, 2, 3] })).not.toThrow();
  });

  it('rejects oversize bodies, deep nesting, long arrays, wide objects and long strings with the path', () => {
    const expectLimit = (body: unknown, limit: string, path?: string, bytes?: number) => {
      try {
        assertWithinRequestLimits(body, DEFAULT_REQUEST_LIMITS, bytes);
        fail(`expected ${limit}`);
      } catch (err) {
        expect(err).toBeInstanceOf(RequestLimitError);
        expect((err as RequestLimitError).limit).toBe(limit);
        if (path) expect((err as RequestLimitError).path).toBe(path);
      }
    };
    expectLimit({}, 'maxBytes', '$', DEFAULT_REQUEST_LIMITS.maxBytes + 1);
    expectLimit(nested(11), 'maxDepth');
    expectLimit({ list: new Array(1_001).fill(0) }, 'maxArrayLength', '$.list');
    expectLimit(Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, i])), 'maxKeysPerObject', '$');
    expectLimit({ note: 'x'.repeat(64 * 1024 + 1) }, 'maxStringLength', '$.note');
  });

  it('survives hostile nesting without a stack overflow and rejects cycles', () => {
    expect(() => assertWithinRequestLimits(nested(50_000))).toThrow(RequestLimitError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => assertWithinRequestLimits(cyclic)).toThrow(RequestLimitError);
  });

  it('allows exactly the maximum depth', () => {
    expect(() => assertWithinRequestLimits(nested(9))).not.toThrow(); // 9 wrappers + leaf = depth 10
  });
});
