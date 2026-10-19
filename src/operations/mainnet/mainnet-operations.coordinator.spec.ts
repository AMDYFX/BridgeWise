/**
 * File: src/operations/mainnet/mainnet-operations.coordinator.spec.ts
 *
 * Integration tests across the mainnet operations boundaries (#1378-#1381):
 * an outage must block canaries, signer quorum must be enforced, chain scopes
 * must stay isolated, and only a confirmed canary may authorize expansion.
 */

import { ChainOutagePlaybookService } from './chain-outage-playbook.service';
import { ChainOutagePlaybook } from './chain-outage-playbook.types';
import { ChainFeatureRolloutService } from './chain-feature-rollout.service';
import { MainnetCanaryTransferService } from './mainnet-canary-transfer.service';
import { MainnetOperationsCoordinator } from './mainnet-operations.coordinator';
import {
  SignerAvailabilityProbe,
  SignerProbeResult,
} from './signer-availability-readiness.types';
import { SignerAvailabilityReadinessService } from './signer-availability-readiness.service';

const STELLAR_DESTINATION =
  'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const EVM_DESTINATION = '0x1234567890abcdef1234567890abcdef12345678';

class MutableProbe implements SignerAvailabilityProbe {
  public responses = new Map<string, SignerProbeResult>();

  async check(signerId: string): Promise<SignerProbeResult> {
    return this.responses.get(signerId) ?? { available: true, latencyMs: 10 };
  }
}

