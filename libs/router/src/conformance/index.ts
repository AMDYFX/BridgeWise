/**
 * Route-provider conformance suite — public API.
 *
 * @example
 * ```ts
 * import {
 *   runConformanceSuite,
 *   formatConformanceReport,
 * } from '@bridgewise/router/conformance';
 * import type { RouteProvider, ConformanceFixture } from '@bridgewise/router/conformance';
 * ```
 */

export { runConformanceSuite, formatConformanceReport } from "./runner";
export { BUILT_IN_CASES } from "./cases";
export type {
  RouteProvider,
  ProviderHealthResult,
  ConformanceFixture,
  ConformanceCase,
  ConformanceCaseOutcome,
  ConformanceCaseResult,
  ConformanceCaseStatus,
  ConformanceReport,
  ConformanceSuiteOptions,
} from "./types";
export { DEFAULT_CONFORMANCE_TIMEOUT_MS } from "./types";
