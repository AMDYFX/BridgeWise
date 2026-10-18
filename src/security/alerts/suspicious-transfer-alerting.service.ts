/**
 * File: src/security/alerts/suspicious-transfer-alerting.service.ts
 *
 * Suspicious transfer alerting.
 *
 * Inspects each bridge transfer against explainable rules and delivers
 * severity-tagged alerts to pluggable sinks:
 *
 *   - WATCHLISTED_ADDRESS     sender or recipient is on the watchlist (critical)
 *   - LARGE_TRANSFER          amount at/above the asset's large threshold (high)
 *   - STRUCTURING             repeated transfers just below that threshold (high)
 *   - HIGH_CUMULATIVE_VOLUME  sender volume in the window exceeds a cap (high)
 *   - HIGH_VELOCITY           too many transfers from one sender in the window (medium)
 *   - MALFORMED_TRANSFER      the transfer could not be inspected (medium)
 *
 * Secure defaults: malformed input raises an alert instead of being skipped,
 * misconfigured thresholds fail fast at construction rather than silently
 * disabling a control, a failing sink never blocks other sinks or the caller,
 * and all state (per-sender history, cooldowns, retained alerts) is bounded.
 *
 * Per-transfer rules (watchlist, large, malformed) always alert. Aggregate
 * rules (velocity, cumulative, structuring) are rate-limited per
 * rule/sender/asset by a cooldown so a sustained burst does not flood sinks.
 */

import { randomUUID } from 'crypto';
import { addAmounts, compareAmounts, isValidAmount, percentOf } from './decimal';
import type {
  AlertQuery,
  AlertSeverity,
  AlertSink,
  SuspiciousTransferAlert,
  SuspiciousTransferAlertingConfig,
  SuspiciousTransferRule,
  SuspiciousTransferStats,
  TransferInspectionResult,
  TransferToInspect,
} from './suspicious-transfer.types';

const DEFAULT_WINDOW_MS = 60 * 60 * 1000; // 1h
const DEFAULT_MAX_TRANSFERS = 10;
const DEFAULT_BAND_PERCENT = 80;
const DEFAULT_STRUCTURING_MIN = 3;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5m
const DEFAULT_MAX_ALERTS = 1000;
const DEFAULT_MAX_SENDERS = 10_000;
const MAX_ENTRIES_PER_SENDER = 1000;

interface HistoryEntry {
  timestamp: number;
  asset: string;
  amount: string;
}

export class SuspiciousTransferAlertingService {
  private readonly windowMs: number;
  private readonly maxTransfers: number;
  private readonly bandPercent: number;
  private readonly structuringMin: number;
  private readonly cooldownMs: number;
  private readonly maxAlerts: number;
  private readonly maxSenders: number;
  private readonly largeThresholds: Map<string, string>;
  private readonly defaultLargeThreshold: string | undefined;
  private readonly cumulativeThresholds: Map<string, string>;
  private readonly watchlist: Set<string>;
  private readonly sinks: AlertSink[];
  private readonly now: () => number;

  private readonly history = new Map<string, HistoryEntry[]>();
  private readonly lastAlertAt = new Map<string, number>();
  private alerts: SuspiciousTransferAlert[] = [];
  private stats = { inspected: 0, alertsRaised: 0, suppressed: 0, sinkFailures: 0 };

