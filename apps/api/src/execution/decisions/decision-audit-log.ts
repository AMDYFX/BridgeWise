import { createHash } from 'node:crypto';

export interface DecisionRecord {
  executionId: string;
  decision: string;
  /** Redacted deep copy of the inputs the decision was made from. */
  inputs: Record<string, unknown>;
  /** SHA-256 of the canonical inputs, so later tampering is detectable. */
  inputsHash: string;
  at: number;
}

const SECRET_KEY = /(secret|private|password|token|signature|api[-_]?key|mnemonic)/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[REDACTED]' : redact(v)]),
    );
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/** Stable JSON: object keys sorted so equal inputs always hash equally. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Append-only record of why the system routed, retried, refunded or held an execution. */
export class ExecutionDecisionLog {
  private readonly records: DecisionRecord[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  record(executionId: string, decision: string, inputs: Record<string, unknown>): DecisionRecord {
    const safe = redact(inputs) as Record<string, unknown>;
    const record: DecisionRecord = Object.freeze({
      executionId,
      decision,
      inputs: JSON.parse(canonicalize(safe)) as Record<string, unknown>,
      inputsHash: createHash('sha256').update(canonicalize(safe)).digest('hex'),
      at: this.now(),
    });
    this.records.push(record);
    return record;
  }

  forExecution(executionId: string): DecisionRecord[] {
    return this.records.filter((r) => r.executionId === executionId);
  }

  /** True when the stored inputs still match the hash recorded with them. */
  verify(record: DecisionRecord): boolean {
    return createHash('sha256').update(canonicalize(record.inputs)).digest('hex') === record.inputsHash;
  }
}
