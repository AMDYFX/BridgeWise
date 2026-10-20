export const EXECUTION_STATES = [
  'created',
  'quoted',
  'reserved',
  'submitted',
  'confirmed',
  'failed',
  'cancelled',
] as const;

export type ExecutionState = (typeof EXECUTION_STATES)[number];

/** Allowed transitions. `submitted` is irreversible: it cannot be cancelled, only confirmed or failed. */
export const TRANSITIONS: Record<ExecutionState, readonly ExecutionState[]> = {
  created: ['quoted', 'cancelled', 'failed'],
  quoted: ['reserved', 'cancelled', 'failed'],
  reserved: ['submitted', 'cancelled', 'failed'],
  submitted: ['confirmed', 'failed'],
  confirmed: [],
  failed: [],
  cancelled: [],
};

export const isTerminal = (state: ExecutionState): boolean => TRANSITIONS[state].length === 0;

export const canTransition = (from: ExecutionState, to: ExecutionState): boolean =>
  TRANSITIONS[from].includes(to);

export interface ExecutionRecord {
  id: string;
  state: ExecutionState;
  /** Incremented on every transition; used for compare-and-set. */
  version: number;
}

export class InvalidTransitionError extends Error {
  constructor(from: ExecutionState, to: ExecutionState) {
    super(`invalid execution transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export class VersionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`version conflict: expected ${expected}, found ${actual}`);
    this.name = 'VersionConflictError';
  }
}

/** Pure compare-and-set transition; a stale `expectedVersion` means another actor already moved the record. */
export function transition(record: ExecutionRecord, to: ExecutionState, expectedVersion: number): ExecutionRecord {
  if (record.version !== expectedVersion) throw new VersionConflictError(expectedVersion, record.version);
  if (!canTransition(record.state, to)) throw new InvalidTransitionError(record.state, to);
  return { ...record, state: to, version: record.version + 1 };
}
