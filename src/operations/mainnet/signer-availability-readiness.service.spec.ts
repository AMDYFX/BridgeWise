/**
 * File: src/operations/mainnet/signer-availability-readiness.service.spec.ts
 *
 * Deterministic unit tests for signer availability readiness checks (#1379).
 */

import {
  SignerAvailabilityProbe,
  SignerProbeResult,
} from './signer-availability-readiness.types';
import {
  SignerAvailabilityReadinessService,
  SignerReadinessError,
} from './signer-availability-readiness.service';

class FakeProbe implements SignerAvailabilityProbe {
  public calls: Array<{ signerId: string; chain: string }> = [];
  public responses = new Map<string, SignerProbeResult | Error>();
  public hangs = new Set<string>();

  async check(signerId: string, chain: string): Promise<SignerProbeResult> {
    this.calls.push({ signerId, chain });
    if (this.hangs.has(signerId)) {
      return new Promise(() => undefined);
    }
    const response = this.responses.get(signerId);
    if (response instanceof Error) throw response;
    return response ?? { available: true, latencyMs: 10 };
  }
}

describe('SignerAvailabilityReadinessService (#1379)', () => {
  let probe: FakeProbe;
  let now: number;
  let service: SignerAvailabilityReadinessService;

  beforeEach(() => {
    probe = new FakeProbe();
    now = 1_700_000_000_000;
    service = new SignerAvailabilityReadinessService(probe, {
      now: () => now,
      timeoutMs: 50,
    });
    service.registerRequirement({
      chain: 'stellar-mainnet',
      signerIds: ['signer-a', 'signer-b', 'signer-c'],
      minAvailable: 2,
      maxLatencyMs: 200,
    });
  });

  it('reports ready when the quorum is reachable within latency budget', async () => {
    const report = await service.checkChain('stellar-mainnet');

    expect(report.status).toBe('ready');
    expect(report.requiredAvailable).toBe(2);
    expect(report.ready).toBe(3);
    expect(report.unavailable).toBe(0);
    expect(report.reasons).toEqual(['all_requirements_met']);
    expect(report.checkedAt).toBe(now);
    expect(probe.calls).toHaveLength(3);
    expect(probe.calls.every((call) => call.chain === 'stellar-mainnet')).toBe(
      true,
    );
  });

  it('degrades when only slow signers meet the quorum', async () => {
    probe.responses.set('signer-a', { available: true, latencyMs: 500 });
    probe.responses.set('signer-b', { available: true, latencyMs: 500 });
    probe.responses.set('signer-c', { available: true, latencyMs: 10 });

    const report = await service.checkChain('stellar-mainnet');

    expect(report.status).toBe('degraded');
    expect(report.ready).toBe(1);
    expect(report.degraded).toBe(2);
    expect(report.reasons).toContain('signer_latency_exceeded');
  });

  it('is unavailable when reachable signers fall below the quorum', async () => {
    probe.responses.set('signer-a', {
      available: false,
      reasonCode: 'hsm_down',
    });
    probe.responses.set('signer-b', {
      available: false,
      reasonCode: 'hsm_down',
    });

    const report = await service.checkChain('stellar-mainnet');

    expect(report.status).toBe('unavailable');
    expect(report.unavailable).toBe(2);
    expect(report.ready).toBe(1);
    expect(report.reasons).toEqual(
      expect.arrayContaining([
        'below_minimum_available_signers',
        'signer_probe_failed',
      ]),
    );
  });

  it('converts probe exceptions to safe reason codes without failing the chain', async () => {
    probe.responses.set('signer-c', new Error('private key material: secret'));

    const report = await service.checkChain('stellar-mainnet');
    const failed = report.signers.find((s) => s.signerId === 'signer-c');

    expect(report.status).toBe('ready');
    expect(failed?.status).toBe('unavailable');
    expect(failed?.reasonCode).toBe('probe_error');
    expect(JSON.stringify(report)).not.toContain('private key material');
  });

  it('times out a hanging probe instead of blocking readiness', async () => {
    probe.hangs.add('signer-c');

    const report = await service.checkChain('stellar-mainnet', {
      timeoutMs: 5,
    });
    const hanging = report.signers.find((s) => s.signerId === 'signer-c');

    expect(hanging?.reasonCode).toBe('probe_timeout');
    expect(report.status).toBe('ready');
  });

  it('sanitizes unsafe probe reason codes', async () => {
    probe.responses.set('signer-a', {
      available: false,
      reasonCode: 'PRIVATE_KEY=abc123',
    });

    const report = await service.checkChain('stellar-mainnet');
    const signer = report.signers.find((s) => s.signerId === 'signer-a');
    expect(signer?.reasonCode).toBe('unspecified');
  });

  it('assertReady fails closed with the readiness report attached', async () => {
    probe.responses.set('signer-a', { available: false });
    probe.responses.set('signer-b', { available: false });
    probe.responses.set('signer-c', { available: false });

    await expect(service.assertReady('stellar-mainnet')).rejects.toBeInstanceOf(
      SignerReadinessError,
    );

    await expect(service.assertReady('stellar-mainnet')).rejects.toMatchObject({
      chain: 'stellar-mainnet',
      status: 'unavailable',
    });
  });

  it('keeps chain reports isolated and exposes the last report', async () => {
    service.registerRequirement({
      chain: 'ethereum-mainnet',
      signerIds: ['evm-signer'],
      minAvailable: 1,
      maxLatencyMs: 100,
    });
    probe.responses.set('evm-signer', { available: false });

    await service.checkChain('stellar-mainnet');
    const eth = await service.checkChain('ethereum-mainnet');

    expect(eth.status).toBe('unavailable');
    expect(service.isReady('stellar-mainnet')).toBe(true);
    expect(service.isReady('ethereum-mainnet')).toBe(false);
    expect(service.getLastReport('ethereum-mainnet')?.signers).toHaveLength(1);
  });

  it('checks every registered chain', async () => {
    service.registerRequirement({
      chain: 'ethereum-mainnet',
      signerIds: ['evm-signer'],
      minAvailable: 1,
      maxLatencyMs: 100,
    });

    const reports = await service.checkAll();
    expect(reports.map((r) => r.chain).sort()).toEqual([
      'ethereum-mainnet',
      'stellar-mainnet',
    ]);
  });

  it('validates requirements and rejects unknown chains', async () => {
    expect(() =>
      service.registerRequirement({
        chain: '',
        signerIds: ['a'],
        minAvailable: 1,
        maxLatencyMs: 100,
      }),
    ).toThrow(/chain/);

    expect(() =>
      service.registerRequirement({
        chain: 'stellar-mainnet',
        signerIds: [],
        minAvailable: 1,
        maxLatencyMs: 100,
      }),
    ).toThrow(/at least one signer/);

    expect(() =>
      service.registerRequirement({
        chain: 'stellar-mainnet',
        signerIds: ['a', 'a'],
        minAvailable: 1,
        maxLatencyMs: 100,
      }),
    ).toThrow(/unique/);

    expect(() =>
      service.registerRequirement({
        chain: 'stellar-mainnet',
        signerIds: ['a'],
        minAvailable: 2,
        maxLatencyMs: 100,
      }),
    ).toThrow(/cannot exceed/);

    expect(() =>
      service.registerRequirement({
        chain: 'stellar-mainnet',
        signerIds: ['a'],
        minAvailable: 1,
        maxLatencyMs: 0,
      }),
    ).toThrow(/maxLatencyMs/);

    await expect(service.checkChain('unknown-mainnet')).rejects.toThrow(
      /No signer readiness requirement/,
    );
  });

  it('requires a probe implementation at construction time', () => {
    expect(
      () =>
        new SignerAvailabilityReadinessService(
          undefined as unknown as SignerAvailabilityProbe,
        ),
    ).toThrow(/probe is required/);
  });
});
