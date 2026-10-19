/**
 * File: src/operations/mainnet/mainnet-canary-transfer.service.spec.ts
 *
 * Deterministic unit tests for the mainnet canary transfer procedure (#1381).
 */

import {
  CanaryTransferDependencies,
  MainnetCanaryTransferPlan,
} from './mainnet-canary-transfer.types';
import { MainnetCanaryTransferService } from './mainnet-canary-transfer.service';

const DESTINATION =
  'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ';

describe('MainnetCanaryTransferService (#1381)', () => {
  let now: number;
  let service: MainnetCanaryTransferService;
  let dependencies: {
    submit: jest.Mock;
    getConfirmations: jest.Mock;
    verifySettlement: jest.Mock;
  };

  const basePlan = (
    overrides: Partial<MainnetCanaryTransferPlan> = {},
  ): MainnetCanaryTransferPlan => ({
    canaryId: 'canary-stellar-usdc-1',
    chain: 'stellar-mainnet',
    routeId: 'route-stellar-ethereum',
    asset: 'USDC',
    amount: '0.01',
    destination: DESTINATION,
    requestedBy: 'release-manager',
    ...overrides,
  });

  beforeEach(() => {
    now = 1_700_000_000_000;
    service = new MainnetCanaryTransferService({
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      defaultPollIntervalMs: 25,
    });
    service.registerChainPolicy({
      chain: 'stellar-mainnet',
      assets: ['USDC', 'XLM'],
      maxAmount: '0.1',
      requiredConfirmations: 2,
      timeoutMs: 100,
    });

    dependencies = {
      submit: jest.fn(async () => ({ txHash: 'tx-canary-1' })),
      getConfirmations: jest.fn(async () => 2),
      verifySettlement: jest.fn(async () => true),
    };
  });

  it('passes a capped canary with confirmations and settlement verification', async () => {
    const result = await service.run(basePlan(), dependencies);

    expect(result.passed).toBe(true);
    expect(result.fullRolloutAuthorized).toBe(true);
    expect(result.record.status).toBe('confirmed');
    expect(result.record.confirmations).toBe(2);
    expect(result.record.txHash).toBe('tx-canary-1');
    expect(result.record.attempts).toBe(1);
    expect(result.record.audit.map((a) => a.step)).toEqual([
      'planned',
      'submitted',
      'confirmed',
    ]);
    expect(dependencies.submit).toHaveBeenCalledTimes(1);
    expect(dependencies.verifySettlement).toHaveBeenCalledTimes(1);
    expect(service.authorizeFullRollout(basePlan().canaryId).status).toBe(
      'confirmed',
    );
  });

  it('never exposes the full destination in the stored record', async () => {
    const result = await service.run(basePlan(), dependencies);

    expect(result.record.destinationMasked).toBe(
      `${DESTINATION.slice(0, 6)}…${DESTINATION.slice(-4)}`,
    );
    expect(JSON.stringify(result.record)).not.toContain(DESTINATION);
    expect(dependencies.submit).toHaveBeenCalledWith(
      expect.objectContaining({ destination: DESTINATION }),
    );
  });

  it('is idempotent per canary id and never resubmits', async () => {
    const first = await service.run(basePlan(), dependencies);
    now += 5_000;
    const second = await service.run(basePlan(), dependencies);

    expect(second.record).toEqual(first.record);
    expect(dependencies.submit).toHaveBeenCalledTimes(1);
    expect(service.listRecords()).toHaveLength(1);
  });

  it('shares a single in-flight submission for concurrent replays', async () => {
    let resolveSubmission: (value: { txHash: string }) => void = () =>
      undefined;
    dependencies.submit.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubmission = resolve;
        }),
    );

    const first = service.run(basePlan(), dependencies);
    const second = service.run(basePlan(), dependencies);
    resolveSubmission({ txHash: 'tx-single-flight' });
    const results = await Promise.all([first, second]);

    expect(dependencies.submit).toHaveBeenCalledTimes(1);
    expect(results[0].record).toEqual(results[1].record);
    expect(results[0].passed).toBe(true);
  });

  it('rejects a second active canary on the same route', async () => {
    let resolveSubmission: (value: { txHash: string }) => void = () =>
      undefined;
    dependencies.submit.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubmission = resolve;
        }),
    );

    const first = service.run(basePlan(), dependencies);
    const duplicate = await service.run(
      basePlan({ canaryId: 'canary-stellar-usdc-2' }),
      dependencies,
    );

    expect(duplicate.record.status).toBe('blocked');
    expect(duplicate.record.failureReason).toBe('duplicate_active_canary');
    expect(service.hasActiveCanary('route-stellar-ethereum')).toBe(true);

    resolveSubmission({ txHash: 'tx-first' });
    await first;
    expect(service.hasActiveCanary('route-stellar-ethereum')).toBe(false);
  });

  it('enforces chain, asset, and decimal-safe amount boundaries', async () => {
    const unknownChain = await service.run(
      basePlan({ canaryId: 'canary-chain', chain: 'polygon-mainnet' }),
      dependencies,
    );
    expect(unknownChain.record.failureReason).toBe('chain_not_allowed');

    const unknownAsset = await service.run(
      basePlan({ canaryId: 'canary-asset', asset: 'WBTC' }),
      dependencies,
    );
    expect(unknownAsset.record.failureReason).toBe('asset_not_allowed');

    const aboveCap = await service.run(
      basePlan({
        canaryId: 'canary-cap',
        amount: '0.100000000000000001',
      }),
      dependencies,
    );
    expect(aboveCap.record.failureReason).toBe('amount_exceeds_cap');

    const zero = await service.run(
      basePlan({ canaryId: 'canary-zero', amount: '0' }),
      dependencies,
    );
    expect(zero.record.failureReason).toBe('invalid_plan');

    const malformed = await service.run(
      basePlan({ canaryId: 'canary-malformed', amount: '1e-3' }),
      dependencies,
    );
    expect(malformed.record.failureReason).toBe('invalid_plan');

    const atCap = await service.run(
      basePlan({ canaryId: 'canary-at-cap', amount: '0.1' }),
      dependencies,
    );
    expect(atCap.passed).toBe(true);
    expect(dependencies.submit).toHaveBeenCalledTimes(1);
  });

  it('applies stricter confirmation overrides and validates boundaries', async () => {
    dependencies.getConfirmations.mockResolvedValue(3);
    const stricter = await service.run(
      basePlan({
        canaryId: 'canary-stricter',
        requiredConfirmations: 3,
        timeoutMs: 50,
      }),
      dependencies,
    );
    expect(stricter.passed).toBe(true);
    expect(stricter.record.requiredConfirmations).toBe(3);

    const weaker = await service.run(
      basePlan({ canaryId: 'canary-weaker', requiredConfirmations: 1 }),
      dependencies,
    );
    expect(weaker.record.failureReason).toBe('invalid_plan');

    const longer = await service.run(
      basePlan({ canaryId: 'canary-longer', timeoutMs: 101 }),
      dependencies,
    );
    expect(longer.record.failureReason).toBe('invalid_plan');
  });

  it('times out when confirmations never reach the requirement', async () => {
    dependencies.getConfirmations.mockResolvedValue(1);

    const result = await service.run(
      basePlan({ canaryId: 'canary-timeout' }),
      dependencies,
    );

    expect(result.passed).toBe(false);
    expect(result.record.status).toBe('failed');
    expect(result.record.failureReason).toBe('confirmation_timeout');
    expect(result.record.confirmations).toBe(1);
    expect(dependencies.submit).toHaveBeenCalledTimes(1);
  });

  it('records a safe probe error when confirmation checks fail', async () => {
    dependencies.getConfirmations.mockRejectedValue(
      new Error('RPC returned private payload'),
    );

    const result = await service.run(
      basePlan({ canaryId: 'canary-probe-fail' }),
      dependencies,
    );

    expect(result.record.failureReason).toBe('confirmation_timeout');
    expect(result.record.failureDetail).toBe('confirmation_probe_error');
    expect(JSON.stringify(result.record)).not.toContain('private payload');
  });

  it('fails closed on submission and settlement errors', async () => {
    dependencies.submit.mockRejectedValueOnce(
      Object.assign(new Error('leaky payload'), { code: 'insufficient_fee' }),
    );
    const submitFailure = await service.run(
      basePlan({ canaryId: 'canary-submit-fail' }),
      dependencies,
    );
    expect(submitFailure.record.failureReason).toBe('submission_failed');
    expect(submitFailure.record.failureDetail).toBe('insufficient_fee');
    expect(submitFailure.record.attempts).toBe(1);

    dependencies.verifySettlement.mockResolvedValueOnce(false);
    const verifyFailure = await service.run(
      basePlan({ canaryId: 'canary-verify-fail' }),
      dependencies,
    );
    expect(verifyFailure.record.failureReason).toBe('verification_failed');
    expect(verifyFailure.fullRolloutAuthorized).toBe(false);
  });

  it('blocks the canary when the operator guard denies the chain', async () => {
    const guarded = await service.run(
      basePlan({ canaryId: 'canary-guarded' }),
      dependencies,
      {
        guard: () => ({ allowed: false, reasonCode: 'chain_outage' }),
      },
    );

    expect(guarded.record.status).toBe('failed');
    expect(guarded.record.failureReason).toBe('operator_guard_denied');
    expect(guarded.record.failureDetail).toBe('chain_outage');
    expect(dependencies.submit).not.toHaveBeenCalled();

    const throwingGuard = await service.run(
      basePlan({ canaryId: 'canary-guard-throw' }),
      dependencies,
      {
        guard: () => {
          throw new Error('guard unavailable');
        },
      },
    );
    expect(throwingGuard.record.failureDetail).toBe('guard_error');
  });

  it('authorizes full rollout only for a confirmed canary', async () => {
    expect(() => service.authorizeFullRollout('missing')).toThrow(/not found/);

    dependencies.getConfirmations.mockResolvedValue(0);
    await service.run(basePlan({ canaryId: 'canary-failed' }), dependencies);
    expect(() => service.authorizeFullRollout('canary-failed')).toThrow(
      /failed/,
    );

    dependencies.getConfirmations.mockResolvedValue(2);
    await service.run(basePlan({ canaryId: 'canary-ok' }), dependencies);
    expect(service.authorizeFullRollout('canary-ok').status).toBe('confirmed');
  });

  it('preflight is side-effect free and reports the blocking reason', () => {
    const check = service.preflight(basePlan({ amount: '5' }));

    expect(check.allowed).toBe(false);
    expect(check.reason).toBe('amount_exceeds_cap');
    expect(service.listRecords()).toHaveLength(0);
    expect(dependencies.submit).not.toHaveBeenCalled();
  });

  it('validates chain policies and required dependencies', async () => {
    expect(() =>
      service.registerChainPolicy({
        chain: '',
        assets: ['USDC'],
        maxAmount: '0.1',
        requiredConfirmations: 2,
        timeoutMs: 100,
      }),
    ).toThrow(/chain/);

    expect(() =>
      service.registerChainPolicy({
        chain: 'stellar-mainnet',
        assets: [],
        maxAmount: '0.1',
        requiredConfirmations: 2,
        timeoutMs: 100,
      }),
    ).toThrow(/at least one asset/);

    expect(() =>
      service.registerChainPolicy({
        chain: 'stellar-mainnet',
        assets: ['USDC', 'usdc'],
        maxAmount: '0.1',
        requiredConfirmations: 2,
        timeoutMs: 100,
      }),
    ).toThrow(/unique/);

    expect(() =>
      service.registerChainPolicy({
        chain: 'stellar-mainnet',
        assets: ['USDC'],
        maxAmount: '-1',
        requiredConfirmations: 2,
        timeoutMs: 100,
      }),
    ).toThrow(/maxAmount/);

    expect(() =>
      service.registerChainPolicy({
        chain: 'stellar-mainnet',
        assets: ['USDC'],
        maxAmount: '0.1',
        requiredConfirmations: 0,
        timeoutMs: 100,
      }),
    ).toThrow(/requiredConfirmations/);

    expect(() =>
      service.registerChainPolicy({
        chain: 'stellar-mainnet',
        assets: ['USDC'],
        maxAmount: '0.1',
        requiredConfirmations: 2,
        timeoutMs: 0,
      }),
    ).toThrow(/timeoutMs/);

    await expect(
      service.run(basePlan(), {} as unknown as CanaryTransferDependencies, {}),
    ).rejects.toThrow(/dependencies are required/);

    await expect(
      service.run(basePlan({ canaryId: ' ' }), dependencies),
    ).rejects.toThrow(/canaryId/);
  });

  it('lists policies and rejects duplicate policy assets after normalization', () => {
    const policy = service.getChainPolicy('STELLAR-MAINNET');
    expect(policy?.assets).toEqual(['USDC', 'XLM']);
    expect(service.listChainPolicies()).toHaveLength(1);
    expect(service.getChainPolicy('unknown-mainnet')).toBeUndefined();
  });
});
