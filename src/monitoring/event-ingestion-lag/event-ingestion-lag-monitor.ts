/**
 * Event Ingestion Lag Monitor
 * Tracks lag between event occurrence and ingestion for each chain
 */

import { EventEmitter } from 'events';

export interface EventIngestionLagConfig {
  chainId: number;
  chainName: string;
  alertThresholdMs: number;
  warningThresholdMs: number;
}

export interface EventIngestionMetrics {
  chainId: number;
  chainName: string;
  eventTimestamp: number;
  ingestionTimestamp: number;
  lagMs: number;
}

export interface LagAlert {
  chainId: number;
  chainName: string;
  lagMs: number;
  thresholdMs: number;
  severity: 'warning' | 'critical';
  timestamp: number;
  message: string;
}

export class EventIngestionLagMonitor extends EventEmitter {
  private readonly configs = new Map<number, EventIngestionLagConfig>();
  private readonly activeAlerts = new Map<number, LagAlert>();

  constructor(configs: EventIngestionLagConfig[]) {
    super();
    for (const config of configs) {
      this.configs.set(config.chainId, config);
    }
  }

  /**
   * Record an event ingestion and check for lag alerts
   */
  recordEventIngestion(metrics: EventIngestionMetrics): void {
    const config = this.configs.get(metrics.chainId);
    if (!config) {
      return;
    }

    const lagMs = metrics.ingestionTimestamp - metrics.eventTimestamp;

    if (lagMs > config.alertThresholdMs) {
      this.generateAlert(metrics.chainId, config.chainName, lagMs, config.alertThresholdMs, 'critical');
    } else if (lagMs > config.warningThresholdMs) {
      this.generateAlert(metrics.chainId, config.chainName, lagMs, config.warningThresholdMs, 'warning');
    } else {
      this.resolveAlert(metrics.chainId);
    }
  }

  /**
   * Update configuration for a chain
   */
  updateConfig(config: EventIngestionLagConfig): void {
    this.configs.set(config.chainId, config);
  }

  /**
   * Get active alerts for a chain
   */
  getActiveAlert(chainId: number): LagAlert | null {
    return this.activeAlerts.get(chainId) || null;
  }

  /**
   * Get all active alerts
   */
  getAllActiveAlerts(): LagAlert[] {
    return Array.from(this.activeAlerts.values());
  }

  /**
   * Clear all alerts
   */
  clearAlerts(): void {
    this.activeAlerts.clear();
  }

  private generateAlert(
    chainId: number,
    chainName: string,
    lagMs: number,
    thresholdMs: number,
    severity: 'warning' | 'critical',
  ): void {
    const existing = this.activeAlerts.get(chainId);
    if (existing && existing.severity === severity) {
      existing.lagMs = lagMs;
      existing.timestamp = Date.now();
      return;
    }

    const alert: LagAlert = {
      chainId,
      chainName,
      lagMs,
      thresholdMs,
      severity,
      timestamp: Date.now(),
      message: `Event ingestion lag for ${chainName}: ${lagMs.toFixed(0)}ms exceeds ${severity} threshold of ${thresholdMs}ms`,
    };

    this.activeAlerts.set(chainId, alert);
    this.emit('alert', alert);
  }

  private resolveAlert(chainId: number): void {
    const existing = this.activeAlerts.get(chainId);
    if (existing) {
      this.activeAlerts.delete(chainId);
      this.emit('resolved', { chainId, resolvedAt: Date.now() });
    }
  }
}
