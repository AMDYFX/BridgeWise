/**
 * Built-in conformance cases every route provider must satisfy.
 *
 * Cases are pure functions over a {@link ConformanceFixture}.  They perform
 * no I/O of their own — all dependencies (provider stub, edges, options) are
 * supplied by the fixture so assertions are fully deterministic.
 */

import { PathFinder } from "../path-finder";
import { ConformanceCase, ConformanceFixture } from "./types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function assertEdgesBelongToProvider(
  fixture: ConformanceFixture,
  edges: Awaited<ReturnType<ConformanceFixture["provider"]["getEdges"]>>,
): string[] {
  const mismatches: string[] = [];
  for (const edge of edges) {
    if (edge.provider !== fixture.provider.name) {
      mismatches.push(
        `edge ${edge.sourceNode}->${edge.targetNode} has provider "${edge.provider}" ` +
          `but provider.name is "${fixture.provider.name}"`,
      );
    }
  }
  return mismatches;
}

function assertNoDuplicateEdges(edges: Awaited<ReturnType<ConformanceFixture["provider"]["getEdges"]>>): string[] {
  const seen = new Set<string>();
  const mismatches: string[] = [];
  for (const e of edges) {
    const key = `${e.sourceNode}|${e.targetNode}|${e.provider}`;
    if (seen.has(key)) {
      mismatches.push(`duplicate edge detected: ${key}`);
    } else {
      seen.add(key);
    }
  }
  return mismatches;
}

// ─── Cases ────────────────────────────────────────────────────────────────────

/**
 * All built-in conformance cases.
 *
 * The suite runner executes each case in order against the supplied fixture.
 * Add chain-specific or provider-specific cases by appending to this array or
 * passing extra cases to {@link runConformanceSuite}.
 */
