/**
 * File: src/routing/eligibility/asset-route-eligibility.spec.ts
 *
 * Tests for AssetRouteEligibilityService (#1284).
 */

import { AssetRouteEligibilityService } from './asset-route-eligibility.service';
import type { BridgeRoute } from '../../services/route-ranker';

describe('AssetRouteEligibilityService (#1284)', () => {
  let service: AssetRouteEligibilityService;

  const mockRoute: BridgeRoute = {
    id: 'route-usdc-1',
    fromChain: 'ethereum',
    toChain: 'stellar',
    fromToken: 'USDC',
    toToken: 'USDC',
    amount: '1000',
    fee: { amount: '1', token: 'USDC', usdValue: 1 },
    estimatedTime: 5,
    successRate: 0.99,
    provider: 'cctp',
    slippage: 0.2,
  };

  beforeEach(() => {
    service = new AssetRouteEligibilityService();
  });

  describe('Policy Management', () => {
    it('sets, retrieves, and clears asset policies', () => {
      service.setPolicy({
        asset: 'usdc',
        status: 'active',
        minTransferAmount: '10',
        maxTransferAmount: '100000',
      });

      const retrieved = service.getPolicy('USDC');
      expect(retrieved).toBeDefined();
      expect(retrieved?.asset).toBe('USDC');
      expect(retrieved?.minTransferAmount).toBe('10');

      expect(service.getAllPolicies()).toHaveLength(1);

      service.clearAllPolicies();
      expect(service.getAllPolicies()).toHaveLength(0);
    });

    it('deletes specific asset policies', () => {
      service.setPolicy({ asset: 'XLM' });
      expect(service.deletePolicy('xlm')).toBe(true);
      expect(service.getPolicy('XLM')).toBeUndefined();
      expect(service.deletePolicy('XLM')).toBe(false);
    });

    it('rejects policies with empty asset identifiers', () => {
      expect(() => service.setPolicy({ asset: '' })).toThrow(
        'Asset identifier must be a non-empty string.',
      );
    });
  });

  describe('Route Eligibility Evaluation', () => {
    it('admits routes when no asset policy is registered', () => {
      const evaluation = service.evaluateRoute(mockRoute);
      expect(evaluation.eligible).toBe(true);
      expect(evaluation.reasons).toHaveLength(0);
    });

    it('admits routes meeting all policy criteria', () => {
      service.setPolicy({
        asset: 'USDC',
        status: 'active',
        allowedProviders: ['cctp', 'stargate'],
        allowedCorridors: [{ fromChain: 'ethereum', toChain: 'stellar' }],
        minTransferAmount: '10',
        maxTransferAmount: '50000',
        maxSlippagePercent: 0.5,
      });

      const evaluation = service.evaluateRoute(mockRoute);
      expect(evaluation.eligible).toBe(true);
      expect(evaluation.reasons).toHaveLength(0);
    });

    it('rejects routes for quarantined, paused, or deprecated assets', () => {
      service.setPolicy({ asset: 'USDC', status: 'quarantined' });
      let evalResult = service.evaluateRoute(mockRoute);
      expect(evalResult.eligible).toBe(false);
      expect(evalResult.reasons[0].code).toBe('ASSET_QUARANTINED');

      service.setPolicy({ asset: 'USDC', status: 'paused' });
      evalResult = service.evaluateRoute(mockRoute);
      expect(evalResult.eligible).toBe(false);
      expect(evalResult.reasons[0].code).toBe('ASSET_PAUSED');

      service.setPolicy({ asset: 'USDC', status: 'deprecated' });
      evalResult = service.evaluateRoute(mockRoute);
      expect(evalResult.eligible).toBe(false);
      expect(evalResult.reasons[0].code).toBe('ASSET_DEPRECATED');
    });

    it('enforces allowed and blocked providers', () => {
      // Disallowed by whitelist
      service.setPolicy({
        asset: 'USDC',
        allowedProviders: ['wormhole', 'allbridge'],
      });
      let evalResult = service.evaluateRoute(mockRoute);
      expect(evalResult.eligible).toBe(false);
      expect(evalResult.reasons[0].code).toBe('PROVIDER_NOT_ALLOWED');

      // Disallowed by blacklist
      service.setPolicy({
        asset: 'USDC',
        blockedProviders: ['cctp'],
      });
      evalResult = service.evaluateRoute(mockRoute);
      expect(evalResult.eligible).toBe(false);
      expect(evalResult.reasons[0].code).toBe('PROVIDER_BLOCKED');
    });

    it('enforces allowed and blocked chain corridors', () => {
      // Not in allowed corridors
      service.setPolicy({
        asset: 'USDC',
        allowedCorridors: [{ fromChain: 'polygon', toChain: 'stellar' }],
      });
      let evalResult = service.evaluateRoute(mockRoute);
      expect(evalResult.eligible).toBe(false);
      expect(evalResult.reasons[0].code).toBe('CORRIDOR_NOT_ALLOWED');

      // Blocked corridor
      service.setPolicy({
        asset: 'USDC',
        blockedCorridors: [{ fromChain: 'ethereum', toChain: 'stellar' }],
      });
      evalResult = service.evaluateRoute(mockRoute);
      expect(evalResult.eligible).toBe(false);
      expect(evalResult.reasons[0].code).toBe('CORRIDOR_BLOCKED');
    });

    it('enforces transfer amount bounds (min and max) and handles decimals', () => {
      service.setPolicy({
        asset: 'USDC',
        minTransferAmount: '100.5',
        maxTransferAmount: '500.0',
      });

      // Below min
      let evalResult = service.evaluateRoute(mockRoute, '50');
      expect(evalResult.eligible).toBe(false);
      expect(evalResult.reasons[0].code).toBe('AMOUNT_BELOW_MINIMUM');

      // Above max
      evalResult = service.evaluateRoute(mockRoute, '1000');
      expect(evalResult.eligible).toBe(false);
      expect(evalResult.reasons[0].code).toBe('AMOUNT_EXCEEDS_MAXIMUM');

      // Within bounds
      evalResult = service.evaluateRoute(mockRoute, '250.75');
      expect(evalResult.eligible).toBe(true);

      // Boundary values
      expect(service.evaluateRoute(mockRoute, '100.5').eligible).toBe(true);
      expect(service.evaluateRoute(mockRoute, '500.0').eligible).toBe(true);
    });

    it('handles invalid amount formatting gracefully', () => {
      service.setPolicy({
        asset: 'USDC',
        minTransferAmount: '10',
      });

      const evalResult = service.evaluateRoute(mockRoute, 'invalid-num');
      expect(evalResult.eligible).toBe(false);
      expect(evalResult.reasons[0].code).toBe('INVALID_AMOUNT');
    });

    it('enforces slippage limit when route slippage exceeds policy', () => {
      service.setPolicy({
        asset: 'USDC',
        maxSlippagePercent: 0.1,
      });

      const evalResult = service.evaluateRoute(mockRoute); // slippage is 0.2%
      expect(evalResult.eligible).toBe(false);
      expect(evalResult.reasons[0].code).toBe('SLIPPAGE_EXCEEDED');
    });
  });

  describe('Batch Filtering', () => {
    it('partitions routes into eligible and rejected batches', () => {
      service.setPolicy({
        asset: 'USDC',
        allowedProviders: ['cctp'],
      });

      const route1 = { ...mockRoute, id: 'r1', provider: 'cctp' };
      const route2 = { ...mockRoute, id: 'r2', provider: 'unapproved' };

      const batchResult = service.filterRoutes([route1, route2]);
      expect(batchResult.totalEvaluated).toBe(2);
      expect(batchResult.eligibleRoutes).toHaveLength(1);
      expect(batchResult.eligibleRoutes[0].id).toBe('r1');
      expect(batchResult.rejectedRoutes).toHaveLength(1);
      expect(batchResult.rejectedRoutes[0].route.id).toBe('r2');
      expect(batchResult.rejectedRoutes[0].reasons[0].code).toBe('PROVIDER_NOT_ALLOWED');
    });
  });
});
