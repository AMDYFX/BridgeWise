/**
 * File: src/operations/mainnet/chain-outage-playbook.service.ts
 *
 * Chain outage response playbooks (#1378).
 *
 * The service keeps an auditable, chain-scoped incident lifecycle:
 * open -> mitigate (ordered steps + automatic containment) -> escalate -> resolve.
 * Incident opening is idempotent per dedupe key so repeated alerts never create
 * duplicate response tracks, and resolution requires every configured recovery
 * signal to be observed.
 */

import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import {
  ChainOutageIncident,
  ChainOutagePlaybook,
  ChainOutageSeverity,
  ChainOutageType,
  OpenOutageIncidentInput,
  OpenOutageIncidentResult,
  OutageIncidentFilter,
  OutageIncidentStatus,
  ResolveOutageIncidentInput,
} from './chain-outage-playbook.types';
import { DEFAULT_CHAIN_OUTAGE_PLAYBOOKS } from './chain-outage-playbooks.defaults';

const SEVERITIES: ChainOutageSeverity[] = ['sev1', 'sev2', 'sev3'];
const OUTAGE_TYPES: ChainOutageType[] = [
  'rpc_unavailable',
  'finality_stall',
  'bridge_contract_paused',
  'validator_degradation',
  'congestion',
];
const ACTIVE_STATUSES: OutageIncidentStatus[] = [
  'open',
  'mitigating',
  'escalated',
];

export interface ChainOutagePlaybookServiceOptions {
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Set to false to start without the built-in mainnet playbooks. */
  loadDefaults?: boolean;
}

@Injectable()
export class ChainOutagePlaybookService extends EventEmitter {
  private readonly logger = new Logger(ChainOutagePlaybookService.name);
  private readonly playbooks = new Map<string, ChainOutagePlaybook>();
  private readonly playbookIdsByChainAndType = new Map<string, string>();
  private readonly incidents = new Map<string, ChainOutageIncident>();
  private readonly now: () => number;
  private incidentSequence = 0;

  constructor(options: ChainOutagePlaybookServiceOptions = {}) {
    super();
    this.now = options.now ?? Date.now;
    if (options.loadDefaults !== false) {
      for (const playbook of DEFAULT_CHAIN_OUTAGE_PLAYBOOKS) {
        this.registerPlaybook(playbook, { replace: true });
      }
    }
  }

  /**
   * Register a playbook for a single chain/outage-type pair.
   * Use `replace` to deliberately override an existing deployment playbook.
   */
  public registerPlaybook(
    playbook: ChainOutagePlaybook,
    options: { replace?: boolean } = {},
  ): ChainOutagePlaybook {
    const normalized = this.normalizePlaybook(playbook);
    const key = this.playbookKey(normalized.chain, normalized.outageType);
    const existingId = this.playbookIdsByChainAndType.get(key);

    if (existingId && existingId !== normalized.id && !options.replace) {
      throw new Error(
        `A playbook already exists for ${normalized.chain}/${normalized.outageType}: ${existingId}`,
      );
    }
    if (this.playbooks.has(normalized.id) && !options.replace) {
      throw new Error(`Playbook already registered: ${normalized.id}`);
    }

    if (existingId) {
      this.playbooks.delete(existingId);
    }
    this.playbooks.set(normalized.id, normalized);
    this.playbookIdsByChainAndType.set(key, normalized.id);
    return this.copyPlaybook(normalized);
  }

  public listPlaybooks(chain?: string): ChainOutagePlaybook[] {
    const normalizedChain = chain ? normalizeChain(chain) : undefined;
    return Array.from(this.playbooks.values())
      .filter((p) => !normalizedChain || p.chain === normalizedChain)
      .map((p) => this.copyPlaybook(p));
  }

  public getPlaybook(
    chain: string,
    outageType: ChainOutageType,
  ): ChainOutagePlaybook | undefined {
    const id = this.playbookIdsByChainAndType.get(
      this.playbookKey(normalizeChain(chain), outageType),
    );
    const playbook = id ? this.playbooks.get(id) : undefined;
    return playbook ? this.copyPlaybook(playbook) : undefined;
  }

