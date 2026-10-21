export class SlippageExceededError extends Error {
  constructor(message = 'Simulation failed: Slippage threshold exceeded') {
    super(message);
    this.name = 'SlippageExceededError';
  }
}

export class InsufficientFootprintError extends Error {
  constructor(message = 'Simulation failed: Insufficient ledger footprint key authorization') {
    super(message);
    this.name = 'InsufficientFootprintError';
  }
}

export class SimulationRevertError extends Error {
  public readonly revertCode?: string | number;
  constructor(message = 'Simulation reverted', revertCode?: string | number) {
    super(message);
    this.name = 'SimulationRevertError';
    this.revertCode = revertCode;
  }
}

export class ResourceFeeCeilingExceededError extends Error {
  public readonly network: string;
  public readonly resourceFeeStroops: number;
  public readonly ceilingStroops: number;
  constructor(
    network: string,
    resourceFeeStroops: number,
    ceilingStroops: number,
    message = `Soroban resource fee ${resourceFeeStroops} stroops exceeds ceiling ${ceilingStroops} stroops for network "${network}"`,
  ) {
    super(message);
    this.name = 'ResourceFeeCeilingExceededError';
    this.network = network;
    this.resourceFeeStroops = resourceFeeStroops;
    this.ceilingStroops = ceilingStroops;
  }
}

export interface SorobanSimOptions {
  rpcUrl: string;
  expectedMinOutput?: string;
  maxSlippagePercent?: number;
  expectedFootprintKeys?: string[];
  /** Network identifier for resource fee ceiling enforcement (e.g. "stellar-testnet"). */
  network?: string;
  /** Optional ceiling service for enforcing resource fee limits. */
  ceilingService?: {
    check: (request: { network: string; resourceFeeStroops: number }) => {
      allowed: boolean;
      ceilingStroops: number | null;
      violations: Array<{ code: string; message: string }>;
    };
  };
}

export interface SorobanSimulationResult {
  successful: boolean;
  minResourceFee: string;
  sorobanData?: {
    auth?: any[];
    resources?: {
      footprint?: {
        readOnly?: string[];
        readWrite?: string[];
      };
    };
  };
  simulatedOutput?: string;
  error?: string;
}
