import {
  executeDeploymentPlan,
  validateDeploymentPlan,
} from './deploy-contracts';

const deployerAddress = `0x${'1'.repeat(40)}`;
const plan = {
  chainId: 31337,
  deployerAddress,
  startingNonce: 7,
  deployments: [
    { contractName: 'BridgeConfig', constructorArgs: [] },
    { contractName: 'BridgeOwnable', constructorArgs: [deployerAddress] },
  ],
};

function createContext(overrides: Record<string, unknown> = {}) {
  const deployments: Array<{ nonce: number; address: string }> = [];
  const context = {
    provider: {
      getNetwork: jest.fn().mockResolvedValue({ chainId: 31337n }),
      getTransactionCount: jest.fn().mockResolvedValue(7),
      getCode: jest.fn().mockResolvedValue('0x'),
    },
    signer: { getAddress: jest.fn().mockResolvedValue(deployerAddress) },
    getCreateAddress: jest.fn(
      ({ nonce }: { nonce: number }) =>
        `0x${nonce.toString(16).padStart(40, '0')}`,
    ),
    getContractFactory: jest.fn(async () => ({
      deploy: jest.fn(async (...args: unknown[]) => {
        const transactionOptions = args[args.length - 1] as { nonce: number };
        const address = `0x${transactionOptions.nonce.toString(16).padStart(40, '0')}`;
        deployments.push({ nonce: transactionOptions.nonce, address });
        return {
          waitForDeployment: jest.fn().mockResolvedValue(undefined),
          getAddress: jest.fn().mockResolvedValue(address),
          deploymentTransaction: jest.fn().mockReturnValue({
            hash: `0x${'a'.repeat(64)}`,
            wait: jest.fn().mockResolvedValue({ status: 1 }),
          }),
        };
      }),
    })),
    ...overrides,
  };
  return { context: context as never, deployments };
}

describe('deterministic deployment plans', () => {
  it('accepts a valid plan and deploys each contract at its pinned nonce', async () => {
    const { context, deployments } = createContext();

    const manifest = await executeDeploymentPlan(plan, context);

    expect(deployments.map(({ nonce }) => nonce)).toEqual([7, 8]);
    expect(manifest.deployments.map(({ nonce }) => nonce)).toEqual([7, 8]);
    expect(manifest.deployments[0].address).toBe(`0x${'7'.padStart(40, '0')}`);
    expect(manifest.chainId).toBe(plan.chainId);
  });

  it('rejects invalid chain IDs, nonces, and empty deployment lists', () => {
    expect(() => validateDeploymentPlan({ ...plan, chainId: 0 })).toThrow(
      /chainId/,
    );
    expect(() =>
      validateDeploymentPlan({ ...plan, startingNonce: -1 }),
    ).toThrow(/startingNonce/);
    expect(() => validateDeploymentPlan({ ...plan, deployments: [] })).toThrow(
      /at least one/,
    );
    expect(() =>
      validateDeploymentPlan({
        ...plan,
        startingNonce: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow(/safe integer range/);
  });

  it('refuses a connected chain that does not match the plan', async () => {
    const { context } = createContext({
      provider: { getNetwork: jest.fn().mockResolvedValue({ chainId: 1n }) },
    });

    await expect(executeDeploymentPlan(plan, context)).rejects.toThrow(
      /chain ID/,
    );
  });

  it('refuses a different signer or pending nonce before deploying', async () => {
    const signerContext = createContext({
      signer: {
        getAddress: jest.fn().mockResolvedValue(`0x${'2'.repeat(40)}`),
      },
    });
    await expect(
      executeDeploymentPlan(plan, signerContext.context),
    ).rejects.toThrow(/signer/);

    const nonceContext = createContext({
      provider: {
        getNetwork: jest.fn().mockResolvedValue({ chainId: 31337n }),
        getTransactionCount: jest.fn().mockResolvedValue(8),
        getCode: jest.fn().mockResolvedValue('0x'),
      },
    });
    await expect(
      executeDeploymentPlan(plan, nonceContext.context),
    ).rejects.toThrow(/nonce/);
  });

  it('refuses to deploy over code at any predicted address', async () => {
    const { context } = createContext({
      provider: {
        getNetwork: jest.fn().mockResolvedValue({ chainId: 31337n }),
        getTransactionCount: jest.fn().mockResolvedValue(7),
        getCode: jest.fn().mockResolvedValue('0x6000'),
      },
    });

    await expect(executeDeploymentPlan(plan, context)).rejects.toThrow(
      /already contains code/,
    );
    expect((context as any).getContractFactory).not.toHaveBeenCalled();
  });

  it('reports confirmed deployments when a later deployment fails', async () => {
    const { context } = createContext({
      getContractFactory: jest
        .fn()
        .mockResolvedValueOnce({
          deploy: jest.fn().mockResolvedValue({
            waitForDeployment: jest.fn().mockResolvedValue(undefined),
            getAddress: jest
              .fn()
              .mockResolvedValue(`0x${'7'.padStart(40, '0')}`),
            deploymentTransaction: jest.fn().mockReturnValue({
              hash: `0x${'a'.repeat(64)}`,
              wait: jest.fn().mockResolvedValue({ status: 1 }),
            }),
          }),
        })
        .mockRejectedValueOnce(new Error('simulated deploy failure')),
    });
    const onDeployment = jest.fn();

    await expect(
      executeDeploymentPlan(plan, context, onDeployment),
    ).rejects.toThrow('simulated deploy failure');
    expect(onDeployment).toHaveBeenCalledTimes(1);
    expect(onDeployment.mock.calls[0][1]).toHaveLength(1);
  });
});
