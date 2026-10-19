/**
 * File: src/routing/denylist/bridge-route-denylist.service.ts
 *
 * Implements configurable bridge route denylist (#1289).
 * Enforces security, compliance, and risk boundaries by blocking
 * malicious, degraded, or sanctioned routes, providers, corridors, and tokens.
 */

import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import {
  CandidateRouteForDenylist,
  CreateDenylistRuleDto,
  DenylistFilterResult,
  DenylistQueryFilter,
  DenylistRule,
  RouteDenylistEvaluation,
} from './bridge-route-denylist.types';

@Injectable()
export class BridgeRouteDenylistService extends EventEmitter {
  private readonly logger = new Logger(BridgeRouteDenylistService.name);
  private readonly rules = new Map<string, DenylistRule>();

  constructor() {
    super();
  }

  /**
   * Add a new denylist rule.
   */
  public addRule(dto: CreateDenylistRuleDto): DenylistRule {
    this.validateDto(dto);

    const now = Date.now();
    const id = dto.id ?? `rule-${dto.targetType}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const normalizedTarget = this.normalizeTarget(dto.targetType, dto.target);

    if (dto.scope === 'temporary' && (!dto.expiresAt || dto.expiresAt <= now)) {
      throw new Error('Temporary denylist rules must specify a future expiresAt timestamp.');
    }

    const rule: DenylistRule = {
      id,
      targetType: dto.targetType,
      target: normalizedTarget,
      reason: dto.reason.trim(),
      scope: dto.scope ?? 'permanent',
      expiresAt: dto.expiresAt,
      enabled: dto.enabled ?? true,
      addedBy: dto.addedBy ?? 'operator',
      createdAt: now,
      updatedAt: now,
    };

    this.rules.set(id, rule);
    this.emit('rule_added', rule);
    this.logger.log(
      `Added denylist rule [${id}]: ${rule.targetType} "${rule.target}" (${rule.scope}) - Reason: ${rule.reason}`,
    );

    return rule;
  }

  /**
   * Update an existing denylist rule.
   */
  public updateRule(id: string, updates: Partial<CreateDenylistRuleDto>): DenylistRule {
    const existing = this.rules.get(id);
    if (!existing) {
      throw new Error(`Denylist rule not found: ${id}`);
    }

    const now = Date.now();
    const updatedTarget = updates.target
      ? this.normalizeTarget(updates.targetType ?? existing.targetType, updates.target)
      : existing.target;

    const updated: DenylistRule = {
      ...existing,
      ...updates,
      target: updatedTarget,
      updatedAt: now,
    };

    this.rules.set(id, updated);
    this.emit('rule_updated', updated);
    this.logger.log(`Updated denylist rule [${id}]: enabled=${updated.enabled}`);

    return updated;
  }

  /**
   * Remove a denylist rule by ID.
   */
  public removeRule(id: string): boolean {
    const existing = this.rules.get(id);
    if (!existing) {
      return false;
    }

    this.rules.delete(id);
    this.emit('rule_removed', existing);
    this.logger.log(`Removed denylist rule [${id}]: ${existing.targetType} "${existing.target}"`);
    return true;
  }

  /**
   * Retrieve a rule by ID.
   */
  public getRule(id: string): DenylistRule | undefined {
    return this.rules.get(id);
  }

  /**
   * List denylist rules matching optional filters.
   */
  public listRules(filter: DenylistQueryFilter = {}): DenylistRule[] {
    const now = Date.now();
    let result = Array.from(this.rules.values());

    if (filter.targetType) {
      result = result.filter((r) => r.targetType === filter.targetType);
    }
    if (filter.enabledOnly) {
      result = result.filter((r) => r.enabled);
    }
    if (filter.activeOnly) {
      result = result.filter((r) => this.isRuleActive(r, now));
    }
    if (filter.targetSubstring) {
      const needle = filter.targetSubstring.toLowerCase();
      result = result.filter((r) => r.target.toLowerCase().includes(needle));
    }

    return result;
  }

  /**
   * Evaluate if a specific route matches any active denylist rule.
   */
  public evaluateRoute(route: CandidateRouteForDenylist): RouteDenylistEvaluation {
    if (!route || !route.id) {
      throw new Error('Candidate route must have a valid non-empty id.');
    }

    const now = Date.now();
    const activeRules = Array.from(this.rules.values()).filter((r) =>
      this.isRuleActive(r, now),
    );

    for (const rule of activeRules) {
      if (this.doesRouteMatchRule(route, rule)) {
        this.emit('route_denied', { routeId: route.id, rule });
        return {
          routeId: route.id,
          isDenied: true,
          matchedRule: rule,
          denialReason: rule.reason,
          evaluatedAt: now,
        };
      }
    }

    return {
      routeId: route.id,
      isDenied: false,
      evaluatedAt: now,
    };
  }

  /**
   * Filter candidate routes against the active denylist.
   */
  public filterRoutes<T extends CandidateRouteForDenylist>(
    routes: readonly T[],
  ): DenylistFilterResult<T> {
    if (!routes || routes.length === 0) {
      return {
        allowedRoutes: [],
        deniedRoutes: [],
        totalEvaluated: 0,
        allowedCount: 0,
        deniedCount: 0,
      };
    }

    const allowedRoutes: T[] = [];
    const deniedRoutes: Array<{ route: T; evaluation: RouteDenylistEvaluation }> = [];

    for (const route of routes) {
      const evaluation = this.evaluateRoute(route);
      if (evaluation.isDenied) {
        deniedRoutes.push({ route, evaluation });
      } else {
        allowedRoutes.push(route);
      }
    }

    return {
      allowedRoutes,
      deniedRoutes,
      totalEvaluated: routes.length,
      allowedCount: allowedRoutes.length,
      deniedCount: deniedRoutes.length,
    };
  }

  /**
   * Check if a route matches a specific denylist rule.
   */
  private doesRouteMatchRule(
    route: CandidateRouteForDenylist,
    rule: DenylistRule,
  ): boolean {
    switch (rule.targetType) {
      case 'route':
        return route.id.toLowerCase() === rule.target.toLowerCase();

      case 'provider':
        return route.provider.toLowerCase() === rule.target.toLowerCase();

      case 'corridor': {
        const corridor = `${route.fromChain.toLowerCase()}:${route.toChain.toLowerCase()}`;
        return corridor === rule.target.toLowerCase();
      }

      case 'token': {
        const targetToken = rule.target.toUpperCase();
        return (
          route.fromToken.toUpperCase() === targetToken ||
          route.toToken.toUpperCase() === targetToken
        );
      }

      case 'asset_pair': {
        const pair = `${route.fromToken.toUpperCase()}:${route.toToken.toUpperCase()}`;
        return pair === rule.target.toUpperCase();
      }

      default:
        return false;
    }
  }

  /**
   * Determine if a rule is currently active (enabled and not expired).
   */
  private isRuleActive(rule: DenylistRule, now: number): boolean {
    if (!rule.enabled) {
      return false;
    }
    if (rule.scope === 'temporary' && rule.expiresAt !== undefined) {
      return now < rule.expiresAt;
    }
    return true;
  }

  /**
   * Normalize targets based on type.
   */
  private normalizeTarget(targetType: string, target: string): string {
    const trimmed = target.trim();
    switch (targetType) {
      case 'route':
      case 'provider':
        return trimmed.toLowerCase();
      case 'corridor': {
        const parts = trimmed.split(':');
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
          throw new Error('Corridor target must be in "fromChain:toChain" format.');
        }
        return `${parts[0].trim().toLowerCase()}:${parts[1].trim().toLowerCase()}`;
      }
      case 'token':
        return trimmed.toUpperCase();
      case 'asset_pair': {
        const parts = trimmed.split(':');
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
          throw new Error('Asset pair target must be in "fromToken:toToken" format.');
        }
        return `${parts[0].trim().toUpperCase()}:${parts[1].trim().toUpperCase()}`;
      }
      default:
        return trimmed;
    }
  }

  /**
   * Validate rule creation DTO.
   */
  private validateDto(dto: CreateDenylistRuleDto): void {
    if (!dto || typeof dto !== 'object') {
      throw new Error('Rule DTO must be an object.');
    }
    if (!dto.target || typeof dto.target !== 'string' || dto.target.trim() === '') {
      throw new Error('Denylist rule target must be a non-empty string.');
    }
    if (!dto.reason || typeof dto.reason !== 'string' || dto.reason.trim() === '') {
      throw new Error('Denylist rule reason must be a non-empty string.');
    }
    const validTypes = ['route', 'provider', 'corridor', 'token', 'asset_pair'];
    if (!validTypes.includes(dto.targetType)) {
      throw new Error(
        `Invalid targetType: ${dto.targetType}. Must be one of: ${validTypes.join(', ')}`,
      );
    }
  }

  /**
   * Reset in-memory rules.
   */
  public clearRules(): void {
    this.rules.clear();
  }
}
