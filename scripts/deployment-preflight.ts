export interface DeploymentPreflightPlan {
  chainId: number;
  deployerAddress: string;
  expectedNonce: number;
  minimumBalanceWei: string;
  requiredContracts: Array<{ name: string; address: string }>;
}

export interface DeploymentPreflightProvider {
  getNetwork(): Promise<{ chainId: bigint }>;
  getBalance(address: string): Promise<bigint>;
  getTransactionCount(address: string, blockTag: 'pending'): Promise<number>;
  getCode(address: string): Promise<string>;
}

export interface ContractAddressApprovalReader {
  isContractApproved(chainId: string | number, address: string): boolean;
}

export interface DeploymentPreflightCheck {
  id: string;
  status: 'passed' | 'failed';
  detail: string;
}

export interface DeploymentPreflightReport {
  checkedAt: number;
  chainId: number;
  deployerAddress: string;
  passed: boolean;
  checks: DeploymentPreflightCheck[];
}

export async function runDeploymentPreflight(
  planInput: unknown,
  context: {
    provider: DeploymentPreflightProvider;
    allowlist: ContractAddressApprovalReader;
    configuredDeployerAddress: string;
    now?: () => number;
  },
): Promise<DeploymentPreflightReport> {
  const plan = validatePlan(planInput);
  const configuredDeployerAddress = normalizeEvmAddress(
    context.configuredDeployerAddress,
    'configuredDeployerAddress',
  );
  const checks: DeploymentPreflightCheck[] = [];
  const addCheck = (id: string, passed: boolean, detail: string): void => {
    checks.push({ id, status: passed ? 'passed' : 'failed', detail });
  };

  try {
    const network = await context.provider.getNetwork();
    addCheck(
      'chain-id',
      network.chainId === BigInt(plan.chainId),
      network.chainId === BigInt(plan.chainId)
        ? `Connected to expected chain ${plan.chainId}`
        : `Connected chain ${network.chainId} does not match expected chain ${plan.chainId}`,
    );
  } catch {
    addCheck(
      'chain-id',
      false,
      'Unable to query chain ID from the configured RPC',
    );
  }

  const deployerMatches =
    configuredDeployerAddress ===
    normalizeEvmAddress(plan.deployerAddress, 'deployerAddress');
  addCheck(
    'deployer-address',
    deployerMatches,
    deployerMatches
      ? 'Configured deployer matches the reviewed plan'
      : 'Configured deployer does not match the reviewed plan',
  );

  try {
    const balance = await context.provider.getBalance(
      configuredDeployerAddress,
    );
    const minimum = BigInt(plan.minimumBalanceWei);
    addCheck(
      'native-balance',
      balance >= minimum,
      balance >= minimum
        ? 'Deployer balance meets the configured minimum'
        : 'Deployer balance is below the configured minimum',
    );
  } catch {
    addCheck(
      'native-balance',
      false,
      'Unable to query deployer balance from the configured RPC',
    );
  }

  try {
    const nonce = await context.provider.getTransactionCount(
      configuredDeployerAddress,
      'pending',
    );
    addCheck(
      'pending-nonce',
      nonce === plan.expectedNonce,
      nonce === plan.expectedNonce
        ? `Pending nonce matches expected nonce ${plan.expectedNonce}`
        : `Pending nonce ${nonce} does not match expected nonce ${plan.expectedNonce}`,
    );
  } catch {
    addCheck(
      'pending-nonce',
      false,
      'Unable to query deployer nonce from the configured RPC',
    );
  }

  for (const contract of plan.requiredContracts) {
    const address = normalizeEvmAddress(
      contract.address,
      `requiredContracts.${contract.name}`,
    );
    let approved = false;
    try {
      approved = context.allowlist.isContractApproved(plan.chainId, address);
    } catch {
      approved = false;
    }

    addCheck(
      `allowlist:${contract.name}`,
      approved,
      approved
        ? `${contract.name} is approved on chain ${plan.chainId}`
        : `${contract.name} is not approved on chain ${plan.chainId}`,
    );
    if (!approved) continue;

    try {
      const code = await context.provider.getCode(address);
      const hasCode = code.length > 2 && !/^0x0*$/i.test(code);
      addCheck(
        `contract-code:${contract.name}`,
        hasCode,
        hasCode
          ? `${contract.name} has deployed runtime code`
          : `${contract.name} has no deployed runtime code`,
      );
    } catch {
      addCheck(
        `contract-code:${contract.name}`,
        false,
        `Unable to query runtime code for ${contract.name}`,
      );
    }
  }

  return {
    checkedAt: (context.now ?? Date.now)(),
    chainId: plan.chainId,
    deployerAddress: configuredDeployerAddress,
    passed: checks.every((check) => check.status === 'passed'),
    checks,
  };
}

export function validatePlan(value: unknown): DeploymentPreflightPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Deployment preflight plan must be a JSON object');
  }
  const plan = value as Partial<DeploymentPreflightPlan>;
  if (!Number.isSafeInteger(plan.chainId) || plan.chainId! < 1) {
    throw new TypeError('chainId must be a positive safe integer');
  }
  normalizeEvmAddress(plan.deployerAddress, 'deployerAddress');
  if (!Number.isSafeInteger(plan.expectedNonce) || plan.expectedNonce! < 0) {
    throw new TypeError('expectedNonce must be a non-negative safe integer');
  }
  if (
    typeof plan.minimumBalanceWei !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(plan.minimumBalanceWei)
  ) {
    throw new TypeError(
      'minimumBalanceWei must be a non-negative integer string',
    );
  }
  if (!Array.isArray(plan.requiredContracts)) {
    throw new TypeError('requiredContracts must be an array');
  }

  const names = new Set<string>();
  for (const contract of plan.requiredContracts) {
    if (
      !contract ||
      typeof contract.name !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(contract.name)
    ) {
      throw new TypeError('Each required contract must have a valid name');
    }
    if (names.has(contract.name)) {
      throw new TypeError(`Duplicate required contract name: ${contract.name}`);
    }
    names.add(contract.name);
    normalizeEvmAddress(contract.address, `requiredContracts.${contract.name}`);
  }

  return plan as DeploymentPreflightPlan;
}

function normalizeEvmAddress(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !/^0x[a-fA-F0-9]{40}$/.test(value) ||
    /^0x0{40}$/i.test(value)
  ) {
    throw new TypeError(`${field} must be a non-zero EVM address`);
  }
  return value.toLowerCase();
}