  /**
   * Open (or reuse) a chain-scoped incident. Repeated alerts with the same
   * dedupe key return the active incident instead of creating a duplicate.
   */
  public openIncident(
    input: OpenOutageIncidentInput,
  ): OpenOutageIncidentResult {
    this.assertNonEmpty(input?.openedBy, 'openedBy');
    this.assertNonEmpty(input?.detectionSource, 'detectionSource');
    if (!OUTAGE_TYPES.includes(input?.outageType)) {
      throw new Error(`Unsupported outage type: ${input?.outageType}`);
    }

    const chain = normalizeChain(input.chain);
    const playbook = this.getPlaybook(chain, input.outageType);
    if (!playbook) {
      throw new Error(
        `No playbook registered for ${chain}/${input.outageType}`,
      );
    }
    if (input.severity && !SEVERITIES.includes(input.severity)) {
      throw new Error(`Unsupported severity: ${input.severity}`);
    }

    const dedupeKey = normalizeDedupeKey(
      input.dedupeKey ?? input.detectionSource,
    );
    const duplicate = this.findActiveIncident(
      chain,
      input.outageType,
      dedupeKey,
    );
    if (duplicate) {
      return { incident: this.copyIncident(duplicate), created: false };
    }

    const at = this.now();
    const incident: ChainOutageIncident = {
      id: this.nextIncidentId(chain, at),
      chain,
      playbookId: playbook.id,
      outageType: playbook.outageType,
      severity: input.severity ?? playbook.severity,
      status: 'open',
      openedAt: at,
      updatedAt: at,
      openedBy: input.openedBy.trim(),
      detectionSource: input.detectionSource.trim(),
      dedupeKey,
      steps: playbook.steps
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((step) => ({ stepId: step.id, status: 'pending' })),
      escalations: [],
      automaticActions: [],
    };

    this.incidents.set(incident.id, incident);
    this.emit('incident_opened', this.copyIncident(incident));
    this.logger.warn(
      `Chain outage incident opened id=${incident.id} chain=${chain} type=${incident.outageType} severity=${incident.severity}`,
    );
    return { incident: this.copyIncident(incident), created: true };
  }

  public getIncident(incidentId: string): ChainOutageIncident | undefined {
    const incident = this.incidents.get(incidentId);
    return incident ? this.copyIncident(incident) : undefined;
  }

  public listIncidents(
    filter: OutageIncidentFilter = {},
  ): ChainOutageIncident[] {
    let result = Array.from(this.incidents.values());
    if (filter.chain) {
      const chain = normalizeChain(filter.chain);
      result = result.filter((i) => i.chain === chain);
    }
    if (filter.status) {
      result = result.filter((i) => i.status === filter.status);
    }
    if (filter.activeOnly) {
      result = result.filter((i) => ACTIVE_STATUSES.includes(i.status));
    }
    return result.map((i) => this.copyIncident(i));
  }

  public startStep(
    incidentId: string,
    stepId: string,
    actor: string,
  ): ChainOutageIncident {
    this.assertNonEmpty(actor, 'actor');
    const incident = this.requireActiveIncident(incidentId);
    const step = this.requireStep(incident, stepId);
    if (step.status !== 'pending') {
      throw new Error(`Step ${stepId} is not pending (${step.status})`);
    }
    this.assertPreviousStepsSettled(incident, stepId);

    const at = this.now();
    step.status = 'in_progress';
    step.startedAt = at;
    step.actor = actor.trim();
    incident.updatedAt = at;
    if (incident.status === 'open') {
      incident.status = 'mitigating';
    }

    const playbook = this.playbooks.get(incident.playbookId);
    const definition = playbook?.steps.find((s) => s.id === stepId);
    if (definition?.action) {
      if (!incident.automaticActions.includes(definition.action)) {
        incident.automaticActions.push(definition.action);
      }
      this.emit('automatic_action', {
        incidentId: incident.id,
        chain: incident.chain,
        action: definition.action,
      });
      this.logger.warn(
        `Chain outage automatic action incident=${incident.id} chain=${incident.chain} action=${definition.action}`,
      );
    }

    this.emit('step_started', {
      incidentId: incident.id,
      stepId,
      actor: step.actor,
    });
    return this.copyIncident(incident);
  }

