import { ethers } from 'ethers';

export interface ExpectedSimulationOutcome {
  targetContract: string;
  expectedReturnValue?: string; // Optional expected hex string output
  maxGasEstimateAllowed: bigint;
  allowRevert?: boolean;
}

export interface SimulationMismatchAlert {
  alertType: 'SIMULATION_REVERT' | 'GAS_EXCEEDED_BOUND' | 'RETURN_DATA_MISMATCH';
  chainId: number;
  targetContract: string;
  nonce: number;
  reason: string;
  timestamp: string;
}

export class EVMSimulationGuard {
  constructor(
    private readonly provider: ethers.JsonRpcProvider,
    private readonly chainId: number,
    private readonly alertHandler: (alert: SimulationMismatchAlert) => void
  ) {}

  /**
   * Dry-runs transaction via eth_call and eth_estimateGas prior to signing and broadcasting. (#1318)
   */
  public async simulateAndVerify(
    tx: ethers.TransactionRequest,
    expected: ExpectedSimulationOutcome
  ): Promise<{ success: boolean; gasEstimate: bigint }> {
    const nonce = typeof tx.nonce === 'number' ? tx.nonce : -1;
    const target = tx.to ? tx.to.toString() : expected.targetContract;

    try {
      // 1. Dry run execution via eth_call
      const returnData = await this.provider.call(tx);

      if (expected.expectedReturnValue && returnData !== expected.expectedReturnValue) {
        const alert: SimulationMismatchAlert = {
          alertType: 'RETURN_DATA_MISMATCH',
          chainId: this.chainId,
          targetContract: target,
          nonce,
          reason: `Simulation returned ${returnData}, expected ${expected.expectedReturnValue}`,
          timestamp: new Date().toISOString(),
        };
        this.alertHandler(alert);
        throw new Error(`Simulation return data mismatch on chain ${this.chainId} for target ${target}`);
      }

      // 2. Estimate gas usage
      const gasEstimate = await this.provider.estimateGas(tx);

      if (gasEstimate > expected.maxGasEstimateAllowed) {
        const alert: SimulationMismatchAlert = {
          alertType: 'GAS_EXCEEDED_BOUND',
          chainId: this.chainId,
          targetContract: target,
          nonce,
          reason: `Estimated gas (${gasEstimate}) exceeded max threshold (${expected.maxGasEstimateAllowed})`,
          timestamp: new Date().toISOString(),
        };
        this.alertHandler(alert);
        throw new Error(`Simulation gas estimate (${gasEstimate}) exceeded allowed cap (${expected.maxGasEstimateAllowed})`);
      }

      return { success: true, gasEstimate };
    } catch (error: any) {
      if (error.message?.includes('Simulation')) {
        throw error; // Re-throw custom validation error
      }

      // Handle RPC revert / simulation failure
      const alert: SimulationMismatchAlert = {
        alertType: 'SIMULATION_REVERT',
        chainId: this.chainId,
        targetContract: target,
        nonce,
        reason: error.reason || error.message || 'Execution dry-run reverted on RPC node',
        timestamp: new Date().toISOString(),
      };
      this.alertHandler(alert);

      throw new Error(`Transaction simulation failed on chain ${this.chainId}: ${alert.reason}`);
    }
  }
}