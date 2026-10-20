import {
  RoutingGraph,
  OptimalRoute,
  HopDetails,
  GraphNode,
  GraphEdge,
} from './graph-builder';

export interface RedisCacheAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec?: number): Promise<void>;
}

export class InMemoryRedisMockAdapter implements RedisCacheAdapter {
  private store = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSec = 60): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSec * 1000,
    });
  }

  clear(): void {
    this.store.clear();
  }
}

export class DAGPathfinder {
  private graph: RoutingGraph;
  private cache: RedisCacheAdapter;

  constructor(graph: RoutingGraph, cacheAdapter?: RedisCacheAdapter) {
    this.graph = graph;
    this.cache = cacheAdapter || new InMemoryRedisMockAdapter();
  }

  public updateGraph(graph: RoutingGraph): void {
    this.graph = graph;
  }

  /**
   * Calculates price impact as percentage loss due to fees and exchange rate slippage.
   * Price impact = ((inputAmount - outputAmount) / inputAmount) * 100
   */
  private calculatePriceImpact(inputAmount: number, outputAmount: number): number {
    if (inputAmount <= 0) return 0;
    const impact = ((inputAmount - outputAmount) / inputAmount) * 100;
    return Math.max(0, impact);
  }

  /**
   * Validates that price impact is within acceptable thresholds.
   * Rejects routes with excessive price impact (>5% by default).
   */
  private validatePriceImpact(priceImpact: number, maxThreshold = 5): boolean {
    return priceImpact <= maxThreshold;
  }

  /**
   * Calculates optimal multi-hop execution route using depth-limited search (maxHops <= 3).
   * Accounts for bridge fees, gas costs, and intermediate gas token conversions.
   * Includes price impact estimation safeguards.
   */
  public async findOptimalRoute(
    sourceNodeId: string,
    targetNodeId: string,
    inputAmount: number,
    maxHops = 3
  ): Promise<OptimalRoute | null> {
    const startTime = performance.now();

    if (inputAmount <= 0) {
      throw new Error('Input amount must be greater than zero');
    }

    const cacheKey = `route:${sourceNodeId}:${targetNodeId}:${inputAmount}:${maxHops}`;
    const cachedResult = await this.cache.get(cacheKey);
    if (cachedResult) {
      const parsed: OptimalRoute = JSON.parse(cachedResult);
      parsed.executionTimeMs = Math.round(performance.now() - startTime);
      return parsed;
    }

    const sourceNode = this.graph.nodes.get(sourceNodeId);
    const targetNode = this.graph.nodes.get(targetNodeId);

    if (!sourceNode || !targetNode) {
      return null;
    }

    let bestRoute: OptimalRoute | null = null;
    let maxOutputAmount = -1;

    const dfs = (
      currentNodeId: string,
      currentAmount: number,
      pathNodes: GraphNode[],
      pathEdges: GraphEdge[],
      visitedNodeIds: Set<string>,
      depth: number
    ) => {
      if (depth > maxHops) {
        return;
      }

      if (currentNodeId === targetNodeId) {
        // Calculate totals for this complete pathway
        const hops: HopDetails[] = [];
        let accumulatedAmount = inputAmount;
        let totalGasCostUsd = 0;
        let totalBridgeFeeUsd = 0;
        let totalEstimatedTimeSec = 0;

        for (let i = 0; i < pathEdges.length; i++) {
          const edge = pathEdges[i];
          const fromNode = pathNodes[i];
          const toNode = pathNodes[i + 1];

          // Check if intermediate hop requires gas token conversion cost
          const gasConversionCost = edge.requiresGasConversion
            ? edge.intermediateGasTokenCostUsd || 1.5
            : 0;

          const hopGasCost = edge.gasCostUsd + gasConversionCost;
          const hopBridgeFee = edge.bridgeFeeUsd;
          const nextAmount = accumulatedAmount * edge.exchangeRate;

          // Calculate hop-level price impact
          const hopPriceImpact = this.calculatePriceImpact(accumulatedAmount, nextAmount);

          totalGasCostUsd += hopGasCost;
          totalBridgeFeeUsd += hopBridgeFee;
          totalEstimatedTimeSec += edge.estimatedTimeSec;

          hops.push({
            fromNode,
            toNode,
            protocol: edge.protocol,
            bridgeFeeUsd: hopBridgeFee,
            gasCostUsd: hopGasCost,
            exchangeRate: edge.exchangeRate,
            inputAmount: accumulatedAmount,
            outputAmount: nextAmount,
            estimatedTimeSec: edge.estimatedTimeSec,
            priceImpactPercentage: hopPriceImpact,
          });

          accumulatedAmount = nextAmount;
        }

        const totalCostUsd = totalGasCostUsd + totalBridgeFeeUsd;
        const totalPriceImpact = this.calculatePriceImpact(inputAmount, accumulatedAmount);

        // Price impact safeguard: reject routes with excessive price impact
        if (!this.validatePriceImpact(totalPriceImpact)) {
          return;
        }

        if (accumulatedAmount > maxOutputAmount) {
          maxOutputAmount = accumulatedAmount;
          bestRoute = {
            path: pathNodes,
            hops,
            totalInputAmount: inputAmount,
            totalOutputAmount: accumulatedAmount,
            totalGasCostUsd,
            totalBridgeFeeUsd,
            totalCostUsd,
            totalEstimatedTimeSec,
            executionTimeMs: 0,
            totalPriceImpactPercentage: totalPriceImpact,
          };
        }
        return;
      }

      const edges = this.graph.adjacency.get(currentNodeId) || [];
      for (const edge of edges) {
        const nextNodeId = edge.toNodeId;
        if (visitedNodeIds.has(nextNodeId)) {
          continue; // Prevent cycles
        }

        const nextNode = this.graph.nodes.get(nextNodeId);
        if (!nextNode) continue;

        visitedNodeIds.add(nextNodeId);
        const nextAmount = currentAmount * edge.exchangeRate;

        dfs(
          nextNodeId,
          nextAmount,
          [...pathNodes, nextNode],
          [...pathEdges, edge],
          visitedNodeIds,
          depth + 1
        );

        visitedNodeIds.delete(nextNodeId);
      }
    };

    const initialVisited = new Set<string>([sourceNodeId]);
    dfs(sourceNodeId, inputAmount, [sourceNode], [], initialVisited, 0);

    const endTime = performance.now();
    const executionTimeMs = Number((endTime - startTime).toFixed(2));

    if (bestRoute) {
      (bestRoute as OptimalRoute).executionTimeMs = executionTimeMs;
      await this.cache.set(cacheKey, JSON.stringify(bestRoute), 30);
    }

    return bestRoute;
  }
}
