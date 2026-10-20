/**
 * Conformance suite runner.
 *
 * Executes every registered {@link ConformanceCase} against the supplied
 * {@link ConformanceFixture}.  Each case runs in isolation — a failure or
 * thrown error in one case never aborts the run.
 */

import {
  ConformanceCase,
  ConformanceCaseOutcome,
  ConformanceCaseResult,
  ConformanceFixture,
  ConformanceReport,
  ConformanceSuiteOptions,
  DEFAULT_CONFORMANCE_TIMEOUT_MS,
} from "./types";
import { BUILT_IN_CASES } from "./cases";

function classify(
  c: ConformanceCase,
  mismatches: string[],
): ConformanceCaseOutcome {
  const matches = mismatches.length === 0;
  if (c.status === "known-issue") return matches ? "xpass" : "xfail";
  return matches ? "pass" : "fail";
}

/**
 * Run the conformance suite for a single provider fixture.
 *
 * @param fixture     - Deterministic dependencies for the provider under test.
 * @param extraCases  - Additional cases appended after the built-in suite.
 * @param options     - Tag filter, time budget, suite name override.
 */
export async function runConformanceSuite(
  fixture: ConformanceFixture,
  extraCases: ConformanceCase[] = [],
  options: ConformanceSuiteOptions & { suiteName?: string } = {},
): Promise<ConformanceReport> {
  const suite = options.suiteName ?? fixture.provider.name;
  const budgetMs = options.caseTimeoutMs ?? DEFAULT_CONFORMANCE_TIMEOUT_MS;
  const includeTags =
    options.includeTags && options.includeTags.length > 0
      ? new Set(options.includeTags)
      : null;

  const allCases: ConformanceCase[] = [...BUILT_IN_CASES, ...extraCases];
  const results: ConformanceCaseResult[] = [];
  const runStart = Date.now();

  for (const c of allCases) {
    // Tag filter
    if (includeTags && !c.tags.some((t) => includeTags.has(t))) {
      results.push({ id: c.id, outcome: "skipped", mismatches: [], durationMs: 0 });
      continue;
    }

    const start = Date.now();
    let result: ConformanceCaseResult;

    try {
      const mismatches = await c.assert(fixture);
      const durationMs = Date.now() - start;

      const timedMismatches =
        durationMs > budgetMs
          ? [...mismatches, `took ${durationMs}ms, exceeding the ${budgetMs}ms budget`]
          : mismatches;

      result = {
        id: c.id,
        outcome: classify(c, timedMismatches),
        mismatches: timedMismatches,
        durationMs,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = {
        id: c.id,
        outcome: "error",
        mismatches: [],
        error: message,
        durationMs: Date.now() - start,
      };
    }

    results.push(result);
  }

  const count = (o: ConformanceCaseOutcome) =>
    results.filter((r) => r.outcome === o).length;

  const report: ConformanceReport = {
    suite,
    total: results.length,
    passed: count("pass"),
    failed: count("fail"),
    errored: count("error"),
    expectedFailures: count("xfail"),
    unexpectedPasses: count("xpass"),
    skipped: count("skipped"),
    durationMs: Date.now() - runStart,
    results,
    ok: false,
  };
  report.ok =
    report.failed === 0 &&
    report.errored === 0 &&
    report.unexpectedPasses === 0;

  return report;
}

/** Render a conformance report as plain text suitable for CI logs. */
export function formatConformanceReport(report: ConformanceReport): string {
  const lines = [
    `Route-provider conformance [${report.suite}]: ${report.ok ? "OK" : "FAILED"} ` +
      `(${report.passed} passed, ${report.failed} failed, ${report.errored} errored, ` +
      `${report.expectedFailures} known-issues, ${report.unexpectedPasses} unexpectedly passing, ` +
      `${report.skipped} skipped; ${report.total} total in ${report.durationMs}ms)`,
  ];
  for (const r of report.results) {
    if (r.outcome === "fail" || r.outcome === "error" || r.outcome === "xpass") {
      lines.push(`  ✗ [${r.outcome}] ${r.id}`);
      if (r.outcome === "xpass") {
        lines.push('      known issue now behaves correctly; set status to "active"');
      }
      for (const m of r.mismatches) lines.push(`      ${m}`);
      if (r.error) lines.push(`      error: ${r.error}`);
    }
  }
  return lines.join("\n");
}
