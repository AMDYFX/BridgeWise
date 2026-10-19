/**
 * File: src/routing/deviation/quote-execution-deviation.types.ts
 *
 * Types for tracking quote-to-execution price deviation (#1286).
 * Preserves asset and chain boundaries, enforces idempotency,
 * and provides structured diagnostics for operators.
 */

export type DeviationSeverity =
  | 'favorable'
  | 'neutral'
  | 'acceptable_slippage'
  | 'warning_slippage'
  | 'critical_breach';

export type DeviationActionRequired =
  | 'none'
  | 'log_warning'
  | 'operator_escalation'
  | 'circuit_breaker';

export interface QuoteRecord {
  quoteId: string;
  routeId: string;
  fromChain: string;
  toChain: string;
  fromToken: string;
  toToken: string;
  inputAmount: string;
  expectedOutputAmount: string;
  expectedEffectivePrice?: number;
  maxAllowedSlippageBps?: number;
  quotedAt: number;
  expiresAt: number;
}

export interface ExecutionRecord {
  executionId: string;
  quoteId: string;
  txHash: string;
  replacementTxHash?: string;
  executedOutputAmount: string;
  actualGasOrFeeAmount?: string;
  executedAt: number;
  blockNumber?: number;
  reorgDepth?: number;
  status?: 'submitted' | 'confirmed' | 'failed' | 'replaced' | 'reorg_detected';
}

export interface PriceDeviationReport {
  quoteId: string;
  executionId: string;
  routeId: string;
  fromChain: string;
  toChain: string;
  fromToken: string;
  toToken: string;
  inputAmount: string;
  expectedOutputAmount: string;
  executedOutputAmount: string;
  expectedPrice: number;
  executedPrice: number;
  priceDeviationBps: number;
  percentageDeviation: number;
  severity: DeviationSeverity;
  isAcceptable: boolean;
  actionRequired: DeviationActionRequired;
  txHash: string;
  replacementTxHash?: string;
  reorgDepth?: number;
  timestamp: number;
}

export interface DeviationThresholds {
  acceptableBps: number;
  warningBps: number;
  criticalBps: number;
  maxHardToleranceBps: number;
}

export interface DeviationQueryFilter {
  routeId?: string;
  fromChain?: string;
  toChain?: string;
  fromToken?: string;
  toToken?: string;
  severity?: DeviationSeverity;
  minDeviationBps?: number;
  sinceTimestamp?: number;
}

export interface DeviationMetricsSummary {
  totalTracked: number;
  favorableCount: number;
  acceptableCount: number;
  warningCount: number;
  criticalCount: number;
  averageDeviationBps: number;
  maxDeviationBps: number;
}
