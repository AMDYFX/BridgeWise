/**
 * File: src/routing/tiebreaking/route-tie-breaker.service.ts
 *
 * Implements deterministic tie-breaking for equal routes (#1288).
 * Provides multi-tier tie resolution, explainable decision records,
 * and deterministic output ordering.
 */

import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import {
  MetricEpsilons,
  RankedTieBrokenRoute,
  TieBreakableRoute,
  TieBreakerConfig,
  TieBreakerRule,
  TieBrokenResult,
  TieResolution,
} from './route-tie-breaker.types';

export const DEFAULT_TIE_BREAKER_RULES: TieBreakerRule[] = [
  'composite_score',
  'historical_reliability',
  'lowest_fee',
  'execution_speed',
  'provider_preference',
  'stable_fingerprint',
];

export const DEFAULT_SCORE_EPSILON = 1e-6;
export const DEFAULT_METRIC_EPSILONS: Required<MetricEpsilons> = {
  reliability: 1e-5,
  fee: 1e-4, // $0.0001
  speed: 1e-4, // 0.0001 minutes
};

@Injectable()
export class RouteTieBreakerService {
  private readonly logger = new Logger(RouteTieBreakerService.name);
  private config: Required<Omit<TieBreakerConfig, 'preferredProviders'>> & {
    preferredProviders: string[];
  };

  constructor(config: TieBreakerConfig = {}) {
    this.config = {
      scoreEpsilon: config.scoreEpsilon ?? DEFAULT_SCORE_EPSILON,
      ruleOrder: config.ruleOrder ?? [...DEFAULT_TIE_BREAKER_RULES],
      preferredProviders: config.preferredProviders ?? [],
      metricEpsilons: {
        ...DEFAULT_METRIC_EPSILONS,
        ...config.metricEpsilons,
      },
    };
  }

  /**
   * Update tie-breaker configuration.
   */
  public updateConfig(config: Partial<TieBreakerConfig>): void {
    if (config.scoreEpsilon !== undefined) {
      if (config.scoreEpsilon < 0 || !Number.isFinite(config.scoreEpsilon)) {
        throw new Error('scoreEpsilon must be a non-negative finite number.');
      }
      this.config.scoreEpsilon = config.scoreEpsilon;
    }
    if (config.ruleOrder !== undefined) {
      this.config.ruleOrder = [...config.ruleOrder];
    }
    if (config.preferredProviders !== undefined) {
      this.config.preferredProviders = [...config.preferredProviders];
    }
    if (config.metricEpsilons !== undefined) {
      this.config.metricEpsilons = {
        ...this.config.metricEpsilons,
        ...config.metricEpsilons,
      };
    }
    this.logger.log('Updated RouteTieBreaker configuration.');
  }

  public getConfig(): TieBreakerConfig {
    return {
      scoreEpsilon: this.config.scoreEpsilon,
      ruleOrder: [...this.config.ruleOrder],
      preferredProviders: [...this.config.preferredProviders],
      metricEpsilons: { ...this.config.metricEpsilons },
    };
  }

  /**
   * Sort and break ties deterministically across a collection of candidate routes.
   */
  public breakTies<T extends TieBreakableRoute>(
    routes: readonly T[],
  ): TieBrokenResult<T> {
    if (!routes || routes.length === 0) {
      return {
        rankedRoutes: [],
        tieResolutions: [],
        deterministicDigest: crypto.createHash('sha256').update('').digest('hex'),
      };
    }

    routes.forEach((r) => this.validateRoute(r));

    const resolutions: TieResolution[] = [];
    const routeResolutions = new Map<string, TieBreakerRule>();

    // Copy array for sorting
    const sorted = [...routes];

    sorted.sort((a, b) => {
      const comparison = this.compareRoutes(a, b);
      if (comparison.rule !== 'composite_score') {
        resolutions.push(comparison.resolution);
        routeResolutions.set(comparison.resolution.winningRouteId, comparison.rule);
      }
      return comparison.diff;
    });

    const rankedRoutes: RankedTieBrokenRoute<T>[] = sorted.map((route, idx) => ({
      route,
      rank: idx + 1,
      decidingRule: routeResolutions.get(route.id),
    }));

    // Calculate deterministic hash digest of the ranked IDs
    const digest = crypto
      .createHash('sha256')
      .update(rankedRoutes.map((r) => `${r.rank}:${r.route.id}`).join('|'))
      .digest('hex');

    return {
      rankedRoutes,
      tieResolutions: resolutions,
      deterministicDigest: digest,
    };
  }

