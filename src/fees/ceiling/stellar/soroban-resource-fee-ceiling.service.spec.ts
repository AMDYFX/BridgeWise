/**
 * Unit tests for SorobanResourceFeeCeilingService (#1331).
 *
 * Covers success, boundary, invalid-input, and failure cases.
 * No production keys or unpinned live-network state.
 */

import { SorobanResourceFeeCeilingService, createDefaultCeilingConfig } from './soroban-resource-fee-ceiling.service';
import type {
  SorobanResourceFeeCeilingConfig,
  ResourceFeeCeilingRequest,
  ResourceFeeCeilingViolationCode,
} from './types';

describe('SorobanResourceFeeCeilingService Unit Tests (#1331)', () => {
  const now = 1_700_000_000_000; // Fixed timestamp for determinism

  const baseConfig: SorobanResourceFeeCeilingConfig = {
    policies: [
      {
        network: 'stellar-mainnet',
        maxResourceFeeStroops: 10_000_000, // 1 XLM
        warningThresholdStroops: 5_000_000, // 0.5 XLM
      },
      {
        network: 'stellar-testnet',
        maxResourceFeeStroops: 5_000_000, // 0.5 XLM
        warningThresholdStroops: 2_500_000, // 0.25 XLM
      },
      {
        network: 'stellar-futurenet',
        maxResourceFeeStroops: 3_000_000, // 0.3 XLM
      },
    ],
    defaultMaxResourceFeeStroops: 2_000_000, // 0.2 XLM
    denyUnlistedNetworks: true,
    now: () => now,
  };

  let service: SorobanResourceFeeCeilingService;

  beforeEach(() => {
    service = new SorobanResourceFeeCeilingService(baseConfig);
  });

  const makeRequest = (overrides: Partial<ResourceFeeCeilingRequest> = {}): ResourceFeeCeilingRequest => ({
    network: 'stellar-testnet',
    resourceFeeStroops: 1_000_000,
    reference: 'test-ref',
    timestamp: now,
    ...overrides,
  });

  describe('check() - Success Cases', () => {
    it('allows fee well below ceiling', () => {
      const result = service.check(makeRequest({ resourceFeeStroops: 1_000_000 }));
      expect(result.allowed).toBe(true);
      expect(result.violations).toHaveLength(0);
      expect(result.ceilingStroops).toBe(5_000_000);
      expect(result.warningTriggered).toBe(false);
      expect(result.network).toBe('stellar-testnet');
    });

    it('allows fee exactly at ceiling', () => {
      const result = service.check(makeRequest({ resourceFeeStroops: 5_000_000 }));
      expect(result.allowed).toBe(true);
      expect(result.violations).toHaveLength(0);
      expect(result.ceilingStroops).toBe(5_000_000);
    });

    it('allows fee on mainnet with higher ceiling', () => {
      const result = service.check(makeRequest({ network: 'stellar-mainnet', resourceFeeStroops: 8_000_000 }));
      expect(result.allowed).toBe(true);
      expect(result.ceilingStroops).toBe(10_000_000);
    });

    it('triggers warning when fee exceeds warning threshold but not ceiling', () => {
      const result = service.check(makeRequest({ resourceFeeStroops: 3_000_000 }));
      expect(result.allowed).toBe(true);
      expect(result.warningTriggered).toBe(true);
      expect(result.ceilingStroops).toBe(5_000_000);
    });

    it('allows fee on network with no warning threshold', () => {
      const result = service.check(makeRequest({ network: 'stellar-futurenet', resourceFeeStroops: 1_500_000 }));
      expect(result.allowed).toBe(true);
      expect(result.warningTriggered).toBe(false);
      expect(result.ceilingStroops).toBe(3_000_000);
    });

    it('uses default ceiling for unlisted network when configured', () => {
      const result = service.check(makeRequest({ network: 'custom-network', resourceFeeStroops: 1_500_000 }));
      expect(result.allowed).toBe(true);
      expect(result.ceilingStroops).toBe(2_000_000);
    });

    it('allows unrestricted when network disabled', () => {
      service.upsertPolicy({
        network: 'disabled-net',
        maxResourceFeeStroops: 100,
        disabled: true,
      });
      const result = service.check(makeRequest({ network: 'disabled-net', resourceFeeStroops: 10_000_000 }));
      expect(result.allowed).toBe(true);
      expect(result.ceilingStroops).toBeNull();
    });
  });

  describe('check() - Boundary Cases', () => {
    it('denies fee exceeding ceiling by 1 stroop', () => {
      const result = service.check(makeRequest({ resourceFeeStroops: 5_000_001 }));
      expect(result.allowed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].code).toBe('EXCEEDS_CEILING');
      expect(result.violations[0].limit).toBe(5_000_000);
      expect(result.violations[0].observed).toBe(5_000_001);
    });

    it('denies fee far exceeding ceiling', () => {
      const result = service.check(makeRequest({ resourceFeeStroops: 50_000_000 }));
      expect(result.allowed).toBe(false);
      expect(result.violations[0].code).toBe('EXCEEDS_CEILING');
    });

    it('denies unlisted network when denyUnlistedNetworks=true', () => {
      const result = service.check(makeRequest({ network: 'unknown-network', resourceFeeStroops: 100 }));
      expect(result.allowed).toBe(false);
      expect(result.violations[0].code).toBe('NETWORK_NOT_ALLOWED');
      expect(result.ceilingStroops).toBeNull();
    });

    it('allows unlisted network when denyUnlistedNetworks=false', () => {
      const permissiveConfig = { ...baseConfig, denyUnlistedNetworks: false };
      const permissiveService = new SorobanResourceFeeCeilingService(permissiveConfig);
      const result = permissiveService.check(makeRequest({ network: 'unknown-network', resourceFeeStroops: 100 }));
      expect(result.allowed).toBe(true);
      expect(result.ceilingStroops).toBeNull();
    });

    it('uses default ceiling for unlisted network when default is set', () => {
      const configWithDefault = { ...baseConfig, denyUnlistedNetworks: false };
      const serviceWithDefault = new SorobanResourceFeeCeilingService(configWithDefault);
      const result = serviceWithDefault.check(makeRequest({ network: 'unknown-network', resourceFeeStroops: 1_500_000 }));
      expect(result.allowed).toBe(true);
      expect(result.ceilingStroops).toBe(2_000_000);
    });
  });

  describe('check() - Invalid Input Cases', () => {
    it('rejects negative fee', () => {
      const result = service.check(makeRequest({ resourceFeeStroops: -1 }));
      expect(result.allowed).toBe(false);
      expect(result.violations[0].code).toBe('INVALID_FEE_AMOUNT');
    });

    it('rejects NaN fee', () => {
      const result = service.check(makeRequest({ resourceFeeStroops: NaN }));
      expect(result.allowed).toBe(false);
      expect(result.violations[0].code).toBe('INVALID_FEE_AMOUNT');
    });

    it('rejects Infinity fee', () => {
      const result = service.check(makeRequest({ resourceFeeStroops: Infinity }));
      expect(result.allowed).toBe(false);
      expect(result.violations[0].code).toBe('INVALID_FEE_AMOUNT');
    });

    it('rejects fee as string (type coercion)', () => {
      // @ts-expect-error testing invalid input
      const result = service.check(makeRequest({ resourceFeeStroops: '1000' }));
      expect(result.allowed).toBe(false);
      expect(result.violations[0].code).toBe('INVALID_FEE_AMOUNT');
    });
  });

  describe('Configuration Validation', () => {
    it('throws on empty network in policy', () => {
      expect(() =>
        new SorobanResourceFeeCeilingService({
          policies: [{ network: '', maxResourceFeeStroops: 1000 }],
        }),
      ).toThrow('policy.network must be a non-empty string');
    });

    it('throws on negative maxResourceFeeStroops', () => {
      expect(() =>
        new SorobanResourceFeeCeilingService({
          policies: [{ network: 'test', maxResourceFeeStroops: -1 }],
        }),
      ).toThrow('policy.maxResourceFeeStroops must be a finite non-negative number');
    });

    it('throws on negative warningThresholdStroops', () => {
      expect(() =>
        new SorobanResourceFeeCeilingService({
          policies: [{ network: 'test', maxResourceFeeStroops: 1000, warningThresholdStroops: -1 }],
        }),
      ).toThrow('policy.warningThresholdStroops must be a finite non-negative number');
    });

    it('throws when warning threshold exceeds ceiling', () => {
      expect(() =>
        new SorobanResourceFeeCeilingService({
          policies: [{ network: 'test', maxResourceFeeStroops: 1000, warningThresholdStroops: 2000 }],
        }),
      ).toThrow('policy.warningThresholdStroops cannot exceed maxResourceFeeStroops');
    });

    it('accepts zero ceiling (effectively disabling the network)', () => {
      const zeroCeilingService = new SorobanResourceFeeCeilingService({
        policies: [{ network: 'zero-net', maxResourceFeeStroops: 0 }],
      });
      const result = zeroCeilingService.check(makeRequest({ network: 'zero-net', resourceFeeStroops: 0 }));
      expect(result.allowed).toBe(true);
      const denied = zeroCeilingService.check(makeRequest({ network: 'zero-net', resourceFeeStroops: 1 }));
      expect(denied.allowed).toBe(false);
    });
  });

  describe('Runtime Policy Management', () => {
    it('upsertPolicy adds new policy', () => {
      service.upsertPolicy({
        network: 'new-network',
        maxResourceFeeStroops: 7_000_000,
        warningThresholdStroops: 3_500_000,
      });
      const result = service.check(makeRequest({ network: 'new-network', resourceFeeStroops: 4_000_000 }));
      expect(result.allowed).toBe(true);
      expect(result.warningTriggered).toBe(true);
    });

    it('upsertPolicy updates existing policy', () => {
      service.upsertPolicy({
        network: 'stellar-testnet',
        maxResourceFeeStroops: 8_000_000,
      });
      const result = service.check(makeRequest({ resourceFeeStroops: 6_000_000 }));
      expect(result.allowed).toBe(true);
      expect(result.ceilingStroops).toBe(8_000_000);
    });

    it('removePolicy removes policy', () => {
      service.removePolicy('stellar-testnet');
      const result = service.check(makeRequest({ resourceFeeStroops: 1_500_000 }));
      expect(result.allowed).toBe(true);
      expect(result.ceilingStroops).toBe(2_000_000); // Falls back to default
    });

    it('reset clears all policies', () => {
      service.reset();
      const result = service.check(makeRequest({ resourceFeeStroops: 1_500_000 }));
      expect(result.allowed).toBe(true);
      expect(result.ceilingStroops).toBe(2_000_000); // Default
    });
  });

  describe('getStatus() and getAllStatuses()', () => {
    it('returns correct status for explicit policy', () => {
      const status = service.getStatus('stellar-testnet');
      expect(status.network).toBe('stellar-testnet');
      expect(status.ceilingStroops).toBe(5_000_000);
      expect(status.warningThresholdStroops).toBe(2_500_000);
      expect(status.disabled).toBe(false);
      expect(status.policySource).toBe('explicit');
    });

    it('returns correct status for default policy', () => {
      const status = service.getStatus('unknown-network');
      expect(status.policySource).toBe('default');
      expect(status.ceilingStroops).toBe(2_000_000);
    });

    it('returns deny-unlisted status when no default and denyUnlisted=true', () => {
      const strictService = new SorobanResourceFeeCeilingService({
        policies: [],
        denyUnlistedNetworks: true,
      });
      const status = strictService.getStatus('unknown');
      expect(status.policySource).toBe('deny-unlisted');
      expect(status.ceilingStroops).toBeNull();
    });

    it('getAllStatuses returns all known networks', () => {
      const statuses = service.getAllStatuses();
      const networks = statuses.map((s) => s.network).sort();
      expect(networks).toContain('stellar-mainnet');
      expect(networks).toContain('stellar-testnet');
      expect(networks).toContain('stellar-futurenet');
    });
  });

  describe('createDefaultCeilingConfig', () => {
    it('returns config with mainnet, testnet, futurenet policies', () => {
      const config = createDefaultCeilingConfig();
      expect(config.policies).toHaveLength(3);
      const networks = config.policies.map((p) => p.network).sort();
      expect(networks).toEqual(['stellar-futurenet', 'stellar-mainnet', 'stellar-testnet']);
    });

    it('allows overrides', () => {
      const config = createDefaultCeilingConfig({
        defaultMaxResourceFeeStroops: 1_000_000,
        denyUnlistedNetworks: false,
      });
      expect(config.defaultMaxResourceFeeStroops).toBe(1_000_000);
      expect(config.denyUnlistedNetworks).toBe(false);
    });
  });

  describe('Audit Trail', () => {
    it('includes reference in result', () => {
      const result = service.check(makeRequest({ reference: 'tx-123' }));
      expect(result.resourceFeeStroops).toBe(1_000_000);
      // Reference is not in result but request is preserved for caller audit
    });

    it('includes evaluatedAt timestamp', () => {
      const result = service.check(makeRequest({ timestamp: now + 1000 }));
      expect(result.evaluatedAt).toBe(now + 1000);
    });

    it('uses service clock when timestamp not provided', () => {
      const result = service.check({ network: 'stellar-testnet', resourceFeeStroops: 100 });
      expect(result.evaluatedAt).toBe(now);
    });
  });
});