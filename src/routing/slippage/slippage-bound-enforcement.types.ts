/**
 * File: src/routing/slippage/slippage-bound-enforcement.types.ts
 *
 * Types for slippage bound enforcement (#1283).
 * Enforces minimum, maximum, and per-asset slippage boundaries,
 * verifying minimum output satisfaction without precision loss.
 */

export interface SlippageEnforcementConfig {
  /** Minimum allowable slippage in basis points (e.g., 1 bps = 0.01%). Defaults to 1. */
  minAllowedSlippageBps?: number;
  /** Maximum allowable slippage in basis points (e.g., 500 bps = 5.0%). Defaults to 500. */
  maxAllowedSlippageBps?: number;
  /** Default slippage in basis points if not specified by user. Defaults to 50 (0.5%). */
  defaultSlippageBps?: number;
  /** Asset-specific maximum slippage caps in basis points (e.g. USDC: 50 bps). */
  perAssetMaxSlippageBps?: Record<string, number>;
  /** Whether to strictly enforce expectedOutput - slippage >= minOutputAmount. Defaults to true. */
  strictMinOutputCheck?: boolean;
}

export interface SlippageValidationRequest {
  routeId: string;
  asset: string;
  amountIn?: string;
  expectedOutput: string;
  minOutputAmount: string;
  userToleranceBps?: number;
  simulatedOutput?: string;
  metadata?: Record<string, string>;
}

export type SlippageRejectionCode =
  | 'SLIPPAGE_EXCEEDED'
  | 'SLIPPAGE_BELOW_MINIMUM'
  | 'INVALID_SLIPPAGE_BOUNDS'
  | 'MIN_OUTPUT_NOT_SATISFIED'
  | 'SIMULATED_OUTPUT_BELOW_MIN'
  | 'INVALID_AMOUNT_FORMAT';

export interface SlippageValidationResult {
  routeId: string;
  asset: string;
  valid: boolean;
  effectiveSlippageBps: number;
  effectiveSlippagePercent: number;
  allowedMaxSlippageBps: number;
  minOutputSatisfied: boolean;
  rejectionCode?: SlippageRejectionCode;
  rejectionMessage?: string;
  evaluatedAt: number;
}
