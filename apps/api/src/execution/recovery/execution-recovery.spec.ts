import { RetryBudgetTracker } from './retry-budget';
import { StuckTransactionEscalator, escalationLevelFor } from './stuck-escalation';
import { ExecutionQuarantine, ExecutionQuarantinedError } from './execution-quarantine';
import { DestinationReplayGuard } from './destination-replay-guard';

describe('retry budgets per failure class', () => {
  it('bounds retries, backs off exponentially and caps the delay', () => {
    const tracker = new RetryBudgetTracker();
    const delays = [1, 2, 3, 4, 5].map(() => tracker.consume('e1', 'network'));
    expect(delays.map((d) => d.delayMs)).toEqual([500, 1_000, 2_000, 4_000, 8_000]);
    expect(delays[4]).toMatchObject({ allowed: true, remaining: 0 });
    expect(tracker.consume('e1', 'network')).toMatchObject({ allowed: false, exhausted: true });
  });

  it('keeps classes and executions independent and never retries deterministic failures', () => {
    const tracker = new RetryBudgetTracker();
    expect(tracker.consume('e1', 'validation').allowed).toBe(false);
    expect(tracker.consume('e1', 'insufficient_funds').allowed).toBe(false);
    for (let i = 0; i < 3; i++) tracker.consume('e1', 'timeout');
    expect(tracker.consume('e1', 'timeout').allowed).toBe(false);
    expect(tracker.consume('e1', 'network').allowed).toBe(true);
    expect(tracker.consume('e2', 'timeout').allowed).toBe(true);
  });

  it('can reset an execution once it recovers', () => {
    const tracker = new RetryBudgetTracker();
    for (let i = 0; i < 3; i++) tracker.consume('e1', 'timeout');
    tracker.reset('e1');
    expect(tracker.consume('e1', 'timeout').attempt).toBe(1);
  });
});

describe('stuck transaction escalation timers', () => {
  const policy = { warnAfterMs: 1_000, pageAfterMs: 5_000, manualAfterMs: 10_000 };

  it('maps age to the escalation level', () => {
    const e = { id: 'e', state: 'submitted', stateSince: 0 };
    expect(escalationLevelFor(e, 999, policy)).toBeNull();
    expect(escalationLevelFor(e, 1_000, policy)).toBe('warn');
    expect(escalationLevelFor(e, 5_000, policy)).toBe('page');
    expect(escalationLevelFor(e, 10_000, policy)).toBe('manual_intervention');
  });

  it('fires each level once, skips terminal executions and resets on a new state', () => {
    const escalator = new StuckTransactionEscalator(policy);
    const stuck = { id: 'e', state: 'submitted', stateSince: 0 };
    expect(escalator.sweep([stuck], 1_500).map((x) => x.level)).toEqual(['warn']);
    expect(escalator.sweep([stuck], 2_000)).toEqual([]);
    expect(escalator.sweep([stuck], 6_000).map((x) => x.level)).toEqual(['page']);
    expect(escalator.sweep([stuck], 11_000).map((x) => x.level)).toEqual(['manual_intervention']);
    expect(escalator.sweep([{ ...stuck, state: 'confirmed' }], 50_000)).toEqual([]);
    expect(escalator.sweep([{ ...stuck, state: 'reserved', stateSince: 20_000 }], 21_500).map((x) => x.level)).toEqual(['warn']);
  });

  it('requires ascending thresholds', () => {
    expect(() => new StuckTransactionEscalator({ warnAfterMs: 5, pageAfterMs: 5, manualAfterMs: 9 })).toThrow('ascending');
  });
});

describe('operator-controlled quarantine', () => {
  it('blocks quarantined executions, is idempotent and audited', () => {
    const q = new ExecutionQuarantine(() => 7);
    q.quarantine('e1', 'alice', 'suspicious destination');
    q.quarantine('e1', 'bob', 'duplicate request');
    expect(q.list()).toHaveLength(1);
    expect(() => q.assertNotQuarantined('e1')).toThrow(ExecutionQuarantinedError);
    expect(() => q.assertNotQuarantined('e2')).not.toThrow();
    expect(q.release('e1', 'alice', 'cleared')).toBe(true);
    expect(q.release('e1', 'alice', 'cleared')).toBe(false);
    expect(q.audit.map((a) => a.action)).toEqual(['quarantined', 'released']);
  });

  it('requires an operator and a reason', () => {
    const q = new ExecutionQuarantine();
    expect(() => q.quarantine('e1', '', 'why')).toThrow('required');
    expect(() => q.release('e1', 'op', ' ')).toThrow('required');
  });
});

describe('safe replay of failed destination calls', () => {
  it('replays only proven-not-executed calls with the same payload, within the limit', () => {
    const guard = new DestinationReplayGuard(2);
    guard.recordAttempt('e1', 'stellar', '{"a":1}', 'failed_not_executed');
    expect(guard.requestReplay('e1', 'stellar', '{"a":1}')).toMatchObject({ allowed: true, replaysUsed: 1 });
    expect(guard.requestReplay('e1', 'stellar', '{"a":1}')).toMatchObject({ allowed: true, replaysUsed: 2 });
    expect(guard.requestReplay('e1', 'stellar', '{"a":1}')).toMatchObject({ allowed: false, reason: 'replay_limit' });
  });

  it('never replays executed or unknown outcomes, changed payloads or unknown executions', () => {
    const guard = new DestinationReplayGuard();
    guard.recordAttempt('e1', 'stellar', 'p', 'executed');
    guard.recordAttempt('e2', 'stellar', 'p', 'unknown');
    guard.recordAttempt('e3', 'stellar', 'p', 'failed_not_executed');
    expect(guard.requestReplay('e1', 'stellar', 'p').reason).toBe('already_executed');
    expect(guard.requestReplay('e2', 'stellar', 'p').reason).toBe('outcome_unknown');
    expect(guard.requestReplay('e3', 'stellar', 'tampered').reason).toBe('payload_changed');
    expect(guard.requestReplay('missing', 'stellar', 'p').reason).toBe('not_failed');
  });

  it('keeps destination chains separate', () => {
    const guard = new DestinationReplayGuard();
    guard.recordAttempt('e1', 'stellar', 'p', 'executed');
    guard.recordAttempt('e1', 'ethereum', 'p', 'failed_not_executed');
    expect(guard.requestReplay('e1', 'ethereum', 'p').allowed).toBe(true);
    expect(guard.requestReplay('e1', 'stellar', 'p').allowed).toBe(false);
  });
});
