import { ethers } from 'ethers';

export interface FeeCapConfig {
  maxFeePerGasWei: bigint;       // Global absolute max fee per gas cap (e.g., 200 Gwei)
  maxPriorityFeePerGasWei: bigint; // Max priority tip cap (e.g., 5 Gwei)
  minBumpingPercentage: number;  // Min bump percentage for replacements (EIP-1559 requires >= 10%)
  maxReplacementAttempts: number; // Max replacement tries before operator escalation (e.g., 3)
}

export interface EVMTransactionPayload {
  to: string;
  data: string;
  value: bigint;
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export class EVMTransactionManager {
  private replacementAttempts = new Map<number, number>(); // Nonce -> count

  constructor(
    private readonly provider: ethers.JsonRpcProvider,
    private readonly wallet: ethers.Wallet,
    private readonly config: FeeCapConfig
  ) {}

  /**
   * Enforces fee cap bounds on transaction parameters. (#1316)
   */
  public validateAndCapFees(maxFee: bigint, priorityFee: bigint): { safeMaxFee: bigint; safePriorityFee: bigint } {
    if (maxFee > this.config.maxFeePerGasWei) {
      console.warn(`[FEE_CAP_GUARD] Proposed maxFeePerGas (${ethers.formatUnits(maxFee, 'gwei')} Gwei) exceeds max cap (${ethers.formatUnits(this.config.maxFeePerGasWei, 'gwei')} Gwei). Capping to maximum allowed.`);
    }

    const safeMaxFee = maxFee > this.config.maxFeePerGasWei ? this.config.maxFeePerGasWei : maxFee;
    const safePriorityFee = priorityFee > this.config.maxPriorityFeePerGasWei ? this.config.maxPriorityFeePerGasWei : priorityFee;

    return { safeMaxFee, safePriorityFee };
  }

  /**
   * Builds and submits a transaction replacement with fee bumping and safeguard checks. (#1316)
   */
  public async submitReplacementTransaction(
    nonce: number,
    originalMaxFee: bigint,
    originalPriorityFee: bigint,
    txPayload: Omit<EVMTransactionPayload, 'nonce' | 'maxFeePerGas' | 'maxPriorityFeePerGas'>
  ): Promise<ethers.TransactionResponse> {
    const attempts = (this.replacementAttempts.get(nonce) || 0) + 1;

    // 1. Guard against infinite replacement loops
    if (attempts > this.config.maxReplacementAttempts) {
      console.error(`[REPLACEMENT_GUARD] Nonce ${nonce} reached maximum replacement attempts (${this.config.maxReplacementAttempts}). Escalating to operator.`);
      throw new Error(`Replacement attempt limit reached for nonce ${nonce}. Operator intervention required.`);
    }

    // 2. Calculate bumped fee (min 10% bump as per EIP-1559)
    const bumpMultiplier = BigInt(100 + this.config.minBumpingPercentage);
    const bumpedMaxFee = (originalMaxFee * bumpMultiplier) / 100n;
    const bumpedPriorityFee = (originalPriorityFee * bumpMultiplier) / 100n;

    // 3. Apply fee caps to bumped values
    const { safeMaxFee, safePriorityFee } = this.validateAndCapFees(bumpedMaxFee, bumpedPriorityFee);

    // Ensure bumped fee is strictly higher than original (EIP-1559 rule)
    if (safeMaxFee <= originalMaxFee) {
      throw new Error(`Bumped max fee (${safeMaxFee}) does not exceed original max fee (${originalMaxFee}) due to cap enforcement.`);
    }

    this.replacementAttempts.set(nonce, attempts);

    const tx: ethers.TransactionRequest = {
      to: txPayload.to,
      data: txPayload.data,
      value: txPayload.value,
      nonce,
      maxFeePerGas: safeMaxFee,
      maxPriorityFeePerGas: safePriorityFee,
      type: 2, // EIP-1559
    };

    console.info(`[TX_REPLACEMENT] Submitting replacement for nonce ${nonce} (Attempt ${attempts}/${this.config.maxReplacementAttempts}) with maxFee: ${ethers.formatUnits(safeMaxFee, 'gwei')} Gwei`);

    return await this.wallet.sendTransaction(tx);
  }
}