  public completeStep(
    incidentId: string,
    stepId: string,
    actor: string,
    note?: string,
  ): ChainOutageIncident {
    this.assertNonEmpty(actor, 'actor');
    const incident = this.requireActiveIncident(incidentId);
    const step = this.requireStep(incident, stepId);
    if (step.status !== 'in_progress') {
      throw new Error(`Step ${stepId} must be in_progress to complete`);
    }

    const at = this.now();
    step.status = 'completed';
    step.completedAt = at;
    step.actor = actor.trim();
    if (note) step.note = note.trim();
    incident.updatedAt = at;

    this.emit('step_completed', {
      incidentId: incident.id,
      stepId,
      actor: step.actor,
    });
    return this.copyIncident(incident);
  }

  public skipStep(
    incidentId: string,
    stepId: string,
    actor: string,
    note: string,
  ): ChainOutageIncident {
    this.assertNonEmpty(actor, 'actor');
    this.assertNonEmpty(note, 'note');
    const incident = this.requireActiveIncident(incidentId);
    const step = this.requireStep(incident, stepId);
    const playbook = this.playbooks.get(incident.playbookId);
    const definition = playbook?.steps.find((s) => s.id === stepId);
    if (definition?.required) {
      throw new Error(`Required step ${stepId} cannot be skipped`);
    }
    if (step.status !== 'pending') {
      throw new Error(`Step ${stepId} is not pending (${step.status})`);
    }
    this.assertPreviousStepsSettled(incident, stepId);

    const at = this.now();
    step.status = 'skipped';
    step.actor = actor.trim();
    step.note = note.trim();
    step.completedAt = at;
    incident.updatedAt = at;

    this.emit('step_skipped', {
      incidentId: incident.id,
      stepId,
      actor: step.actor,
    });
    return this.copyIncident(incident);
  }

  public escalate(
    incidentId: string,
    reason: string,
    role?: string,
  ): ChainOutageIncident {
    this.assertNonEmpty(reason, 'reason');
    const incident = this.requireActiveIncident(incidentId);
    const playbook = this.playbooks.get(incident.playbookId);
    if (!playbook) {
      throw new Error(`Playbook missing for incident: ${incident.playbookId}`);
    }

    const at = this.now();
    incident.escalations.push({
      at,
      role: (role ?? playbook.escalation.secondaryRole).trim(),
      reason: reason.trim(),
    });
    incident.status = 'escalated';
    incident.updatedAt = at;

    this.emit('incident_escalated', {
      incidentId: incident.id,
      chain: incident.chain,
      role: incident.escalations[incident.escalations.length - 1].role,
    });
    this.logger.warn(
      `Chain outage incident escalated id=${incident.id} chain=${incident.chain}`,
    );
    return this.copyIncident(incident);
  }

  /**
   * Resolve an active incident. All required steps must be completed and every
   * recovery signal must have been observed; otherwise resolution is rejected.
   */
  public resolveIncident(
    input: ResolveOutageIncidentInput,
  ): ChainOutageIncident {
    this.assertNonEmpty(input?.resolvedBy, 'resolvedBy');
    const incident = this.requireActiveIncident(input.incidentId);
    const playbook = this.playbooks.get(incident.playbookId);
    if (!playbook) {
      throw new Error(`Playbook missing for incident: ${incident.playbookId}`);
    }

    const incomplete = playbook.steps.filter((definition) => {
      if (!definition.required) return false;
      const step = incident.steps.find((s) => s.stepId === definition.id);
      return step?.status !== 'completed';
    });
    if (incomplete.length > 0) {
      throw new Error(
        `Required steps are incomplete: ${incomplete.map((s) => s.id).join(', ')}`,
      );
    }

    const observed = new Set(
      (input.observedSignals ?? []).map((signal) =>
        signal.trim().toLowerCase(),
      ),
    );
    const missingSignals = playbook.recovery.signals.filter(
      (signal) => !observed.has(signal.trim().toLowerCase()),
    );
    if (missingSignals.length > 0) {
      throw new Error(
        `Recovery signals not observed: ${missingSignals.join(', ')}`,
      );
    }

    const at = this.now();
    incident.status = 'resolved';
    incident.updatedAt = at;
    incident.resolution = {
      at,
      resolvedBy: input.resolvedBy.trim(),
      observedSignals: Array.from(observed),
      note: input.note?.trim(),
    };

    this.emit('incident_resolved', this.copyIncident(incident));
    this.logger.log(
      `Chain outage incident resolved id=${incident.id} chain=${incident.chain}`,
    );
    return this.copyIncident(incident);
  }

