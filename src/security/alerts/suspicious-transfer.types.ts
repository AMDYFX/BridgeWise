/**
 * File: src/security/alerts/suspicious-transfer.types.ts
 *
 * Type definitions for suspicious transfer alerting.
 *
 * The alerting service inspects each bridge transfer against a small set of
 * explainable rules (watchlists, unusually large amounts, burst frequency,
 * cumulative volume, and structuring just below the large-transfer threshold)
 * and raises severity-tagged alerts to pluggable sinks.
 */

/** Alert severity, lowest to highest. */
export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';

/** Stable machine-readable rule identifiers. */
export type SuspiciousTransferRule =
  | 'WATCHLISTED_ADDRESS'
  | 'LARGE_TRANSFER'
  | 'HIGH_VELOCITY'
  | 'HIGH_CUMULATIVE_VOLUME'
  | 'STRUCTURING'
  | 'MALFORMED_TRANSFER';

/** A transfer to inspect. */
export interface TransferToInspect {
  transferId: string;
  /** Originating address. */
  sender: string;
  /** Receiving address. */
  recipient: string;
  /** Asset symbol (e.g. USDC). Matched case-insensitively. */
  asset: string;
  /** Amount as a non-negative decimal string. */
  amount: string;
  sourceChain?: string;
  destinationChain?: string;
  /** Observation time (epoch ms). Defaults to the service clock. */
  timestamp?: number;
}

/** A raised alert. */
export interface SuspiciousTransferAlert {
  id: string;
  rule: SuspiciousTransferRule;
  severity: AlertSeverity;
  transferId: string;
  sender: string;
  recipient: string;
  asset: string;
  amount: string;
  /** Human-readable explanation. */
  message: string;
  /** Rule-specific context (observed value, threshold, window...). */
  details: Record<string, string | number>;
  createdAt: number;
}

/** A destination for alerts (log, webhook, notification service, ...). */
export type AlertSink = (alert: SuspiciousTransferAlert) => void | Promise<void>;

/** Service configuration. Every field is optional; defaults are noted. */
export interface SuspiciousTransferAlertingConfig {
  /** Per-asset amount at/above which a single transfer is flagged. */
  largeTransferThresholds?: Record<string, string>;
  /** Fallback large-transfer threshold for assets not listed above. */
  defaultLargeTransferThreshold?: string;
  /** Rolling window for velocity/cumulative/structuring rules (default 1h). */
  windowMs?: number;
  /** Max transfers per sender within the window before alerting (default 10). */
  maxTransfersPerWindow?: number;
  /** Per-asset cumulative sender volume within the window that triggers an alert. */
  cumulativeVolumeThresholds?: Record<string, string>;
  /** Lower edge of the structuring band as a % of the large threshold (default 80). */
  structuringBandPercent?: number;
  /** Near-threshold transfers within the window that count as structuring (default 3). */
  structuringMinCount?: number;
  /** Addresses (sender or recipient) that always raise a critical alert. */
  watchlist?: string[];
  /** Suppress repeat aggregate-rule alerts per sender/asset for this long (default 5m). */
  cooldownMs?: number;
  /** Maximum alerts retained for inspection (default 1000). */
  maxRetainedAlerts?: number;
  /** Maximum distinct senders whose history is tracked (default 10000). */
  maxTrackedSenders?: number;
  /** Initial alert sinks. */
  sinks?: AlertSink[];
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/** Result of inspecting one transfer. */
export interface TransferInspectionResult {
  transferId: string;
  suspicious: boolean;
  alerts: SuspiciousTransferAlert[];
  /** Aggregate-rule alerts withheld because of the cooldown. */
  suppressed: number;
  /** Sinks that threw or rejected while delivering this transfer's alerts. */
  sinkFailures: number;
}

/** Filter for retained alerts. */
export interface AlertQuery {
  rule?: SuspiciousTransferRule;
  severity?: AlertSeverity;
  sender?: string;
  /** Maximum alerts to return, newest first (default: all retained). */
  limit?: number;
}

/** Operational counters. */
export interface SuspiciousTransferStats {
  inspected: number;
  alertsRaised: number;
  suppressed: number;
  sinkFailures: number;
  trackedSenders: number;
}
