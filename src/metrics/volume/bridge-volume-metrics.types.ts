/**
 * File: src/metrics/volume/bridge-volume-metrics.types.ts
 *
 * Type definitions for bridge volume metrics.
 *
 * Volume metrics answer "how much value is flowing through which bridge, asset
 * and route, and how much of it succeeds?" over a rolling retention window.
 */

/** A single bridge transfer observation. */
export interface BridgeVolumeEvent {
  /** Bridge/provider identifier (e.g. 'allbridge'). */
  bridge: string;
  /** Asset symbol (e.g. USDC). Matched case-insensitively. */
  asset: string;
  /** Transferred amount as a non-negative decimal string. */
  amount: string;
  /** Source chain identifier. */
  sourceChain: string;
  /** Destination chain identifier. */
  destinationChain: string;
  /** Whether the transfer completed successfully. */
  success: boolean;
  /** Observation time (epoch ms). Defaults to the service clock. */
  timestamp?: number;
}

/** Outcome of recording an event. */
export interface RecordVolumeResult {
  recorded: boolean;
  /** Present when the event was rejected. */
  reason?: 'INVALID_AMOUNT' | 'INVALID_IDENTIFIER' | 'INVALID_TIMESTAMP' | 'FUTURE_TIMESTAMP';
}

/** Filter applied to volume queries. All fields are optional. */
export interface VolumeQuery {
  bridge?: string;
  asset?: string;
  sourceChain?: string;
  destinationChain?: string;
  /** Inclusive lower bound (epoch ms). */
  from?: number;
  /** Exclusive upper bound (epoch ms). Defaults to now. */
  to?: number;
}

/** Aggregated volume figures. */
export interface VolumeMetrics {
  /** Number of transfers observed. */
  count: number;
  successCount: number;
  failureCount: number;
  /** Sum of all transfer amounts (successful + failed). */
  totalVolume: string;
  successfulVolume: string;
  failedVolume: string;
  /** Successful transfers / all transfers, or null when there are none. */
  successRate: number | null;
  /** `totalVolume / count`, or '0' when there are none. */
  averageSize: string;
  /** Largest single transfer, or '0' when there are none. */
  largestTransfer: string;
}

/** Dimension to group a breakdown by. */
export type VolumeGroupBy = 'bridge' | 'asset' | 'route';

/** One row of a grouped breakdown. */
export interface VolumeBreakdownEntry {
  /** Group key (bridge id, asset symbol, or `source->destination`). */
  key: string;
  metrics: VolumeMetrics;
}

/** One bucket of a time series. */
export interface VolumeTimeBucket {
  /** Inclusive bucket start (epoch ms). */
  start: number;
  /** Exclusive bucket end (epoch ms). */
  end: number;
  metrics: VolumeMetrics;
}

/** Service configuration. */
export interface BridgeVolumeMetricsConfig {
  /** How long events are retained (default 24h). */
  retentionMs?: number;
  /** Hard cap on retained events; oldest are dropped first (default 100000). */
  maxEvents?: number;
  /** Maximum tolerated clock skew for future timestamps (default 60s). */
  maxFutureSkewMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/** Operational counters for the metrics collector itself. */
export interface VolumeCollectorStats {
  retainedEvents: number;
  rejectedEvents: number;
  evictedEvents: number;
}
