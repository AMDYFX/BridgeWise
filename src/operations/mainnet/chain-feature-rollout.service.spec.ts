/**
 * File: src/operations/mainnet/chain-feature-rollout.service.spec.ts
 *
 * Deterministic unit tests for controlled feature rollout by chain (#1380).
 */

import { ChainFeatureRolloutService } from './chain-feature-rollout.service';

describe('ChainFeatureRolloutService (#1380)', () => {
  let now: number;
  let service: ChainFeatureRolloutService;

  beforeEach(() => {
    now = 1_700_000_000_000;
    service = new ChainFeatureRolloutService({
      now: () => now,
      maxStepIncrease: 25,
    });
    service.defineFeature({
      key: 'soroban-settlement-v2',
      description: 'Next-generation Soroban settlement path',
      updatedBy: 'release-manager',
      chains: [
        { chain: 'stellar-mainnet', percentage: 50 },
        { chain: 'ethereum-mainnet', percentage: 0, allowlist: ['partner-1'] },
      ],
    });
  });

  it('defines a chain-scoped feature and evaluates known chains', () => {
    const definition = service.getFeature('soroban-settlement-v2');

    expect(definition?.enabled).toBe(true);
    expect(definition?.paused).toBe(false);
    expect(definition?.chains.map((c) => c.chain)).toEqual([
      'stellar-mainnet',
      'ethereum-mainnet',
    ]);
    expect(service.hasFeature('soroban-settlement-v2')).toBe(true);
  });

  it('fails closed for unknown features and untargeted chains', () => {
    const unknown = service.evaluate('never-defined', {
      chain: 'stellar-mainnet',
      subjectId: 'user-1',
    });
    expect(unknown).toMatchObject({
      enabled: false,
      reason: 'unknown_feature',
      percentage: 0,
    });

    const untargeted = service.evaluate('soroban-settlement-v2', {
      chain: 'polygon-mainnet',
      subjectId: 'user-1',
    });
    expect(untargeted).toMatchObject({
      enabled: false,
      reason: 'chain_not_targeted',
    });
  });

  it('keeps cohort assignment stable and bounded by the percentage', () => {
    const first = service.evaluate('soroban-settlement-v2', {
      chain: 'stellar-mainnet',
      subjectId: 'user-42',
    });
    for (let i = 0; i < 5; i += 1) {
      expect(
        service.evaluate('soroban-settlement-v2', {
          chain: 'stellar-mainnet',
          subjectId: 'user-42',
        }).enabled,
      ).toBe(first.enabled);
    }

    let enabled = 0;
    for (let i = 0; i < 2_000; i += 1) {
      if (
        service.isEnabled('soroban-settlement-v2', {
          chain: 'stellar-mainnet',
          subjectId: `user-${i}`,
        })
      ) {
        enabled += 1;
      }
    }
    expect(enabled).toBeGreaterThan(850);
    expect(enabled).toBeLessThan(1_150);
  });

  it('honors 0% and 100% boundaries', () => {
    const ethereum = service.evaluate('soroban-settlement-v2', {
      chain: 'ethereum-mainnet',
      subjectId: 'regular-user',
    });
    expect(ethereum).toMatchObject({
      enabled: false,
      reason: 'chain_percentage_zero',
    });

    service.setChainRollout(
      'soroban-settlement-v2',
      'stellar-mainnet',
      100,
      'release-manager',
      { force: true },
    );
    const full = service.evaluate('soroban-settlement-v2', {
      chain: 'stellar-mainnet',
      subjectId: 'any-user',
    });
    expect(full).toMatchObject({ enabled: true, reason: 'enabled' });
  });

  it('lets allowlisted subjects bypass a zero percentage', () => {
    const allowlisted = service.evaluate('soroban-settlement-v2', {
      chain: 'ethereum-mainnet',
      subjectId: 'PARTNER-1',
    });
    expect(allowlisted).toMatchObject({
      enabled: true,
      reason: 'allowlisted',
    });

    const other = service.evaluate('soroban-settlement-v2', {
      chain: 'ethereum-mainnet',
      subjectId: 'partner-2',
    });
    expect(other.enabled).toBe(false);
  });

  it('pause, disable, resume, and re-enable override every chain', () => {
    service.pauseFeature('soroban-settlement-v2', 'incident-commander');
    expect(
      service.evaluate('soroban-settlement-v2', {
        chain: 'ethereum-mainnet',
        subjectId: 'partner-1',
      }).reason,
    ).toBe('feature_paused');

    service.resumeFeature('soroban-settlement-v2', 'incident-commander');
    service.disableFeature('soroban-settlement-v2', 'incident-commander');
    expect(
      service.evaluate('soroban-settlement-v2', {
        chain: 'stellar-mainnet',
        subjectId: 'user-1',
      }).reason,
    ).toBe('feature_disabled');

    service.enableFeature('soroban-settlement-v2', 'release-manager');
    expect(
      service.evaluate('soroban-settlement-v2', {
        chain: 'ethereum-mainnet',
        subjectId: 'partner-1',
      }).enabled,
    ).toBe(true);
  });

  it('rate-limits percentage increases while allowing reductions and force', () => {
    expect(() =>
      service.setChainRollout(
        'soroban-settlement-v2',
        'ethereum-mainnet',
        100,
        'release-manager',
      ),
    ).toThrow(/exceeds maxStepIncrease/);

    const stepped = service.setChainRollout(
      'soroban-settlement-v2',
      'ethereum-mainnet',
      25,
      'release-manager',
    );
    expect(
      stepped.chains.find((c) => c.chain === 'ethereum-mainnet')?.percentage,
    ).toBe(25);

    service.setChainRollout(
      'soroban-settlement-v2',
      'ethereum-mainnet',
      10,
      'release-manager',
    );

    const forced = service.setChainRollout(
      'soroban-settlement-v2',
      'ethereum-mainnet',
      100,
      'release-manager',
      { force: true },
    );
    expect(
      forced.chains.find((c) => c.chain === 'ethereum-mainnet')?.percentage,
    ).toBe(100);
  });

  it('requires an explicit chain target and prevents duplicate chains', () => {
    expect(() =>
      service.setChainRollout(
        'soroban-settlement-v2',
        'polygon-mainnet',
        10,
        'release-manager',
      ),
    ).toThrow(/not targeted/);

    const updated = service.addChainTarget(
      'soroban-settlement-v2',
      'polygon-mainnet',
      0,
      'release-manager',
    );
    expect(updated.chains).toHaveLength(3);
    expect(
      service.evaluate('soroban-settlement-v2', {
        chain: 'polygon-mainnet',
        subjectId: 'user-1',
      }).reason,
    ).toBe('chain_percentage_zero');

    expect(() =>
      service.addChainTarget(
        'soroban-settlement-v2',
        'polygon-mainnet',
        10,
        'release-manager',
      ),
    ).toThrow(/already targeted/);
  });

  it('records an immutable mutation audit trail', () => {
    now += 1_000;
    service.pauseFeature('soroban-settlement-v2', 'incident-commander');
    now += 1_000;
    service.setChainRollout(
      'soroban-settlement-v2',
      'stellar-mainnet',
      25,
      'release-manager',
    );

    const snapshot = service.getSnapshot('soroban-settlement-v2');
    expect(snapshot?.audit.map((entry) => entry.action)).toEqual([
      'define',
      'pause',
      'set_percentage',
    ]);
    expect(snapshot?.audit[2]).toMatchObject({
      chain: 'stellar-mainnet',
      fromPercentage: 50,
      toPercentage: 25,
      actor: 'release-manager',
    });

    snapshot!.audit[0].actor = 'tampered';
    snapshot!.chains[0].percentage = 99;
    expect(service.getAuditTrail('soroban-settlement-v2')[0].actor).toBe(
      'release-manager',
    );
    expect(
      service.getFeature('soroban-settlement-v2')?.chains[0].percentage,
    ).toBe(25);
  });

  it('validates keys, percentages, chains, allowlists, and actors', () => {
    expect(() =>
      service.defineFeature({
        key: '1-invalid',
        updatedBy: 'ops',
        chains: [{ chain: 'stellar-mainnet', percentage: 0 }],
      }),
    ).toThrow(/feature key/);

    expect(() =>
      service.defineFeature({
        key: 'empty-chains',
        updatedBy: 'ops',
        chains: [],
      }),
    ).toThrow(/at least one chain/);

    expect(() =>
      service.defineFeature({
        key: 'duplicate-chains',
        updatedBy: 'ops',
        chains: [
          { chain: 'stellar-mainnet', percentage: 0 },
          { chain: 'stellar-mainnet', percentage: 10 },
        ],
      }),
    ).toThrow(/Duplicate chain target/);

    expect(() =>
      service.defineFeature({
        key: 'bad-percentage',
        updatedBy: 'ops',
        chains: [{ chain: 'stellar-mainnet', percentage: 150 }],
      }),
    ).toThrow(/between 0 and 100/);

    expect(() =>
      service.defineFeature({
        key: 'bad-allowlist',
        updatedBy: 'ops',
        chains: [
          {
            chain: 'stellar-mainnet',
            percentage: 10,
            allowlist: ['ok', 'ok'],
          },
        ],
      }),
    ).toThrow(/allowlist entries must be unique/);

    expect(() =>
      service.defineFeature({
        key: 'missing-actor',
        updatedBy: '',
        chains: [{ chain: 'stellar-mainnet', percentage: 0 }],
      }),
    ).toThrow(/updatedBy/);

    expect(() =>
      service.evaluate('soroban-settlement-v2', {
        chain: 'stellar-mainnet',
        subjectId: ' ',
      }),
    ).toThrow(/subjectId/);
  });

  it('rejects duplicate feature definitions', () => {
    expect(() =>
      service.defineFeature({
        key: 'soroban-settlement-v2',
        updatedBy: 'ops',
        chains: [{ chain: 'stellar-mainnet', percentage: 10 }],
      }),
    ).toThrow(/already defined/);
  });
});
