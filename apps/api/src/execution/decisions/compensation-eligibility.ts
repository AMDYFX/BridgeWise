export interface FailedExecution {
  id: string;
  state: string;
  /** Source-chain debit is confirmed on-chain. */
  sourceDebited: boolean;
  /** Destination delivery is proven not to have happened (not merely unknown). */
  destinationNotExecuted: boolean;
  alreadyCompensated: boolean;
  quarantined: boolean;
  sourceAmount: bigint;
  /** Fee that is not refundable (already paid to the network or relayer). */
  nonRefundableFee: bigint;
  failedAt: number;
}

export type IneligibleReason =
  | 'not_failed'
  | 'source_not_debited'
  | 'destination_outcome_not_proven'
  | 'already_compensated'
  | 'quarantined'
  | 'window_expired'
  | 'nothing_to_refund';

export interface CompensationDecision {
  eligible: boolean;
  reasons: IneligibleReason[];
  refundAmount: bigint;
}

export interface CompensationPolicy {
  /** Claims after this long are rejected. */
  claimWindowMs: number;
}

/** Every failed rule is reported so operators see the full picture, not just the first one. */
export function evaluateCompensation(
  execution: FailedExecution,
  now: number,
  policy: CompensationPolicy,
): CompensationDecision {
  const reasons: IneligibleReason[] = [];
  if (execution.state !== 'failed') reasons.push('not_failed');
  if (!execution.sourceDebited) reasons.push('source_not_debited');
  if (!execution.destinationNotExecuted) reasons.push('destination_outcome_not_proven');
  if (execution.alreadyCompensated) reasons.push('already_compensated');
  if (execution.quarantined) reasons.push('quarantined');
  if (now - execution.failedAt > policy.claimWindowMs) reasons.push('window_expired');

  const refundAmount = execution.sourceAmount - execution.nonRefundableFee;
  if (refundAmount <= 0n) reasons.push('nothing_to_refund');

  const eligible = reasons.length === 0;
  return { eligible, reasons, refundAmount: eligible ? refundAmount : 0n };
}
