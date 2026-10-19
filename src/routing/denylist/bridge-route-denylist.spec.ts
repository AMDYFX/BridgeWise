/**
 * File: src/routing/denylist/bridge-route-denylist.spec.ts
 *
 * Tests for BridgeRouteDenylistService (#1289).
 */

import { BridgeRouteDenylistService } from './bridge-route-denylist.service';
import { CandidateRouteForDenylist } from './bridge-route-denylist.types';

describe('BridgeRouteDenylistService', () => {
  let service: BridgeRouteDenylistService;

  beforeEach(() => {
    service = new BridgeRouteDenylistService();
  });

  const baseRoute: CandidateRouteForDenylist = {
    id: 'route-circle-cctp-1',
    fromChain: 'stellar',
    toChain: 'ethereum',
    fromToken: 'USDC',
    toToken: 'USDC',
    provider: 'circle-cctp',
  };

  describe('Rule Creation & Validation', () => {
    it('creates permanent and temporary rules successfully', () => {
      const rule = service.addRule({
        targetType: 'provider',
        target: 'circle-cctp',
        reason: 'Provider API downtime',
        scope: 'permanent',
      });

      expect(rule.id).toBeDefined();
      expect(rule.target).toBe('circle-cctp');
      expect(rule.reason).toBe('Provider API downtime');
      expect(rule.enabled).toBe(true);

      const tempRule = service.addRule({
        targetType: 'route',
        target: 'route-circle-cctp-1',
        reason: 'Temporary maintenance',
        scope: 'temporary',
        expiresAt: Date.now() + 60000,
      });

      expect(tempRule.scope).toBe('temporary');
      expect(tempRule.expiresAt).toBeDefined();
    });

    it('throws when target or reason is empty', () => {
      expect(() =>
        service.addRule({
          targetType: 'provider',
          target: '',
          reason: 'Valid reason',
        }),
      ).toThrow('Denylist rule target must be a non-empty string.');

      expect(() =>
        service.addRule({
          targetType: 'provider',
          target: 'provider-x',
          reason: '',
        }),
      ).toThrow('Denylist rule reason must be a non-empty string.');
    });

    it('throws when temporary rule has no or past expiresAt', () => {
      expect(() =>
        service.addRule({
          targetType: 'route',
          target: 'route-1',
          reason: 'Test',
          scope: 'temporary',
          expiresAt: Date.now() - 1000,
        }),
      ).toThrow('Temporary denylist rules must specify a future expiresAt timestamp.');
    });

    it('throws when corridor target format is invalid', () => {
      expect(() =>
        service.addRule({
          targetType: 'corridor',
          target: 'invalid-corridor',
          reason: 'Test',
        }),
      ).toThrow('Corridor target must be in "fromChain:toChain" format.');
    });
  });

  describe('Denylist Matching Scopes', () => {
    it('denies route matching route ID rule', () => {
      service.addRule({
        targetType: 'route',
        target: 'route-circle-cctp-1',
        reason: 'Compromised contract',
      });

      const evalResult = service.evaluateRoute(baseRoute);
      expect(evalResult.isDenied).toBe(true);
      expect(evalResult.denialReason).toBe('Compromised contract');
      expect(evalResult.matchedRule?.targetType).toBe('route');
    });

    it('denies route matching provider rule', () => {
      service.addRule({
        targetType: 'provider',
        target: 'circle-cctp',
        reason: 'Provider RPC instability',
      });

      const evalResult = service.evaluateRoute(baseRoute);
      expect(evalResult.isDenied).toBe(true);
      expect(evalResult.denialReason).toBe('Provider RPC instability');
    });

    it('denies route matching corridor rule', () => {
      service.addRule({
        targetType: 'corridor',
        target: 'stellar:ethereum',
        reason: 'Bridge bridge-head halted',
      });

      const evalResult = service.evaluateRoute(baseRoute);
      expect(evalResult.isDenied).toBe(true);
      expect(evalResult.denialReason).toBe('Bridge bridge-head halted');
    });

    it('denies route matching token rule', () => {
      service.addRule({
        targetType: 'token',
        target: 'USDC',
        reason: 'Emergency token freeze',
      });

      const evalResult = service.evaluateRoute(baseRoute);
      expect(evalResult.isDenied).toBe(true);
      expect(evalResult.denialReason).toBe('Emergency token freeze');
    });

    it('denies route matching asset pair rule', () => {
      service.addRule({
        targetType: 'asset_pair',
        target: 'USDC:USDC',
        reason: 'Corridor asset pair blocked',
      });

      const evalResult = service.evaluateRoute(baseRoute);
      expect(evalResult.isDenied).toBe(true);
      expect(evalResult.denialReason).toBe('Corridor asset pair blocked');
    });

    it('allows route when no rules match', () => {
      service.addRule({
        targetType: 'provider',
        target: 'different-provider',
        reason: 'Unrelated issue',
      });

      const evalResult = service.evaluateRoute(baseRoute);
      expect(evalResult.isDenied).toBe(false);
      expect(evalResult.matchedRule).toBeUndefined();
    });
  });

  describe('Rule Expiration & Disabled State', () => {
    it('ignores expired temporary rule', () => {
      const rule = service.addRule({
        targetType: 'route',
        target: 'route-circle-cctp-1',
        reason: 'Quick fix',
        scope: 'temporary',
        expiresAt: Date.now() + 50,
      });

      // Override expiresAt to the past to simulate time passing
      rule.expiresAt = Date.now() - 100;

      const evalResult = service.evaluateRoute(baseRoute);
      expect(evalResult.isDenied).toBe(false);
    });

    it('ignores disabled rule', () => {
      const rule = service.addRule({
        targetType: 'route',
        target: 'route-circle-cctp-1',
        reason: 'Disabled rule',
        enabled: false,
      });

      const evalResult = service.evaluateRoute(baseRoute);
      expect(evalResult.isDenied).toBe(false);

      // Re-enable
      service.updateRule(rule.id, { enabled: true });
      const reEval = service.evaluateRoute(baseRoute);
      expect(reEval.isDenied).toBe(true);
    });
  });

  describe('Batch Filtering', () => {
    it('partitions candidate routes into allowed and denied sets', () => {
      service.addRule({
        targetType: 'provider',
        target: 'risky-bridge',
        reason: 'Exploit reported',
      });

      const routeSafe: CandidateRouteForDenylist = {
        id: 'route-safe',
        fromChain: 'stellar',
        toChain: 'polygon',
        fromToken: 'USDC',
        toToken: 'USDC',
        provider: 'safe-bridge',
      };

      const routeBlocked: CandidateRouteForDenylist = {
        id: 'route-blocked',
        fromChain: 'stellar',
        toChain: 'polygon',
        fromToken: 'USDC',
        toToken: 'USDC',
        provider: 'risky-bridge',
      };

      const result = service.filterRoutes([routeSafe, routeBlocked]);
      expect(result.totalEvaluated).toBe(2);
      expect(result.allowedCount).toBe(1);
      expect(result.deniedCount).toBe(1);
      expect(result.allowedRoutes[0].id).toBe('route-safe');
      expect(result.deniedRoutes[0].route.id).toBe('route-blocked');
      expect(result.deniedRoutes[0].evaluation.denialReason).toBe('Exploit reported');
    });

    it('handles empty route array gracefully', () => {
      const result = service.filterRoutes([]);
      expect(result.allowedRoutes).toEqual([]);
      expect(result.deniedRoutes).toEqual([]);
      expect(result.totalEvaluated).toBe(0);
    });
  });

  describe('Lifecycle & Events', () => {
    it('emits events on rule addition, update, removal, and denial', () => {
      const addedSpy = jest.fn();
      const updatedSpy = jest.fn();
      const removedSpy = jest.fn();
      const deniedSpy = jest.fn();

      service.on('rule_added', addedSpy);
      service.on('rule_updated', updatedSpy);
      service.on('rule_removed', removedSpy);
      service.on('route_denied', deniedSpy);

      const rule = service.addRule({
        targetType: 'provider',
        target: 'test-bridge',
        reason: 'Event test',
      });
      expect(addedSpy).toHaveBeenCalledTimes(1);

      service.updateRule(rule.id, { reason: 'Updated reason' });
      expect(updatedSpy).toHaveBeenCalledTimes(1);

      service.evaluateRoute({ ...baseRoute, provider: 'test-bridge' });
      expect(deniedSpy).toHaveBeenCalledTimes(1);

      service.removeRule(rule.id);
      expect(removedSpy).toHaveBeenCalledTimes(1);
      expect(service.getRule(rule.id)).toBeUndefined();
    });

    it('lists rules with filtering', () => {
      service.addRule({
        targetType: 'corridor',
        target: 'stellar:ethereum',
        reason: 'Corridor rule',
      });
      service.addRule({
        targetType: 'token',
        target: 'USDT',
        reason: 'Token rule',
      });

      const corridorRules = service.listRules({ targetType: 'corridor' });
      expect(corridorRules.length).toBe(1);
      expect(corridorRules[0].target).toBe('stellar:ethereum');

      const all = service.listRules();
      expect(all.length).toBe(2);
    });
  });
});
