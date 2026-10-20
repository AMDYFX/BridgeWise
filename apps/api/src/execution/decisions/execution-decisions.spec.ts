import { evaluateCompensation, FailedExecution } from './compensation-eligibility';
import { ExecutionDecisionLog, canonicalize } from './decision-audit-log';
import { decideAfterTimeout } from './timeout-recovery';
import { FaultInjector, SimulatedChain } from './fault-injection';

const failed = (over: Partial<FailedExecution> = {}): FailedExecution => ({
  id: 'e1',
  state: 'failed',
  sourceDebited: true,
  destinationNotExecuted: true,
  alreadyCompensated: false,
  quarantined: false,
  sourceAmount: 1_000n,
  nonRefundableFee: 25n,
  failedAt: 0,
  ...over,
});
const policy = { claimWindowMs: 10_000 };

describe('compensation eligibility', () => {
  it('refunds the amount minus non-refundable fees when every rule passes', () => {
    expect(evaluateCompensation(failed(), 5_000, policy)).toEqual({ eligible: true, reasons: [], refundAmount: 975n });
  });

  it('reports every failed rule', () => {
    const decision = evaluateCompensation(
      failed({ state: 'submitted', sourceDebited: false, destinationNotExecuted: false, alreadyCompensated: true, quarantined: true }),
      20_000,
      policy,
    );
    expect(decision.eligible).toBe(false);
    expect(decision.refundAmount).toBe(0n);
    expect(decision.reasons).toEqual([
      'not_failed',
      'source_not_debited',
      'destination_outcome_not_proven',
      'already_compensated',
      'quarantined',
      'window_expired',
    ]);
  });

  it('refuses when fees consume the whole amount', () => {
    expect(evaluateCompensation(failed({ nonRefundableFee: 1_000n }), 0, policy).reasons).toEqual(['nothing_to_refund']);
  });
});

describe('execution decision audit log', () => {
  it('records redacted, hashed, frozen inputs in order', () => {
    const log = new ExecutionDecisionLog(() => 9);
    const record = log.record('e1', 'route_selected', { route: 'eth->stellar', apiKey: 'sk_live_123', nested: { signature: 'abc', fee: 5n } });
    log.record('e2', 'retry', {});
    log.record('e1', 'refund_held', { reason: 'review' });

    expect(record.inputs).toEqual({ route: 'eth->stellar', apiKey: '[REDACTED]', nested: { signature: '[REDACTED]', fee: '5' } });
    expect(JSON.stringify(record)).not.toContain('sk_live_123');
    expect(Object.isFrozen(record)).toBe(true);
    expect(log.forExecution('e1').map((r) => r.decision)).toEqual(['route_selected', 'refund_held']);
    expect(log.verify(record)).toBe(true);
    expect(log.verify({ ...record, inputs: { route: 'tampered' } })).toBe(false);
  });

  it('hashes equal inputs equally regardless of key order', () => {
    const log = new ExecutionDecisionLog();
    expect(log.record('e', 'd', { a: 1, b: 2 }).inputsHash).toBe(log.record('e', 'd', { b: 2, a: 1 }).inputsHash);
    expect(canonicalize({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });
});

describe('timeout recovery', () => {
  const base = { submissionAttempted: true, elapsedMs: 1_000, safeAbsenceWindowMs: 60_000, maxRecoveryMs: 600_000 };

  it('never resubmits while the outcome is uncertain', () => {
    expect(decideAfterTimeout({ ...base, lookup: 'unknown' })).toBe('poll_again');
    expect(decideAfterTimeout({ ...base, lookup: 'not_found' })).toBe('poll_again');
    expect(decideAfterTimeout({ ...base, lookup: 'found' })).toBe('await_confirmation');
  });

  it('resubmits only when nothing was sent or the tx is definitively absent past the safe window', () => {
    expect(decideAfterTimeout({ ...base, submissionAttempted: false, lookup: 'unknown' })).toBe('resubmit');
    expect(decideAfterTimeout({ ...base, lookup: 'not_found', elapsedMs: 60_000 })).toBe('resubmit');
    expect(decideAfterTimeout({ ...base, lookup: 'unknown', elapsedMs: 60_000 })).toBe('poll_again');
    expect(decideAfterTimeout({ ...base, lookup: 'unknown', elapsedMs: 600_000 })).toBe('manual_review');
  });
});

describe('deterministic fault injection', () => {
  /** Executor under test: submit, and on timeout consult the chain before ever resubmitting. */
  function execute(chain: SimulatedChain, key: string, maxAttempts = 5): string {
    let elapsed = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = chain.submit(key);
      if (result === 'confirmed') return 'confirmed';
      if (result === 'error') continue; // failed before sending: safe to retry
      elapsed += 60_000;
      const action = decideAfterTimeout({
        submissionAttempted: true,
        lookup: chain.lookup(key),
        elapsedMs: elapsed,
        safeAbsenceWindowMs: 60_000,
        maxRecoveryMs: 600_000,
      });
      if (action === 'await_confirmation') return 'confirmed';
      if (action === 'manual_review') return 'manual_review';
    }
    return 'gave_up';
  }

  it('timeout after send does not produce a second submission', () => {
    const chain = new SimulatedChain(new FaultInjector({ submit: ['timeout_after_send'] }));
    expect(execute(chain, 'tx-1')).toBe('confirmed');
    expect(chain.landed.get('tx-1')).toBe(1);
  });

  it('a dropped request is resubmitted exactly once to land', () => {
    const chain = new SimulatedChain(new FaultInjector({ submit: ['drop'] }));
    expect(execute(chain, 'tx-2')).toBe('confirmed');
    expect(chain.landed.get('tx-2')).toBe(1);
  });

  it('errors before send are retried without duplicates, and the plan is reproducible', () => {
    const run = () => {
      const chain = new SimulatedChain(new FaultInjector({ submit: ['error_before_send', 'error_before_send', 'timeout_after_send'] }));
      return [execute(chain, 'tx-3'), chain.landed.get('tx-3')];
    };
    expect(run()).toEqual(['confirmed', 1]);
    expect(run()).toEqual(run());
  });
});
