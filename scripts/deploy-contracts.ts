import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface DeploymentPlan {
  chainId: number;
  deployerAddress: string;
  startingNonce: number;
  deployments: Array<{
    contractName: string;
    constructorArgs: unknown[];
  }>;
}

interface DeploymentContext {
  provider: {
    getNetwork(): Promise<{ chainId: bigint }>;
    getTransactionCount(address: string, blockTag: 'pending'): Promise<number>;
    getCode(address: string): Promise<string>;
  };
  signer: {
    getAddress(): Promise<string>;
  };
  getCreateAddress(input: { from: string; nonce: number }): string;
  getContractFactory(
    contractName: string,
    signer: DeploymentContext['signer'],
  ): Promise<{
    deploy(...args: unknown[]): Promise<{
      waitForDeployment(): Promise<void>;
      getAddress(): Promise<string>;
      deploymentTransaction(): {
        hash: string;
        wait(): Promise<{ status: number | null }>;
      } | null;
    }>;
  }>;
}

export function validateDeploymentPlan(value: unknown): DeploymentPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Deployment plan must be a JSON object');
  }

  const plan = value as Partial<DeploymentPlan>;
  if (!Number.isSafeInteger(plan.chainId) || plan.chainId! < 1) {
    throw new Error('Deployment plan chainId must be a positive integer');
  }
  if (
    typeof plan.deployerAddress !== 'string' ||
    !/^0x[a-fA-F0-9]{40}$/.test(plan.deployerAddress)
  ) {
    throw new Error(
      'Deployment plan deployerAddress must be a 20-byte EVM address',
    );
  }
  if (!Number.isSafeInteger(plan.startingNonce) || plan.startingNonce! < 0) {
    throw new Error(
      'Deployment plan startingNonce must be a non-negative integer',
    );
  }
  if (!Array.isArray(plan.deployments) || plan.deployments.length === 0) {
    throw new Error('Deployment plan must include at least one deployment');
  }
  if (
    plan.startingNonce! >
    Number.MAX_SAFE_INTEGER - (plan.deployments.length - 1)
  ) {
    throw new Error(
      'Deployment plan nonce range exceeds the safe integer range',
    );
  }

  for (const deployment of plan.deployments) {
    if (
      !deployment ||
      typeof deployment.contractName !== 'string' ||
      !/^[A-Za-z0-9_]+$/.test(deployment.contractName) ||
      !Array.isArray(deployment.constructorArgs)
    ) {
      throw new Error(
        'Each deployment requires a contractName and constructorArgs array',
      );
    }
  }

  return plan as DeploymentPlan;
}

export async function executeDeploymentPlan(
  planInput: unknown,
  context: DeploymentContext,
  onDeployment?: (
    deployment: {
      contractName: string;
      nonce: number;
      address: string;
      transactionHash: string;
    },
    completed: Array<{
      contractName: string;
      nonce: number;
      address: string;
      transactionHash: string;
    }>,
  ) => void | Promise<void>,
) {
  const plan = validateDeploymentPlan(planInput);
  const network = await context.provider.getNetwork();
  if (network.chainId !== BigInt(plan.chainId)) {
    throw new Error(
      `Connected chain ID ${network.chainId} does not match plan chain ID ${plan.chainId}`,
    );
  }

  const deployerAddress = await context.signer.getAddress();
  if (deployerAddress.toLowerCase() !== plan.deployerAddress.toLowerCase()) {
    throw new Error('Connected signer does not match plan deployerAddress');
  }

  const pendingNonce = await context.provider.getTransactionCount(
    deployerAddress,
    'pending',
  );
  if (pendingNonce !== plan.startingNonce) {
    throw new Error(
      `Pending deployer nonce ${pendingNonce} does not match plan startingNonce ${plan.startingNonce}`,
    );
  }

  const predicted = plan.deployments.map((deployment, index) => ({
    ...deployment,
    nonce: plan.startingNonce + index,
    address: context.getCreateAddress({
      from: deployerAddress,
      nonce: plan.startingNonce + index,
    }),
  }));

  for (const deployment of predicted) {
    if ((await context.provider.getCode(deployment.address)) !== '0x') {
      throw new Error(
        `Predicted deployment address already contains code: ${deployment.address}`,
      );
    }
  }

  const deployments = [];
  for (const deployment of predicted) {
    const factory = await context.getContractFactory(
      deployment.contractName,
      context.signer,
    );
    const contract = await factory.deploy(...deployment.constructorArgs, {
      nonce: deployment.nonce,
    });
    await contract.waitForDeployment();
    const receipt = await contract.deploymentTransaction()?.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(
        `Deployment transaction failed for ${deployment.contractName}`,
      );
    }

    const address = await contract.getAddress();
    if (address.toLowerCase() !== deployment.address.toLowerCase()) {
      throw new Error(
        `Deployed address mismatch for ${deployment.contractName}`,
      );
    }

    const completedDeployment = {
      contractName: deployment.contractName,
      nonce: deployment.nonce,
      address,
      transactionHash: contract.deploymentTransaction()!.hash,
    };
    deployments.push(completedDeployment);
    await onDeployment?.(completedDeployment, [...deployments]);
  }

  return {
    schemaVersion: 1,
    status: 'complete' as const,
    chainId: plan.chainId,
    deployerAddress,
    startingNonce: plan.startingNonce,
    planHash: hashDeploymentPlan(plan),
    deployments,
  };
}

export function hashDeploymentPlan(plan: DeploymentPlan): string {
  return createHash('sha256').update(stableSerialize(plan)).digest('hex');
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function main(): Promise<void> {
  const planPath = process.env.DEPLOYMENT_PLAN_PATH;
  if (!planPath)
    throw new Error(
      'Set DEPLOYMENT_PLAN_PATH to a reviewed deployment plan JSON file',
    );

  const plan = validateDeploymentPlan(
    JSON.parse(readFileSync(resolve(planPath), 'utf8')),
  );
  const planHash = hashDeploymentPlan(plan);
  const manifestPath = resolve(
    process.env.DEPLOYMENT_MANIFEST_PATH ??
      `deployments/${plan.chainId}-${planHash.slice(0, 12)}.json`,
  );
  if (existsSync(manifestPath)) {
    throw new Error(
      `Refusing to overwrite existing deployment manifest: ${manifestPath}`,
    );
  }

  const { network } = await import('hardhat');
  const connection = await network.getOrCreate();
  const [signer] = await connection.ethers.getSigners();
  if (!signer)
    throw new Error(
      'No deployer signer is configured for the selected network',
    );

  const manifest = await executeDeploymentPlan(
    plan,
    {
      provider: connection.ethers.provider,
      signer,
      getCreateAddress: connection.ethers.getCreateAddress,
      getContractFactory: (name, deploymentSigner) =>
        connection.ethers.getContractFactory(
          name,
          deploymentSigner as typeof signer,
        ),
    },
    (_deployment, completed) =>
      writeManifest(manifestPath, {
        schemaVersion: 1,
        status: 'in_progress',
        chainId: plan.chainId,
        deployerAddress: plan.deployerAddress,
        startingNonce: plan.startingNonce,
        planHash,
        deployments: completed,
      }),
  );

  writeManifest(manifestPath, manifest);
  console.log(`Deployment manifest written: ${manifestPath}`);
}

function writeManifest(manifestPath: string, manifest: unknown): void {
  mkdirSync(dirname(manifestPath), { recursive: true });
  const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  renameSync(temporaryPath, manifestPath);
}
