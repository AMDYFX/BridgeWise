/**
 * Route-provider conformance suite tests.
 *
 * Drives the conformance runner with deterministic fixtures to verify every
 * built-in case covers the expected scenarios (happy-path, failure injection,
 * boundary checks, chain/asset boundary enforcement, idempotency).
 */

import { runConformanceSuite, formatConformanceReport, BUILT_IN_CASES } from "../conformance";
import type {
  ConformanceFixture,
  ConformanceCase,
  RouteProvider,
  ProviderHealthResult,
} from "../conformance";
import type { GraphEdge } from "../types";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeEdge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    sourceNode: "USDC:stellar",
    targetNode: "USDC:ethereum",
    provider: "stub-bridge",
    fee: 0.5,
    latencyMs: 15000,
    liquidity: 10000,
    isActive: true,
    ...overrides,
  };
}

function makeProvider(overrides: Partial<RouteProvider> = {}): RouteProvider {
  return {
    name: "stub-bridge",
    supportsRoute: (src, tgt) => src !== tgt,
    getEdges: async () => [makeEdge()],
    ping: async (): Promise<ProviderHealthResult> => ({ ok: true, latencyMs: 10 }),
    ...overrides,
  };
}

function makeFixture(overrides: Partial<ConformanceFixture> = {}): ConformanceFixture {
  return {
    provider: makeProvider(),
    edges: [makeEdge()],
    routingOptions: { strategy: "cheapest" },
    providerHealthy: true,
    simulatedLatencyMs: 0,
    ...overrides,
  };
}

// ─── Suite runner: happy-path ─────────────────────────────────────────────────

describe("runConformanceSuite — happy-path fixture", () => {
  it("reports ok=true for a well-behaved provider", async () => {
    const report = await runConformanceSuite(makeFixture());
    expect(report.ok).toBe(true);
    expect(report.failed).toBe(0);
    expect(report.errored).toBe(0);
    expect(report.total).toBeGreaterThan(0);
  });

  it("suite name defaults to provider.name", async () => {
    const report = await runConformanceSuite(makeFixture());
    expect(report.suite).toBe("stub-bridge");
  });

  it("suite name can be overridden", async () => {
    const report = await runConformanceSuite(makeFixture(), [], { suiteName: "my-suite" });
    expect(report.suite).toBe("my-suite");
  });

  it("all built-in cases are represented in results", async () => {
    const report = await runConformanceSuite(makeFixture());
    const resultIds = new Set(report.results.map((r) => r.id));
    for (const c of BUILT_IN_CASES) {
      expect(resultIds.has(c.id)).toBe(true);
    }
  });
});

// ─── supportsRoute ────────────────────────────────────────────────────────────

describe("case: supports-route-returns-boolean", () => {
  it("passes when supportsRoute returns boolean", async () => {
    const report = await runConformanceSuite(makeFixture());
    const r = report.results.find((x) => x.id === "supports-route-returns-boolean")!;
    expect(r.outcome).toBe("pass");
  });

  it("fails when supportsRoute returns a non-boolean truthy value", async () => {
    const provider = makeProvider({
      // @ts-expect-error intentionally returning wrong type for test
      supportsRoute: () => 1,
    });
    const report = await runConformanceSuite(makeFixture({ provider }));
    const r = report.results.find((x) => x.id === "supports-route-returns-boolean")!;
    expect(r.outcome).toBe("fail");
    expect(r.mismatches[0]).toMatch(/expected boolean/);
  });
});

describe("case: supports-route-same-chain-returns-false", () => {
  it("passes when supportsRoute(x, x) returns false", async () => {
    const report = await runConformanceSuite(makeFixture());
    const r = report.results.find((x) => x.id === "supports-route-same-chain-returns-false")!;
    expect(r.outcome).toBe("pass");
  });

  it("fails when supportsRoute(x, x) returns true", async () => {
    const provider = makeProvider({ supportsRoute: () => true });
    const report = await runConformanceSuite(makeFixture({ provider }));
    const r = report.results.find((x) => x.id === "supports-route-same-chain-returns-false")!;
    expect(r.outcome).toBe("fail");
    expect(r.mismatches[0]).toMatch(/same-chain transfers are not bridge routes/);
  });
});

// ─── getEdges ─────────────────────────────────────────────────────────────────

describe("case: get-edges-returns-array", () => {
  it("passes for a provider returning an array", async () => {
    const report = await runConformanceSuite(makeFixture());
    const r = report.results.find((x) => x.id === "get-edges-returns-array")!;
    expect(r.outcome).toBe("pass");
  });

  it("fails when getEdges returns null", async () => {
    const provider = makeProvider({
      // @ts-expect-error intentionally wrong return type
      getEdges: async () => null,
    });
    const report = await runConformanceSuite(makeFixture({ provider }));
    const r = report.results.find((x) => x.id === "get-edges-returns-array")!;
    expect(r.outcome).toBe("fail");
  });
});

