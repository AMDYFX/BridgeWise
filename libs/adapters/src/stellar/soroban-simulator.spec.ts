import { SorobanSimulator } from './soroban-simulator';
import {
  InsufficientFootprintError,
  ResourceFeeCeilingExceededError,
  SimulationRevertError,
  SlippageExceededError,
} from './types/soroban-sim.types';

describe('SorobanSimulator Unit & Integration Tests (#714, #1331)', () => {
  let simulator: SorobanSimulator;

  beforeEach(() => {
    simulator = new SorobanSimulator({
      rpcUrl: 'https://soroban-testnet.stellar.org',
    });
  });

  it('should parse valid execution parameters for successful simulation', () => {
    const rawResult = {
      minResourceFee: '1200',
      outputAmount: '99.5',
      sorobanData: {
        resources: {
          footprint: {
            readOnly: ['CONTRACT_STATE_1'],
            readWrite: ['USER_BALANCE_1'],
          },
        },
      },
      simulatedOutput: 'SIMULATION_XDR_DATA',
    };

    const res = simulator.parseAndValidateSimulation(rawResult, {
      expectedMinOutput: '99.0',
      expectedFootprintKeys: ['CONTRACT_STATE_1', 'USER_BALANCE_1'],
    });

    expect(res.successful).toBe(true);
    expect(res.minResourceFee).toBe('1200');
    expect(res.simulatedOutput).toBe('SIMULATION_XDR_DATA');
  });

  it('should throw SlippageExceededError when output amount is below expected minimum', () => {
    const rawResult = {
      minResourceFee: '1000',
      outputAmount: '95.0',
    };

    expect(() =>
      simulator.parseAndValidateSimulation(rawResult, {
        expectedMinOutput: '98.0',
      }),
    ).toThrow(SlippageExceededError);
  });

  it('should throw InsufficientFootprintError when missing required footprint authorization keys', () => {
    const rawResult = {
      minResourceFee: '1000',
      sorobanData: {
        resources: {
          footprint: {
            readOnly: ['KEY_A'],
            readWrite: [],
          },
        },
      },
    };

    expect(() =>
      simulator.parseAndValidateSimulation(rawResult, {
        expectedFootprintKeys: ['KEY_A', 'KEY_MISSING_B'],
      }),
    ).toThrow(InsufficientFootprintError);
  });

  it('should throw SimulationRevertError on contract execution revert', () => {
    const rawResult = {
      error: 'Error(Contract, #102)',
      code: 102,
    };

    expect(() => simulator.parseAndValidateSimulation(rawResult)).toThrow(SimulationRevertError);
  });

  it('should simulate transaction async call successfully', async () => {
    const res = await simulator.simulateTransaction('AAAAAQ==');
    expect(res.successful).toBe(true);
    expect(res.minResourceFee).toBe('500');
  });

  describe('Resource Fee Ceiling Policy Integration (#1331)', () => {
    const mockCeilingService = {
      check: jest.fn((request: { network: string; resourceFeeStroops: number }) => {
        const ceiling = request.network === 'stellar-mainnet' ? 10_000_000 : 5_000_000;
        return {
          allowed: request.resourceFeeStroops <= ceiling,
          ceilingStroops: ceiling,
          violations: request.resourceFeeStroops > ceiling
            ? [{ code: 'EXCEEDS_CEILING', message: `Fee ${request.resourceFeeStroops} exceeds ceiling ${ceiling}` }]
            : [],
        };
      }),
    };

    it('should allow simulation when resource fee is below ceiling', () => {
      const rawResult = {
        minResourceFee: '1000',
        sorobanData: { resources: { footprint: { readOnly: [], readWrite: [] } } },
        simulatedOutput: 'SIMULATION_XDR_DATA',
      };

      const res = simulator.parseAndValidateSimulation(rawResult, {
        network: 'stellar-testnet',
        ceilingService: mockCeilingService,
      });

      expect(res.successful).toBe(true);
      expect(mockCeilingService.check).toHaveBeenCalledWith({
        network: 'stellar-testnet',
        resourceFeeStroops: 1000,
      });
    });

    it('should throw ResourceFeeCeilingExceededError when resource fee exceeds ceiling', () => {
      const rawResult = {
        minResourceFee: '6000000', // 6M stroops > 5M ceiling for testnet
        sorobanData: { resources: { footprint: { readOnly: [], readWrite: [] } } },
        simulatedOutput: 'SIMULATION_XDR_DATA',
      };

      expect(() =>
        simulator.parseAndValidateSimulation(rawResult, {
          network: 'stellar-testnet',
          ceilingService: mockCeilingService,
        }),
      ).toThrow(ResourceFeeCeilingExceededError);

      expect(mockCeilingService.check).toHaveBeenCalledWith({
        network: 'stellar-testnet',
        resourceFeeStroops: 6_000_000,
      });
    });

    it('should include network, resource fee, and ceiling in error', () => {
      const rawResult = {
        minResourceFee: '15000000', // 15M stroops > 10M ceiling for mainnet
        sorobanData: { resources: { footprint: { readOnly: [], readWrite: [] } } },
        simulatedOutput: 'SIMULATION_XDR_DATA',
      };

      try {
        simulator.parseAndValidateSimulation(rawResult, {
          network: 'stellar-mainnet',
          ceilingService: mockCeilingService,
        });
        fail('Expected ResourceFeeCeilingExceededError');
      } catch (err) {
        expect(err).toBeInstanceOf(ResourceFeeCeilingExceededError);
        expect((err as ResourceFeeCeilingExceededError).network).toBe('stellar-mainnet');
        expect((err as ResourceFeeCeilingExceededError).resourceFeeStroops).toBe(15_000_000);
        expect((err as ResourceFeeCeilingExceededError).ceilingStroops).toBe(10_000_000);
      }
    });

    it('should not check ceiling when network is not provided', () => {
      const rawResult = {
        minResourceFee: '100000000', // Very high fee
        sorobanData: { resources: { footprint: { readOnly: [], readWrite: [] } } },
        simulatedOutput: 'SIMULATION_XDR_DATA',
      };

      const res = simulator.parseAndValidateSimulation(rawResult, {
        ceilingService: mockCeilingService,
      });

      expect(res.successful).toBe(true);
      expect(mockCeilingService.check).not.toHaveBeenCalled();
    });

    it('should not check ceiling when ceilingService is not provided', () => {
      const rawResult = {
        minResourceFee: '100000000',
        sorobanData: { resources: { footprint: { readOnly: [], readWrite: [] } } },
        simulatedOutput: 'SIMULATION_XDR_DATA',
      };

      const res = simulator.parseAndValidateSimulation(rawResult, {
        network: 'stellar-testnet',
      });

      expect(res.successful).toBe(true);
      expect(mockCeilingService.check).not.toHaveBeenCalled();
    });

    it('should check ceiling before footprint validation', () => {
      const rawResult = {
        minResourceFee: '6000000', // Exceeds ceiling
        sorobanData: {
          resources: {
            footprint: {
              readOnly: ['MISSING_KEY'],
              readWrite: [],
            },
          },
        },
        simulatedOutput: 'SIMULATION_XDR_DATA',
      };

      // Should throw ceiling error first, not footprint error
      expect(() =>
        simulator.parseAndValidateSimulation(rawResult, {
          network: 'stellar-testnet',
          ceilingService: mockCeilingService,
          expectedFootprintKeys: ['MISSING_KEY'],
        }),
      ).toThrow(ResourceFeeCeilingExceededError);
    });

    it('should check ceiling before slippage validation', () => {
      const rawResult = {
        minResourceFee: '6000000', // Exceeds ceiling
        outputAmount: '50.0', // Below expected min
        sorobanData: { resources: { footprint: { readOnly: [], readWrite: [] } } },
        simulatedOutput: 'SIMULATION_XDR_DATA',
      };

      // Should throw ceiling error first, not slippage error
      expect(() =>
        simulator.parseAndValidateSimulation(rawResult, {
          network: 'stellar-testnet',
          ceilingService: mockCeilingService,
          expectedMinOutput: '90.0',
        }),
      ).toThrow(ResourceFeeCeilingExceededError);
    });
  });
});
