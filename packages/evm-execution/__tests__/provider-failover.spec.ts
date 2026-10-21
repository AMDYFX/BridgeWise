import { EVMProviderFailoverManager } from '../src/provider-failover';

describe('EVM Execution Provider Failover & Health Scoring (#1317)', () => {
  let failoverManager: EVMProviderFailoverManager;

  beforeEach(() => {
    failoverManager = new EVMProviderFailoverManager([
      { id: 'primary-node', url: 'https://rpc.primary.test' },
      { id: 'secondary-node', url: 'https://rpc.secondary.test' },
    ], {
      maxConsecutiveFailures: 2,
      cooldownPeriodMs: 1000, // 1 second for test speed
    });
  });

  it('should select the healthy primary node by default', () => {
    const best = failoverManager.getBestProvider();
    expect(best.id).toBe('primary-node');
  });

  it('should failover to secondary node when primary exceeds max consecutive failures', () => {
    // Fail primary node twice
    failoverManager.recordFailure('primary-node', 'ETIMEDOUT');
    failoverManager.recordFailure('primary-node', 'ETIMEDOUT');

    const statuses = failoverManager.getNodeStatus();
    expect(statuses.find((s) => s.id === 'primary-node')?.failures).toBe(2);

    // Should failover to secondary node
    const best = failoverManager.getBestProvider();
    expect(best.id).toBe('secondary-node');
  });

  it('should recover primary node after cooldown period expires', async () => {
    // Fail primary node to trigger cooldown
    failoverManager.recordFailure('primary-node', 'Server Error');
    failoverManager.recordFailure('primary-node', 'Server Error');
    expect(failoverManager.getBestProvider().id).toBe('secondary-node');

    // Wait for cooldown period (1000ms)
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Primary should be available for trial recovery
    const best = failoverManager.getBestProvider();
    expect(best.id).toBe('primary-node');
  });

  it('should reward successful requests and increase health score', () => {
    failoverManager.recordSuccess('primary-node', 35);
    const status = failoverManager.getNodeStatus().find((s) => s.id === 'primary-node');
    expect(status?.healthScore).toBe(100); // capped at 100
    expect(status?.avgLatencyMs).toBe(47); // weighted rolling average (50*4 + 35)/5
  });
});