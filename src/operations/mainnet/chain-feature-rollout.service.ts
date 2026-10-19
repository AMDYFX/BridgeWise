/**
 * File: src/operations/mainnet/chain-feature-rollout.service.ts
 *
 * Controlled feature rollout by chain (#1380).
 *
 * Safety properties:
 * - Evaluation fails closed for unknown features, disabled/paused features,
 *   and chains that were never explicitly targeted.
 * - Percentage increases are rate-limited (default 25 points) so a rollout
 *   cannot jump from canary to full traffic in one mutation.
 * - Cohort assignment uses a stable hash of feature + subject, so retries and
 *   repeated evaluations keep the same subject in the same treatment.
 * - Every mutation is appended to an in-memory audit trail.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  DefineFeatureRolloutInput,
  FeatureChainRollout,
  FeatureRolloutDefinition,
  FeatureRolloutSnapshot,
  RolloutAuditEntry,
  RolloutDecision,
  RolloutDecisionReason,
  RolloutEvaluationContext,
} from './chain-feature-rollout.types';

const DEFAULT_MAX_STEP_INCREASE = 25;
const FEATURE_KEY_PATTERN = /^[a-z][a-z0-9._-]{1,63}$/i;

export interface ChainFeatureRolloutServiceOptions {
  /** Injectable clock for deterministic tests and audits. */
  now?: () => number;
  /** Largest allowed percentage increase per mutation. Defaults to 25. */
  maxStepIncrease?: number;
}

@Injectable()
export class ChainFeatureRolloutService {
  private readonly logger = new Logger(ChainFeatureRolloutService.name);
  private readonly features = new Map<string, FeatureRolloutDefinition>();
  private readonly audit: RolloutAuditEntry[] = [];
  private readonly now: () => number;
  private readonly maxStepIncrease: number;

  constructor(options: ChainFeatureRolloutServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxStepIncrease = options.maxStepIncrease ?? DEFAULT_MAX_STEP_INCREASE;
    if (
      !Number.isInteger(this.maxStepIncrease) ||
      this.maxStepIncrease < 1 ||
      this.maxStepIncrease > 100
    ) {
      throw new Error('maxStepIncrease must be an integer between 1 and 100');
    }
  }

  public defineFeature(
    input: DefineFeatureRolloutInput,
  ): FeatureRolloutDefinition {
    this.assertNonEmpty(input?.updatedBy, 'updatedBy');
    const key = normalizeFeatureKey(input?.key);
    if (this.features.has(key)) {
      throw new Error(`Feature rollout already defined: ${key}`);
    }
    if (!Array.isArray(input.chains) || input.chains.length === 0) {
      throw new Error('Feature rollout must target at least one chain');
    }

    const chains = input.chains.map((entry) =>
      this.normalizeChainRollout(entry),
    );
    this.assertUniqueChains(chains);

    const at = this.now();
    const definition: FeatureRolloutDefinition = {
      key,
      description: (input.description ?? '').trim(),
      enabled: input.enabled ?? true,
      paused: false,
      chains,
      updatedAt: at,
      updatedBy: input.updatedBy.trim(),
    };
    this.features.set(key, definition);
    this.record({
      at,
      featureKey: key,
      action: 'define',
      actor: definition.updatedBy,
    });
    this.logger.log(
      `Feature rollout defined key=${key} chains=${chains
        .map((c) => `${c.chain}:${c.percentage}`)
        .join(',')}`,
    );
    return this.copyDefinition(definition);
  }

  public hasFeature(featureKey: string): boolean {
    return this.features.has(normalizeFeatureKey(featureKey));
  }

  public listFeatures(): FeatureRolloutDefinition[] {
    return Array.from(this.features.values()).map((definition) =>
      this.copyDefinition(definition),
    );
  }

  public getFeature(featureKey: string): FeatureRolloutDefinition | undefined {
    const definition = this.features.get(normalizeFeatureKey(featureKey));
    return definition ? this.copyDefinition(definition) : undefined;
  }

