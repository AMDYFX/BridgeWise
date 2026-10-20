/**
 * Alert Deduplication Service
 * Prevents duplicate alerts for repeated incidents
 */

export interface Alert {
  id: string;
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  source: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface DeduplicationKey {
  type: string;
  source: string;
  fingerprint: string;
}

export class AlertDeduplicationService {
  private recentAlerts = new Map<string, Alert>();
  private deduplicationWindowMs = 5 * 60 * 1000; // 5 minutes default

  /**
   * Generate a fingerprint for an alert to identify duplicates
   */
  private generateFingerprint(alert: Alert): string {
    const normalizedMessage = alert.message.toLowerCase().trim();
    const normalizedMetadata = JSON.stringify(alert.metadata || {});
    return `${normalizedMessage}:${normalizedMetadata}`;
  }

  /**
   * Generate deduplication key for an alert
   */
  private generateDeduplicationKey(alert: Alert): string {
    const fingerprint = this.generateFingerprint(alert);
    return `${alert.type}:${alert.source}:${fingerprint}`;
  }

  /**
   * Check if an alert is a duplicate
   */
  isDuplicate(alert: Alert): boolean {
    const key = this.generateDeduplicationKey(alert);
    const existing = this.recentAlerts.get(key);

    if (!existing) {
      return false;
    }

    // Check if within deduplication window
    const timeDiff = alert.timestamp - existing.timestamp;
    return timeDiff < this.deduplicationWindowMs;
  }

  /**
   * Process an alert, returning true if it's a new alert, false if duplicate
   */
  processAlert(alert: Alert): boolean {
    if (this.isDuplicate(alert)) {
      return false;
    }

    const key = this.generateDeduplicationKey(alert);
    this.recentAlerts.set(key, alert);
    this.cleanupOldAlerts();
    return true;
  }

  /**
   * Clean up alerts outside the deduplication window
   */
  private cleanupOldAlerts(): void {
    const now = Date.now();
    const cutoff = now - this.deduplicationWindowMs;

    for (const [key, alert] of this.recentAlerts.entries()) {
      if (alert.timestamp < cutoff) {
        this.recentAlerts.delete(key);
      }
    }
  }

  /**
   * Set the deduplication window in milliseconds
   */
  setDeduplicationWindow(windowMs: number): void {
    this.deduplicationWindowMs = windowMs;
    this.cleanupOldAlerts();
  }

  /**
   * Get the current deduplication window
   */
  getDeduplicationWindow(): number {
    return this.deduplicationWindowMs;
  }

  /**
   * Get the count of tracked alerts
   */
  getTrackedAlertCount(): number {
    return this.recentAlerts.size;
  }

  /**
   * Clear all tracked alerts
   */
  clearTrackedAlerts(): void {
    this.recentAlerts.clear();
  }

  /**
   * Get recent alerts by type
   */
  getAlertsByType(type: string): Alert[] {
    return Array.from(this.recentAlerts.values()).filter(
      (alert) => alert.type === type,
    );
  }

  /**
   * Get recent alerts by source
   */
  getAlertsBySource(source: string): Alert[] {
    return Array.from(this.recentAlerts.values()).filter(
      (alert) => alert.source === source,
    );
  }
}