const playbook: ChainOutagePlaybook = {
  id: 'stellar-mainnet-rpc-fixture',
  chain: 'stellar-mainnet',
  outageType: 'rpc_unavailable',
  severity: 'sev1',
  summary: 'Integration fixture outage',
  steps: [
    {
      id: 'confirm',
      order: 1,
      title: 'Confirm outage',
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
  ],
  escalation: {
    primaryRole: 'oncall',
    secondaryRole: 'ops-lead',
    notifyAfterSeconds: 120,
  },
  recovery: {
    signals: ['rpc_healthy'],
    observationWindowSeconds: 0,
  },
};

describe('MainnetOperationsCoordinator (#1378-#1381)', () => {
  let now: number;
  let probe: MutableProbe;
  let outages: ChainOutagePlaybookService;
  let signers: SignerAvailabilityReadinessService;
  let rollouts: ChainFeatureRolloutService;
  let canaries: MainnetCanaryTransferService;
  let coordinator: MainnetOperationsCoordinator;
  let submit: jest.Mock;
  let getConfirmations: jest.Mock;
  let verifySettlement: jest.Mock;

  const featureKey = 'stellar-canary-settlement';

  beforeEach(() => {
    now = 1_700_000_000_000;
    probe = new MutableProbe();
    outages = new ChainOutagePlaybookService({
      loadDefaults: false,
      now: () => now,
    });
    outages.registerPlaybook(playbook);
    signers = new SignerAvailabilityReadinessService(probe, {
      now: () => now,
      timeoutMs: 50,
    });
    signers.registerRequirement({
      chain: 'stellar-mainnet',
      signerIds: ['stellar-signer-a', 'stellar-signer-b'],
      minAvailable: 2,
      maxLatencyMs: 200,
    });
    signers.registerRequirement({
      chain: 'ethereum-mainnet',
      signerIds: ['evm-signer'],
      minAvailable: 1,
      maxLatencyMs: 200,
    });

    rollouts = new ChainFeatureRolloutService({
      now: () => now,
      maxStepIncrease: 25,
    });
    rollouts.defineFeature({
      key: featureKey,
      description: 'Canary-gated Stellar settlement',
      updatedBy: 'release-manager',
      chains: [
        { chain: 'stellar-mainnet', percentage: 0, allowlist: ['release-bot'] },
        { chain: 'ethereum-mainnet', percentage: 0 },
      ],
    });

    canaries = new MainnetCanaryTransferService({
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      defaultPollIntervalMs: 10,
    });
    canaries.registerChainPolicy({
      chain: 'stellar-mainnet',
      assets: ['USDC'],
      maxAmount: '0.05',
      requiredConfirmations: 2,
      timeoutMs: 100,
    });
    canaries.registerChainPolicy({
      chain: 'ethereum-mainnet',
      assets: ['USDC'],
      maxAmount: '0.01',
      requiredConfirmations: 1,
      timeoutMs: 100,
    });

    coordinator = new MainnetOperationsCoordinator(
      outages,
      signers,
      rollouts,
      canaries,
    );

    submit = jest.fn(async () => ({ txHash: 'tx-canary' }));
    getConfirmations = jest.fn(async () => 2);
    verifySettlement = jest.fn(async () => true);
  });

  const stellarPlan = (canaryId: string, amount = '0.01') => ({
    canaryId,
    chain: 'stellar-mainnet',
    routeId: 'route-stellar-ethereum',
    asset: 'USDC',
    amount,
    destination: STELLAR_DESTINATION,
    requestedBy: 'release-manager',
  });

  const dependencies = () => ({
    submit,
    getConfirmations,
    verifySettlement,
  });

  it('assesses a healthy chain and surfaces the rollout decision', async () => {
    const assessment = await coordinator.assessChain('stellar-mainnet', {
      featureKey,
      subjectId: 'release-bot',
    });

    expect(assessment.operational).toBe(true);
    expect(assessment.reasons).toEqual([]);
    expect(assessment.signerReadiness?.status).toBe('ready');
    expect(assessment.featureDecision).toMatchObject({
      enabled: true,
      reason: 'allowlisted',
    });
    expect(assessment.featureSnapshot?.key).toBe(featureKey);
  });

  it('blocks canaries during a sev1 outage and unblocks after recovery', async () => {
    const { incident } = outages.openIncident({
      chain: 'stellar-mainnet',
      outageType: 'rpc_unavailable',
      openedBy: 'oncall',
      detectionSource: 'rpc-probe',
      dedupeKey: 'rpc-down',
    });

    const blockedAssessment = await coordinator.assessChain('stellar-mainnet');
    expect(blockedAssessment.operational).toBe(false);
    expect(blockedAssessment.reasons).toContain('active_chain_outage');

    const blockedCanary = await coordinator.runCanary(
      stellarPlan('canary-during-outage'),
      dependencies(),
    );
    expect(blockedCanary.record.failureReason).toBe('operator_guard_denied');
    expect(blockedCanary.record.failureDetail).toBe('chain_outage');
    expect(submit).not.toHaveBeenCalled();

    outages.startStep(incident.id, 'confirm', 'oncall');
    outages.completeStep(incident.id, 'confirm', 'oncall');
    outages.startStep(incident.id, 'pause', 'oncall');
    outages.completeStep(incident.id, 'pause', 'oncall');
    outages.resolveIncident({
      incidentId: incident.id,
      resolvedBy: 'oncall',
      observedSignals: ['rpc_healthy'],
    });

    const recoveredAssessment =
      await coordinator.assessChain('stellar-mainnet');
    expect(recoveredAssessment.operational).toBe(true);

    const canary = await coordinator.runCanary(
      stellarPlan('canary-after-recovery'),
      dependencies(),
    );
    expect(canary.passed).toBe(true);
    expect(canary.fullRolloutAuthorized).toBe(true);
    expect(canaries.authorizeFullRollout('canary-after-recovery').status).toBe(
      'confirmed',
    );

    // Only after the canary passes does the rollout advance, in bounded steps.
    rollouts.setChainRollout(
      featureKey,
      'stellar-mainnet',
      25,
      'release-manager',
    );
    const expanded = rollouts.setChainRollout(
      featureKey,
      'stellar-mainnet',
      50,
      'release-manager',
    );
    expect(
      expanded.chains.find((c) => c.chain === 'stellar-mainnet')?.percentage,
    ).toBe(50);
    expect(() =>
      rollouts.setChainRollout(
        featureKey,
        'stellar-mainnet',
        100,
        'release-manager',
      ),
    ).toThrow(/maxStepIncrease/);
  });

  it('blocks canaries when signer quorum is below the requirement', async () => {
    probe.responses.set('stellar-signer-b', { available: false });

    const assessment = await coordinator.assessChain('stellar-mainnet');
    expect(assessment.operational).toBe(false);
    expect(assessment.reasons).toContain('signer_readiness_unavailable');

    const canary = await coordinator.runCanary(
      stellarPlan('canary-signer-down'),
      dependencies(),
    );
    expect(canary.record.failureReason).toBe('operator_guard_denied');
    expect(canary.record.failureDetail).toBe('signer_readiness_unavailable');
    expect(submit).not.toHaveBeenCalled();
  });

  it('fails closed when a chain has no signer readiness requirement', async () => {
    canaries.registerChainPolicy({
      chain: 'polygon-mainnet',
      assets: ['USDC'],
      maxAmount: '0.01',
      requiredConfirmations: 1,
      timeoutMs: 100,
    });
    rollouts.addChainTarget(
      featureKey,
      'polygon-mainnet',
      0,
      'release-manager',
    );

    const assessment = await coordinator.assessChain('polygon-mainnet');
    expect(assessment.operational).toBe(false);
    expect(assessment.reasons).toContain('signer_readiness_not_configured');

    const canary = await coordinator.runCanary(
      {
        ...stellarPlan('canary-polygon'),
        chain: 'polygon-mainnet',
        destination: EVM_DESTINATION,
      },
      dependencies(),
    );
    expect(canary.record.failureDetail).toBe('signer_readiness_not_configured');
    expect(submit).not.toHaveBeenCalled();
  });

  it('keeps chain scopes isolated during an outage', async () => {
    outages.openIncident({
      chain: 'stellar-mainnet',
      outageType: 'rpc_unavailable',
      openedBy: 'oncall',
      detectionSource: 'rpc-probe',
      dedupeKey: 'stellar-only',
    });

    const stellar = await coordinator.assessChain('stellar-mainnet');
    const ethereum = await coordinator.assessChain('ethereum-mainnet');
    expect(stellar.operational).toBe(false);
    expect(ethereum.operational).toBe(true);

    const ethereumCanary = await coordinator.runCanary(
      {
        canaryId: 'canary-ethereum-1',
        chain: 'ethereum-mainnet',
        routeId: 'route-ethereum-stellar',
        asset: 'USDC',
        amount: '0.005',
        destination: EVM_DESTINATION,
        requestedBy: 'release-manager',
      },
      dependencies(),
    );
    expect(ethereumCanary.passed).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('does not authorize rollout expansion after a failed canary', async () => {
    getConfirmations.mockResolvedValue(0);

    const canary = await coordinator.runCanary(
      stellarPlan('canary-timeout'),
      dependencies(),
    );
    expect(canary.passed).toBe(false);
    expect(canary.record.failureReason).toBe('confirmation_timeout');
    expect(() => canaries.authorizeFullRollout('canary-timeout')).toThrow(
      /failed/,
    );

    const snapshot = rollouts.getSnapshot(featureKey);
    expect(
      snapshot?.chains.find((c) => c.chain === 'stellar-mainnet')?.percentage,
    ).toBe(0);
  });

  it('rejects an over-cap canary before any submission', async () => {
    const canary = await coordinator.runCanary(
      stellarPlan('canary-over-cap', '0.06'),
      dependencies(),
    );

    expect(canary.record.status).toBe('blocked');
    expect(canary.record.failureReason).toBe('amount_exceeds_cap');
    expect(submit).not.toHaveBeenCalled();
  });

  it('replays a confirmed canary without duplicate submission', async () => {
    const first = await coordinator.runCanary(
      stellarPlan('canary-idempotent'),
      dependencies(),
    );
    const second = await coordinator.runCanary(
      stellarPlan('canary-idempotent'),
      dependencies(),
    );

    expect(first.passed).toBe(true);
    expect(second.record).toEqual(first.record);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