  /**
   * True when an active sev1/sev2 incident means the chain must not originate
   * new transfers, canary rollouts, or settlements.
   */
  public isChainBlocked(chain: string): boolean {
    const normalizedChain = normalizeChain(chain);
    return Array.from(this.incidents.values()).some(
      (incident) =>
        incident.chain === normalizedChain &&
        ACTIVE_STATUSES.includes(incident.status) &&
        (incident.severity === 'sev1' || incident.severity === 'sev2'),
    );
  }

  public getActiveIncidentsForChain(chain: string): ChainOutageIncident[] {
    const normalizedChain = normalizeChain(chain);
    return Array.from(this.incidents.values())
      .filter(
        (incident) =>
          incident.chain === normalizedChain &&
          ACTIVE_STATUSES.includes(incident.status),
      )
      .map((incident) => this.copyIncident(incident));
  }

  public clear(): void {
    this.incidents.clear();
  }

  private normalizePlaybook(
    playbook: ChainOutagePlaybook,
  ): ChainOutagePlaybook {
    this.assertNonEmpty(playbook?.id, 'playbook.id');
    this.assertNonEmpty(playbook?.chain, 'playbook.chain');
    this.assertNonEmpty(playbook?.summary, 'playbook.summary');
    if (!OUTAGE_TYPES.includes(playbook.outageType)) {
      throw new Error(`Unsupported outage type: ${playbook.outageType}`);
    }
    if (!SEVERITIES.includes(playbook.severity)) {
      throw new Error(`Unsupported severity: ${playbook.severity}`);
    }
    if (!Array.isArray(playbook.steps) || playbook.steps.length === 0) {
      throw new Error('Playbook must define at least one step');
    }

    const stepIds = new Set<string>();
    const stepOrders = new Set<number>();
    const steps = playbook.steps.map((step) => {
      this.assertNonEmpty(step.id, 'step.id');
      this.assertNonEmpty(step.title, 'step.title');
      this.assertNonEmpty(step.ownerRole, 'step.ownerRole');
      if (!Number.isFinite(step.order) || step.order <= 0) {
        throw new Error(`Step ${step.id} must have a positive order`);
      }
      if (!Number.isFinite(step.slaSeconds) || step.slaSeconds <= 0) {
        throw new Error(`Step ${step.id} must have a positive slaSeconds`);
      }
      if (stepIds.has(step.id)) {
        throw new Error(`Duplicate playbook step id: ${step.id}`);
      }
      if (stepOrders.has(step.order)) {
        throw new Error(`Duplicate playbook step order: ${step.order}`);
      }
      stepIds.add(step.id);
      stepOrders.add(step.order);
      return { ...step };
    });

    if (!Array.isArray(playbook.recovery?.signals)) {
      throw new Error('Playbook recovery signals must be an array');
    }
    const signals = playbook.recovery.signals
      .map((signal) => String(signal).trim())
      .filter(Boolean);
    if (signals.length === 0) {
      throw new Error('Playbook must define at least one recovery signal');
    }
    if (new Set(signals.map((s) => s.toLowerCase())).size !== signals.length) {
      throw new Error('Recovery signals must be unique');
    }
    if (
      !Number.isFinite(playbook.recovery.observationWindowSeconds) ||
      playbook.recovery.observationWindowSeconds < 0
    ) {
      throw new Error('observationWindowSeconds must be zero or positive');
    }

    this.assertNonEmpty(
      playbook.escalation?.primaryRole,
      'escalation.primaryRole',
    );
    this.assertNonEmpty(
      playbook.escalation?.secondaryRole,
      'escalation.secondaryRole',
    );

    return {
      ...playbook,
      id: playbook.id.trim(),
      chain: normalizeChain(playbook.chain),
      summary: playbook.summary.trim(),
      steps: steps.sort((a, b) => a.order - b.order),
      recovery: {
        ...playbook.recovery,
        signals,
      },
      escalation: { ...playbook.escalation },
    };
  }

