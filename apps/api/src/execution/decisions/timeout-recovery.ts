export type ChainLookup = 'found' | 'not_found' | 'unknown';

export type TimeoutAction =
  | 'resubmit' // proven safe: nothing was submitted or the tx is definitively absent past the safe window
  | 'await_confirmation' // the transaction exists; just wait
  | 'poll_again' // cannot tell yet; check again, never resubmit
  | 'manual_review'; // out of time to decide automatically

export interface TimeoutContext {
  /** Whether a send was ever attempted. */
  submissionAttempted: boolean;
  lookup: ChainLookup;
  /** Time since the submission attempt. */
  elapsedMs: number;
  /** After this long a definitive `not_found` means the tx will not land (e.g. expired/dropped). */
  safeAbsenceWindowMs: number;
  /** Give up automatic recovery after this long. */
  maxRecoveryMs: number;
}

/**
 * Decides what to do after a submission timeout without risking a duplicate: resubmission is allowed only
 * when no send was attempted, or the chain definitively lacks the transaction after the safe window.
 */
export function decideAfterTimeout(ctx: TimeoutContext): TimeoutAction {
  if (!ctx.submissionAttempted) return 'resubmit';
  if (ctx.lookup === 'found') return 'await_confirmation';
  if (ctx.elapsedMs >= ctx.maxRecoveryMs) return 'manual_review';
  if (ctx.lookup === 'not_found' && ctx.elapsedMs >= ctx.safeAbsenceWindowMs) return 'resubmit';
  return 'poll_again';
}