  /**
   * Evaluate a feature for a chain-scoped subject. Unknown or malformed inputs
   * fail closed rather than defaulting to enabled.
   */
  public evaluate(
    featureKey: string,
    context: RolloutEvaluationContext,
  ): RolloutDecision {
    this.assertNonEmpty(context?.subjectId, 'subjectId');
    this.assertNonEmpty(context?.chain, 'chain');
    const chain = normalizeChain(context.chain);
    const subjectId = context.subjectId.trim();
    const at = this.now();
    const definition = this.features.get(normalizeFeatureKey(featureKey));

    if (!definition) {
      return this.decision(
        featureKey,
        chain,
        subjectId,
        false,
        0,
        'unknown_feature',
        at,
      );
    }
    if (!definition.enabled) {
      return this.decision(
        definition.key,
        chain,
        subjectId,
        false,
        0,
        'feature_disabled',
        at,
      );
    }
    if (definition.paused) {
      return this.decision(
        definition.key,
        chain,
        subjectId,
        false,
        0,
        'feature_paused',
        at,
      );
    }

    const rollout = definition.chains.find((entry) => entry.chain === chain);
    if (!rollout) {
      return this.decision(
        definition.key,
        chain,
        subjectId,
        false,
        0,
        'chain_not_targeted',
        at,
      );
    }
    const allowlist = (rollout.allowlist ?? []).map((entry) =>
      entry.toLowerCase(),
    );
    if (allowlist.includes(subjectId.toLowerCase())) {
      return this.decision(
        definition.key,
        chain,
        subjectId,
        true,
        rollout.percentage,
        'allowlisted',
        at,
      );
    }
    if (rollout.percentage <= 0) {
      return this.decision(
        definition.key,
        chain,
        subjectId,
        false,
        0,
        'chain_percentage_zero',
        at,
      );
    }
    if (rollout.percentage >= 100) {
      return this.decision(
        definition.key,
        chain,
        subjectId,
        true,
        100,
        'enabled',
        at,
      );
    }

    const bucket = stableBucket(definition.key, subjectId);
    const enabled = bucket < rollout.percentage;
    return this.decision(
      definition.key,
      chain,
      subjectId,
      enabled,
      rollout.percentage,
      enabled ? 'enabled' : 'cohort_excluded',
      at,
    );
  }

  public isEnabled(
    featureKey: string,
    context: RolloutEvaluationContext,
  ): boolean {
    return this.evaluate(featureKey, context).enabled;
  }

  /**
   * Change the rollout percentage for a chain that is already targeted.
   * Adds are not implicit: use `addChainTarget` first to avoid enabling a
   * feature on a chain by typo or copy/paste.
   */
  public setChainRollout(
    featureKey: string,
    chain: string,
    percentage: number,
    actor: string,
    options: { force?: boolean } = {},
  ): FeatureRolloutDefinition {
    this.assertNonEmpty(actor, 'actor');
    this.assertPercentage(percentage);
    const definition = this.requireFeature(featureKey);
    const normalizedChain = normalizeChain(chain);
    const rollout = definition.chains.find(
      (entry) => entry.chain === normalizedChain,
    );
    if (!rollout) {
      throw new Error(
        `Feature ${definition.key} is not targeted at chain ${normalizedChain}`,
      );
    }

    const from = rollout.percentage;
    if (
      percentage > from &&
      percentage - from > this.maxStepIncrease &&
      !options.force
    ) {
      throw new Error(
        `Rollout increase for ${definition.key}/${normalizedChain} exceeds maxStepIncrease=${this.maxStepIncrease} (${from} -> ${percentage})`,
      );
    }

    const at = this.now();
    rollout.percentage = percentage;
    definition.updatedAt = at;
    definition.updatedBy = actor.trim();
    this.record({
      at,
      featureKey: definition.key,
      chain: normalizedChain,
      action: 'set_percentage',
      actor: definition.updatedBy,
      fromPercentage: from,
      toPercentage: percentage,
    });
    this.logger.log(
      `Feature rollout updated key=${definition.key} chain=${normalizedChain} percentage=${from}->${percentage}`,
    );
    return this.copyDefinition(definition);
  }

