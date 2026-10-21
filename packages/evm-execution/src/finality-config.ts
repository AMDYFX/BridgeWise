import { ethers } from 'ethers';

export interface ChainFinalityRule {
  chainId: number;
  chainName: string;
  requiredConfirmations: number;
  allowsFastLaneFinality: boolean;
  reorgProtectionBlockWindow: number;
}

export const DEFAULT_CHAIN_FINALITY_CONFIGS: Record<number, ChainFinalityRule> = {
  1: {
    chainId: 1,
    chainName: 'Ethereum Mainnet',
    requiredConfirmations: 12, // Standard secure finality (approx 2.4 mins)
    allowsFastLaneFinality: false,
    reorgProtectionBlockWindow: 64,
  },
  42161: {
    chainId: 42161,
    chainName: 'Arbitrum One',
    requiredConfirmations: 1, // L2 instant confirmation with sequencer batching
    allowsFastLaneFinality: true,
    reorgProtectionBlockWindow: 10,
  },
  10: {
    chainId: 10,
    chainName: 'Optimism',
    requiredConfirmations: 1, // L2 instant confirmation
    allowsFastLaneFinality: true,
    reorgProtectionBlockWindow: 10,
  },
  137: {
    chainId: 137,
    chainName: 'Polygon PoS',
    requiredConfirmations: 128, // High reorg susceptibility on Polygon PoS checkpoints
    allowsFastLaneFinality: false,
    reorgProtectionBlockWindow: 256,
  },
};

export class EVMChainFinalityManager {
  private finalityRules = new Map<number, ChainFinalityRule>();

  constructor(customConfigs?: ChainFinalityRule[]) {
    // Load default configs
    for (const [chainId, rule] of Object.entries(DEFAULT_CHAIN_FINALITY_CONFIGS)) {
      this.finalityRules.set(Number(chainId), rule);
    }

    // Override with custom configs if provided
    if (customConfigs) {
      for (const rule of customConfigs) {
        this.finalityRules.set(rule.chainId, rule);
      }
    }
  }

  /**
   * Retrieves the finality rule for a given chain ID. (#1315)
   */
  public getRule(chainId: number): ChainFinalityRule {
    const rule = this.finalityRules.get(chainId);
    if (!rule) {
      throw new Error(`Unsupported chain ID ${chainId} for finality configuration. Fallback not permitted.`);
    }
    return rule;
  }

  /**
   * Validates whether a transaction receipt has achieved required chain-specific confirmations. (#1315)
   */
  public async verifyFinality(
    provider: ethers.JsonRpcProvider,
    chainId: number,
    txHash: string
  ): Promise<{ isFinalized: boolean; currentConfirmations: number; requiredConfirmations: number }> {
    const rule = this.getRule(chainId);
    const receipt = await provider.getTransactionReceipt(txHash);

    if (!receipt || receipt.blockNumber === null) {
      return { isFinalized: false, currentConfirmations: 0, requiredConfirmations: rule.requiredConfirmations };
    }

    const currentBlockNumber = await provider.getBlockNumber();
    const currentConfirmations = currentBlockNumber - receipt.blockNumber + 1;

    const isFinalized = currentConfirmations >= rule.requiredConfirmations;

    if (!isFinalized) {
      console.info(`[FINALITY_PENDING] Chain ${rule.chainName} (ID: ${chainId}) tx ${txHash} has ${currentConfirmations}/${rule.requiredConfirmations} confirmations.`);
    }

    return {
      isFinalized,
      currentConfirmations,
      requiredConfirmations: rule.requiredConfirmations,
    };
  }
}