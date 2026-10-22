import {
  STELLAR_NETWORK_PASSPHRASES,
  StellarEnvelopeRpcClient,
  StellarTransactionEnvelopeSizeLimiter,
} from '../../../../src/stellar/transactions/envelope';
import {
  StellarSimulationResponse,
  StellarTransactionSimulationChecker,
} from '../../../../src/stellar/transactions/simulation';

const TESTNET_PASSPHRASE = STELLAR_NETWORK_PASSPHRASES.testnet;

function createLimiter() {
  return new StellarTransactionEnvelopeSizeLimiter({
    policies: [
      {
        network: 'stellar-testnet',
        networkPassphrase: TESTNET_PASSPHRASE,
        maxEnvelopeBytes: 100 * 1024,
        warningThresholdBytes: 90 * 1024,
      },
    ],
  });
}

function simulationResponse(
  overrides: Partial<StellarSimulationResponse> = {},
): StellarSimulationResponse {
  return {
    success: true,
    feeCharged: 500,
    resourceUsage: {
      cpuInstructions: 10_000,
      memoryBytes: 2_048,
      readBytes: 512,
      writeBytes: 256,
    },
    ...overrides,
  };
}

describe('Stellar envelope limits with the RPC boundary', () => {
  it('accepts an envelope when the RPC passphrase matches the policy', async () => {
    const limiter = createLimiter();
    const rpc: StellarEnvelopeRpcClient = {
      getNetworkPassphrase: jest.fn().mockResolvedValue(TESTNET_PASSPHRASE),
    };

    const result = await limiter.checkWithRpc(
      { network: 'stellar-testnet', envelopeBytes: 4_096, operationCount: 1 },
      rpc,
    );

    expect(result.allowed).toBe(true);
    expect(result.network).toBe('stellar-testnet');
    expect(rpc.getNetworkPassphrase).toHaveBeenCalledTimes(1);
  });

  it('denies when the RPC reports a different network passphrase', async () => {
    const limiter = createLimiter();
    const rpc: StellarEnvelopeRpcClient = {
      getNetworkPassphrase: jest
        .fn()
        .mockResolvedValue(STELLAR_NETWORK_PASSPHRASES.public),
    };

    const result = await limiter.checkWithRpc(
      { network: 'stellar-testnet', envelopeBytes: 4_096 },
      rpc,
    );

    expect(result.allowed).toBe(false);
    expect(result.violations.map((item) => item.code)).toContain(
      'NETWORK_PASSPHRASE_MISMATCH',
    );
  });

  it('fails closed when the RPC request throws', async () => {
    const limiter = createLimiter();
    const rpc: StellarEnvelopeRpcClient = {
      getNetworkPassphrase: jest
        .fn()
        .mockRejectedValue(new Error('connection refused')),
    };

    const result = await limiter.checkWithRpc(
      { network: 'stellar-testnet', envelopeBytes: 4_096 },
      rpc,
    );

    expect(result.allowed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].code).toBe('RPC_UNAVAILABLE');
    expect(limiter.getMetrics().rpcFailures).toBe(1);
  });

  it('can proceed with a warning when onRpcFailure is allow', async () => {
    const limiter = new StellarTransactionEnvelopeSizeLimiter({
      policies: [
        {
          network: 'stellar-testnet',
          networkPassphrase: TESTNET_PASSPHRASE,
          maxEnvelopeBytes: 1_024,
        },
      ],
      onRpcFailure: 'allow',
    });
    const rpc: StellarEnvelopeRpcClient = {
      getNetworkPassphrase: jest.fn().mockRejectedValue(new Error('timeout')),
    };

    const result = await limiter.checkWithRpc(
      {
        network: 'stellar-testnet',
        networkPassphrase: TESTNET_PASSPHRASE,
        envelopeBytes: 512,
      },
      rpc,
    );

    expect(result.allowed).toBe(true);
    expect(result.violations.map((item) => item.code)).toEqual([
      'NETWORK_UNVERIFIED',
    ]);
  });

  it('rejects non-string and malformed RPC passphrase responses', async () => {
    const limiter = createLimiter();

    for (const response of [42, '', 'x'.repeat(1_000), null]) {
      const result = await limiter.checkWithRpc(
        { network: 'stellar-testnet', envelopeBytes: 512 },
        { getNetworkPassphrase: async () => response },
      );

      expect(result.allowed).toBe(false);
      expect(result.violations.map((item) => item.code)).toContain(
        'RPC_RESPONSE_INVALID',
      );
    }

    expect(limiter.getMetrics().rpcFailures).toBe(4);
  });
});

describe('Stellar envelope limits with the simulation boundary', () => {
  it('rejects an envelope whose simulation failed', async () => {
    const limiter = createLimiter();
    const checker = new StellarTransactionSimulationChecker();
    const simulation = checker.check(
      simulationResponse({ success: false, error: 'HostError' }),
    );

    const result = await limiter.checkWithRpc(
      {
        network: 'stellar-testnet',
        envelopeXdr: Buffer.alloc(1_024).toString('base64'),
        simulation,
      },
      { getNetworkPassphrase: async () => TESTNET_PASSPHRASE },
    );

    expect(result.allowed).toBe(false);
    expect(result.violations.map((item) => item.code)).toContain(
      'SIMULATION_REJECTED',
    );
    expect(result.violations[0].message).toContain('SIMULATION_FAILED');
  });

  it('accepts an envelope whose simulation is within every budget', async () => {
    const limiter = createLimiter();
    const checker = new StellarTransactionSimulationChecker();
    const simulation = checker.check(simulationResponse());

    const result = await limiter.checkWithRpc(
      {
        network: 'stellar-testnet',
        envelopeXdr: Buffer.alloc(1_024).toString('base64'),
        operationCount: 2,
        sequence: '77',
        simulation,
      },
      { getNetworkPassphrase: async () => TESTNET_PASSPHRASE },
    );

    expect(result.allowed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});
