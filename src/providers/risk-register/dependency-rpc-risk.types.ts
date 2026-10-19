/**
 * File: src/providers/risk-register/dependency-rpc-risk.types.ts
 *
 * Types for the dependency and RPC provider risk register (#1382).
 *
 * The register is the operator-facing inventory of everything the routing and
 * execution platform leans on that BridgeWise does not control: npm packages,
 * oracle/SDK dependencies, and the RPC providers that answer chain queries.
 * Each entry carries the risk attributes needed to answer "if this breaks,
 * how much of the platform goes down with it?" before it breaks.
 *
 * Security notes:
 *   - Entries are untrusted input: they are validated on the way in and
 *     endpoint references must never contain credentials or API keys.
 *   - Nothing derived from an entry (host, metadata, notes) is written to
 *     logs or audit params un-sanitized.
 */

export type RiskEntryKind = 'dependency' | 'rpc-provider';

export type RiskCriticality = 'critical' | 'high' | 'medium' | 'low';

/**
 * How much an entry depends on a party outside the operator's control.
 * `self-hosted` still carries operational risk (somebody has to patch it),
 * `single-vendor` carries the most.
 */
export type RiskTrustModel =
  'self-hosted' | 'multi-vendor' | 'single-vendor' | 'third-party-managed';

export type RiskEntryStatus = 'active' | 'degraded' | 'suspended' | 'retired';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** A registered dependency or RPC provider. Immutable via the public API. */
export interface RiskRegisterEntry {
  readonly id: string;
  readonly kind: RiskEntryKind;
  /** Human label, e.g. 'Alchemy mainnet RPC'. */
  readonly label: string;
  readonly criticality: RiskCriticality;
  readonly trustModel: RiskTrustModel;
  /** Chains this entry serves (normalized lowercase), e.g. ['ethereum']. */
  readonly chains: readonly string[];
  /** Dependency version or provider plan, when known. */
  readonly version?: string;
  /**
   * Host or base URL of an RPC provider *without* credentials, query string
   * or fragment. Normalized to a hostname on registration.
   */
  readonly endpointHost?: string;
  /** Entry ids this entry can fail over to. */
  readonly fallbackEntryIds: readonly string[];
  /** Team or service accountable for the entry. */
  readonly ownerId?: string;
  readonly status: RiskEntryStatus;
  readonly registeredAt: number;
  readonly updatedAt: number;
  /** Sanitized, JSON-safe metadata (secrets redacted, depth/size capped). */
  readonly metadata: Record<string, unknown>;
}

export interface RegisterRiskEntryInput {
  id: string;
  kind: RiskEntryKind;
  label: string;
  criticality: RiskCriticality;
  trustModel: RiskTrustModel;
  chains?: string[];
  version?: string;
  endpointHost?: string;
  fallbackEntryIds?: string[];
  ownerId?: string;
  status?: Exclude<RiskEntryStatus, 'retired'>;
  metadata?: Record<string, unknown>;
}

export interface UpdateRiskEntryInput {
  label?: string;
  criticality?: RiskCriticality;
  trustModel?: RiskTrustModel;
  chains?: string[];
  version?: string;
  fallbackEntryIds?: string[];
  ownerId?: string;
  status?: Exclude<RiskEntryStatus, 'retired'>;
}

/** A single observed or simulated failure of an entry. */
export interface FailureEventInput {
  /** Optional idempotency key; re-submitting the same key is a no-op. */
  eventId?: string;
  entryId: string;
  observedAt: number;
  /** Short, secret-free reason, e.g. 'HTTP 503 from load balancer'. */
  reason: string;
  observedBy: string;
  /** How long the failure lasted, when known. */
  durationMs?: number;
}

export interface FailureEvent {
  readonly eventId: string;
  readonly entryId: string;
  readonly observedAt: number;
  readonly reason: string;
  readonly observedBy: string;
  readonly durationMs?: number;
}

export interface RecordFailureResult {
  readonly recorded: boolean;
  /** True when the eventId had already been recorded (idempotent replay). */
  readonly duplicate: boolean;
  readonly event?: FailureEvent;
}

/** One weighted contributor to a risk score, for explainability. */
export interface RiskFactor {
  readonly id: string;
  /** Points this factor can contribute, before its current value. */
  readonly weight: number;
  /** Points it actually contributed this time (0..weight). */
  readonly contribution: number;
  /** Why the factor contributed what it did. */
  readonly detail: string;
}

export interface RiskScore {
  readonly entryId: string;
  readonly kind: RiskEntryKind;
  /** 0 (minimal risk) .. 100 (highest risk). Deterministic per entry state. */
  readonly score: number;
  readonly level: RiskLevel;
  readonly factors: readonly RiskFactor[];
  readonly computedAt: number;
}

export interface RiskReportEntry {
  readonly entry: RiskRegisterEntry;
  readonly score: RiskScore;
}

export interface RiskReport {
  readonly generatedAt: number;
  /** Window used for the failure-history factor. */
  readonly failureWindowMs: number;
  readonly total: number;
  readonly counts: Record<RiskLevel, number>;
  /** Active/degraded/suspended entries, worst score first. */
  readonly entries: readonly RiskReportEntry[];
  /** Entries at `high` or `critical`, ids only, worst first. */
  readonly highRisk: readonly string[];
  /** Critical entries with no registered fallback: single points of failure. */
  readonly singlePointsOfFailure: readonly string[];
  /** Fallback ids that point at nothing: register data-quality defects. */
  readonly danglingFallbacks: readonly string[];
  /** providerId → entry ids, for the linked provider fleet. */
  readonly providerExposure: Readonly<Record<string, readonly string[]>>;
}

export interface RiskRegisterMetrics {
  readonly registered: number;
  readonly retired: number;
  readonly failureEventsRecorded: number;
  readonly duplicateFailureEvents: number;
  readonly assessments: number;
  readonly rejectedInputs: number;
}

export type RiskLogLevel = 'info' | 'warn';

/**
 * Structured, secret-free log emission. `message` never contains hosts,
 * endpoint URLs, metadata values or raw caller input.
 */
export interface RiskLogEvent {
  readonly level: RiskLogLevel;
  readonly code: string;
  readonly at: number;
  readonly entryId?: string;
  readonly message: string;
}

export interface RiskRegisterConfig {
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Failure-history window for scoring (default 24h). */
  failureWindowMs?: number;
  /** Entries verified longer ago than this are stale (default 7d). */
  staleAfterMs?: number;
  /** Maximum retained failure events, oldest evicted first (default 1000). */
  maxFailureEvents?: number;
  /** Structured, secret-free log sink. */
  log?: (event: RiskLogEvent) => void;
}

export type RiskRegisterErrorCode =
  | 'INVALID_ENTRY'
  | 'DUPLICATE_ENTRY'
  | 'ENTRY_NOT_FOUND'
  | 'INVALID_FAILURE_EVENT'
  | 'ENTRY_RETIRED'
  | 'INVALID_ACTOR';

/** Thrown when an input is rejected or an entry cannot be found. */
export class RiskRegisterError extends Error {
  constructor(
    public readonly code: RiskRegisterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RiskRegisterError';
  }
}
