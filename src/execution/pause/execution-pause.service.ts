import {
  RoutePauseRecord,
  RoutePauseFilter,
} from '../types/execution-operations.types';

export class ExecutionPauseService {
  private routePauses = new Map<string, RoutePauseRecord>();

  public pauseRoute(
    routeId: string,
    sourceChain: string,
    destinationChain: string,
    pausedBy: string,
    reason?: string,
  ): RoutePauseRecord {
    const record: RoutePauseRecord = {
      routeId,
      sourceChain,
      destinationChain,
      paused: true,
      pausedAt: Date.now(),
      pausedBy,
      reason,
    };
    this.routePauses.set(routeId, record);
    return record;
  }

  public resumeRoute(routeId: string): boolean {
    const record = this.routePauses.get(routeId);
    if (!record) return false;
    record.paused = false;
    return true;
  }

  public isRoutePaused(routeId: string): boolean {
    const record = this.routePauses.get(routeId);
    return record?.paused ?? false;
  }

  public getPausedRoutes(filter?: RoutePauseFilter): RoutePauseRecord[] {
    let records = Array.from(this.routePauses.values());
    if (!filter) return records;

    if (filter.pausedOnly !== false) {
      records = records.filter((r) => r.paused);
    }
    if (filter.sourceChain) {
      records = records.filter((r) => r.sourceChain === filter.sourceChain);
    }
    if (filter.destinationChain) {
      records = records.filter(
        (r) => r.destinationChain === filter.destinationChain,
      );
    }
    return records;
  }

  public clear(): void {
    this.routePauses.clear();
  }
}
