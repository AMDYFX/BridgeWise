import { ethers } from 'ethers';

export interface ProviderNode {
  id: string;
  url: string;
  provider: ethers.JsonRpcProvider;
  healthScore: number;       // 0 to 100
  consecutiveFailures: number;
  lastFailureTime?: number;
  avgLatencyMs: number;
}

export interface FailoverConfig {
  maxConsecutiveFailures: number;
  cooldownPeriodMs: number;
  recoveryWeightBonus: number;
}

export class EVMProviderFailoverManager {
  private nodes: ProviderNode[] = [];
  private readonly config: FailoverConfig;

  constructor(nodes: { id: string; url: string; weight?: number }[], config?: Partial<FailoverConfig>) {
    this.config = {
      maxConsecutiveFailures: 3,
      cooldownPeriodMs: 60 * 1000, // 1 minute cooldown
      recoveryWeightBonus: 10,
      ...config,
    };

    this.nodes = nodes.map((n) => ({
      id: n.id,
      url: n.url,
      provider: new ethers.JsonRpcProvider(n.url),
      healthScore: 100,
      consecutiveFailures: 0,
      avgLatencyMs: 50, // Initial baseline
    }));
  }

  /**
   * Retrieves the healthiest available provider node, bypassing nodes in cooldown. (#1317)
   */
  public getBestProvider(): { id: string; provider: ethers.JsonRpcProvider } {
    const now = Date.now();

    // Reset or filter nodes out of cooldown if needed
    const availableNodes = this.nodes.filter((node) => {
      if (node.consecutiveFailures >= this.config.maxConsecutiveFailures) {
        if (node.lastFailureTime && now - node.lastFailureTime > this.config.cooldownPeriodMs) {
          // Cooldown expired, permit trial recovery
          node.consecutiveFailures = 0;
          node.healthScore = Math.min(100, node.healthScore + this.config.recoveryWeightBonus);
          console.info(`[PROVIDER_RECOVERY] Node ${node.id} exiting cooldown. Trial health score restored to ${node.healthScore}`);
          return true;
        }
        return false;
      }
      return true;
    });

    if (availableNodes.length === 0) {
      console.error('[PROVIDER_FAILOVER_FATAL] All RPC provider nodes are currently unhealthy or in cooldown!');
      // Fallback to primary node as last resort
      return { id: this.nodes[0].id, provider: this.nodes[0].provider };
    }

    // Sort by highest health score, then lowest latency
    availableNodes.sort((a, b) => {
      if (b.healthScore !== a.healthScore) {
        return b.healthScore - a.healthScore;
      }
      return a.avgLatencyMs - b.avgLatencyMs;
    });

    return { id: availableNodes[0].id, provider: availableNodes[0].provider };
  }

  /**
   * Records a successful RPC request, improving health score and latency metrics. (#1317)
   */
  public recordSuccess(nodeId: string, latencyMs: number): void {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node) return;

    node.consecutiveFailures = 0;
    node.avgLatencyMs = Math.round((node.avgLatencyMs * 4 + latencyMs) / 5); // Rolling average
    node.healthScore = Math.min(100, node.healthScore + 2);
  }

  /**
   * Records an RPC failure or timeout, penalizing health score and triggering failover logic. (#1317)
   */
  public recordFailure(nodeId: string, errorReason: string): void {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node) return;

    node.consecutiveFailures++;
    node.healthScore = Math.max(0, node.healthScore - 25);
    node.lastFailureTime = Date.now();

    console.warn(`[PROVIDER_FAILURE] Node ${node.id} failed (consecutive: ${node.consecutiveFailures}, health: ${node.healthScore}). Reason: ${errorReason}`);

    if (node.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      console.error(`[PROVIDER_FAILOVER] Node ${node.id} has exceeded max failures. Entering ${this.config.cooldownPeriodMs}ms cooldown.`);
    }
  }

  public getNodeStatus(): Array<{ id: string; healthScore: number; failures: number; avgLatencyMs: number }> {
    return this.nodes.map((n) => ({
      id: n.id,
      healthScore: n.healthScore,
      failures: n.consecutiveFailures,
      avgLatencyMs: n.avgLatencyMs,
    }));
  }
}