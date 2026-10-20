export interface TreasurySnapshot {
  /** Pool identifier, e.g. `ethereum:USDC`. */
  pool: string;
  /** Epoch milliseconds when the balances were read. */
  capturedAt: number;
}

export type SnapshotFreshness = 'fresh' | 'stale' | 'from_future';

export interface SnapshotCheck {
  pool: string;
  ageMs: number;
  status: SnapshotFreshness;
}

export class StaleSnapshotError extends Error {
  constructor(readonly stale: SnapshotCheck[]) {
    super(`stale treasury snapshots: ${stale.map((s) => `${s.pool} (${s.status}, ${s.ageMs}ms)`).join(', ')}`);
    this.name = 'StaleSnapshotError';
  }
}

/** Snapshots older than `maxAgeMs`, or timestamped in the future (clock skew), are not safe to act on. */
export function checkSnapshot(snapshot: TreasurySnapshot, now: number, maxAgeMs: number): SnapshotCheck {
  const ageMs = now - snapshot.capturedAt;
  const status: SnapshotFreshness = ageMs < 0 ? 'from_future' : ageMs > maxAgeMs ? 'stale' : 'fresh';
  return { pool: snapshot.pool, ageMs, status };
}

export function detectStaleSnapshots(snapshots: TreasurySnapshot[], now: number, maxAgeMs: number): SnapshotCheck[] {
  return snapshots.map((s) => checkSnapshot(s, now, maxAgeMs)).filter((c) => c.status !== 'fresh');
}

/** Throws before any liquidity decision is made on outdated balances. */
export function assertSnapshotsFresh(snapshots: TreasurySnapshot[], now: number, maxAgeMs: number): void {
  const stale = detectStaleSnapshots(snapshots, now, maxAgeMs);
  if (stale.length > 0) throw new StaleSnapshotError(stale);
}
