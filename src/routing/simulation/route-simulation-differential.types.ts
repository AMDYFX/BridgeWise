/**
 * File: src/routing/simulation/route-simulation-differential.types.ts
 *
 * Types for route simulation differential testing and verification (#1282).
 * Enables comparing simulation outputs across independent simulation engines,
 * analytical pricing models, or live/dry-run RPCs to detect divergence,
 * revert risks, and fee estimation variances.
 */

export interface SimulationExecutionStep {
  stepIndex: number;
  protocol: string;
  action: 'swap' | 'bridge' | 'wrap' | 'unwrap';
  sourceAsset: string;
  targetAsset: string;
  expectedInput: string;
  expectedOutput: string;
  gasEstimate: string;
}

export interface RouteSimulationTarget {
  routeId: string;
  sourceChainId: number;
  destinationChainId: number;
  sourceAsset: string;
  destinationAsset: string;
  inputAmount: string;
  expectedOutputAmount: string;
  steps: SimulationExecutionStep[];
}

export interface EngineSimulationResult {
  engineId: string;
  success: boolean;
  simulatedOutputAmount?: string;
  simulatedGasUnits?: string;
  simulatedFeeAmount?: string;
  revertReason?: string;
  executionDurationMs: number;
  traceHash?: string;
}

export interface SimulationDifferentialConfig {
  maxAllowedOutputDivergenceBps: number; // e.g. 20 bps = 0.20%
  maxAllowedFeeDivergenceBps: number; // e.g. 500 bps = 5.0%
  requireRevertConsensus: boolean; // if true, all engines must agree on success/revert
  minRequiredEngines: number;
}

export type DifferentialStatus =
  | 'MATCH'
  | 'DIVERGENT_OUTPUT'
  | 'DIVERGENT_FEES'
  | 'REVERT_MISMATCH'
  | 'ENGINE_FAILURE'
  | 'INSUFFICIENT_ENGINES';

export interface RouteSimulationDifferentialReport {
  routeId: string;
  status: DifferentialStatus;
  isAcceptable: boolean;
  primaryEngineId: string;
  engineCount: number;
  outputDivergenceBps: number;
  feeDivergenceBps: number;
  engineResults: EngineSimulationResult[];
  diagnosticEvidence: {
    discrepancyDescription?: string;
    agreedOnRevert?: boolean;
    recommendedAction: 'PROCEED' | 'HOLD_FOR_REVIEW' | 'REJECT_ROUTE';
    divergenceDetails?: {
      primaryOutput: string;
      secondaryOutputs: { engineId: string; output: string; deltaBps: number }[];
    };
  };
  evaluatedAt: number;
}

export interface ISimulationEngine {
  readonly engineId: string;
  simulate(route: RouteSimulationTarget): Promise<EngineSimulationResult>;
}
