/**
 * Provider Health Score History
 * Tracks health score history for providers over time
 */

export interface HealthScoreEntry {
  providerId: string;
  score: number;
  timestamp: number;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
}

export class ProviderHealthHistory {
  private history: Map<string, HealthScoreEntry[]> = new Map();
  private maxEntriesPerProvider = 1000;

  /**
   * Record a health score for a provider
   */
  recordHealthScore(entry: HealthScoreEntry): void {
    const providerHistory = this.history.get(entry.providerId) || [];

    providerHistory.push(entry);

    // Limit history size
    if (providerHistory.length > this.maxEntriesPerProvider) {
      providerHistory.shift();
    }

    this.history.set(entry.providerId, providerHistory);
  }

  /**
   * Get health history for a specific provider
   */
  getHealthHistory(providerId: string): HealthScoreEntry[] {
    return this.history.get(providerId) || [];
  }

  /**
   * Get health history for a specific time range
   */
  getHealthHistoryInRange(
    providerId: string,
    startTime: number,
    endTime: number,
  ): HealthScoreEntry[] {
    const history = this.getHealthHistory(providerId);
    return history.filter(
      (entry) => entry.timestamp >= startTime && entry.timestamp <= endTime,
    );
  }

  /**
   * Get the most recent health score for a provider
   */
  getLatestHealthScore(providerId: string): HealthScoreEntry | null {
    const history = this.getHealthHistory(providerId);
    return history.length > 0 ? history[history.length - 1] : null;
  }

  /**
   * Calculate average health score for a provider over a time range
   */
  getAverageHealthScore(
    providerId: string,
    startTime: number,
    endTime: number,
  ): number {
    const rangeHistory = this.getHealthHistoryInRange(
      providerId,
      startTime,
      endTime,
    );

    if (rangeHistory.length === 0) {
      return 0;
    }

    const sum = rangeHistory.reduce((acc, entry) => acc + entry.score, 0);
    return sum / rangeHistory.length;
  }

  /**
   * Clear history for a specific provider
   */
  clearProviderHistory(providerId: string): void {
    this.history.delete(providerId);
  }

  /**
   * Clear all history
   */
  clearAllHistory(): void {
    this.history.clear();
  }

  /**
   * Get all provider IDs with history
   */
  getProviderIds(): string[] {
    return Array.from(this.history.keys());
  }
}
