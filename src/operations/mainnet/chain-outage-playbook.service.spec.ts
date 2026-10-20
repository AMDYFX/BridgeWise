/**
 * File: src/operations/mainnet/chain-outage-playbook.service.spec.ts
 *
 * Deterministic unit tests for chain outage response playbooks (#1378).
 */

import { ChainOutagePlaybookService } from './chain-outage-playbook.service';
import { ChainOutagePlaybook } from './chain-outage-playbook.types';

const fixturePlaybook: ChainOutagePlaybook = {
  id: 'stellar-test-rpc-outage',
  chain: 'stellar-mainnet',
  outageType: 'rpc_unavailable',
  severity: 'sev1',
  summary: 'Fixture outage playbook',
  steps: [
    {
      id: 'confirm',
      order: 1,
      title: 'Confirm outage scope',
      ownerRole: 'oncall',
      slaSeconds: 60,
      required: true,
    },
    {
      id: 'pause',
      order: 2,
      title: 'Pause Stellar routes',
      ownerRole: 'oncall',
      slaSeconds: 60,
      required: true,
      action: 'pause_routes',
    },
    {
      id: 'notify',
      order: 3,
      title: 'Notify partners',
      ownerRole: 'comms',
      slaSeconds: 120,
      required: false,
      action: 'notify_oncall',
    },
  ],
  escalation: {
    primaryRole: 'oncall',
    secondaryRole: 'ops-lead',
    notifyAfterSeconds: 300,
  },
  recovery: {
    signals: ['rpc_healthy', 'routes_reopened'],
    observationWindowSeconds: 60,
  },
};