export const BUILT_IN_CASES: ConformanceCase[] = [
  // ── supportsRoute ──────────────────────────────────────────────────────────

  {
    id: "supports-route-returns-boolean",
    description: "supportsRoute() must return a boolean (not truthy / falsy).",
    tags: ["contract", "supports-route"],
    status: "active",
    async assert(fixture) {
      const result = fixture.provider.supportsRoute("stellar", "ethereum", "USDC");
      if (typeof result !== "boolean") {
        return [`supportsRoute() returned ${typeof result}, expected boolean`];
      }
      return [];
    },
  },

  {
    id: "supports-route-consistent-with-edges",
    description:
      "When supportsRoute() returns true the provider must supply at least one active edge for that pair.",
    tags: ["contract", "supports-route", "consistency"],
    status: "active",
    async assert(fixture) {
      const mismatches: string[] = [];
      const [sourceChain, targetChain, asset] = ["stellar", "ethereum", "USDC"];
      const supports = fixture.provider.supportsRoute(sourceChain, targetChain, asset);
      if (!supports) return [];

      if (fixture.simulateGetEdgesFailure) return [];

      const edges = await fixture.provider.getEdges(sourceChain, targetChain, asset);
      const activeEdges = edges.filter((e) => e.isActive);
      if (activeEdges.length === 0) {
        mismatches.push(
          `supportsRoute("${sourceChain}", "${targetChain}", "${asset}") returned true ` +
            `but getEdges returned no active edges`,
        );
      }
      return mismatches;
    },
  },

  {
    id: "supports-route-same-chain-returns-false",
    description: "supportsRoute() must return false when source and target chains are identical.",
    tags: ["contract", "supports-route", "chain-boundary"],
    status: "active",
    async assert(fixture) {
      const result = fixture.provider.supportsRoute("stellar", "stellar", "USDC");
      if (result === true) {
        return [`supportsRoute("stellar", "stellar", ...) must return false; same-chain transfers are not bridge routes`];
      }
      return [];
    },
  },

  // ── getEdges ───────────────────────────────────────────────────────────────

  {
    id: "get-edges-returns-array",
    description: "getEdges() must resolve to an Array (never null / undefined).",
    tags: ["contract", "get-edges"],
    status: "active",
    async assert(fixture) {
      if (fixture.simulateGetEdgesFailure) return [];
      const result = await fixture.provider.getEdges("stellar", "ethereum", "USDC");
      if (!Array.isArray(result)) {
        return [`getEdges() resolved to ${typeof result}, expected an Array`];
      }
      return [];
    },
  },

  {
    id: "get-edges-provider-name-matches",
    description: "Every edge returned by getEdges() must carry the provider's own name.",
    tags: ["contract", "get-edges", "asset-boundary"],
    status: "active",
    async assert(fixture) {
      if (fixture.simulateGetEdgesFailure) return [];
      const edges = await fixture.provider.getEdges("stellar", "ethereum", "USDC");
      return assertEdgesBelongToProvider(fixture, edges);
    },
  },

  {
    id: "get-edges-no-duplicate-edges",
    description: "getEdges() must not return duplicate edges (same sourceNode + targetNode + provider).",
    tags: ["contract", "get-edges", "idempotency"],
    status: "active",
    async assert(fixture) {
      if (fixture.simulateGetEdgesFailure) return [];
      const edges = await fixture.provider.getEdges("stellar", "ethereum", "USDC");
      return assertNoDuplicateEdges(edges);
    },
  },

  {
    id: "get-edges-idempotent",
    description: "Calling getEdges() twice returns structurally identical results (idempotency).",
    tags: ["contract", "get-edges", "idempotency"],
    status: "active",
    async assert(fixture) {
      if (fixture.simulateGetEdgesFailure) return [];
      const first = await fixture.provider.getEdges("stellar", "ethereum", "USDC");
      const second = await fixture.provider.getEdges("stellar", "ethereum", "USDC");
      const mismatches: string[] = [];

      if (first.length !== second.length) {
        mismatches.push(`getEdges() length changed between calls: ${first.length} → ${second.length}`);
        return mismatches;
      }
      for (let i = 0; i < first.length; i++) {
        const a = first[i];
        const b = second[i];
        if (a.sourceNode !== b.sourceNode || a.targetNode !== b.targetNode || a.provider !== b.provider) {
          mismatches.push(`getEdges()[${i}] differs between calls`);
        }
        if (a.fee !== b.fee) {
          mismatches.push(`getEdges()[${i}].fee changed between calls: ${a.fee} → ${b.fee}`);
        }
      }
      return mismatches;
    },
  },

  {
    id: "get-edges-failure-does-not-corrupt-router",
    description:
      "When getEdges() rejects, the PathFinder built from the surviving edges must still resolve routes correctly.",
    tags: ["failure", "recovery", "get-edges"],
    status: "active",
    async assert(fixture) {
      if (!fixture.simulateGetEdgesFailure) return [];

      // Simulate partial failure: provider throws, we fall back to an empty edge set.
      let edges: import("../types").GraphEdge[] = [];
      try {
        edges = await fixture.provider.getEdges("stellar", "ethereum", "USDC");
      } catch {
        edges = [];
      }

      const finder = new PathFinder();
      finder.buildGraph(edges);
      // Router must not throw when the graph is empty.
      const result = finder.findPath("USDC:stellar", "USDC:ethereum", { strategy: "cheapest" });
      if (result !== null) {
        return [
          `expected PathFinder to return null for empty graph (provider failure), got a route with ${result.totalHops} hop(s)`,
        ];
      }
      return [];
    },
  },

  // ── ping / health-gate ─────────────────────────────────────────────────────

  {
    id: "ping-returns-health-result",
    description: "ping() must resolve to an object with an ok boolean and a numeric latencyMs.",
    tags: ["contract", "health"],
    status: "active",
    async assert(fixture) {
      const result = await fixture.provider.ping();
      const mismatches: string[] = [];
      if (typeof result.ok !== "boolean") {
        mismatches.push(`ping().ok must be boolean, got ${typeof result.ok}`);
      }
      if (typeof result.latencyMs !== "number" || result.latencyMs < 0) {
        mismatches.push(`ping().latencyMs must be a non-negative number, got ${result.latencyMs}`);
      }
      if (!result.ok && (result.reason === undefined || result.reason === "")) {
        mismatches.push("ping().reason must be set when ping().ok is false");
      }
      return mismatches;
    },
  },

  {
    id: "ping-healthy-provider-ok-true",
    description: "A healthy provider's ping() must resolve with ok === true.",
    tags: ["health", "happy-path"],
    status: "active",
    async assert(fixture) {
      if (fixture.providerHealthy === false) return [];
      const result = await fixture.provider.ping();
      if (!result.ok) {
        return [`healthy provider ping() returned ok=false: ${result.reason}`];
      }
      return [];
    },
  },

  {
    id: "ping-unhealthy-provider-ok-false",
    description: "An unhealthy provider's ping() must resolve with ok === false and a non-empty reason.",
    tags: ["health", "failure"],
    status: "active",
    async assert(fixture) {
      if (fixture.providerHealthy !== false) return [];
      const result = await fixture.provider.ping();
      if (result.ok) {
        return ["unhealthy provider ping() returned ok=true"];
      }
      if (!result.reason) {
        return ["unhealthy provider ping() must include a reason string"];
      }
      return [];
    },
  },

  // ── chain / asset boundary ─────────────────────────────────────────────────

  {
    id: "edges-respect-asset-boundary",
    description: "Edges must not silently swap assets between source and target nodes.",
    tags: ["asset-boundary", "get-edges"],
    status: "active",
    async assert(fixture) {
      if (fixture.simulateGetEdgesFailure) return [];
      const edges = await fixture.provider.getEdges("stellar", "ethereum", "USDC");
      const mismatches: string[] = [];
      for (const edge of edges) {
        const srcAsset = edge.sourceNode.split(":")[0];
        const tgtAsset = edge.targetNode.split(":")[0];
        if (srcAsset && tgtAsset && srcAsset !== tgtAsset) {
          mismatches.push(
            `asset mismatch on edge ${edge.sourceNode}->${edge.targetNode}: ` +
              `source asset "${srcAsset}" ≠ target asset "${tgtAsset}"`,
          );
        }
      }
      return mismatches;
    },
  },

  {
    id: "edges-positive-fee-and-latency",
    description: "Every edge must have fee >= 0 and latencyMs > 0.",
    tags: ["contract", "get-edges", "boundary"],
    status: "active",
    async assert(fixture) {
      if (fixture.simulateGetEdgesFailure) return [];
      const edges = await fixture.provider.getEdges("stellar", "ethereum", "USDC");
      const mismatches: string[] = [];
      for (const edge of edges) {
        if (edge.fee < 0) {
          mismatches.push(`edge ${edge.sourceNode}->${edge.targetNode} has negative fee: ${edge.fee}`);
        }
        if (edge.latencyMs <= 0) {
          mismatches.push(
            `edge ${edge.sourceNode}->${edge.targetNode} has non-positive latencyMs: ${edge.latencyMs}`,
          );
        }
        if (edge.liquidity < 0) {
          mismatches.push(
            `edge ${edge.sourceNode}->${edge.targetNode} has negative liquidity: ${edge.liquidity}`,
          );
        }
      }
      return mismatches;
    },
  },

  // ── routing integration ────────────────────────────────────────────────────

  {
    id: "fixture-edges-routable-by-pathfinder",
    description:
      "When the fixture supplies at least one active edge the PathFinder must return a route between source and target.",
    tags: ["integration", "routing"],
    status: "active",
    async assert(fixture) {
      if (fixture.simulateGetEdgesFailure) return [];
      if (fixture.edges.length === 0) return [];

      const finder = new PathFinder();
      finder.buildGraph(fixture.edges);

      const firstEdge = fixture.edges.find((e) => e.isActive);
      if (!firstEdge) return [];

      const result = finder.findPath(firstEdge.sourceNode, firstEdge.targetNode, fixture.routingOptions);
      if (!result) {
        return [
          `PathFinder returned null for ${firstEdge.sourceNode} → ${firstEdge.targetNode} ` +
            `even though a matching active edge exists`,
        ];
      }
      return [];
    },
  },
];