  public addChainTarget(
    featureKey: string,
    chain: string,
    percentage: number,
    actor: string,
  ): FeatureRolloutDefinition {
    this.assertNonEmpty(actor, 'actor');
    this.assertPercentage(percentage);
    const definition = this.requireFeature(featureKey);
    const rollout = this.normalizeChainRollout({ chain, percentage });
    if (definition.chains.some((entry) => entry.chain === rollout.chain)) {
      throw new Error(
        `Chain ${rollout.chain} is already targeted by ${definition.key}`,
      );
    }

    const at = this.now();
    definition.chains.push(rollout);
    definition.updatedAt = at;
    definition.updatedBy = actor.trim();
    this.record({
      at,
      featureKey: definition.key,
      chain: rollout.chain,
      action: 'add_chain',
      actor: definition.updatedBy,
      toPercentage: percentage,
    });
    return this.copyDefinition(definition);
  }

  public pauseFeature(
    featureKey: string,
    actor: string,
  ): FeatureRolloutDefinition {
    return this.setPaused(featureKey, actor, true);
  }

  public resumeFeature(
    featureKey: string,
    actor: string,
  ): FeatureRolloutDefinition {
    return this.setPaused(featureKey, actor, false);
  }

  public enableFeature(
    featureKey: string,
    actor: string,
  ): FeatureRolloutDefinition {
    return this.setEnabled(featureKey, actor, true);
  }

  public disableFeature(
    featureKey: string,
    actor: string,
  ): FeatureRolloutDefinition {
    return this.setEnabled(featureKey, actor, false);
  }

  /** Operator evidence: definition, per-chain state, and mutation audit. */
  public getSnapshot(featureKey: string): FeatureRolloutSnapshot | undefined {
    const definition = this.features.get(normalizeFeatureKey(featureKey));
    if (!definition) return undefined;
    return {
      key: definition.key,
      description: definition.description,
      enabled: definition.enabled,
      paused: definition.paused,
      updatedAt: definition.updatedAt,
      updatedBy: definition.updatedBy,
      chains: definition.chains.map((entry) => ({
        ...entry,
        allowlist: entry.allowlist ? [...entry.allowlist] : undefined,
      })),
      audit: this.audit
        .filter((entry) => entry.featureKey === definition.key)
        .map((entry) => ({ ...entry })),
    };
  }

  public getAuditTrail(featureKey?: string): RolloutAuditEntry[] {
    const key = featureKey ? normalizeFeatureKey(featureKey) : undefined;
    return this.audit
      .filter((entry) => !key || entry.featureKey === key)
      .map((entry) => ({ ...entry }));
  }

  public clear(): void {
    this.features.clear();
    this.audit.length = 0;
  }

  private setPaused(
    featureKey: string,
    actor: string,
    paused: boolean,
  ): FeatureRolloutDefinition {
    this.assertNonEmpty(actor, 'actor');
    const definition = this.requireFeature(featureKey);
    const at = this.now();
    definition.paused = paused;
    definition.updatedAt = at;
    definition.updatedBy = actor.trim();
    this.record({
      at,
      featureKey: definition.key,
      action: paused ? 'pause' : 'resume',
      actor: definition.updatedBy,
    });
    this.logger.warn(
      `Feature rollout ${paused ? 'paused' : 'resumed'} key=${definition.key}`,
    );
    return this.copyDefinition(definition);
  }