describe('ChainOutagePlaybookService (#1378)', () => {
  let now: number;
  let service: ChainOutagePlaybookService;

  beforeEach(() => {
    now = 1_700_000_000_000;
    service = new ChainOutagePlaybookService({
      loadDefaults: false,
      now: () => now,
    });
    service.registerPlaybook(fixturePlaybook);
  });

  const open = () =>
    service.openIncident({
      chain: 'stellar-mainnet',
      outageType: 'rpc_unavailable',
      openedBy: 'oncall-1',
      detectionSource: 'rpc-probe',
      dedupeKey: 'stellar-rpc-down',
    });

  const completeRequiredSteps = (incidentId: string) => {
    service.startStep(incidentId, 'confirm', 'oncall-1');
    now += 10;
    service.completeStep(
      incidentId,
      'confirm',
      'oncall-1',
      'two providers agree',
    );
    service.startStep(incidentId, 'pause', 'oncall-1');
    now += 10;
    service.completeStep(incidentId, 'pause', 'oncall-1');
  };

  it('opens a chain-scoped incident with pending steps', () => {
    const { incident, created } = open();

    expect(created).toBe(true);
    expect(incident.chain).toBe('stellar-mainnet');
    expect(incident.status).toBe('open');
    expect(incident.severity).toBe('sev1');
    expect(incident.steps.map((s) => s.status)).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
    expect(service.getIncident(incident.id)?.detectionSource).toBe('rpc-probe');
  });

  it('is idempotent for repeated alerts with the same dedupe key', () => {
    const first = open();
    now += 5_000;
    const second = open();

    expect(second.created).toBe(false);
    expect(second.incident.id).toBe(first.incident.id);
    expect(service.listIncidents({ activeOnly: true })).toHaveLength(1);
  });

  it('allows a new incident once the previous one is resolved', () => {
    const first = open();
    completeRequiredSteps(first.incident.id);
    service.resolveIncident({
      incidentId: first.incident.id,
      resolvedBy: 'oncall-1',
      observedSignals: ['rpc_healthy', 'routes_reopened'],
    });
    now += 1_000;

    const second = open();
    expect(second.created).toBe(true);
    expect(second.incident.id).not.toBe(first.incident.id);
  });

  it('emits automatic containment actions and audits them', () => {
    const actions: string[] = [];
    service.on('automatic_action', (event) => actions.push(event.action));
    const { incident } = open();

    service.startStep(incident.id, 'confirm', 'oncall-1');
    service.completeStep(incident.id, 'confirm', 'oncall-1');
    const updated = service.startStep(incident.id, 'pause', 'oncall-1');

    expect(actions).toEqual(['pause_routes']);
    expect(updated.automaticActions).toEqual(['pause_routes']);
    expect(updated.status).toBe('mitigating');
  });

  it('rejects out-of-order step execution and unsafe skips', () => {
    const { incident } = open();

    expect(() => service.startStep(incident.id, 'pause', 'oncall-1')).toThrow(
      /Previous steps must settle/,
    );

    service.startStep(incident.id, 'confirm', 'oncall-1');
    service.completeStep(incident.id, 'confirm', 'oncall-1');
    expect(() =>
      service.skipStep(incident.id, 'pause', 'oncall-1', 'skip'),
    ).toThrow(/Required step/);
    service.startStep(incident.id, 'pause', 'oncall-1');
    service.completeStep(incident.id, 'pause', 'oncall-1');

    // Optional steps may be skipped with an auditable note.
    const skipped = service.skipStep(
      incident.id,
      'notify',
      'oncall-1',
      'partners already notified',
    );
    const notify = skipped.steps.find((s) => s.stepId === 'notify');
    expect(notify?.status).toBe('skipped');
    expect(notify?.note).toBe('partners already notified');
  });

  it('escalates and records the responsible role', () => {
    const { incident } = open();

    const escalated = service.escalate(
      incident.id,
      'rpc failover exceeded SLA',
    );

    expect(escalated.status).toBe('escalated');
    expect(escalated.escalations).toHaveLength(1);
    expect(escalated.escalations[0].role).toBe('ops-lead');
    expect(service.isChainBlocked('stellar-mainnet')).toBe(true);
  });

  it('requires every required step and recovery signal before resolution', () => {
    const { incident } = open();

    expect(() =>
      service.resolveIncident({
        incidentId: incident.id,
        resolvedBy: 'oncall-1',
        observedSignals: ['rpc_healthy', 'routes_reopened'],
      }),
    ).toThrow(/Required steps are incomplete/);

    completeRequiredSteps(incident.id);
    expect(() =>
      service.resolveIncident({
        incidentId: incident.id,
        resolvedBy: 'oncall-1',
        observedSignals: ['rpc_healthy'],
      }),
    ).toThrow(/routes_reopened/);

    const resolved = service.resolveIncident({
      incidentId: incident.id,
      resolvedBy: 'oncall-1',
      observedSignals: ['RPC_HEALTHY', 'routes_reopened'],
    });
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolution?.observedSignals).toEqual([
      'rpc_healthy',
      'routes_reopened',
    ]);
    expect(service.isChainBlocked('stellar-mainnet')).toBe(false);
  });

  it('does not block a different chain', () => {
    open();
    expect(service.isChainBlocked('ethereum-mainnet')).toBe(false);
    expect(service.getActiveIncidentsForChain('ethereum-mainnet')).toHaveLength(
      0,
    );
  });

  it('rejects incidents for chains without a playbook', () => {
    expect(() =>
      service.openIncident({
        chain: 'unknown-mainnet',
        outageType: 'rpc_unavailable',
        openedBy: 'oncall-1',
        detectionSource: 'rpc-probe',
      }),
    ).toThrow(/No playbook registered/);
  });

  it('validates playbook definitions and duplicate registrations', () => {
    expect(() =>
      service.registerPlaybook({
        ...fixturePlaybook,
        summary: '',
      }),
    ).toThrow(/playbook.summary/);

    expect(() =>
      service.registerPlaybook({
        ...fixturePlaybook,
        id: 'duplicate',
      }),
    ).toThrow(/already exists/);

    expect(() =>
      service.registerPlaybook({
        ...fixturePlaybook,
        id: 'duplicate-order',
        chain: 'other-mainnet',
        steps: [
          { ...fixturePlaybook.steps[0] },
          { ...fixturePlaybook.steps[1], order: 1 },
        ],
      }),
    ).toThrow(/Duplicate playbook step order/);

    expect(() =>
      service.registerPlaybook({
        ...fixturePlaybook,
        id: 'missing-signals',
        chain: 'other-mainnet',
        recovery: { signals: [], observationWindowSeconds: 60 },
      }),
    ).toThrow(/at least one recovery signal/);
  });

  it('ships built-in playbooks for the mainnet chains', () => {
    const defaults = new ChainOutagePlaybookService();
    const playbooks = defaults.listPlaybooks();

    expect(playbooks.map((p) => p.chain)).toEqual(
      expect.arrayContaining([
        'stellar-mainnet',
        'ethereum-mainnet',
        'arbitrum-mainnet',
      ]),
    );
    expect(
      defaults.getPlaybook('stellar-mainnet', 'rpc_unavailable')?.severity,
    ).toBe('sev1');
  });

  it('returns defensive copies so callers cannot mutate audited state', () => {
    const { incident } = open();
    incident.steps[0].status = 'completed';
    incident.status = 'resolved';

    const stored = service.getIncident(incident.id);
    expect(stored?.steps[0].status).toBe('pending');
    expect(stored?.status).toBe('open');
  });
});
