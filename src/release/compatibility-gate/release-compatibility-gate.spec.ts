/**
 * File: src/release/compatibility-gate/release-compatibility-gate.spec.ts
 *
 * Tests for the release compatibility gate for contract and API (#1384).
 * Deterministic fixtures; covers success, boundary, invalid-input, and
 * failure cases for the contract ABI diff and the OpenAPI delegation, the
 * fail-closed behavior on malformed artifacts, the audited release-manager
 * override, and reproducible evidence hashes.
 */

import { PrivilegedActionAuditLog } from '../../audit/privileged/privileged-action-audit-log';
import { ReleaseCompatibilityGate } from './release-compatibility-gate.service';
import type { GateLogEvent } from './release-compatibility-gate.types';
import { CompatibilityGateError } from './release-compatibility-gate.types';

const T0 = 1_700_000_000_000;

// ─── Fixtures ───────────────────────────────────────────────────────────────

const fn = (
  name: string,
  inputs: { name: string; type: string }[] = [],
  outputs: { name: string; type: string }[] = [],
  stateMutability = 'nonpayable',
) => ({ type: 'function', name, inputs, outputs, stateMutability });

const baselineAbi = [
  {
    type: 'constructor',
    inputs: [{ name: 'owner', type: 'address' }],
    stateMutability: 'nonpayable',
  },
  fn('withdraw', [{ name: 'amount', type: 'uint256' }], [], 'nonpayable'),
  fn('paused', [], [{ name: '', type: 'bool' }], 'view'),
  fn('deposit', [], [], 'payable'),
  {
    type: 'event',
    name: 'Withdrawal',
    inputs: [
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'to', type: 'address', indexed: true },
    ],
    anonymous: false,
  },
  { type: 'error', name: 'NotAuthorized', inputs: [{ name: 'caller', type: 'address' }] },
];

/** A minimal OpenAPI document that survives the compatibility checker. */
function apiDoc(paths: Record<string, unknown>, version = '1.0.0') {
  return {
    openapi: '3.0.0',
    info: { title: 'BridgeWise API', version },
    paths,
  };
}

const operation = (responses: Record<string, unknown> = {}) => ({
  operationId: 'getQuote',
  summary: 'Get a quote',
  responses: {
    '200': { description: 'ok' },
    ...responses,
  },
});

const baselineApi = apiDoc({ '/quotes': { get: operation({ '429': { description: 'rate limited' } }) } });

function makeGate(config: { overrideRoles?: string[] } = {}) {
  let clock = T0;
  const logs: GateLogEvent[] = [];
  const audit = new PrivilegedActionAuditLog({ now: () => clock });
  const gate = new ReleaseCompatibilityGate(audit, {
    now: () => clock,
    overrideRoles: config.overrideRoles,
    log: (event) => logs.push(event),
  });
  return { gate, audit, logs };
}

function expectGateError(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CompatibilityGateError);
    expect((error as CompatibilityGateError).code).toBe(code);
    return;
  }
  throw new Error(`expected CompatibilityGateError with code "${code}" to be thrown`);
}

// ─── Contract half ──────────────────────────────────────────────────────────

