import {
  TransactionReplacementRecord,
  ReplacementReason,
} from '../types/execution-operations.types';

export class TransactionReplacementAuditService {
  private replacements = new Map<string, TransactionReplacementRecord[]>();

  public recordReplacement(
    executionId: string,
    originalTxHash: string,
    newTxHash: string,
    nonce: number,
    reason: ReplacementReason,
    oldGasPrice: string,
    newGasPrice: string,
    operator?: string,
  ): TransactionReplacementRecord {
    const replacementId = `rep-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const record: TransactionReplacementRecord = {
      replacementId,
      executionId,
      originalTxHash,
      newTxHash,
      nonce,
      reason,
      oldGasPrice,
      newGasPrice,
      timestamp: Date.now(),
      operator,
      confirmed: false,
    };

    const records = this.replacements.get(executionId) ?? [];
    records.push(record);
    this.replacements.set(executionId, records);
    return record;
  }

  public markConfirmed(executionId: string, replacementId: string): boolean {
    const records = this.replacements.get(executionId);
    if (!records) return false;
    const record = records.find((r) => r.replacementId === replacementId);
    if (!record) return false;
    record.confirmed = true;
    return true;
  }

  public getReplacements(executionId: string): TransactionReplacementRecord[] {
    return this.replacements.get(executionId) ?? [];
  }

  public clear(): void {
    this.replacements.clear();
  }
}
