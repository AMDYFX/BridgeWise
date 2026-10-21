import { ethers } from 'ethers';
import { EVMTransactionManager, FeeCapConfig } from '../src/transaction-manager';

describe('EVM Execution Fee Cap & Replacement Safeguards (#1316)', () => {
  let txManager: EVMTransactionManager;
  let mockProvider: jest.Mocked<ethers.JsonRpcProvider>;
  let mockWallet: jest.Mocked<ethers.Wallet>;

  const config: FeeCapConfig = {
    maxFeePerGasWei: ethers.parseUnits('100', 'gwei'), // 100 Gwei Max
    maxPriorityFeePerGasWei: ethers.parseUnits('5', 'gwei'), // 5 Gwei Tip Max
    minBumpingPercentage: 15, // 15% bump
    maxReplacementAttempts: 2,
  };

  beforeEach(() => {
    mockProvider = {} as any;
    mockWallet = {
      sendTransaction: jest.fn(),
    } as any;

    txManager = new EVMTransactionManager(mockProvider, mockWallet, config);
  });

  it('should enforce absolute max fee cap when proposed fee exceeds limit', () => {
    const proposedMaxFee = ethers.parseUnits('150', 'gwei');
    const proposedPriorityFee = ethers.parseUnits('10', 'gwei');

    const { safeMaxFee, safePriorityFee } = txManager.validateAndCapFees(proposedMaxFee, proposedPriorityFee);

    expect(safeMaxFee).toEqual(config.maxFeePerGasWei); // Capped to 100 Gwei
    expect(safePriorityFee).toEqual(config.maxPriorityFeePerGasWei); // Capped to 5 Gwei
  });

  it('should allow fee replacement within bounds and bump by minimum percentage', async () => {
    const originalMax = ethers.parseUnits('50', 'gwei');
    const originalPriority = ethers.parseUnits('2', 'gwei');

    mockWallet.sendTransaction.mockResolvedValue({ hash: '0xmockhash123' } as any);

    const txRes = await txManager.submitReplacementTransaction(10, originalMax, originalPriority, {
      to: '0x1111111111111111111111111111111111111111',
      data: '0x',
      value: 0n,
    });

    expect(txRes.hash).toBe('0xmockhash123');
    expect(mockWallet.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        nonce: 10,
        maxFeePerGas: ethers.parseUnits('57.5', 'gwei'), // 50 * 1.15
      })
    );
  });

  it('should throw an error and trigger operator escalation when max replacement attempts are exceeded', async () => {
    const originalMax = ethers.parseUnits('20', 'gwei');
    const originalPriority = ethers.parseUnits('2', 'gwei');

    mockWallet.sendTransaction.mockResolvedValue({ hash: '0xmockhash123' } as any);

    // Attempt 1
    await txManager.submitReplacementTransaction(12, originalMax, originalPriority, {
      to: '0x1111111111111111111111111111111111111111',
      data: '0x',
      value: 0n,
    });

    // Attempt 2
    await txManager.submitReplacementTransaction(12, originalMax, originalPriority, {
      to: '0x1111111111111111111111111111111111111111',
      data: '0x',
      value: 0n,
    });

    // Attempt 3 (Exceeds maxReplacementAttempts = 2)
    await expect(
      txManager.submitReplacementTransaction(12, originalMax, originalPriority, {
        to: '0x1111111111111111111111111111111111111111',
        data: '0x',
        value: 0n,
      })
    ).rejects.toThrow('Replacement attempt limit reached for nonce 12. Operator intervention required.');
  });
});