  /**
   * Deterministic pairwise comparator between two routes.
   * Returns diff < 0 if a should come before b, diff > 0 if b should come before a.
   */
  public compareRoutes<T extends TieBreakableRoute>(
    a: T,
    b: T,
  ): { diff: number; rule: TieBreakerRule; resolution: TieResolution } {
    for (const rule of this.config.ruleOrder) {
      switch (rule) {
        case 'composite_score': {
          const scoreDiff = b.compositeScore - a.compositeScore;
          if (Math.abs(scoreDiff) > this.config.scoreEpsilon) {
            const winner = scoreDiff < 0 ? a : b;
            return {
              diff: scoreDiff,
              rule: 'composite_score',
              resolution: {
                routeAId: a.id,
                routeBId: b.id,
                winningRouteId: winner.id,
                decidingRule: 'composite_score',
                detail: `Score difference: ${Math.abs(scoreDiff).toFixed(6)} exceeds epsilon ${this.config.scoreEpsilon}`,
              },
            };
          }
          break;
        }

        case 'historical_reliability': {
          const relDiff = b.reliability - a.reliability;
          const eps = this.config.metricEpsilons.reliability ?? DEFAULT_METRIC_EPSILONS.reliability;
          if (Math.abs(relDiff) > eps) {
            const winner = relDiff < 0 ? a : b;
            return {
              diff: relDiff,
              rule: 'historical_reliability',
              resolution: {
                routeAId: a.id,
                routeBId: b.id,
                winningRouteId: winner.id,
                decidingRule: 'historical_reliability',
                detail: `Reliability delta: ${winner.id} (${winner.reliability}) beat (${relDiff < 0 ? b.reliability : a.reliability})`,
              },
            };
          }
          break;
        }

        case 'lowest_fee': {
          // Lower fee is better
          const feeDiff = a.feeAmountUsd - b.feeAmountUsd;
          const eps = this.config.metricEpsilons.fee ?? DEFAULT_METRIC_EPSILONS.fee;
          if (Math.abs(feeDiff) > eps) {
            const winner = feeDiff < 0 ? a : b;
            return {
              diff: feeDiff,
              rule: 'lowest_fee',
              resolution: {
                routeAId: a.id,
                routeBId: b.id,
                winningRouteId: winner.id,
                decidingRule: 'lowest_fee',
                detail: `Fee delta: ${winner.id} ($${winner.feeAmountUsd}) beat ($${feeDiff < 0 ? b.feeAmountUsd : a.feeAmountUsd})`,
              },
            };
          }
          break;
        }

        case 'execution_speed': {
          // Lower estimated time is better
          const speedDiff = a.estimatedTimeMinutes - b.estimatedTimeMinutes;
          const eps = this.config.metricEpsilons.speed ?? DEFAULT_METRIC_EPSILONS.speed;
          if (Math.abs(speedDiff) > eps) {
            const winner = speedDiff < 0 ? a : b;
            return {
              diff: speedDiff,
              rule: 'execution_speed',
              resolution: {
                routeAId: a.id,
                routeBId: b.id,
                winningRouteId: winner.id,
                decidingRule: 'execution_speed',
                detail: `Speed delta: ${winner.id} (${winner.estimatedTimeMinutes}m) beat (${speedDiff < 0 ? b.estimatedTimeMinutes : a.estimatedTimeMinutes}m)`,
              },
            };
          }
          break;
        }

        case 'provider_preference': {
          if (this.config.preferredProviders.length > 0) {
            const indexA = this.config.preferredProviders.indexOf(a.provider);
            const indexB = this.config.preferredProviders.indexOf(b.provider);

            // Found provider gets positive priority; lower index = higher preference
            const priorityA = indexA !== -1 ? indexA : Infinity;
            const priorityB = indexB !== -1 ? indexB : Infinity;

            if (priorityA !== priorityB) {
              const winner = priorityA < priorityB ? a : b;
              return {
                diff: priorityA - priorityB,
                rule: 'provider_preference',
                resolution: {
                  routeAId: a.id,
                  routeBId: b.id,
                  winningRouteId: winner.id,
                  decidingRule: 'provider_preference',
                  detail: `Provider preference: ${winner.provider} preferred over ${winner === a ? b.provider : a.provider}`,
                },
              };
            }
          }
          break;
        }

        case 'stable_fingerprint': {
          const fpA = this.computeFingerprint(a);
          const fpB = this.computeFingerprint(b);
          const cmp = fpA.localeCompare(fpB);
          if (cmp !== 0) {
            const winner = cmp < 0 ? a : b;
            return {
              diff: cmp,
              rule: 'stable_fingerprint',
              resolution: {
                routeAId: a.id,
                routeBId: b.id,
                winningRouteId: winner.id,
                decidingRule: 'stable_fingerprint',
                detail: `Deterministic fingerprint tie-breaker: ${fpA} vs ${fpB}`,
              },
            };
          }
          break;
        }
      }
    }

    // Ultimate fallback if fingerprinted identically
    const fallbackCmp = a.id.localeCompare(b.id);
    return {
      diff: fallbackCmp,
      rule: 'stable_fingerprint',
      resolution: {
        routeAId: a.id,
        routeBId: b.id,
        winningRouteId: fallbackCmp <= 0 ? a.id : b.id,
        decidingRule: 'stable_fingerprint',
        detail: `ID lexicographical fallback: ${a.id} vs ${b.id}`,
      },
    };
  }

