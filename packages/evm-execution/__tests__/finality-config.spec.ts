import { ethers } from 'ethers';
import { EVMChainFinalityManager, DEFAULT_CHAIN_FINALITY_CONFIGS } from '../src/finality-config';

describe('EVM Execution Chain-Specific Finality Configuration (#1315)', () => {
  let finalityManager: EVMChainFinalityManager;
  let mockProvider: jest.Mocked<ethers.JsonRpcProvider>;

  beforeEach(() => {
    finalityManager = new EVMChainFinalityManager();
    mockProvider = {
      getTransactionReceipt: jest.fn(),
      getBlockNumber: jest.fn(),
    } as any;
  });

  it('should return correct finality rules for Ethereum Mainnet and L2 rollups', () => {
    const ethRule = finalityManager.getRule(1);
    expect(ethRule.requiredConfirmations).toBe(12);
    expect(ethRule.allowsFastLaneFinality).toBe(false);

    const arbRule = finalityManager.getRule(42161);
    expect(arbRule.requiredConfirmations).toBe(1);
    expect(arbRule.allowsFastLaneFinality).toBe(true);
  });

  it('should throw an error for unsupported or unregistered chain IDs', () => {
    expect(() => finalityManager.getRule(999999)).toThrow('Unsupported chain ID 999999');
  });

  it('should confirm transaction finality when current confirmations meet or exceed required threshold', async () => {
    // Transaction mined at block 100, current block is 115 (16 confirmations >= 12 required)
    mockProvider.getTransactionReceipt.mockResolvedValue({ blockNumber: 100 } as any);
    mockProvider.getBlockNumber.mockResolvedValue(115);

    const result = await finalityManager.verifyFinality(mockProvider, 1, '0xmockhash');

    expect(result.isFinalized).toBe(true);
    expect(result.currentConfirmations).toBe(16);
    expect(result.requiredConfirmations).toBe(12);
  });

  it('should report transaction as unfinalized when confirmations are below threshold', async () => {
    // Transaction mined at block 100, current block is 103 (4 confirmations < 12 required)
    mockProvider.getTransactionReceipt.mockResolvedValue({ blockNumber: 100 } as any);
    mockProvider.getBlockNumber.mockResolvedValue(103);

    const result = await finalityManager.verifyFinality(mockProvider, 1, '0xmockhash');

    expect(result.isFinalized).toBe(false);
    expect(result.currentConfirmations).toBe(4);
    expect(result.requiredConfirmations).toBe(12);
  });
});