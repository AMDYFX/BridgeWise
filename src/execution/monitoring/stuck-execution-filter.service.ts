import {
  ExecutionRecord,
  StuckExecutionFilter,
} from '../types/execution-operations.types';

export class StuckExecutionFilterService {
  private executions = new Map<string, ExecutionRecord>();

  public trackExecution(record: ExecutionRecord): void {
    this.executions.set(record.executionId, record);
  }

  public updateHeartbeat(executionId: string, timestamp = Date.now()): void {
    const record = this.executions.get(executionId);
    if (record) {
      record.lastHeartbeatAt = timestamp;
      record.updatedAt = timestamp;
    }
  }

  public findStuckExecutions(filter: StuckExecutionFilter = {}): ExecutionRecord[] {
    const now = Date.now();
    const thresholdMs = filter.thresholdMs ?? 300000; // default 5 minutes
    const terminalStates = ['completed', 'refunded', 'failed'];

    return Array.from(this.executions.values()).filter((record) => {
      // Must not be in terminal state
      if (terminalStates.includes(record.state)) return false;

      // Check stuck duration
      const duration = now - record.lastHeartbeatAt;
      if (duration < thresholdMs) return false;

      // Filter by route
      if (filter.routeId && record.routeId !== filter.routeId) return false;

      // Filter by source/destination chain
      if (filter.sourceChain && record.sourceChain !== filter.sourceChain) return false;
      if (filter.destinationChain && record.destinationChain !== filter.destinationChain) return false;

      // Filter by reason
      if (filter.stuckReason && record.stuckReason !== filter.stuckReason) return false;

      // Filter by retry count
      if (filter.minRetryCount !== undefined && record.retryCount < filter.minRetryCount) return false;

      return true;
    });
  }

  public clear(): void {
    this.executions.clear();
  }
}
