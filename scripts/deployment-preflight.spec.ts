import { runDeploymentPreflight, validatePlan } from './deployment-preflight';

const deployerAddress = `0x${'1'.repeat(40)}`;
const dependencyAddress = `0x${'2'.repeat(40)}`;
const plan = {
  chainId: 31337,
  deployerAddress,
  expectedNonce: 7,
  minimumBalanceWei: '1000',
  requiredContracts: [{ name: 'bridgeRouter', address: dependencyAddress }],
};

function createContext(overrides: Record<string, unknown> = {}) {
  return {
    provider: {
      getNetwork: jest.fn().mockResolvedValue({ chainId: 31337n }),
      getBalance: jest.fn().mockResolvedValue(1000n),
      getTransactionCount: jest.fn().mockResolvedValue(7),
      getCode: jest.fn().mockResolvedValue('0x6000'),
    },
    allowlist: { isContractApproved: jest.fn().mockReturnValue(true) },
    configuredDeployerAddress: deployerAddress,
    now: () => 1234,
    ...overrides,
  };
}

describe('deployment preflight', () => {
  it('passes all checks for a ready deployment', async () => {
    const report = await runDeploymentPreflight(plan, createContext() as never);

    expect(report.passed).toBe(true);
    expect(report.checkedAt).toBe(1234);
    expect(report.checks.every((check) => check.status === 'passed')).toBe(
      true,
    );
  });

  it('fails closed when chain, deployer, balance, or nonce do not match', async () => {
    const context = createContext({
      configuredDeployerAddress: `0x${'3'.repeat(40)}`,
      provider: {
        getNetwork: jest.fn().mockResolvedValue({ chainId: 1n }),
        getBalance: jest.fn().mockResolvedValue(999n),
        getTransactionCount: jest.fn().mockResolvedValue(8),
        getCode: jest.fn().mockResolvedValue('0x6000'),
      },
    });

    const report = await runDeploymentPreflight(plan, context as never);

    expect(report.passed).toBe(false);
    expect(
      report.checks.filter((check) => check.status === 'failed'),
    ).toHaveLength(4);
  });

  it('requires allowlisted dependencies and deployed code', async () => {
    const context = createContext({
      allowlist: { isContractApproved: jest.fn().mockReturnValue(false) },
    });
    const report = await runDeploymentPreflight(plan, context as never);

    expect(report.passed).toBe(false);
    expect(
      report.checks.find((check) => check.id === 'allowlist:bridgeRouter')
        ?.status,
    ).toBe('failed');
    expect(context.provider.getCode).not.toHaveBeenCalled();

    const noCodeContext = createContext({
      provider: {
        getNetwork: jest.fn().mockResolvedValue({ chainId: 31337n }),
        getBalance: jest.fn().mockResolvedValue(1000n),
        getTransactionCount: jest.fn().mockResolvedValue(7),
        getCode: jest.fn().mockResolvedValue('0x'),
      },
    });
    const noCodeReport = await runDeploymentPreflight(
      plan,
      noCodeContext as never,
    );
    expect(
      noCodeReport.checks.find(
        (check) => check.id === 'contract-code:bridgeRouter',
      )?.status,
    ).toBe('failed');
  });

  it('reports RPC failures without leaking provider error messages', async () => {
    const context = createContext({
      provider: {
        getNetwork: jest
          .fn()
          .mockRejectedValue(new Error('RPC token secret-value')),
        getBalance: jest
          .fn()
          .mockRejectedValue(new Error('RPC token secret-value')),
        getTransactionCount: jest
          .fn()
          .mockRejectedValue(new Error('RPC token secret-value')),
        getCode: jest.fn().mockResolvedValue('0x6000'),
      },
    });
    const report = await runDeploymentPreflight(plan, context as never);

    expect(report.passed).toBe(false);
    expect(JSON.stringify(report)).not.toContain('secret-value');
  });

  it('rejects invalid plan boundaries before querying the provider', async () => {
    const invalidPlan = { ...plan, expectedNonce: -1 };
    const context = createContext();

    expect(() => validatePlan(invalidPlan)).toThrow(/expectedNonce/);
    await expect(
      runDeploymentPreflight(invalidPlan, context as never),
    ).rejects.toThrow(/expectedNonce/);
    expect(context.provider.getNetwork).not.toHaveBeenCalled();
  });
});