  constructor(config: SuspiciousTransferAlertingConfig = {}) {
    this.now = config.now ?? (() => Date.now());
    this.windowMs = positiveNumber('windowMs', config.windowMs, DEFAULT_WINDOW_MS);
    this.maxTransfers = positiveInteger(
      'maxTransfersPerWindow',
      config.maxTransfersPerWindow,
      DEFAULT_MAX_TRANSFERS,
    );
    this.structuringMin = positiveInteger(
      'structuringMinCount',
      config.structuringMinCount,
      DEFAULT_STRUCTURING_MIN,
    );
    this.maxAlerts = positiveInteger('maxRetainedAlerts', config.maxRetainedAlerts, DEFAULT_MAX_ALERTS);
    this.maxSenders = positiveInteger('maxTrackedSenders', config.maxTrackedSenders, DEFAULT_MAX_SENDERS);

    this.bandPercent = config.structuringBandPercent ?? DEFAULT_BAND_PERCENT;
    if (
      !(this.bandPercent > 0 && this.bandPercent < 100) ||
      !isValidAmount(String(this.bandPercent))
    ) {
      throw new Error('structuringBandPercent must be between 0 and 100 (exclusive)');
    }
    this.cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    if (!Number.isFinite(this.cooldownMs) || this.cooldownMs < 0) {
      throw new Error('cooldownMs must be a non-negative number');
    }

    this.largeThresholds = amountMap('largeTransferThresholds', config.largeTransferThresholds);
    this.cumulativeThresholds = amountMap(
      'cumulativeVolumeThresholds',
      config.cumulativeVolumeThresholds,
    );
    if (config.defaultLargeTransferThreshold !== undefined) {
      if (!isValidAmount(config.defaultLargeTransferThreshold)) {
        throw new Error('defaultLargeTransferThreshold must be a non-negative decimal string');
      }
      this.defaultLargeThreshold = config.defaultLargeTransferThreshold.trim();
    }

    this.watchlist = new Set((config.watchlist ?? []).map(normalizeAddress));
    this.sinks = [...(config.sinks ?? [])];
  }

  /** Register an additional alert sink. */
  addSink(sink: AlertSink): void {
    this.sinks.push(sink);
  }

  /** Add an address to the watchlist. */
  addToWatchlist(address: string): void {
    this.watchlist.add(normalizeAddress(address));
  }

  /** Remove an address from the watchlist. Returns true if it was present. */
  removeFromWatchlist(address: string): boolean {
    return this.watchlist.delete(normalizeAddress(address));
  }

  /**
   * Inspect a transfer, deliver any alerts to the sinks, and return the
   * outcome. Never throws for bad input or failing sinks.
   */
  async inspect(transfer: TransferToInspect): Promise<TransferInspectionResult> {
    this.stats.inspected += 1;
    const now = this.now();
    const timestamp = transfer?.timestamp ?? now;

    const malformed = this.validate(transfer, timestamp);
    if (malformed) {
      const alert = this.buildAlert(transfer, 'MALFORMED_TRANSFER', 'medium', malformed, {}, now);
      return this.finish(transfer, [alert], 0);
    }

    const sender = normalizeAddress(transfer.sender);
    const asset = normalizeAsset(transfer.asset);
    const amount = transfer.amount.trim();

    this.recordHistory(sender, { timestamp, asset, amount }, now);
    const windowEntries = this.windowEntries(sender, asset, timestamp);

    const raised: SuspiciousTransferAlert[] = [];
    let suppressed = 0;
    const emitAggregate = (
      rule: SuspiciousTransferRule,
      severity: AlertSeverity,
      message: string,
      details: Record<string, string | number>,
    ) => {
      const key = `${rule}|${sender}|${asset}`;
      const last = this.lastAlertAt.get(key);
      if (last !== undefined && now - last < this.cooldownMs) {
        suppressed += 1;
        return;
      }
      this.markAlerted(key, now);
      raised.push(this.buildAlert(transfer, rule, severity, message, details, now));
    };

    // 1 — watchlist (per-transfer, never suppressed).
    const flagged = [
      ['sender', sender],
      ['recipient', normalizeAddress(transfer.recipient)],
    ].filter(([, address]) => this.watchlist.has(address));
    if (flagged.length > 0) {
      raised.push(
        this.buildAlert(
          transfer,
          'WATCHLISTED_ADDRESS',
          'critical',
          `transfer ${transfer.transferId} involves a watchlisted ${flagged.map(([role]) => role).join(' and ')}`,
          { matched: flagged.map(([role]) => role).join(',') },
          now,
        ),
      );
    }

    // 2 — large single transfer (per-transfer, never suppressed).
    const largeThreshold = this.largeThresholdFor(asset);
    if (largeThreshold !== undefined && compareAmounts(amount, largeThreshold) >= 0) {
      raised.push(
        this.buildAlert(
          transfer,
          'LARGE_TRANSFER',
          'high',
          `amount ${amount} ${asset} is at or above the large-transfer threshold ${largeThreshold}`,
          { threshold: largeThreshold, observed: amount },
          now,
        ),
      );
    }

    // 3 — velocity.
    const allWindowEntries = this.windowEntries(sender, undefined, timestamp);
    if (allWindowEntries.length > this.maxTransfers) {
      emitAggregate(
        'HIGH_VELOCITY',
        'medium',
        `${allWindowEntries.length} transfers from one sender within the window exceeds the limit of ${this.maxTransfers}`,
        { observed: allWindowEntries.length, limit: this.maxTransfers, windowMs: this.windowMs },
      );
    }

    // 4 — cumulative volume.
    const cumulativeThreshold = this.cumulativeThresholds.get(asset);
    if (cumulativeThreshold !== undefined) {
      const total = windowEntries.reduce((sum, e) => addAmounts(sum, e.amount), '0');
      if (compareAmounts(total, cumulativeThreshold) > 0) {
        emitAggregate(
          'HIGH_CUMULATIVE_VOLUME',
          'high',
          `sender moved ${total} ${asset} within the window, above the cap ${cumulativeThreshold}`,
          { observed: total, threshold: cumulativeThreshold, windowMs: this.windowMs },
        );
      }
    }

    // 5 — structuring just below the large-transfer threshold.
    if (largeThreshold !== undefined) {
      const lower = percentOf(largeThreshold, String(this.bandPercent));
      const inBand = (value: string) =>
        compareAmounts(value, lower) >= 0 && compareAmounts(value, largeThreshold) < 0;
      if (inBand(amount)) {
        const nearThreshold = windowEntries.filter((e) => inBand(e.amount)).length;
        if (nearThreshold >= this.structuringMin) {
          emitAggregate(
            'STRUCTURING',
            'high',
            `${nearThreshold} transfers between ${lower} and ${largeThreshold} ${asset} within the window look like structuring`,
            { observed: nearThreshold, minCount: this.structuringMin, lowerBound: lower, threshold: largeThreshold },
          );
        }
      }
    }

    return this.finish(transfer, raised, suppressed);
  }