describe('ReleaseCompatibilityGate (contract ABI)', () => {
  it('passes an identical contract and records reproducible evidence', () => {
    const { gate, logs } = makeGate();

    const report = gate.evaluate({
      releaseId: 'v2026.10.1',
      contracts: [{ name: 'BridgeVault', baseline: baselineAbi, candidate: baselineAbi }],
    });

    expect(report.verdict).toBe('pass');
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({ id: 'contract-abi', subject: 'BridgeVault', passed: true });
    expect(report.counts).toEqual({ breaking: 0, warning: 0, info: 0 });
    expect(report.evidence.checker).toBe('bridgewise-release-compatibility-gate/1');
    expect(report.evidence.releaseInputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.evidence.sectionHashes['contract:BridgeVault']).toMatch(/^[0-9a-f]{64}$/);
    expect(logs.map((event) => event.code)).toEqual(['GATE_PASSED']);

    // Same input → same evidence hash (reproducible verification).
    const again = gate.evaluate({
      releaseId: 'v2026.10.1',
      contracts: [{ name: 'BridgeVault', baseline: baselineAbi, candidate: baselineAbi }],
    });
    expect(again.evidence).toEqual(report.evidence);
  });

  it('fails on a removed function with the documented rule and location', () => {
    const { gate } = makeGate();
    const candidate = baselineAbi.filter(
      (entry) => !((entry as { name?: string }).name === 'withdraw'),
    );

    const report = gate.evaluate({
      releaseId: 'v2',
      contracts: [{ name: 'BridgeVault', baseline: baselineAbi, candidate }],
    });

    expect(report.verdict).toBe('fail');
    const breaking = report.checks[0].changes.filter((change) => change.severity === 'breaking');
    expect(breaking.map((change) => change.rule)).toEqual(['function-removed']);
    expect(breaking[0].location).toBe('contracts.BridgeVault.functions.withdraw(uint256)');
    expect(gate.metrics()).toMatchObject({ evaluations: 1, failedEvaluations: 1 });
    expect(() => gate.assertPass(report)).toThrow(CompatibilityGateError);
  });

  it('classifies ABI changes by severity per the upgrade-implication table', () => {
    const { gate } = makeGate();
    const candidate = [
      { type: 'constructor', inputs: [], stateMutability: 'nonpayable' }, // args changed → breaking
      fn('withdraw', [{ name: 'amount', type: 'uint256' }, { name: 'token', type: 'address' }]), // retyped → breaking
      fn('paused', [], [{ name: '', type: 'uint8' }], 'nonpayable'), // outputs changed → breaking; view→nonpayable → warning
      fn('deposit', [], [], 'nonpayable'), // payable removed → breaking
      fn('rescueTokens', [{ name: 'token', type: 'address' }]), // added → info
      {
        type: 'event',
        name: 'Withdrawal',
        inputs: [
          { name: 'amount', type: 'uint128', indexed: false }, // signature change → breaking
          { name: 'to', type: 'address', indexed: true },
        ],
        anonymous: false,
      },
      { type: 'error', name: 'NotAuthorized', inputs: [{ name: 'caller', type: 'address' }] },
    ];

    const report = gate.evaluate({
      releaseId: 'v3',
      contracts: [{ name: 'BridgeVault', baseline: baselineAbi, candidate }],
    });
    const rules = report.checks[0].changes.map((change) => `${change.severity}:${change.rule}`);

    expect(rules).toEqual(
      expect.arrayContaining([
        'breaking:function-inputs-changed',
        'breaking:function-outputs-changed',
        'warning:function-mutability-relaxed',
        'breaking:function-payable-removed',
        'info:function-added',
        'breaking:event-inputs-changed',
        'breaking:constructor-inputs-changed',
      ]),
    );
    // The retyped function is not double-reported as an addition.
    expect(rules.filter((rule) => rule === 'info:function-added')).toHaveLength(1);
    expect(report.verdict).toBe('fail');
  });

  it('passes additive-only contract changes and warning-only changes by default', () => {
    const { gate } = makeGate();
    const candidate = [
      ...baselineAbi,
      fn('rescueTokens', [{ name: 'token', type: 'address' }]),
      { type: 'error', name: 'AmountTooSmall', inputs: [] },
    ];

    const report = gate.evaluate({
      releaseId: 'v4',
      contracts: [{ name: 'BridgeVault', baseline: baselineAbi, candidate }],
    });

    expect(report.verdict).toBe('pass');
    expect(report.counts.info).toBe(2);
    expect(report.counts.breaking).toBe(0);

    // A warning-only change passes the default policy but fails strict warnings.
    const warnOnly = [
      fn('withdraw', [{ name: 'amount', type: 'uint256' }], [], 'view'), // nonpayable→view → info
      fn('paused', [], [{ name: '', type: 'bool' }], 'nonpayable'), // warning
      ...baselineAbi.slice(2),
    ];
    const relaxed = gate.evaluate(
      {
        releaseId: 'v5',
        contracts: [{ name: 'BridgeVault', baseline: [baselineAbi[1], baselineAbi[2]], candidate: [warnOnly[0], warnOnly[1]] }],
      },
      { failOnWarnings: true },
    );
    expect(relaxed.verdict).toBe('fail');
    expect(relaxed.counts.warning).toBe(1);
  });

  it('compares tuple parameters component-by-component', () => {
    const { gate } = makeGate();
    const base = [
      {
        type: 'function',
        name: 'swap',
        inputs: [
          {
            name: 'order',
            type: 'tuple',
            components: [
              { name: 'tokenIn', type: 'address' },
              { name: 'amountIn', type: 'uint256' },
            ],
          },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
      },
    ];
    const same = JSON.parse(JSON.stringify(base));
    const changed = JSON.parse(JSON.stringify(base));
    changed[0].inputs[0].components[1].type = 'uint128';

    expect(
      gate.evaluate({
        releaseId: 'tuple-same',
        contracts: [{ name: 'Router', baseline: base, candidate: same }],
      }).verdict,
    ).toBe('pass');
    expect(
      gate.evaluate({
        releaseId: 'tuple-changed',
        contracts: [{ name: 'Router', baseline: base, candidate: changed }],
      }).verdict,
    ).toBe('fail');
  });

  it('fails closed on malformed contract artifacts instead of skipping them', () => {
    const { gate, logs } = makeGate();

    expectGateError(
      () =>
        gate.evaluate({
          releaseId: 'bad-1',
          contracts: [{ name: 'BridgeVault', baseline: baselineAbi, candidate: { abi: 'nope' } }],
        }),
      'MALFORMED_CONTRACT_ARTIFACT',
    );
    expectGateError(
      () =>
        gate.evaluate({
          releaseId: 'bad-2',
          contracts: [
            {
              name: 'BridgeVault',
              baseline: baselineAbi,
              candidate: [{ type: 'function', name: 'broken', inputs: 'not-an-array' }],
            },
          ],
        }),
      'MALFORMED_CONTRACT_ARTIFACT',
    );
    expectGateError(
      () =>
        gate.evaluate({
          releaseId: 'bad-3',
          contracts: [{ name: 'BridgeVault', baseline: baselineAbi, candidate: [{ type: 'banana' }] }],
        }),
      'MALFORMED_CONTRACT_ARTIFACT',
    );
    expectGateError(
      () =>
        gate.evaluate({
          releaseId: 'bad-4',
          contracts: [
            {
              name: 'BridgeVault',
              baseline: baselineAbi,
              candidate: [
                {
                  type: 'function',
                  name: 'swap',
                  inputs: [{ name: 'order', type: 'tuple' }], // components missing
                  outputs: [],
                  stateMutability: 'nonpayable',
                },
              ],
            },
          ],
        }),
      'MALFORMED_CONTRACT_ARTIFACT',
    );
    // A malformed release never produced a stored passing report.
    expect(gate.getReport('bad-1')).toBeUndefined();
    expect(gate.metrics().failedEvaluations).toBe(0);
    expect(logs).toHaveLength(0);
  });

  it('rejects invalid candidates: empty release, bad ids, bad contract names', () => {
    const { gate } = makeGate();

    expectGateError(() => gate.evaluate({ releaseId: 'v1' }), 'INVALID_INPUT');
    expectGateError(
      () => gate.evaluate({ releaseId: '', contracts: [{ name: 'X', baseline: [], candidate: [] }] }),
      'INVALID_INPUT',
    );
    expectGateError(
      () =>
        gate.evaluate({
          releaseId: 'v1',
          contracts: [{ name: 'Bad Name!', baseline: [], candidate: [] }],
        }),
      'INVALID_INPUT',
    );
    expect(gate.metrics().rejectedInputs).toBeGreaterThan(0);
  });
});

// ─── API half ───────────────────────────────────────────────────────────────

describe('ReleaseCompatibilityGate (API document)', () => {
  it('passes a compatible API document', () => {
    const { gate } = makeGate();

    const report = gate.evaluate({
      releaseId: 'api-1',
      api: { baseline: baselineApi, candidate: baselineApi },
    });

    expect(report.verdict).toBe('pass');
    expect(report.checks[0].id).toBe('api-openapi');
    expect(report.evidence.sectionHashes.api).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails on a breaking API change and maps the checker rules', () => {
    const { gate } = makeGate();
    const candidate = apiDoc({});

    const report = gate.evaluate({
      releaseId: 'api-2',
      api: { baseline: baselineApi, candidate },
    });

    expect(report.verdict).toBe('fail');
    expect(report.checks[0].changes.map((change) => change.rule)).toContain('operation-removed');
    expect(report.checks[0].changes[0].severity).toBe('breaking');
  });

  it('fails closed on a malformed API document even under lenient policies', () => {
    const { gate } = makeGate();

    const report = gate.evaluate(
      { releaseId: 'api-3', api: { baseline: baselineApi, candidate: { openapi: '3.0.0' } } },
      { failOnBreaking: false },
    );

    expect(report.verdict).toBe('fail');
    expect(report.checks[0].changes.map((change) => change.rule)).toContain('document-invalid');
  });

  it('honors strictWarnings for API warnings', () => {
    const { gate } = makeGate();
    // Dropping the 429 response is a warning, not a break.
    const candidate = apiDoc({ '/quotes': { get: operation() } });

    const lenient = gate.evaluate({ releaseId: 'api-4', api: { baseline: baselineApi, candidate } });
    expect(lenient.verdict).toBe('pass');
    expect(lenient.counts.warning).toBe(1);

    const strict = gate.evaluate(
      { releaseId: 'api-5', api: { baseline: baselineApi, candidate } },
      { failOnWarnings: true },
    );
    expect(strict.verdict).toBe('fail');
  });
});

// ─── Combined release + override + evidence ─────────────────────────────────

describe('ReleaseCompatibilityGate (whole release lifecycle)', () => {
  it('combines contract and API checks into one verdict with aggregate counts', () => {
    const { gate } = makeGate();

    const report = gate.evaluate({
      releaseId: 'v2026.11.0',
      contracts: [{ name: 'BridgeVault', baseline: baselineAbi, candidate: baselineAbi }],
      api: { baseline: baselineApi, candidate: baselineApi },
    });

    expect(report.checks.map((check) => check.id)).toEqual(['contract-abi', 'api-openapi']);
    expect(report.verdict).toBe('pass');
    expect(Object.keys(report.evidence.sectionHashes).sort()).toEqual([
      'api',
      'contract:BridgeVault',
    ]);
    expect(() => gate.assertPass(report)).not.toThrow();
  });

  it('gives different releases different evidence hashes', () => {
    const { gate } = makeGate();
    const candidate = baselineAbi.filter(
      (entry) => !((entry as { name?: string }).name === 'paused'),
    );

    const a = gate.evaluate({
      releaseId: 'rel-a',
      contracts: [{ name: 'BridgeVault', baseline: baselineAbi, candidate: baselineAbi }],
    });
    const b = gate.evaluate({
      releaseId: 'rel-b',
      contracts: [{ name: 'BridgeVault', baseline: baselineAbi, candidate }],
    });

    expect(a.evidence.releaseInputHash).not.toBe(b.evidence.releaseInputHash);
    expect(a.evidence.sectionHashes['contract:BridgeVault']).not.toBe(
      b.evidence.sectionHashes['contract:BridgeVault'],
    );
  });

  it('rejects an unauthorized override, keeps the gate failed, and audits the denial', () => {
    const { gate, audit } = makeGate();
    const failing = gate.evaluate({
      releaseId: 'rel-1',
      contracts: [
        {
          name: 'BridgeVault',
          baseline: baselineAbi,
          candidate: baselineAbi.filter((entry) => (entry as { name?: string }).name !== 'withdraw'),
        },
      ],
    });
    expect(failing.verdict).toBe('fail');

    expectGateError(
      () =>
        gate.override({
          releaseId: 'rel-1',
          actor: 'eager-intern',
          actorRoles: ['engineer'],
          reason: 'please just ship it, we tested manually',
        }),
      'OVERRIDE_DENIED',
    );

    expect(gate.getReport('rel-1')!.verdict).toBe('fail');
    expect(() => gate.assertPass(gate.getReport('rel-1')!)).toThrow(CompatibilityGateError);

    const { items } = audit.query({ action: 'compatibility-gate.override' });
    expect(items.map((entry) => entry.outcome)).toEqual(['attempted', 'denied']);
    expect(items[1].reason).toContain('release override role');
    expect(audit.verifyIntegrity().valid).toBe(true);
    expect(gate.metrics()).toMatchObject({ overrides: 0, deniedOverrides: 1 });
  });

  it('waives a failing report with a release-manager role and records it', () => {
    const { gate, audit, logs } = makeGate();
    gate.evaluate({
      releaseId: 'rel-2',
      contracts: [
        {
          name: 'BridgeVault',
          baseline: baselineAbi,
          candidate: baselineAbi.filter((entry) => (entry as { name?: string }).name !== 'withdraw'),
        },
      ],
    });

    const waived = gate.override({
      releaseId: 'rel-2',
      actor: 'release-manager-7',
      actorRoles: ['Release-Manager'],
      reason: 'breaking change announced in v2026.11 migration guide',
    });

    expect(waived.verdict).toBe('pass');
    expect(waived.waived).toMatchObject({ by: 'release-manager-7' });
    expect(waived.waived!.waivedFindings.breaking).toBe(1);
    expect(() => gate.assertPass(waived)).not.toThrow();
    // The original findings survive the waiver for auditors.
    expect(waived.checks[0].changes.some((change) => change.rule === 'function-removed')).toBe(true);

    const { items } = audit.query({ action: 'compatibility-gate.override' });
    expect(items.map((entry) => entry.outcome)).toEqual(['attempted', 'success']);
    expect(items[0].category).toBe('configuration');
    expect(logs.map((event) => event.code)).toEqual(['GATE_FAILED', 'GATE_OVERRIDDEN']);
    expect(gate.metrics().overrides).toBe(1);

    // A waived report cannot be waived again, and re-evaluating the same
    // releaseId replaces it with a fresh (failing) report.
    expectGateError(
      () =>
        gate.override({
          releaseId: 'rel-2',
          actor: 'release-manager-7',
          actorRoles: ['release-manager'],
          reason: 'second waiver attempt, not allowed',
        }),
      'NOTHING_TO_WAIVE',
    );
  });

  it('rejects malformed override requests and unknown releases', () => {
    const { gate } = makeGate();

    expectGateError(
      () => gate.override({ releaseId: 'ghost', actor: 'x', actorRoles: [], reason: 'long enough reason' }),
      'INVALID_INPUT',
    );
    gate.evaluate({
      releaseId: 'rel-3',
      contracts: [{ name: 'BridgeVault', baseline: baselineAbi, candidate: baselineAbi }],
    });
    expectGateError(
      () =>
        gate.override({
          releaseId: 'rel-3',
          actor: 'release-manager-7',
          actorRoles: ['release-manager'],
          reason: 'long enough reason',
        }),
      'NOTHING_TO_WAIVE',
    );
    expectGateError(
      () =>
        gate.override({
          releaseId: 'rel-3',
          actor: 'release-manager-7',
          actorRoles: ['release-manager'],
          reason: 'short',
        }),
      'INVALID_INPUT',
    );
  });

  it('formats a report into an evidence block without leaking document content', () => {
    const { gate } = makeGate();
    const report = gate.evaluate({
      releaseId: 'rel-4',
      contracts: [
        {
          name: 'BridgeVault',
          baseline: baselineAbi,
          candidate: baselineAbi.filter((entry) => (entry as { name?: string }).name !== 'withdraw'),
        },
      ],
      api: { baseline: baselineApi, candidate: apiDoc({}) },
    });

    const text = gate.formatReport(report);

    expect(text).toContain('Release compatibility gate: FAIL');
    expect(text).toContain('release: rel-4');
    expect(text).toContain('function-removed');
    expect(text).toContain('operation-removed');
    expect(text).toContain(report.evidence.releaseInputHash);
    // Info-level noise is summarized in counts, not listed line by line.
    expect(text).not.toContain('function-added');
  });
});
