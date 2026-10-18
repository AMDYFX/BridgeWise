import { RouteSimulationDifferentialService } from './route-simulation-differential.service';
import {
  ISimulationEngine,
  RouteSimulationTarget,
} from './route-simulation-differential.types';

describe('RouteSimulationDifferentialService (#1282)', () => {
  let service: RouteSimulationDifferentialService;

  const mockRoute: RouteSimulationTarget = {
    routeId: 'route-eth-opt-1',
    sourceChainId: 1,
    destinationChainId: 10,
    sourceAsset: 'USDC',
    destinationAsset: 'USDC',
    inputAmount: '1000',
    expectedOutputAmount: '998',
    steps: [
      {
        stepIndex: 0,
        protocol: 'Across',
        action: 'bridge',
        sourceAsset: 'USDC',
        targetAsset: 'USDC',
        expectedInput: '1000',
        expectedOutput: '998',
        gasEstimate: '150000',
      },
    ],
  };

  beforeEach(() => {
    service = new RouteSimulationDifferentialService({
      maxAllowedOutputDivergenceBps: 20, // 0.20%
      maxAllowedFeeDivergenceBps: 200, // 2.0%
      requireRevertConsensus: true,
      minRequiredEngines: 2,
    });
  });

  it('calculates divergence in basis points accurately', () => {
    // 1000 vs 999 -> delta is 1 -> 1 * 10000 / 1000 = 10 bps
    const bps = service.calculateDivergenceBps('1000', '999');
    expect(bps).toBe(10);
  });

  it('rejects if available simulation engines are below required minimum', async () => {
    const singleEngine: ISimulationEngine = {
      engineId: 'engine-tenderly',
      simulate: jest.fn().mockResolvedValue({
        engineId: 'engine-tenderly',
        success: true,
        simulatedOutputAmount: '998',
        executionDurationMs: 120,
      }),
    };
    service.registerEngine(singleEngine);

    const report = await service.evaluateRouteDifferential(mockRoute);
    expect(report.status).toBe('INSUFFICIENT_ENGINES');
    expect(report.isAcceptable).toBe(false);
  });

  it('matches when both engines report identical or near-identical results within bounds', async () => {
    const engineA: ISimulationEngine = {
      engineId: 'engine-tenderly',
      simulate: jest.fn().mockResolvedValue({
        engineId: 'engine-tenderly',
        success: true,
        simulatedOutputAmount: '998.0',
        simulatedFeeAmount: '2.0',
        executionDurationMs: 150,
      }),
    };
    const engineB: ISimulationEngine = {
      engineId: 'engine-alchemy',
      simulate: jest.fn().mockResolvedValue({
        engineId: 'engine-alchemy',
        success: true,
        simulatedOutputAmount: '997.9', // ~1 bps divergence, well below 20 bps
        simulatedFeeAmount: '2.01',
        executionDurationMs: 180,
      }),
    };

    service.registerEngine(engineA);
    service.registerEngine(engineB);

    const report = await service.evaluateRouteDifferential(mockRoute);
    expect(report.status).toBe('MATCH');
    expect(report.isAcceptable).toBe(true);
    expect(report.outputDivergenceBps).toBeLessThanOrEqual(20);
    expect(report.diagnosticEvidence.recommendedAction).toBe('PROCEED');
  });

  it('detects output divergence when engines return conflicting output amounts', async () => {
    const engineA: ISimulationEngine = {
      engineId: 'engine-tenderly',
      simulate: jest.fn().mockResolvedValue({
        engineId: 'engine-tenderly',
        success: true,
        simulatedOutputAmount: '998.0',
        simulatedFeeAmount: '2.0',
        executionDurationMs: 120,
      }),
    };
    const engineB: ISimulationEngine = {
      engineId: 'engine-alchemy',
      simulate: jest.fn().mockResolvedValue({
        engineId: 'engine-alchemy',
        success: true,
        simulatedOutputAmount: '970.0', // ~280 bps divergence, exceeds 20 bps
        simulatedFeeAmount: '2.0',
        executionDurationMs: 110,
      }),
    };

    service.registerEngine(engineA);
    service.registerEngine(engineB);

    const report = await service.evaluateRouteDifferential(mockRoute);
    expect(report.status).toBe('DIVERGENT_OUTPUT');
    expect(report.isAcceptable).toBe(false);
    expect(report.diagnosticEvidence.recommendedAction).toBe('REJECT_ROUTE');
  });

  it('detects revert mismatch when one engine succeeds and another reverts', async () => {
    const engineA: ISimulationEngine = {
      engineId: 'engine-tenderly',
      simulate: jest.fn().mockResolvedValue({
        engineId: 'engine-tenderly',
        success: true,
        simulatedOutputAmount: '998.0',
        executionDurationMs: 140,
      }),
    };
    const engineB: ISimulationEngine = {
      engineId: 'engine-alchemy',
      simulate: jest.fn().mockResolvedValue({
        engineId: 'engine-alchemy',
        success: false,
        revertReason: 'TRANSFER_FAILED',
        executionDurationMs: 90,
      }),
    };

    service.registerEngine(engineA);
    service.registerEngine(engineB);

    const report = await service.evaluateRouteDifferential(mockRoute);
    expect(report.status).toBe('REVERT_MISMATCH');
    expect(report.isAcceptable).toBe(false);
    expect(report.diagnosticEvidence.agreedOnRevert).toBe(false);
    expect(report.diagnosticEvidence.recommendedAction).toBe('REJECT_ROUTE');
  });

  it('handles simulated engine crash/exception gracefully and records evidence', async () => {
    const engineA: ISimulationEngine = {
      engineId: 'engine-tenderly',
      simulate: jest.fn().mockResolvedValue({
        engineId: 'engine-tenderly',
        success: true,
        simulatedOutputAmount: '998.0',
        executionDurationMs: 100,
      }),
    };
    const engineB: ISimulationEngine = {
      engineId: 'engine-crashing',
      simulate: jest.fn().mockRejectedValue(new Error('RPC_TIMEOUT')),
    };

    service.registerEngine(engineA);
    service.registerEngine(engineB);

    const report = await service.evaluateRouteDifferential(mockRoute);
    expect(report.isAcceptable).toBe(false);
    expect(report.engineResults.some((r) => r.revertReason?.includes('RPC_TIMEOUT'))).toBe(true);
  });
});