describe("case: get-edges-provider-name-matches", () => {
  it("passes when all edges carry the provider name", async () => {
    const report = await runConformanceSuite(makeFixture());
    const r = report.results.find((x) => x.id === "get-edges-provider-name-matches")!;
    expect(r.outcome).toBe("pass");
  });

  it("fails when an edge has a mismatched provider field", async () => {
    const provider = makeProvider({
      getEdges: async () => [makeEdge({ provider: "different-bridge" })],
    });
    const report = await runConformanceSuite(makeFixture({ provider }));
    const r = report.results.find((x) => x.id === "get-edges-provider-name-matches")!;
    expect(r.outcome).toBe("fail");
    expect(r.mismatches[0]).toMatch(/provider "different-bridge"/);
  });
});

describe("case: get-edges-no-duplicate-edges", () => {
  it("passes when edges are unique", async () => {
    const report = await runConformanceSuite(makeFixture());
    const r = report.results.find((x) => x.id === "get-edges-no-duplicate-edges")!;
    expect(r.outcome).toBe("pass");
  });

  it("fails when duplicate edges are returned", async () => {
    const edge = makeEdge();
    const provider = makeProvider({ getEdges: async () => [edge, edge] });
    const report = await runConformanceSuite(makeFixture({ provider }));
    const r = report.results.find((x) => x.id === "get-edges-no-duplicate-edges")!;
    expect(r.outcome).toBe("fail");
    expect(r.mismatches[0]).toMatch(/duplicate edge/);
  });
});

describe("case: get-edges-idempotent", () => {
  it("passes for a deterministic provider", async () => {
    const report = await runConformanceSuite(makeFixture());
    const r = report.results.find((x) => x.id === "get-edges-idempotent")!;
    expect(r.outcome).toBe("pass");
  });

  it("fails when fee changes between calls", async () => {
    let call = 0;
    const provider = makeProvider({
      getEdges: async () => [makeEdge({ fee: ++call === 1 ? 1 : 2 })],
    });
    const report = await runConformanceSuite(makeFixture({ provider }));
    const r = report.results.find((x) => x.id === "get-edges-idempotent")!;
    expect(r.outcome).toBe("fail");
    expect(r.mismatches[0]).toMatch(/fee changed/);
  });
});

// ─── Failure / recovery ───────────────────────────────────────────────────────

describe("case: get-edges-failure-does-not-corrupt-router", () => {
  it("passes when fixture injects a failure and graph is empty", async () => {
    const provider = makeProvider({
      getEdges: async () => {
        throw new Error("provider unavailable");
      },
    });
    const report = await runConformanceSuite(
      makeFixture({ provider, simulateGetEdgesFailure: new Error("provider unavailable") }),
    );
    const r = report.results.find((x) => x.id === "get-edges-failure-does-not-corrupt-router")!;
    expect(r.outcome).toBe("pass");
  });
});

// ─── Health / ping ────────────────────────────────────────────────────────────

describe("case: ping-returns-health-result", () => {
  it("passes for a valid health result", async () => {
    const report = await runConformanceSuite(makeFixture());
    const r = report.results.find((x) => x.id === "ping-returns-health-result")!;
    expect(r.outcome).toBe("pass");
  });

  it("fails when latencyMs is negative", async () => {
    const provider = makeProvider({
      ping: async () => ({ ok: true, latencyMs: -1 }),
    });
    const report = await runConformanceSuite(makeFixture({ provider }));
    const r = report.results.find((x) => x.id === "ping-returns-health-result")!;
    expect(r.outcome).toBe("fail");
    expect(r.mismatches[0]).toMatch(/non-negative number/);
  });

  it("fails when ok=false but reason is missing", async () => {
    const provider = makeProvider({
      ping: async () => ({ ok: false, latencyMs: 100 }),
    });
    const report = await runConformanceSuite(makeFixture({ provider, providerHealthy: false }));
    const r = report.results.find((x) => x.id === "ping-returns-health-result")!;
    expect(r.outcome).toBe("fail");
    expect(r.mismatches[0]).toMatch(/reason must be set/);
  });
});

describe("case: ping-unhealthy-provider-ok-false", () => {
  it("passes when unhealthy fixture pings with ok=false and a reason", async () => {
    const provider = makeProvider({
      ping: async () => ({ ok: false, latencyMs: 500, reason: "endpoint offline" }),
    });
    const report = await runConformanceSuite(makeFixture({ provider, providerHealthy: false }));
    const r = report.results.find((x) => x.id === "ping-unhealthy-provider-ok-false")!;
    expect(r.outcome).toBe("pass");
  });

  it("fails when unhealthy fixture pings with ok=true", async () => {
    const provider = makeProvider({ ping: async () => ({ ok: true, latencyMs: 0 }) });
    const report = await runConformanceSuite(makeFixture({ provider, providerHealthy: false }));
    const r = report.results.find((x) => x.id === "ping-unhealthy-provider-ok-false")!;
    expect(r.outcome).toBe("fail");
  });
});

// ─── Asset/chain boundary ─────────────────────────────────────────────────────

