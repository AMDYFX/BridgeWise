import {
  CompensationRecord,
  CompensationType,
} from '../types/execution-operations.types';

export class ExecutionCompensationService {
  private compensations = new Map<string, CompensationRecord>();

  public createRecord(
    executionId: string,
    recipient: string,
    amount: string,
    token: string,
    type: CompensationType,
    reason: string,
  ): CompensationRecord {
    const compensationId = `comp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const record: CompensationRecord = {
      compensationId,
      executionId,
      recipient,
      amount,
      token,
      type,
      status: 'pending',
      reason,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.compensations.set(compensationId, record);
    return record;
  }

  public approveRecord(compensationId: string, approvedBy: string): CompensationRecord | null {
    const record = this.compensations.get(compensationId);
    if (!record || record.status !== 'pending') return null;

    record.status = 'approved';
    record.approvedBy = approvedBy;
    record.updatedAt = Date.now();
    return record;
  }

  public executeCompensation(compensationId: string, executedTxHash: string): CompensationRecord | null {
    const record = this.compensations.get(compensationId);
    if (!record || record.status !== 'approved') return null;

    record.status = 'executed';
    record.executedTxHash = executedTxHash;
    record.updatedAt = Date.now();
    return record;
  }

  public getByExecutionId(executionId: string): CompensationRecord[] {
    return Array.from(this.compensations.values()).filter(
      (c) => c.executionId === executionId,
    );
  }

  public clear(): void {
    this.compensations.clear();
  }
}
