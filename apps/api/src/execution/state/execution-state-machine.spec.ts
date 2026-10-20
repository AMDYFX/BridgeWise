import {
  EXECUTION_STATES,
  ExecutionRecord,
  InvalidTransitionError,
  TRANSITIONS,
  VersionConflictError,
  canTransition,
  isTerminal,
  transition,
} from './execution-state-machine';

const record = (state: ExecutionRecord['state'] = 'created', version = 0): ExecutionRecord => ({ id: 'x1', state, version });

describe('execution state machine invariants', () => {
  it('has a transition entry for every state and only references known states', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...EXECUTION_STATES].sort());
    for (const targets of Object.values(TRANSITIONS)) {
      for (const t of targets) expect(EXECUTION_STATES).toContain(t);
    }
  });

  it('never allows self transitions and terminal states have no way out', () => {
    for (const s of EXECUTION_STATES) expect(canTransition(s, s)).toBe(false);
    for (const s of ['confirmed', 'failed', 'cancelled'] as const) {
      expect(isTerminal(s)).toBe(true);
      for (const to of EXECUTION_STATES) expect(canTransition(s, to)).toBe(false);
    }
  });

  it('cannot cancel once submission is irreversible', () => {
    expect(canTransition('reserved', 'cancelled')).toBe(true);
    expect(canTransition('submitted', 'cancelled')).toBe(false);
  });

  it('every state is reachable from created and every path ends in a terminal state', () => {
    const seen = new Set<string>(['created']);
    const queue = ['created'] as Array<(typeof EXECUTION_STATES)[number]>;
    while (queue.length) {
      for (const next of TRANSITIONS[queue.shift() as (typeof EXECUTION_STATES)[number]]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...EXECUTION_STATES].sort());
  });

  it('is deterministic: the same inputs always give the same result', () => {
    expect(transition(record('quoted', 2), 'reserved', 2)).toEqual({ id: 'x1', state: 'reserved', version: 3 });
    expect(transition(record('quoted', 2), 'reserved', 2)).toEqual({ id: 'x1', state: 'reserved', version: 3 });
  });

  it('rejects invalid transitions without mutating the record', () => {
    const r = record('confirmed', 4);
    expect(() => transition(r, 'failed', 4)).toThrow(InvalidTransitionError);
    expect(r).toEqual({ id: 'x1', state: 'confirmed', version: 4 });
  });

  it('lets exactly one of two concurrent actors win via compare-and-set', () => {
    const start = record('reserved', 1);
    const winner = transition(start, 'submitted', 1);
    expect(() => transition(start, 'cancelled', 1)).not.toThrow();
    expect(() => transition(winner, 'cancelled', 1)).toThrow(VersionConflictError);
  });
});
