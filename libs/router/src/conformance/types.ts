/**
 * Types for the route-provider conformance suite.
 *
 * A conformance suite declares a contract that every {@link RouteProvider}
 * implementation must satisfy.  Cases are deterministic (all dependencies are
 * injected via the fixture) so results are reproducible across environments.
 */

import { GraphEdge, RoutingOptions } from "../types";

// ─── Provider contract ────────────────────────────────────────────────────────

/**
 * Minimum surface a route provider must expose to participate in routing.
 * Implementations may add additional capabilities; the conformance suite only
 * drives the interface below.
 */
export interface RouteProvider {
  /** Stable identifier used in corpus hop signatures (e.g. "layerzero"). */
  readonly name: string;

  /**
   * Returns whether this provider can service the given chain pair for the
   * asset identified by `assetSymbol`.
   *
   * Must be pure / synchronous so the suite can assert it without I/O.
   */
  supportsRoute(sourceChain: string, targetChain: string, assetSymbol: string): boolean;

  /**
   * Returns the set of edges this provider contributes to the routing graph.
   * Implementations MUST NOT mutate the returned array.
   * Returns an empty array (never throws) when no edges are available.
   */
  getEdges(sourceChain: string, targetChain: string, assetSymbol: string): Promise<GraphEdge[]>;

  /**
   * Validates that the provider is operational and within acceptable latency /
   * error-rate thresholds.  Used by health-gate assertions.
   */
  ping(): Promise<ProviderHealthResult>;
}

/** Health gate result returned by {@link RouteProvider.ping}. */
export interface ProviderHealthResult {
  ok: boolean;
  latencyMs: number;
  /** Human-readable reason when `ok` is false. */
  reason?: string;
}

// ─── Conformance fixture ──────────────────────────────────────────────────────

/**
 * Deterministic dependency fixture injected into each conformance case.
 * Tests supply a stub implementation; production wires the real providers.
 */
export interface ConformanceFixture {
  /** Provider under test. */
  provider: RouteProvider;

  /** Edges the provider stub should return for `getEdges`. */
  edges: GraphEdge[];

  /** Routing options to use for path-finding assertions. */
  routingOptions: RoutingOptions;

  /**
   * Whether the provider's `ping()` should simulate a healthy response.
   * Defaults to `true`.
   */
  providerHealthy?: boolean;

  /**
   * Milliseconds for the simulated ping latency.
   * Defaults to 0.
   */
  simulatedLatencyMs?: number;

  /**
   * If set, `getEdges` throws this error instead of returning edges.
   * Used to test failure / idempotency scenarios.
   */
  simulateGetEdgesFailure?: Error;
}

// ─── Conformance case ─────────────────────────────────────────────────────────

export type ConformanceCaseStatus = "active" | "known-issue";
export type ConformanceCaseOutcome = "pass" | "fail" | "error" | "xfail" | "xpass" | "skipped";

/** A single provider conformance check. */
export interface ConformanceCase {
  /** Kebab-case identifier unique within the suite (e.g. "supports-route-symmetric"). */
  id: string;
  description: string;
  tags: string[];
  status: ConformanceCaseStatus;
  /** Required when `status` is `known-issue`. */
  issue?: string;

  /**
   * The assertion to execute against the fixture.
   *
   * Must return an array of human-readable mismatch strings.
   * An empty array means the case passed.
   */
  assert(fixture: ConformanceFixture): Promise<string[]>;
}

export interface ConformanceCaseResult {
  id: string;
  outcome: ConformanceCaseOutcome;
  mismatches: string[];
  error?: string;
  durationMs: number;
}

// ─── Suite ────────────────────────────────────────────────────────────────────

export interface ConformanceSuiteOptions {
  /** Only run cases whose tags overlap with this set. */
  includeTags?: string[];
  /** Per-case time budget in ms (default 2000). */
  caseTimeoutMs?: number;
}

export interface ConformanceReport {
  suite: string;
  total: number;
  passed: number;
  failed: number;
  errored: number;
  expectedFailures: number;
  unexpectedPasses: number;
  skipped: number;
  durationMs: number;
  results: ConformanceCaseResult[];
  /** `true` when no case failed, errored, or unexpectedly passed. */
  ok: boolean;
}

export const DEFAULT_CONFORMANCE_TIMEOUT_MS = 2000;
