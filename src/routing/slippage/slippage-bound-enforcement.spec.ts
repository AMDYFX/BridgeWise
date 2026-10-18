import { SlippageBoundEnforcementService } from './slippage-bound-enforcement.service';
import { SlippageValidationRequest } from './slippage-bound-enforcement.types';

describe('SlippageBoundEnforcementService (#1283)', () => {
  let service: SlippageBoundEnforcementService;

  beforeEach(() => {
    service = new SlippageBoundEnforcementService({
      minAllowedSlippageBps: 5, // 0.05%
      maxAllowedSlippageBps: 300, // 3.00%
      defaultSlippageBps: 50, // 0.50%
      perAssetMaxSlippageBps: {
        USDC: 50, // 0.50%
        USDT: 50,
        ETH: 200, // 2.00%
      },
      strictMinOutputCheck: true,
    });
  });

  describe('calculateMinOutput', () => {
    it('calculates minimum output with exact 18-decimal precision', () => {
      // 1000 USDC with 50 bps (0.5%) slippage => 1000 * (10000 - 50) / 10000 = 995 USDC
      const minOutput = service.calculateMinOutput('1000.0', 50);
      expect(minOutput).toBe('995');
    });

    it('calculates minimum output for fractional amounts and small slippages', () => {
      // 10.5 ETH with 10 bps (0.1%) slippage => 10.5 * 0.999 = 10.4895
      const minOutput = service.calculateMinOutput('10.5', 10);
      expect(minOutput).toBe('10.4895');
    });

    it('throws when slippage bps is negative or exceeds 10000', () => {
      expect(() => service.calculateMinOutput('100', -1)).toThrow('Invalid slippage basis points');
      expect(() => service.calculateMinOutput('100', 10001)).toThrow('Invalid slippage basis points');
    });
  });

  describe('calculateEffectiveSlippageBps', () => {
    it('calculates effective slippage in bps correctly', () => {
      // 100 expected, 99 actual => 1% slippage = 100 bps
      const bps = service.calculateEffectiveSlippageBps('100.0', '99.0');
      expect(bps).toBe(100);
    });

    it('returns 0 when actual >= expected', () => {
      const bps = service.calculateEffectiveSlippageBps('100.0', '105.0');
      expect(bps).toBe(0);
    });
  });

  describe('validateSlippage', () => {
    it('validates a correct route within user and asset tolerance', () => {
      const request: SlippageValidationRequest = {
        routeId: 'route-valid-1',
        asset: 'USDC',
        expectedOutput: '1000',
        minOutputAmount: '996',
        userToleranceBps: 45, // 0.45%, within 50 bps cap
        simulatedOutput: '998',
      };

      const result = service.validateSlippage(request);
      expect(result.valid).toBe(true);
      expect(result.effectiveSlippageBps).toBe(40); // 1000 -> 996 is 40 bps
      expect(result.minOutputSatisfied).toBe(true);
      expect(result.rejectionCode).toBeUndefined();
    });

    it('rejects if requested user tolerance exceeds asset-specific max slippage', () => {
      const request: SlippageValidationRequest = {
        routeId: 'route-exceed-asset',
        asset: 'USDC',
        expectedOutput: '1000',
        minOutputAmount: '980',
        userToleranceBps: 100, // 1.0%, exceeds USDC 50 bps cap
      };

      const result = service.validateSlippage(request);
      expect(result.valid).toBe(false);
      expect(result.rejectionCode).toBe('SLIPPAGE_EXCEEDED');
      expect(result.rejectionMessage).toContain('exceeds maximum allowable 50 bps for USDC');
    });

    it('rejects if requested user tolerance is below system minimum allowed', () => {
      const request: SlippageValidationRequest = {
        routeId: 'route-below-min',
        asset: 'ETH',
        expectedOutput: '10',
        minOutputAmount: '9.999',
        userToleranceBps: 2, // 2 bps is below min 5 bps
      };

      const result = service.validateSlippage(request);
      expect(result.valid).toBe(false);
      expect(result.rejectionCode).toBe('SLIPPAGE_BELOW_MINIMUM');
    });

    it('rejects if minOutputAmount violates specified user tolerance', () => {
      const request: SlippageValidationRequest = {
        routeId: 'route-min-violated',
        asset: 'ETH',
        expectedOutput: '10.0',
        minOutputAmount: '9.0', // 10% slippage
        userToleranceBps: 100, // 1% tolerance (requires min 9.9)
      };

      const result = service.validateSlippage(request);
      expect(result.valid).toBe(false);
      expect(result.rejectionCode).toBe('MIN_OUTPUT_NOT_SATISFIED');
    });

    it('rejects if simulatedOutput is lower than minOutputAmount', () => {
      const request: SlippageValidationRequest = {
        routeId: 'route-sim-failed',
        asset: 'ETH',
        expectedOutput: '10.0',
        minOutputAmount: '9.9', // 100 bps
        userToleranceBps: 100,
        simulatedOutput: '9.85', // simulated outcome drops below 9.9
      };

      const result = service.validateSlippage(request);
      expect(result.valid).toBe(false);
      expect(result.rejectionCode).toBe('SIMULATED_OUTPUT_BELOW_MIN');
    });

    it('rejects invalid numeric formats safely without crashing', () => {
      const request: SlippageValidationRequest = {
        routeId: 'route-bad-num',
        asset: 'USDC',
        expectedOutput: 'abc',
        minOutputAmount: '990',
      };

      const result = service.validateSlippage(request);
      expect(result.valid).toBe(false);
      expect(result.rejectionCode).toBe('INVALID_AMOUNT_FORMAT');
    });
  });

  describe('enforceSlippageOrThrow', () => {
    it('executes without throwing on valid route', () => {
      expect(() => {
        service.enforceSlippageOrThrow({
          routeId: 'route-ok',
          asset: 'ETH',
          expectedOutput: '10',
          minOutputAmount: '9.95',
          userToleranceBps: 100,
          simulatedOutput: '9.98',
        });
      }).not.toThrow();
    });

    it('throws descriptive error on slippage violation', () => {
      expect(() => {
        service.enforceSlippageOrThrow({
          routeId: 'route-err',
          asset: 'USDC',
          expectedOutput: '100',
          minOutputAmount: '90',
          userToleranceBps: 150, // exceeds USDC cap 50 bps
        });
      }).toThrow(/Slippage enforcement failed \[SLIPPAGE_EXCEEDED\]/);
    });
  });
});
