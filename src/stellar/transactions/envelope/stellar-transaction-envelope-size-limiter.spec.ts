import {
  STELLAR_NETWORK_PASSPHRASES,
  StellarEnvelopeAuditEvent,
  StellarEnvelopePolicy,
} from './types';
import {
  StellarTransactionEnvelopeSizeLimiter,
  decodedBase64ByteLength,
  envelopeFingerprint,
} from './stellar-transaction-envelope-size-limiter';

const TESTNET_PASSPHRASE = STELLAR_NETWORK_PASSPHRASES.testnet;

function policy(
  overrides: Partial<StellarEnvelopePolicy> = {},
): StellarEnvelopePolicy {
  return {
    network: 'stellar-testnet',
    networkPassphrase: TESTNET_PASSPHRASE,
    maxEnvelopeBytes: 1_024,
    warningThresholdBytes: 900,
    ...overrides,
  };
}

function limiter(
  config: Partial<
    ConstructorParameters<typeof StellarTransactionEnvelopeSizeLimiter>[0]
  > = {},
) {
  return new StellarTransactionEnvelopeSizeLimiter({
    policies: [policy()],
    ...config,
  });
}

function envelope(bytes: number): string {
  return Buffer.alloc(bytes, 7).toString('base64');
}

describe('StellarTransactionEnvelopeSizeLimiter', () => {
  it('allows a valid envelope with matching passphrase and sequence', () => {
    const subject = limiter();

    const result = subject.check({
      network: 'stellar-testnet',
      networkPassphrase: TESTNET_PASSPHRASE,
      envelopeXdr: envelope(512),
      sequence: '101',
      operationCount: 2,
      memoBytes: 16,
    });

    expect(result.allowed).toBe(true);
    expect(result.envelopeBytes).toBe(512);
    expect(result.limitBytes).toBe(1_024);
    expect(result.utilization).toBe(0.5);
    expect(result.violations).toHaveLength(0);
  });

  it('accepts an envelope exactly at the byte limit', () => {
    const result = limiter().check({
      network: 'stellar-testnet',
      networkPassphrase: TESTNET_PASSPHRASE,
      envelopeBytes: 1_024,
    });

    expect(result.allowed).toBe(true);
    expect(result.utilization).toBe(1);
  });

  it('rejects an envelope one byte over the limit', () => {
    const result = limiter().check({
      network: 'stellar-testnet',
      networkPassphrase: TESTNET_PASSPHRASE,
      envelopeBytes: 1_025,
    });

    expect(result.allowed).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        code: 'ENVELOPE_TOO_LARGE',
        severity: 'error',
        limit: 1_024,
        observed: 1_025,
      }),
    );
  });

  it('warns without blocking at the warning threshold', () => {
    const result = limiter().check({
      network: 'stellar-testnet',
      networkPassphrase: TESTNET_PASSPHRASE,
      envelopeBytes: 900,
    });

    expect(result.allowed).toBe(true);
    expect(result.violations.map((item) => item.code)).toContain(
      'ENVELOPE_NEAR_LIMIT',
    );
  });

  it('decodes base64 XDR into bytes for the size check', () => {
    const result = limiter().check({
      network: 'stellar-testnet',
      networkPassphrase: TESTNET_PASSPHRASE,
      envelopeXdr: envelope(1_025),
    });

    expect(result.envelopeBytes).toBe(1_025);
    expect(result.allowed).toBe(false);
    expect(result.violations.map((item) => item.code)).toContain(
      'ENVELOPE_TOO_LARGE',
    );
  });

  it('rejects malformed, missing, negative, and inconsistent sizes', () => {
    const subject = limiter();

    expect(
      subject
        .check({
          network: 'stellar-testnet',
          networkPassphrase: TESTNET_PASSPHRASE,
          envelopeXdr: 'not base64!',
        })
        .violations.map((item) => item.code),
    ).toContain('INVALID_ENVELOPE_ENCODING');

    expect(
      subject
        .check({
          network: 'stellar-testnet',
          networkPassphrase: TESTNET_PASSPHRASE,
        })
        .violations.map((item) => item.code),
    ).toContain('ENVELOPE_SIZE_MISSING');

    expect(
      subject
        .check({
          network: 'stellar-testnet',
          networkPassphrase: TESTNET_PASSPHRASE,
          envelopeBytes: -1,
        })
        .violations.map((item) => item.code),
    ).toContain('INVALID_ENVELOPE_SIZE');

    expect(
      subject
        .check({
          network: 'stellar-testnet',
          networkPassphrase: TESTNET_PASSPHRASE,
          envelopeXdr: envelope(100),
          envelopeBytes: 200,
        })
        .violations.map((item) => item.code),
    ).toContain('ENVELOPE_SIZE_MISMATCH');
  });

  it('rejects an unknown network by default and allows it when configured', () => {
    const denied = limiter().check({
      network: 'stellar-unknown',
      networkPassphrase: TESTNET_PASSPHRASE,
      envelopeBytes: 100,
    });
    expect(denied.allowed).toBe(false);
    expect(denied.violations[0].code).toBe('NETWORK_NOT_CONFIGURED');

    const allowed = limiter({ allowUnlistedNetworks: true }).check({
      network: 'stellar-unknown',
      envelopeBytes: 100,
    });
    expect(allowed.allowed).toBe(true);
    expect(allowed.violations[0]).toMatchObject({
      code: 'NETWORK_NOT_CONFIGURED',
      severity: 'warning',
    });
  });

  it('enforces the network passphrase identity', () => {
    const subject = limiter();

    expect(
      subject
        .check({
          network: 'stellar-testnet',
          envelopeBytes: 100,
        })
        .violations.map((item) => item.code),
    ).toContain('NETWORK_PASSPHRASE_MISSING');

    expect(
      subject
        .check({
          network: 'stellar-testnet',
          networkPassphrase: STELLAR_NETWORK_PASSPHRASES.public,
          envelopeBytes: 100,
        })
        .violations.map((item) => item.code),
    ).toContain('NETWORK_PASSPHRASE_MISMATCH');

    expect(
      limiter({ requireNetworkPassphrase: false }).check({
        network: 'stellar-testnet',
        envelopeBytes: 100,
      }).allowed,
    ).toBe(true);
  });

  it('normalizes network names and enforces sequence bounds', () => {
    const subject = limiter();

    expect(
      subject.check({
        network: ' Stellar-TestNet ',
        networkPassphrase: TESTNET_PASSPHRASE,
        envelopeBytes: 101,
        sequence: '42',
      }).allowed,
    ).toBe(true);

    expect(
      subject
        .check({
          network: 'stellar-testnet',
          networkPassphrase: TESTNET_PASSPHRASE,
          envelopeBytes: 102,
          sequence: 0,
        })
        .violations.map((item) => item.code),
    ).toContain('SEQUENCE_OUT_OF_RANGE');

    expect(
      subject
        .check({
          network: 'stellar-testnet',
          networkPassphrase: TESTNET_PASSPHRASE,
          envelopeBytes: 103,
          sequence: '9223372036854775808',
        })
        .violations.map((item) => item.code),
    ).toContain('SEQUENCE_OUT_OF_RANGE');

    expect(
      subject
        .check({
          network: 'stellar-testnet',
          networkPassphrase: TESTNET_PASSPHRASE,
          envelopeBytes: 104,
          sequence: '12.5',
        })
        .violations.map((item) => item.code),
    ).toContain('INVALID_SEQUENCE');

    expect(
      subject.check({
        network: 'stellar-testnet',
        networkPassphrase: TESTNET_PASSPHRASE,
        envelopeBytes: 105,
        sequence: '9223372036854775807',
      }).allowed,
    ).toBe(true);
  });

  it('enforces operation, memo, and Soroban data limits', () => {
    const subject = limiter({
      policies: [
        policy({
          maxOperations: 3,
          maxMemoBytes: 4,
          maxSorobanTransactionDataBytes: 64,
        }),
      ],
    });

    const result = subject.check({
      network: 'stellar-testnet',
      networkPassphrase: TESTNET_PASSPHRASE,
      envelopeBytes: 100,
      operationCount: 101,
      memoBytes: 5,
      sorobanTransactionDataBytes: 65,
    });

    expect(result.allowed).toBe(false);
    expect(result.violations.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'TOO_MANY_OPERATIONS',
        'MEMO_TOO_LARGE',
        'SOROBAN_DATA_TOO_LARGE',
      ]),
    );
  });

  it('rejects invalid operation counts', () => {
    for (const operationCount of [0, -1, 1.5]) {
      const result = limiter().check({
        network: 'stellar-testnet',
        networkPassphrase: TESTNET_PASSPHRASE,
        envelopeBytes: 100,
        operationCount,
      });
      expect(result.allowed).toBe(false);
      expect(result.violations.map((item) => item.code)).toContain(
        'INVALID_OPERATION_COUNT',
      );
    }
  });

  it('requires and enforces a successful simulation when configured', () => {
    const subject = limiter({
      policies: [policy({ requireSimulation: true })],
    });

    expect(
      subject
        .check({
          network: 'stellar-testnet',
          networkPassphrase: TESTNET_PASSPHRASE,
          envelopeBytes: 100,
        })
        .violations.map((item) => item.code),
    ).toContain('SIMULATION_REQUIRED');

    const rejected = subject.check({
      network: 'stellar-testnet',
      networkPassphrase: TESTNET_PASSPHRASE,
      envelopeBytes: 100,
      simulation: {
        safeToSubmit: false,
        checks: [
          {
            code: 'SIMULATION_FAILED',
            status: 'failed',
            message: 'HostError',
          },
        ],
      },
    });
    expect(rejected.allowed).toBe(false);
    expect(rejected.violations.map((item) => item.code)).toContain(
      'SIMULATION_REJECTED',
    );

    expect(
      subject.check({
        network: 'stellar-testnet',
        networkPassphrase: TESTNET_PASSPHRASE,
        envelopeBytes: 100,
        simulation: { safeToSubmit: true, checks: [] },
      }).allowed,
    ).toBe(true);
  });

  it('denies a duplicate envelope inside the dedupe window and then expires it', () => {
    let now = 1_000;
    const subject = limiter({ now: () => now, dedupeWindowMs: 50 });
    const request = {
      network: 'stellar-testnet',
      networkPassphrase: TESTNET_PASSPHRASE,
      envelopeBytes: 100,
    };

    expect(subject.check(request).allowed).toBe(true);
    const duplicate = subject.check(request);
    expect(duplicate.allowed).toBe(false);
    expect(duplicate.violations.map((item) => item.code)).toContain(
      'DUPLICATE_ENVELOPE',
    );
    expect(subject.getMetrics().duplicates).toBe(1);

    now += 51;
    expect(subject.check(request).allowed).toBe(true);
  });

  it('returns cached decisions for repeated idempotency keys', () => {
    const subject = limiter();
    const request = {
      network: 'stellar-testnet',
      networkPassphrase: TESTNET_PASSPHRASE,
      envelopeBytes: 100,
      idempotencyKey: 'route-1',
    };

    const first = subject.check(request);
    const second = subject.check({ ...request, envelopeBytes: 5_000 });

    expect(first.allowed).toBe(true);
    expect(second.cached).toBe(true);
    expect(second.allowed).toBe(true);
    expect(subject.getMetrics().evaluations).toBe(1);
  });

  it('records secret-free audit events and actionable metrics', () => {
    const events: StellarEnvelopeAuditEvent[] = [];
    const subject = limiter({
      audit: { record: (event) => events.push(event) },
    });

    subject.check({
      network: 'stellar-testnet',
      networkPassphrase: TESTNET_PASSPHRASE,
      envelopeXdr: envelope(1_025),
      reference: 'quote-9',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      network: 'stellar-testnet',
      decision: 'deny',
      envelopeBytes: 1_025,
      limitBytes: 1_024,
      reference: 'quote-9',
      codes: ['ENVELOPE_TOO_LARGE'],
    });
    expect(JSON.stringify(events[0])).not.toContain('networkPassphrase');
    expect(JSON.stringify(events[0])).not.toContain('envelopeXdr');
    expect(subject.getMetrics()).toEqual({
      evaluations: 1,
      allowed: 0,
      denied: 1,
      duplicates: 0,
      rpcFailures: 0,
    });
  });

  it('reports network status for monitoring', () => {
    const subject = limiter({
      policies: [policy({ maxOperations: 10, requireSimulation: true })],
    });

    expect(subject.getStatus(' Stellar-TestNet ')).toEqual({
      network: 'stellar-testnet',
      limitBytes: 1_024,
      warningThresholdBytes: 900,
      maxOperations: 10,
      requireSimulation: true,
      configured: true,
    });
    expect(subject.getStatus('stellar-mainnet').configured).toBe(false);
  });

  it('rejects invalid policy configuration', () => {
    expect(
      () =>
        new StellarTransactionEnvelopeSizeLimiter({
          policies: [policy({ maxEnvelopeBytes: 0 })],
        }),
    ).toThrow(/maxEnvelopeBytes/);

    expect(
      () =>
        new StellarTransactionEnvelopeSizeLimiter({
          policies: [
            policy(),
            policy({ networkPassphrase: STELLAR_NETWORK_PASSPHRASES.public }),
          ],
        }),
    ).toThrow(/Duplicate envelope policy/);

    expect(
      () =>
        new StellarTransactionEnvelopeSizeLimiter({
          policies: [policy({ warningThresholdBytes: 2_000 })],
        }),
    ).toThrow(/warningThresholdBytes/);
  });

  it('validates strict base64 input and fingerprints deterministically', () => {
    expect(decodedBase64ByteLength(envelope(3))).toBe(3);
    expect(decodedBase64ByteLength('')).toBeNull();
    expect(decodedBase64ByteLength('abc')).toBeNull();
    expect(decodedBase64ByteLength('!!!!')).toBeNull();
    expect(decodedBase64ByteLength('YQ===')).toBeNull();
    expect(envelopeFingerprint('abc')).toBe(envelopeFingerprint('abc'));
    expect(envelopeFingerprint('abc')).not.toBe(envelopeFingerprint('abd'));
  });
});