  private findActiveIncident(
    chain: string,
    outageType: ChainOutageType,
    dedupeKey: string,
  ): ChainOutageIncident | undefined {
    return Array.from(this.incidents.values()).find(
      (incident) =>
        incident.chain === chain &&
        incident.outageType === outageType &&
        incident.dedupeKey === dedupeKey &&
        ACTIVE_STATUSES.includes(incident.status),
    );
  }

  private requireActiveIncident(incidentId: string): ChainOutageIncident {
    const incident = this.incidents.get(incidentId);
    if (!incident) {
      throw new Error(`Incident not found: ${incidentId}`);
    }
    if (!ACTIVE_STATUSES.includes(incident.status)) {
      throw new Error(`Incident ${incidentId} is already ${incident.status}`);
    }
    return incident;
  }

  private requireStep(
    incident: ChainOutageIncident,
    stepId: string,
  ): ChainOutageIncident['steps'][number] {
    const step = incident.steps.find((s) => s.stepId === stepId);
    if (!step) {
      throw new Error(`Step not found on incident ${incident.id}: ${stepId}`);
    }
    return step;
  }

  private assertPreviousStepsSettled(
    incident: ChainOutageIncident,
    stepId: string,
  ): void {
    const playbook = this.playbooks.get(incident.playbookId);
    if (!playbook) return;
    const definition = playbook.steps.find((s) => s.id === stepId);
    if (!definition) return;

    const unsettled = playbook.steps
      .filter((s) => s.order < definition.order)
      .filter((s) => {
        const state = incident.steps.find((i) => i.stepId === s.id);
        return state?.status !== 'completed' && state?.status !== 'skipped';
      });
    if (unsettled.length > 0) {
      throw new Error(
        `Previous steps must settle before ${stepId}: ${unsettled
          .map((s) => s.id)
          .join(', ')}`,
      );
    }
  }

  private playbookKey(chain: string, outageType: ChainOutageType): string {
    return `${chain}:${outageType}`;
  }

  private nextIncidentId(chain: string, at: number): string {
    this.incidentSequence += 1;
    return `incident-${chain}-${at}-${this.incidentSequence}`;
  }

  private copyPlaybook(playbook: ChainOutagePlaybook): ChainOutagePlaybook {
    return {
      ...playbook,
      steps: playbook.steps.map((step) => ({ ...step })),
      escalation: { ...playbook.escalation },
      recovery: {
        ...playbook.recovery,
        signals: [...playbook.recovery.signals],
      },
    };
  }

  private copyIncident(incident: ChainOutageIncident): ChainOutageIncident {
    return {
      ...incident,
      steps: incident.steps.map((step) => ({ ...step })),
      escalations: incident.escalations.map((escalation) => ({
        ...escalation,
      })),
      automaticActions: [...incident.automaticActions],
      resolution: incident.resolution
        ? {
            ...incident.resolution,
            observedSignals: [...incident.resolution.observedSignals],
          }
        : undefined,
    };
  }

  private assertNonEmpty(value: unknown, field: string): void {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${field} must be a non-empty string`);
    }
  }
}

function normalizeChain(chain: string): string {
  if (typeof chain !== 'string' || chain.trim() === '') {
    throw new Error('chain must be a non-empty string');
  }
  return chain.trim().toLowerCase();
}

function normalizeDedupeKey(key: string): string {
  const normalized = String(key).trim().toLowerCase().replace(/\s+/g, '-');
  return normalized.slice(0, 128);
}