  /** Retained alerts, newest first. */
  getAlerts(query: AlertQuery = {}): SuspiciousTransferAlert[] {
    const sender = query.sender ? normalizeAddress(query.sender) : undefined;
    const matches = this.alerts
      .filter(
        (a) =>
          (query.rule === undefined || a.rule === query.rule) &&
          (query.severity === undefined || a.severity === query.severity) &&
          (sender === undefined || normalizeAddress(a.sender) === sender),
      )
      .reverse();
    return query.limit !== undefined ? matches.slice(0, Math.max(0, query.limit)) : matches;
  }

  /** Operational counters. */
  getStats(): SuspiciousTransferStats {
    return { ...this.stats, trackedSenders: this.history.size };
  }

  /** Clear history, cooldowns, retained alerts and counters. */
  reset(): void {
    this.history.clear();
    this.lastAlertAt.clear();
    this.alerts = [];
    this.stats = { inspected: 0, alertsRaised: 0, suppressed: 0, sinkFailures: 0 };
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /** Returns a description of what is wrong with the transfer, or null if valid. */
  private validate(transfer: TransferToInspect, timestamp: number): string | null {
    if (!transfer || typeof transfer !== 'object') return 'transfer payload is missing';
    if (!isNonEmpty(transfer.transferId)) return 'transferId is missing';
    if (!isNonEmpty(transfer.sender)) return 'sender is missing';
    if (!isNonEmpty(transfer.recipient)) return 'recipient is missing';
    if (!isNonEmpty(transfer.asset)) return 'asset is missing';
    if (!isValidAmount(transfer.amount)) return 'amount is not a valid non-negative decimal';
    if (!Number.isFinite(timestamp) || timestamp < 0) return 'timestamp is invalid';
    return null;
  }

  private largeThresholdFor(asset: string): string | undefined {
    return this.largeThresholds.get(asset) ?? this.defaultLargeThreshold;
  }

  private recordHistory(sender: string, entry: HistoryEntry, now: number): void {
    let entries = this.history.get(sender);
    if (!entries) {
      if (this.history.size >= this.maxSenders) {
        const oldest = this.history.keys().next().value;
        if (oldest !== undefined) this.history.delete(oldest);
      }
      entries = [];
      this.history.set(sender, entries);
    }
    entries.push(entry);

    const cutoff = now - this.windowMs;
    const kept = entries.filter((e) => e.timestamp > cutoff);
    const bounded =
      kept.length > MAX_ENTRIES_PER_SENDER ? kept.slice(kept.length - MAX_ENTRIES_PER_SENDER) : kept;
    this.history.set(sender, bounded);
  }

  /** Entries for a sender within `(timestamp - windowMs, timestamp]`, optionally for one asset. */
  private windowEntries(sender: string, asset: string | undefined, timestamp: number): HistoryEntry[] {
    const cutoff = timestamp - this.windowMs;
    return (this.history.get(sender) ?? []).filter(
      (e) =>
        e.timestamp > cutoff &&
        e.timestamp <= timestamp &&
        (asset === undefined || e.asset === asset),
    );
  }

  private markAlerted(key: string, now: number): void {
    if (this.lastAlertAt.size >= this.maxSenders) {
      for (const [k, at] of this.lastAlertAt) {
        if (now - at >= this.cooldownMs) this.lastAlertAt.delete(k);
      }
      if (this.lastAlertAt.size >= this.maxSenders) {
        const oldest = this.lastAlertAt.keys().next().value;
        if (oldest !== undefined) this.lastAlertAt.delete(oldest);
      }
    }
    this.lastAlertAt.set(key, now);
  }

  private buildAlert(
    transfer: Partial<TransferToInspect> | undefined,
    rule: SuspiciousTransferRule,
    severity: AlertSeverity,
    message: string,
    details: Record<string, string | number>,
    createdAt: number,
  ): SuspiciousTransferAlert {
    return {
      id: randomUUID(),
      rule,
      severity,
      transferId: String(transfer?.transferId ?? 'unknown'),
      sender: String(transfer?.sender ?? 'unknown'),
      recipient: String(transfer?.recipient ?? 'unknown'),
      asset: String(transfer?.asset ?? 'unknown'),
      amount: String(transfer?.amount ?? 'unknown'),
      message,
      details,
      createdAt,
    };
  }

  private async finish(
    transfer: Partial<TransferToInspect> | undefined,
    alerts: SuspiciousTransferAlert[],
    suppressed: number,
  ): Promise<TransferInspectionResult> {
    this.stats.alertsRaised += alerts.length;
    this.stats.suppressed += suppressed;
    this.retain(alerts);

    const outcomes = await Promise.allSettled(
      alerts.flatMap((alert) =>
        this.sinks.map(async (sink) => {
          await sink(alert);
        }),
      ),
    );
    const sinkFailures = outcomes.filter((o) => o.status === 'rejected').length;
    this.stats.sinkFailures += sinkFailures;

    return {
      transferId: String(transfer?.transferId ?? 'unknown'),
      suspicious: alerts.length > 0,
      alerts,
      suppressed,
      sinkFailures,
    };
  }

  private retain(alerts: SuspiciousTransferAlert[]): void {
    this.alerts.push(...alerts);
    if (this.alerts.length > this.maxAlerts) {
      this.alerts = this.alerts.slice(this.alerts.length - this.maxAlerts);
    }
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function normalizeAddress(address: string): string {
  return String(address ?? '').trim().toLowerCase();
}

function normalizeAsset(asset: string): string {
  return String(asset ?? '').trim().toUpperCase();
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveNumber(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function positiveInteger(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function amountMap(name: string, source: Record<string, string> | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const [asset, amount] of Object.entries(source ?? {})) {
    if (!isValidAmount(amount)) {
      throw new Error(`${name}["${asset}"] must be a non-negative decimal string`);
    }
    map.set(normalizeAsset(asset), amount.trim());
  }
  return map;
}
