import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { network } from 'hardhat';
import { ChainAssetAllowlistService } from '../src/config/allowlist/chain-asset-allowlist.service';
import { runDeploymentPreflight } from './deployment-preflight';

interface AddressAllowlistFile {
  chains: Record<string, string[]>;
}

function loadAllowlist(path: string): ChainAssetAllowlistService {
  const parsed = JSON.parse(
    readFileSync(resolve(path), 'utf8'),
  ) as Partial<AddressAllowlistFile>;
  if (
    !parsed.chains ||
    typeof parsed.chains !== 'object' ||
    Array.isArray(parsed.chains)
  ) {
    throw new Error('Allowlist file must contain a chains object');
  }

  const allowlist = new ChainAssetAllowlistService({ loadDefaults: false });
  for (const [chainId, addresses] of Object.entries(parsed.chains)) {
    if (!/^[1-9][0-9]*$/.test(chainId) || !Array.isArray(addresses)) {
      throw new Error(
        'Allowlist chains must map numeric chain IDs to address arrays',
      );
    }
    allowlist.addSupportedChain({
      chainId,
      name: `EVM chain ${chainId}`,
      type: 'EVM',
      isMainnet: false,
      enabled: true,
    });
    for (const address of addresses)
      allowlist.addApprovedContract(chainId, address);
  }
  return allowlist;
}

export async function main(): Promise<void> {
  const planPath = process.env.DEPLOYMENT_PREFLIGHT_PLAN_PATH;
  const allowlistPath = process.env.DEPLOYMENT_ALLOWLIST_PATH;
  const deployerAddress = process.env.DEPLOYMENT_DEPLOYER_ADDRESS;
  if (!planPath || !allowlistPath || !deployerAddress) {
    throw new Error(
      'Set DEPLOYMENT_PREFLIGHT_PLAN_PATH, DEPLOYMENT_ALLOWLIST_PATH, and DEPLOYMENT_DEPLOYER_ADDRESS',
    );
  }

  const plan = JSON.parse(readFileSync(resolve(planPath), 'utf8'));
  const allowlist = loadAllowlist(allowlistPath);
  const connection = await network.getOrCreate();
  const report = await runDeploymentPreflight(plan, {
    provider: connection.ethers.provider,
    allowlist,
    configuredDeployerAddress: deployerAddress,
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
