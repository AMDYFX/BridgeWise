export interface QuarantineEntry {
  executionId: string;
  reason: string;
  quarantinedBy: string;
  at: number;
}

export interface QuarantineAudit {
  at: number;
  action: 'quarantined' | 'released';
  executionId: string;
  operator: string;
  reason: string;
}

export class ExecutionQuarantinedError extends Error {
  constructor(readonly executionId: string) {
    super(`execution ${executionId} is quarantined`);
    this.name = 'ExecutionQuarantinedError';
  }
}

/** Operator-controlled hold: a quarantined execution cannot be submitted, retried or replayed until released. */
export class ExecutionQuarantine {
  private readonly entries = new Map<string, QuarantineEntry>();
  readonly audit: QuarantineAudit[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  quarantine(executionId: string, operator: string, reason: string): QuarantineEntry {
    if (!operator.trim() || !reason.trim()) throw new Error('operator and reason are required');
    const existing = this.entries.get(executionId);
    if (existing) return existing;
    const entry = { executionId, reason, quarantinedBy: operator, at: this.now() };
    this.entries.set(executionId, entry);
    this.audit.push({ at: entry.at, action: 'quarantined', executionId, operator, reason });
    return entry;
  }

  release(executionId: string, operator: string, reason: string): boolean {
    if (!operator.trim() || !reason.trim()) throw new Error('operator and reason are required');
    if (!this.entries.delete(executionId)) return false;
    this.audit.push({ at: this.now(), action: 'released', executionId, operator, reason });
    return true;
  }

  isQuarantined(executionId: string): boolean {
    return this.entries.has(executionId);
  }

  /** Call before any submit/retry/replay. */
  assertNotQuarantined(executionId: string): void {
    if (this.isQuarantined(executionId)) throw new ExecutionQuarantinedError(executionId);
  }

  list(): QuarantineEntry[] {
    return [...this.entries.values()];
  }
}
