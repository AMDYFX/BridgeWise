import { ethers } from 'ethers';
import { EVMSimulationGuard, SimulationMismatchAlert } from '../src/simulation-guard';

describe('EVM Execution Transaction Simulation Mismatch Alerts (#1318)', () => {
  let simulationGuard: EVMSimulationGuard;
  let mockProvider: jest.Mocked<ethers.JsonRpcProvider>;
  let alertsEmitted: SimulationMismatchAlert[];

  beforeEach(() => {
    alertsEmitted = [];
    mockProvider = {
      call: jest.fn(),
      estimateGas: jest.fn(),
    } as any;

    simulationGuard = new EVMSimulationGuard(
      mockProvider,
      1, // Ethereum Mainnet
      (alert) => alertsEmitted.push(alert)
    );
  });

  it('should successfully pass verification when simulation matches expectations', async () => {
    mockProvider.call.mockResolvedValue('0x0000000000000000000000000000000000000000000000000000000000000001');
    mockProvider.estimateGas.mockResolvedValue(50000n);

    const tx: ethers.TransactionRequest = {
      to: '0x1111111111111111111111111111111111111111',
      data: '0x12345678',
      nonce: 5,
    };

    const res = await simulationGuard.simulateAndVerify(tx, {
      targetContract: '0x1111111111111111111111111111111111111111',
      maxGasEstimateAllowed: 100000n,
    });

    expect(res.success).toBe(true);
    expect(res.gasEstimate).toBe(50000n);
    expect(alertsEmitted).toHaveLength(0);
  });

  it('should emit alert and abort when gas estimate exceeds threshold', async () => {
    mockProvider.call.mockResolvedValue('0x');
    mockProvider.estimateGas.mockResolvedValue(250000n); // Exceeds cap

    const tx: ethers.TransactionRequest = {
      to: '0x1111111111111111111111111111111111111111',
      data: '0x12345678',
      nonce: 6,
    };

    await expect(
      simulationGuard.simulateAndVerify(tx, {
        targetContract: '0x1111111111111111111111111111111111111111',
        maxGasEstimateAllowed: 100000n, // Max allowed is 100k
      })
    ).rejects.toThrow('exceeded allowed cap');

    expect(alertsEmitted).toHaveLength(1);
    expect(alertsEmitted[0].alertType).toBe('GAS_EXCEEDED_BOUND');
    expect(alertsEmitted[0].nonce).toBe(6);
  });

  it('should emit alert and abort when RPC execution dry-run reverts', async () => {
    mockProvider.call.mockRejectedValue(new Error('execution reverted: Insufficient bridge liquidity'));

    const tx: ethers.TransactionRequest = {
      to: '0x1111111111111111111111111111111111111111',
      data: '0x12345678',
      nonce: 7,
    };

    await expect(
      simulationGuard.simulateAndVerify(tx, {
        targetContract: '0x1111111111111111111111111111111111111111',
        maxGasEstimateAllowed: 100000n,
      })
    ).rejects.toThrow('Transaction simulation failed');

    expect(alertsEmitted).toHaveLength(1);
    expect(alertsEmitted[0].alertType).toBe('SIMULATION_REVERT');
    expect(alertsEmitted[0].reason).toContain('Insufficient bridge liquidity');
  });
});