  private setEnabled(
    featureKey: string,
    actor: string,
    enabled: boolean,
  ): FeatureRolloutDefinition {
    this.assertNonEmpty(actor, 'actor');
    const definition = this.requireFeature(featureKey);
    const at = this.now();
    definition.enabled = enabled;
    definition.updatedAt = at;
    definition.updatedBy = actor.trim();
    this.record({
      at,
      featureKey: definition.key,
      action: enabled ? 'enable' : 'disable',
      actor: definition.updatedBy,
    });
    return this.copyDefinition(definition);
  }

  private requireFeature(featureKey: string): FeatureRolloutDefinition {
    const key = normalizeFeatureKey(featureKey);
    const definition = this.features.get(key);
    if (!definition) {
      throw new Error(`Feature rollout not found: ${key}`);
    }
    return definition;
  }

  private normalizeChainRollout(entry: {
    chain: string;
    percentage: number;
    allowlist?: string[];
  }): FeatureChainRollout {
    this.assertPercentage(entry?.percentage);
    const chain = normalizeChain(entry?.chain);

    let allowlist: string[] | undefined;
    if (entry.allowlist !== undefined) {
      if (!Array.isArray(entry.allowlist)) {
        throw new Error('allowlist must be an array of subject ids');
      }
      allowlist = entry.allowlist.map((subject) => {
        if (typeof subject !== 'string' || subject.trim() === '') {
          throw new Error('allowlist entries must be non-empty strings');
        }
        return subject.trim();
      });
      if (
        new Set(allowlist.map((s) => s.toLowerCase())).size !== allowlist.length
      ) {
        throw new Error('allowlist entries must be unique');
      }
      if (allowlist.length === 0) allowlist = undefined;
    }

    return { chain, percentage: entry.percentage, allowlist };
  }

  private assertUniqueChains(chains: FeatureChainRollout[]): void {
    const seen = new Set<string>();
    for (const entry of chains) {
      if (seen.has(entry.chain)) {
        throw new Error(`Duplicate chain target: ${entry.chain}`);
      }
      seen.add(entry.chain);
    }
  }

  private assertPercentage(percentage: number): void {
    if (!Number.isInteger(percentage) || percentage < 0 || percentage > 100) {
      throw new Error(
        `percentage must be an integer between 0 and 100 (received ${percentage})`,
      );
    }
  }

  private assertNonEmpty(value: unknown, field: string): void {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${field} must be a non-empty string`);
    }
  }

  private decision(
    featureKey: string,
    chain: string,
    subjectId: string,
    enabled: boolean,
    percentage: number,
    reason: RolloutDecisionReason,
    evaluatedAt: number,
  ): RolloutDecision {
    return {
      featureKey,
      chain,
      subjectId,
      enabled,
      percentage,
      reason,
      evaluatedAt,
    };
  }

  private record(entry: RolloutAuditEntry): void {
    this.audit.push({ ...entry });
  }

  private copyDefinition(
    definition: FeatureRolloutDefinition,
  ): FeatureRolloutDefinition {
    return {
      ...definition,
      chains: definition.chains.map((entry) => ({
        ...entry,
        allowlist: entry.allowlist ? [...entry.allowlist] : undefined,
      })),
    };
  }
}

function normalizeFeatureKey(key: string): string {
  if (typeof key !== 'string' || !FEATURE_KEY_PATTERN.test(key.trim())) {
    throw new Error(
      'feature key must start with a letter and contain only letters, digits, dot, underscore, or hyphen (2-64 chars)',
    );
  }
  return key.trim().toLowerCase();
}

function normalizeChain(chain: string): string {
  if (typeof chain !== 'string' || chain.trim() === '') {
    throw new Error('chain must be a non-empty string');
  }
  return chain.trim().toLowerCase();
}

/**
 * FNV-1a 32-bit hash. Stable across processes and restarts, unlike
 * Math.random or per-process salts, so cohort membership is reproducible.
 */
function stableBucket(featureKey: string, subjectId: string): number {
  const input = `${featureKey}:${subjectId}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 100;
}
