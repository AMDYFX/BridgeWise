/**
 * Types for Execution Pause, Stuck Filters, Compensation, and Replacement Audit.
 */

export interface RoutePauseRecord {
  routeId: string;
  sourceChain: string;
  destinationChain: string;
  paused: boolean;
  pausedAt?: number;
  pausedBy?: string;
  reason?: string;
}

export interface RoutePauseFilter {
  sourceChain?: string;
  destinationChain?: string;
  pausedOnly?: boolean;
}

export type StuckExecutionReason =
  | 'timeout'
  | 'stalled_relay'
  | 'slippage_exceeded'
  | 'gas_price_spike'
  | 'signature_pending'
  | 'unresponsive_relayer';

export interface ExecutionRecord {
  executionId: string;
  routeId: string;
  sourceChain: string;
  destinationChain: string;
  sourceAddress: string;
  destinationAddress: string;
  amount: string;
  token: string;
  state: string;
  createdAt: number;
  updatedAt: number;
  lastHeartbeatAt: number;
  retryCount: number;
  error?: string;
  stuckReason?: StuckExecutionReason;
}

export interface StuckExecutionFilter {
  thresholdMs?: number;
  routeId?: string;
  sourceChain?: string;
  destinationChain?: string;
  stuckReason?: StuckExecutionReason;
  minRetryCount?: number;
}

export type CompensationType = 'refund' | 'gas_rebate' | 'manual_settlement';
export type CompensationStatus = 'pending' | 'approved' | 'executed' | 'rejected';

export interface CompensationRecord {
  compensationId: string;
  executionId: string;
  recipient: string;
  amount: string;
  token: string;
  type: CompensationType;
  status: CompensationStatus;
  reason: string;
  createdAt: number;
  updatedAt: number;
  approvedBy?: string;
  executedTxHash?: string;
}

export type ReplacementReason =
  | 'speedup'
  | 'cancel'
  | 'gas_increase'
  | 'nonce_retry';

export interface TransactionReplacementRecord {
  replacementId: string;
  executionId: string;
  originalTxHash: string;
  newTxHash: string;
  nonce: number;
  reason: ReplacementReason;
  oldGasPrice: string;
  newGasPrice: string;
  timestamp: number;
  operator?: string;
  confirmed?: boolean;
}
