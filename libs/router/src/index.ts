/**
 * @bridgewise/router — Smart cross-chain liquidity and bridge path routing engine.
 *
 * @example
 * ```ts
 * import { PathFinder, CostCalculator } from '@bridgewise/router';
 * import type { GraphNode, GraphEdge, PathResult, RoutingOptions } from '@bridgewise/router';
 * ```
 */

export { PathFinder } from "./path-finder";
export { CostCalculator } from "./cost-calculator";
export type {
  GraphEdge,
  GraphNode,
  PathResult,
  RoutingOptions,
  RoutingStrategy,
} from "./types";

export { parseCorpusFile, assertCorpusConsistent, CorpusValidationError, CORPUS_LIMITS } from "./regression/corpus-validator";
export { runConformanceSuite, formatConformanceReport, BUILT_IN_CASES } from "./conformance/runner";
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
} from "./conformance/types";
export { DEFAULT_CONFORMANCE_TIMEOUT_MS } from "./conformance/types";
export { runRegressionCorpus, formatRegressionReport, diffOutcome, hopSignature } from "./regression/runner";
export { DEFAULT_CASE_TIMEOUT_MS, DEFAULT_FEE_TOLERANCE, SUPPORTED_SCHEMA_VERSIONS } from "./regression/types";
export type {
  CaseOutcome,
  CaseResult,
  CaseStatus,
  CorpusFile,
  ExpectedOutcome,
  ExpectedRoute,
  GeneratedEdgeSpec,
  GraphSource,
  RegressionCase,
  RegressionLogger,
  RegressionMetricsSink,
  RegressionReport,
  RegressionRequest,
  RunnerOptions,
} from "./regression/types";
