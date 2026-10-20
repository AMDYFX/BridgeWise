/**
 * Reconciliation Checkpoint Persistence
 * Persists reconciliation checkpoints for recovery and audit
 */

export interface ReconciliationCheckpoint {
  id: string;
  timestamp: number;
  chainId: number;
  blockHeight: number;
  asset: string;
  reportedReserve: string;
  expectedReserve: string;
  status: 'BALANCED' | 'SHORTFALL' | 'SURPLUS' | 'INVALID_DATA';
  difference: string | null;
  tolerance: {
    absolute: string;
    relativeBps: number;
  };
}

export interface CheckpointQueryOptions {
  chainId?: number;
  asset?: string;
  fromTimestamp?: number;
  toTimestamp?: number;
  status?: ReconciliationCheckpoint['status'];
}

export interface CheckpointStorage {
  save(checkpoint: ReconciliationCheckpoint): Promise<void>;
  query(options: CheckpointQueryOptions): Promise<ReconciliationCheckpoint[]>;
  getLatest(chainId: number, asset: string): Promise<ReconciliationCheckpoint | null>;
  delete(id: string): Promise<void>;
  deleteOlderThan(timestamp: number): Promise<number>;
}

/**
 * In-memory checkpoint storage for testing and development
 */
export class InMemoryCheckpointStorage implements CheckpointStorage {
  private readonly checkpoints = new Map<string, ReconciliationCheckpoint>();

  async save(checkpoint: ReconciliationCheckpoint): Promise<void> {
    this.checkpoints.set(checkpoint.id, checkpoint);
  }

  async query(options: CheckpointQueryOptions): Promise<ReconciliationCheckpoint[]> {
    const results: ReconciliationCheckpoint[] = [];

    for (const checkpoint of this.checkpoints.values()) {
      if (options.chainId !== undefined && checkpoint.chainId !== options.chainId) {
        continue;
      }
      if (options.asset !== undefined && checkpoint.asset !== options.asset) {
        continue;
      }
      if (options.fromTimestamp !== undefined && checkpoint.timestamp < options.fromTimestamp) {
        continue;
      }
      if (options.toTimestamp !== undefined && checkpoint.timestamp > options.toTimestamp) {
        continue;
      }
      if (options.status !== undefined && checkpoint.status !== options.status) {
        continue;
      }
      results.push(checkpoint);
    }

    return results.sort((a, b) => a.timestamp - b.timestamp);
  }

  async getLatest(chainId: number, asset: string): Promise<ReconciliationCheckpoint | null> {
    const matching: ReconciliationCheckpoint[] = [];

    for (const checkpoint of this.checkpoints.values()) {
      if (checkpoint.chainId === chainId && checkpoint.asset === asset) {
        matching.push(checkpoint);
      }
    }

    if (matching.length === 0) {
      return null;
    }

    return matching.sort((a, b) => b.timestamp - a.timestamp)[0];
  }

  async delete(id: string): Promise<void> {
    this.checkpoints.delete(id);
  }

  async deleteOlderThan(timestamp: number): Promise<number> {
    let count = 0;

    for (const [id, checkpoint] of this.checkpoints.entries()) {
      if (checkpoint.timestamp < timestamp) {
        this.checkpoints.delete(id);
        count++;
      }
    }

    return count;
  }
}

/**
 * Reconciliation checkpoint manager
 */
export class ReconciliationCheckpointManager {
  constructor(private readonly storage: CheckpointStorage) {}

  /**
   * Save a reconciliation checkpoint
   */
  async saveCheckpoint(checkpoint: ReconciliationCheckpoint): Promise<void> {
    await this.storage.save(checkpoint);
  }

  /**
   * Query checkpoints
   */
  async queryCheckpoints(options: CheckpointQueryOptions): Promise<ReconciliationCheckpoint[]> {
    return this.storage.query(options);
  }

  /**
   * Get the latest checkpoint for a chain and asset
   */
  async getLatestCheckpoint(chainId: number, asset: string): Promise<ReconciliationCheckpoint | null> {
    return this.storage.getLatest(chainId, asset);
  }

  /**
   * Delete a checkpoint
   */
  async deleteCheckpoint(id: string): Promise<void> {
    await this.storage.delete(id);
  }

  /**
   * Delete checkpoints older than a timestamp
   */
  async deleteOldCheckpoints(timestamp: number): Promise<number> {
    return this.storage.deleteOlderThan(timestamp);
  }

  /**
   * Create a checkpoint from reconciliation results
   */
  createCheckpointFromReconciliation(
    id: string,
    chainId: number,
    blockHeight: number,
    asset: string,
    reportedReserve: string,
    expectedReserve: string,
    status: ReconciliationCheckpoint['status'],
    difference: string | null,
    tolerance: { absolute: string; relativeBps: number },
  ): ReconciliationCheckpoint {
    return {
      id,
      timestamp: Date.now(),
      chainId,
      blockHeight,
      asset,
      reportedReserve,
      expectedReserve,
      status,
      difference,
      tolerance,
    };
  }
}
