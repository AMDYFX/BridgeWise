/**
 * File: src/metrics/volume/bridge-volume-metrics.service.ts
 *
 * Bridge volume metrics.
 *
 * Records bridge transfer observations and aggregates them into volume,
 * success-rate and size metrics, grouped breakdowns (per bridge / asset /
 * route) and fixed-width time series.
 *
 * Secure defaults: memory is bounded (age-based retention plus a hard event
 * cap), amounts use precision-safe decimal strings, and malformed or
 * far-future events are rejected and counted rather than silently skewing the
 * numbers.
 */

import { addAmounts, compareAmounts, divideByCount, isValidAmount } from './decimal';
import type {
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

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_EVENTS = 100_000;
const DEFAULT_MAX_FUTURE_SKEW_MS = 60_000;
const MAX_TIME_BUCKETS = 10_000;

interface StoredEvent {
  bridge: string;
  asset: string;
  amount: string;
  sourceChain: string;
  destinationChain: string;
  success: boolean;
  timestamp: number;
}

export class BridgeVolumeMetrics {
  private events: StoredEvent[] = [];
  private readonly retentionMs: number;
  private readonly maxEvents: number;
  private readonly maxFutureSkewMs: number;
  private readonly now: () => number;
  private rejected = 0;
  private evicted = 0;

  constructor(config: BridgeVolumeMetricsConfig = {}) {
    this.now = config.now ?? (() => Date.now());
    this.retentionMs = positiveOr(config.retentionMs, DEFAULT_RETENTION_MS);
    this.maxEvents = positiveOr(config.maxEvents, DEFAULT_MAX_EVENTS);
    this.maxFutureSkewMs = config.maxFutureSkewMs ?? DEFAULT_MAX_FUTURE_SKEW_MS;
  }

  /** Record a transfer observation. Never throws; rejections are counted. */
  record(event: BridgeVolumeEvent): RecordVolumeResult {
    const now = this.now();
    const timestamp = event.timestamp ?? now;

    if (!isValidAmount(event.amount)) return this.reject('INVALID_AMOUNT');
    if (
      !isNonEmpty(event.bridge) ||
      !isNonEmpty(event.asset) ||
      !isNonEmpty(event.sourceChain) ||
      !isNonEmpty(event.destinationChain)
    ) {
      return this.reject('INVALID_IDENTIFIER');
    }
    if (!Number.isFinite(timestamp) || timestamp < 0) return this.reject('INVALID_TIMESTAMP');
    if (timestamp > now + this.maxFutureSkewMs) return this.reject('FUTURE_TIMESTAMP');

    this.events.push({
      bridge: norm(event.bridge),
      asset: norm(event.asset),
      amount: event.amount.trim(),
      sourceChain: norm(event.sourceChain),
      destinationChain: norm(event.destinationChain),
      success: event.success === true,
      timestamp,
    });
    this.prune(now);
    return { recorded: true };
  }

  /** Aggregate metrics for every event matching the query. */
  getMetrics(query: VolumeQuery = {}): VolumeMetrics {
    this.prune(this.now());
    return aggregate(this.select(query));
  }

  /** Metrics grouped by bridge, asset or route, highest volume first. */
  getBreakdown(groupBy: VolumeGroupBy, query: VolumeQuery = {}): VolumeBreakdownEntry[] {
    this.prune(this.now());
    const groups = new Map<string, StoredEvent[]>();
    for (const event of this.select(query)) {
      const key = this.groupKey(groupBy, event);
      const bucket = groups.get(key);
      if (bucket) bucket.push(event);
      else groups.set(key, [event]);
    }
    return [...groups.entries()]
      .map(([key, group]) => ({ key, metrics: aggregate(group) }))
      .sort(
        (a, b) =>
          compareAmounts(b.metrics.totalVolume, a.metrics.totalVolume) ||
          (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      );
  }

  /**
   * Fixed-width time series over `[from, to)`. Empty buckets are included so
   * charts get a continuous axis. Throws on an invalid range, since a caller
   * asking for one is a programming error rather than bad telemetry.
   */
  getTimeSeries(bucketMs: number, query: VolumeQuery = {}): VolumeTimeBucket[] {
    const now = this.now();
    this.prune(now);
    const to = query.to ?? now;
    const from = query.from ?? to - this.retentionMs;

    if (!Number.isFinite(bucketMs) || bucketMs <= 0) {
      throw new RangeError('bucketMs must be a positive finite number');
    }
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      throw new RangeError('time series range must satisfy from < to');
    }
    if (Math.ceil((to - from) / bucketMs) > MAX_TIME_BUCKETS) {
      throw new RangeError(`time series would exceed ${MAX_TIME_BUCKETS} buckets`);
    }

    const selected = this.select({ ...query, from, to });
    const buckets: VolumeTimeBucket[] = [];
    for (let start = from; start < to; start += bucketMs) {
      const end = Math.min(start + bucketMs, to);
      const inBucket = selected.filter((e) => e.timestamp >= start && e.timestamp < end);
      buckets.push({ start, end, metrics: aggregate(inBucket) });
    }
    return buckets;
  }

  /** Operational counters for the collector itself. */
  getStats(): VolumeCollectorStats {
    this.prune(this.now());
    return {
      retainedEvents: this.events.length,
      rejectedEvents: this.rejected,
      evictedEvents: this.evicted,
    };
  }

  /** Drop all retained events and reset counters. */
  reset(): void {
    this.events = [];
    this.rejected = 0;
    this.evicted = 0;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private reject(reason: NonNullable<RecordVolumeResult['reason']>): RecordVolumeResult {
    this.rejected += 1;
    return { recorded: false, reason };
  }

  private select(query: VolumeQuery): StoredEvent[] {
    const bridge = query.bridge ? norm(query.bridge) : undefined;
    const asset = query.asset ? norm(query.asset) : undefined;
    const source = query.sourceChain ? norm(query.sourceChain) : undefined;
    const dest = query.destinationChain ? norm(query.destinationChain) : undefined;
    const to = query.to ?? this.now() + 1;

    return this.events.filter(
      (e) =>
        (bridge === undefined || e.bridge === bridge) &&
        (asset === undefined || e.asset === asset) &&
        (source === undefined || e.sourceChain === source) &&
        (dest === undefined || e.destinationChain === dest) &&
        (query.from === undefined || e.timestamp >= query.from) &&
        e.timestamp < to,
    );
  }

  private groupKey(groupBy: VolumeGroupBy, event: StoredEvent): string {
    switch (groupBy) {
      case 'bridge':
        return event.bridge;
      case 'asset':
        return event.asset;
      case 'route':
        return `${event.sourceChain}->${event.destinationChain}`;
    }
  }

  private prune(now: number): void {
    const cutoff = now - this.retentionMs;
    const before = this.events.length;
    this.events = this.events.filter((e) => e.timestamp > cutoff);

    if (this.events.length > this.maxEvents) {
      this.events.sort((a, b) => a.timestamp - b.timestamp);
      this.events = this.events.slice(this.events.length - this.maxEvents);
    }
    this.evicted += before - this.events.length;
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function aggregate(events: StoredEvent[]): VolumeMetrics {
  let totalVolume = '0';
  let successfulVolume = '0';
  let failedVolume = '0';
  let largest = '0';
  let successCount = 0;

  for (const event of events) {
    totalVolume = addAmounts(totalVolume, event.amount);
    if (event.success) {
      successCount += 1;
      successfulVolume = addAmounts(successfulVolume, event.amount);
    } else {
      failedVolume = addAmounts(failedVolume, event.amount);
    }
    if (compareAmounts(event.amount, largest) > 0) largest = event.amount;
  }

  const count = events.length;
  return {
    count,
    successCount,
    failureCount: count - successCount,
    totalVolume,
    successfulVolume,
    failedVolume,
    successRate: count === 0 ? null : successCount / count,
    averageSize: divideByCount(totalVolume, count),
    largestTransfer: largest,
  };
}

function norm(value: string): string {
  return value.trim().toUpperCase();
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
