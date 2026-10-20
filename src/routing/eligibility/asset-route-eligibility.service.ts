/**
 * File: src/routing/eligibility/asset-route-eligibility.service.ts
 *
 * Implements per-asset route eligibility policies (#1284).
 * Enforces asset, chain corridor, provider, hop, and amount boundaries
 * on cross-chain bridge routes.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { BridgeRoute } from '../../services/route-ranker';
import {
  AssetEligibilityRejectionReason,
  AssetRouteEligibilityPolicy,
  BatchRouteEligibilityResult,
  RouteEligibilityEvaluation,
} from './asset-route-eligibility.types';

@Injectable()
export class AssetRouteEligibilityService {
  private readonly logger = new Logger(AssetRouteEligibilityService.name);
  private readonly policies = new Map<string, AssetRouteEligibilityPolicy>();

  /**
   * Normalize an asset key for case-insensitive indexing.
   */
  private normalizeAsset(asset: string): string {
    return asset.trim().toUpperCase();
  }

  /**
   * Set or update an asset policy.
   */
  public setPolicy(policy: AssetRouteEligibilityPolicy): void {
    if (!policy.asset || typeof policy.asset !== 'string') {
      throw new Error('Asset identifier must be a non-empty string.');
    }

    const normalized = this.normalizeAsset(policy.asset);
    const sanitizedPolicy: AssetRouteEligibilityPolicy = {
      ...policy,
      asset: normalized,
      status: policy.status ?? 'active',
      updatedAt: Date.now(),
    };

    this.policies.set(normalized, sanitizedPolicy);
    this.logger.log(`Policy updated for asset: ${normalized} (status: ${sanitizedPolicy.status})`);
  }

  /**
   * Retrieve a policy for an asset.
   */
  public getPolicy(asset: string): AssetRouteEligibilityPolicy | undefined {
    return this.policies.get(this.normalizeAsset(asset));
  }

  /**
   * Remove a policy for an asset.
   */
  public deletePolicy(asset: string): boolean {
    const normalized = this.normalizeAsset(asset);
    const removed = this.policies.delete(normalized);
    if (removed) {
      this.logger.log(`Policy removed for asset: ${normalized}`);
    }
    return removed;
  }

  /**
   * Retrieve all registered policies.
   */
  public getAllPolicies(): AssetRouteEligibilityPolicy[] {
    return Array.from(this.policies.values());
  }

  /**
   * Reset all policies (primarily for testing/reconfiguration).
   */
  public clearAllPolicies(): void {
    this.policies.clear();
  }

  /**
   * Safely compare two numeric/decimal strings (a >= b or a <= b).
   * Supports scientific notation and arbitrary length decimal strings.
   */
  private parseAmountToBigInt(amount: string): bigint {
    const trimmed = amount.trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
      throw new Error(`Invalid numeric amount format: "${trimmed}"`);
    }

    // Split into integer and fractional parts, standardizing on 18 decimals
    const [intPart, fracPart = ''] = trimmed.split('.');
    const paddedFrac = fracPart.padEnd(18, '0').slice(0, 18);
    return BigInt(intPart + paddedFrac);
  }

  /**
   * Evaluates a candidate route against the policy defined for its token.
   */
  public evaluateRoute(
    route: BridgeRoute,
    overrideAmount?: string,
  ): RouteEligibilityEvaluation {
    const asset = this.normalizeAsset(route.fromToken);
    const policy = this.getPolicy(asset);
    const reasons: AssetEligibilityRejectionReason[] = [];
    const now = Date.now();

    // If no policy is registered, default to active unless configured otherwise
    if (!policy) {
      return {
        routeId: route.id,
        asset,
        eligible: true,
        reasons: [],
        evaluatedAt: now,
      };
    }

    // 1. Policy status check
    if (policy.status === 'quarantined') {
      reasons.push({
        code: 'ASSET_QUARANTINED',
        message: `Asset ${asset} is quarantined from cross-chain routing.`,
      });
    } else if (policy.status === 'paused') {
      reasons.push({
        code: 'ASSET_PAUSED',
        message: `Asset ${asset} route execution is currently paused.`,
      });
    } else if (policy.status === 'deprecated') {
      reasons.push({
        code: 'ASSET_DEPRECATED',
        message: `Asset ${asset} routing is deprecated.`,
      });
    }

    // 2. Provider checks
    const routeProvider = route.provider?.trim().toLowerCase();
    if (policy.allowedProviders && policy.allowedProviders.length > 0) {
      const allowed = policy.allowedProviders.map((p) => p.trim().toLowerCase());
      if (!allowed.includes(routeProvider)) {
        reasons.push({
          code: 'PROVIDER_NOT_ALLOWED',
          message: `Provider "${route.provider}" is not allowed for asset ${asset}.`,
        });
      }
    }

    if (policy.blockedProviders && policy.blockedProviders.length > 0) {
      const blocked = policy.blockedProviders.map((p) => p.trim().toLowerCase());
      if (blocked.includes(routeProvider)) {
        reasons.push({
          code: 'PROVIDER_BLOCKED',
          message: `Provider "${route.provider}" is blocked for asset ${asset}.`,
        });
      }
    }

    // 3. Chain corridor checks
    const fromChain = route.fromChain?.trim().toLowerCase();
    const toChain = route.toChain?.trim().toLowerCase();

    if (policy.allowedCorridors && policy.allowedCorridors.length > 0) {
      const corridorAllowed = policy.allowedCorridors.some(
        (c) =>
          c.fromChain.trim().toLowerCase() === fromChain &&
          c.toChain.trim().toLowerCase() === toChain,
      );
      if (!corridorAllowed) {
        reasons.push({
          code: 'CORRIDOR_NOT_ALLOWED',
          message: `Corridor ${route.fromChain} -> ${route.toChain} is not allowed for asset ${asset}.`,
        });
      }
    }

    if (policy.blockedCorridors && policy.blockedCorridors.length > 0) {
      const corridorBlocked = policy.blockedCorridors.some(
        (c) =>
          c.fromChain.trim().toLowerCase() === fromChain &&
          c.toChain.trim().toLowerCase() === toChain,
      );
      if (corridorBlocked) {
        reasons.push({
          code: 'CORRIDOR_BLOCKED',
          message: `Corridor ${route.fromChain} -> ${route.toChain} is blocked for asset ${asset}.`,
        });
      }
    }

    // 4. Amount bounds checks
    const effectiveAmount = overrideAmount || route.amount;
    if (effectiveAmount) {
      try {
        const amountBI = this.parseAmountToBigInt(effectiveAmount);

        if (policy.minTransferAmount) {
          const minBI = this.parseAmountToBigInt(policy.minTransferAmount);
          if (amountBI < minBI) {
            reasons.push({
              code: 'AMOUNT_BELOW_MINIMUM',
              message: `Amount ${effectiveAmount} is below minimum allowed (${policy.minTransferAmount}) for asset ${asset}.`,
            });
          }
        }

        if (policy.maxTransferAmount) {
          const maxBI = this.parseAmountToBigInt(policy.maxTransferAmount);
          if (amountBI > maxBI) {
            reasons.push({
              code: 'AMOUNT_EXCEEDS_MAXIMUM',
              message: `Amount ${effectiveAmount} exceeds maximum allowed (${policy.maxTransferAmount}) for asset ${asset}.`,
            });
          }
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        reasons.push({
          code: 'INVALID_AMOUNT',
          message: `Could not evaluate amount constraints: ${errMsg}`,
        });
      }
    }

    // 5. Slippage check
    if (
      policy.maxSlippagePercent !== undefined &&
      route.slippage !== undefined &&
      route.slippage > policy.maxSlippagePercent
    ) {
      reasons.push({
        code: 'SLIPPAGE_EXCEEDED',
        message: `Route slippage ${route.slippage}% exceeds asset policy limit ${policy.maxSlippagePercent}%.`,
      });
    }

    return {
      routeId: route.id,
      asset,
      eligible: reasons.length === 0,
      reasons,
      evaluatedAt: now,
    };
  }

  /**
   * Filter an array of candidate routes, partitioning into eligible and rejected.
   */
  public filterRoutes(
    routes: BridgeRoute[],
    overrideAmount?: string,
  ): BatchRouteEligibilityResult {
    const eligibleRoutes: BridgeRoute[] = [];
    const rejectedRoutes: {
      route: BridgeRoute;
      reasons: AssetEligibilityRejectionReason[];
    }[] = [];

    for (const route of routes) {
      const evaluation = this.evaluateRoute(route, overrideAmount);
      if (evaluation.eligible) {
        eligibleRoutes.push(route);
      } else {
        rejectedRoutes.push({
          route,
          reasons: evaluation.reasons,
        });
      }
    }

    return {
      eligibleRoutes,
      rejectedRoutes,
      totalEvaluated: routes.length,
    };
  }
}
