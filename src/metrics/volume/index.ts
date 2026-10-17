/**
 * File: src/metrics/volume/index.ts
 *
 * Module barrel for bridge volume metrics.
 */

export { BridgeVolumeMetrics } from './bridge-volume-metrics.service';
export type {
  BridgeVolumeEvent,
  BridgeVolumeMetricsConfig,
  RecordVolumeResult,
  VolumeBreakdownEntry,
  VolumeCollectorStats,
  VolumeGroupBy,
  VolumeMetrics,
  VolumeQuery,
  VolumeTimeBucket,
} from './bridge-volume-metrics.types';