  /**
   * Compute stable deterministic fingerprint for a route.
   */
  private computeFingerprint(route: TieBreakableRoute): string {
    const raw = `${route.fromChain}:${route.toChain}:${route.fromToken}:${route.toToken}:${route.provider}:${route.id}`;
    return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 16);
  }

  /**
   * Validate route data attributes.
   */
  private validateRoute(route: TieBreakableRoute): void {
    if (!route || typeof route !== 'object') {
      throw new Error('Route must be a non-null object.');
    }
    if (!route.id || typeof route.id !== 'string') {
      throw new Error('Route id must be a non-empty string.');
    }
    if (!route.fromChain || !route.toChain) {
      throw new Error(`Route ${route.id} must specify fromChain and toChain.`);
    }
    if (!route.fromToken || !route.toToken) {
      throw new Error(`Route ${route.id} must specify fromToken and toToken.`);
    }
    if (!Number.isFinite(route.compositeScore)) {
      throw new Error(`Route ${route.id} compositeScore must be a finite number.`);
    }
    if (!Number.isFinite(route.reliability) || route.reliability < 0 || route.reliability > 1) {
      throw new Error(`Route ${route.id} reliability must be between 0 and 1.`);
    }
    if (!Number.isFinite(route.feeAmountUsd) || route.feeAmountUsd < 0) {
      throw new Error(`Route ${route.id} feeAmountUsd must be a non-negative number.`);
    }
    if (!Number.isFinite(route.estimatedTimeMinutes) || route.estimatedTimeMinutes < 0) {
      throw new Error(`Route ${route.id} estimatedTimeMinutes must be a non-negative number.`);
    }
  }
}