describe("case: edges-respect-asset-boundary", () => {
  it("passes when source and target asset tokens match", async () => {
    const report = await runConformanceSuite(makeFixture());
    const r = report.results.find((x) => x.id === "edges-respect-asset-boundary")!;
    expect(r.outcome).toBe("pass");
  });

  it("fails when an edge swaps the asset silently", async () => {
    const provider = makeProvider({
      getEdges: async () => [makeEdge({ sourceNode: "USDC:stellar", targetNode: "USDT:ethereum" })],
    });
    const report = await runConformanceSuite(makeFixture({ provider }));
    const r = report.results.find((x) => x.id === "edges-respect-asset-boundary")!;
    expect(r.outcome).toBe("fail");
    expect(r.mismatches[0]).toMatch(/asset mismatch/);
  });
});

describe("case: edges-positive-fee-and-latency", () => {
  it("passes for positive fee and latency", async () => {
    const report = await runConformanceSuite(makeFixture());
    const r = report.results.find((x) => x.id === "edges-positive-fee-and-latency")!;
    expect(r.outcome).toBe("pass");
  });

  it("fails for negative fee", async () => {
    const provider = makeProvider({ getEdges: async () => [makeEdge({ fee: -0.1 })] });
    const report = await runConformanceSuite(makeFixture({ provider }));
    const r = report.results.find((x) => x.id === "edges-positive-fee-and-latency")!;
    expect(r.outcome).toBe("fail");
    expect(r.mismatches[0]).toMatch(/negative fee/);
  });

  it("fails for zero latency", async () => {
    const provider = makeProvider({ getEdges: async () => [makeEdge({ latencyMs: 0 })] });
    const report = await runConformanceSuite(makeFixture({ provider }));
    const r = report.results.find((x) => x.id === "edges-positive-fee-and-latency")!;
    expect(r.outcome).toBe("fail");
    expect(r.mismatches[0]).toMatch(/non-positive latencyMs/);
  });
});

// ─── Tag filtering ────────────────────────────────────────────────────────────

describe("tag filtering", () => {
  it("skips cases not matching includeTags", async () => {
    const report = await runConformanceSuite(makeFixture(), [], { includeTags: ["health"] });
    const skipped = report.results.filter((r) => r.outcome === "skipped");
    const run = report.results.filter((r) => r.outcome !== "skipped");
    expect(skipped.length).toBeGreaterThan(0);
    expect(run.every((r) => {
      const c = BUILT_IN_CASES.find((bc) => bc.id === r.id);
      return c?.tags.includes("health");
    })).toBe(true);
  });
});

// ─── Extra cases ──────────────────────────────────────────────────────────────

describe("extra cases", () => {
  it("appends custom cases to the built-in suite", async () => {
    const customCase: ConformanceCase = {
      id: "custom-noop",
      description: "always passes",
      tags: ["custom"],
      status: "active",
      assert: async () => [],
    };
    const report = await runConformanceSuite(makeFixture(), [customCase]);
    const r = report.results.find((x) => x.id === "custom-noop")!;
    expect(r).toBeDefined();
    expect(r.outcome).toBe("pass");
  });

  it("classifies known-issue custom cases as xfail when they fail", async () => {
    const brokenCase: ConformanceCase = {
      id: "custom-broken",
      description: "always fails",
      tags: ["custom"],
      status: "known-issue",
      issue: "tracked-123",
      assert: async () => ["intentional failure"],
    };
    const report = await runConformanceSuite(makeFixture(), [brokenCase]);
    const r = report.results.find((x) => x.id === "custom-broken")!;
    expect(r.outcome).toBe("xfail");
    expect(report.ok).toBe(true); // xfail does not fail the suite
  });

  it("classifies known-issue cases as xpass when they unexpectedly pass, failing the suite", async () => {
    const fixedCase: ConformanceCase = {
      id: "custom-fixed",
      description: "marked known-issue but now passes",
      tags: ["custom"],
      status: "known-issue",
      issue: "tracked-456",
      assert: async () => [],
    };
    const report = await runConformanceSuite(makeFixture(), [fixedCase]);
    const r = report.results.find((x) => x.id === "custom-fixed")!;
    expect(r.outcome).toBe("xpass");
    expect(report.ok).toBe(false);
  });
});

// ─── formatConformanceReport ──────────────────────────────────────────────────

describe("formatConformanceReport", () => {
  it("summarises a passing report", async () => {
    const report = await runConformanceSuite(makeFixture());
    const text = formatConformanceReport(report);
    expect(text).toMatch(/conformance \[stub-bridge\]: OK/);
    expect(text).toMatch(/passed/);
  });

  it("lists failing cases with their mismatches", async () => {
    const provider = makeProvider({
      // @ts-expect-error intentionally returning wrong type
      supportsRoute: () => 1,
    });
    const report = await runConformanceSuite(makeFixture({ provider }));
    const text = formatConformanceReport(report);
    expect(text).toMatch(/FAILED/);
    expect(text).toMatch(/supports-route-returns-boolean/);
    expect(text).toMatch(/expected boolean/);
  });
});
