export type EscalationLevel = 'warn' | 'page' | 'manual_intervention';

export interface EscalationPolicy {
  /** Age thresholds in ms, ascending. */
  warnAfterMs: number;
  pageAfterMs: number;
  manualAfterMs: number;
}

export interface TrackedExecution {
  id: string;
  state: string;
  /** Epoch ms when the execution entered its current state. */
  stateSince: number;
}

const ORDER: EscalationLevel[] = ['warn', 'page', 'manual_intervention'];

export function escalationLevelFor(
  execution: TrackedExecution,
  now: number,
  policy: EscalationPolicy,
): EscalationLevel | null {
  const age = now - execution.stateSince;
  if (age >= policy.manualAfterMs) return 'manual_intervention';
  if (age >= policy.pageAfterMs) return 'page';
  if (age >= policy.warnAfterMs) return 'warn';
  return null;
}

export interface Escalation {
  executionId: string;
  level: EscalationLevel;
  ageMs: number;
}

/**
 * Evaluates timers for non-terminal executions and fires each level at most once per
 * (execution, state) so operators are not re-paged on every sweep. Entering a new state resets the timers.
 */
export class StuckTransactionEscalator {
  private readonly fired = new Map<string, number>();

  constructor(
    private readonly policy: EscalationPolicy,
    private readonly terminalStates: ReadonlySet<string> = new Set(['confirmed', 'failed', 'cancelled']),
  ) {
    if (!(policy.warnAfterMs < policy.pageAfterMs && policy.pageAfterMs < policy.manualAfterMs)) {
      throw new Error('escalation thresholds must be strictly ascending');
    }
  }

  sweep(executions: TrackedExecution[], now: number): Escalation[] {
    const out: Escalation[] = [];
    for (const execution of executions) {
      if (this.terminalStates.has(execution.state)) continue;
      const level = escalationLevelFor(execution, now, this.policy);
      if (!level) continue;
      const key = `${execution.id}:${execution.state}:${execution.stateSince}`;
      const reached = ORDER.indexOf(level);
      if ((this.fired.get(key) ?? -1) >= reached) continue;
      this.fired.set(key, reached);
      out.push({ executionId: execution.id, level, ageMs: now - execution.stateSince });
    }
    return out;
  }
}
