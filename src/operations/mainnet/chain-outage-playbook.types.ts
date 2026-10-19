/**
 * File: src/operations/mainnet/chain-outage-playbook.types.ts
 *
 * Types for chain outage response playbooks (#1378).
 * Playbooks bind a chain and outage class to an ordered, auditable response
 * procedure with automatic containment actions and explicit recovery signals.
 */

export type ChainOutageSeverity = 'sev1' | 'sev2' | 'sev3';

export type ChainOutageType =
  | 'rpc_unavailable'
  | 'finality_stall'
  | 'bridge_contract_paused'
  | 'validator_degradation'
  | 'congestion';

export type OutageIncidentStatus =
  'open' | 'mitigating' | 'escalated' | 'resolved';

export type OutageStepStatus =
  'pending' | 'in_progress' | 'completed' | 'skipped';

/**
 * Containment actions the platform may execute automatically when the step is
 * started. Actions are chain-scoped by the incident's playbook; they never
 * carry signing material or transaction payloads.
 */
export type OutageAutomaticAction =
  | 'pause_routes'
  | 'disable_chain_feature_flags'
  | 'halt_canary_transfers'
  | 'notify_oncall';

export interface OutagePlaybookStep {
  id: string;
  /** Ascending execution order. Duplicate orders are rejected on registration. */
  order: number;
  title: string;
  ownerRole: string;
  /** Maximum time allowed for the step before operators should escalate. */
  slaSeconds: number;
  required: boolean;
  /** Optional platform action executed when the step is started. */
  action?: OutageAutomaticAction;
}

export interface OutageEscalationPolicy {
  primaryRole: string;
  secondaryRole: string;
  notifyAfterSeconds: number;
}

export interface OutageRecoveryCriteria {
  /**
   * Named signals that must all be observed before an incident can be resolved.
   * Signal values are supplied by the operator runbook and are not ingested
   * from untrusted RPC payloads.
   */
  signals: string[];
  /** How long the signals must remain healthy before recovery is declared. */
  observationWindowSeconds: number;
}

export interface ChainOutagePlaybook {
  id: string;
  /** Normalized chain identifier, e.g. `stellar-mainnet`. */
  chain: string;
  outageType: ChainOutageType;
  severity: ChainOutageSeverity;
  summary: string;
  steps: OutagePlaybookStep[];
  escalation: OutageEscalationPolicy;
  recovery: OutageRecoveryCriteria;
}

export interface OpenOutageIncidentInput {
  chain: string;
  outageType: ChainOutageType;
  openedBy: string;
  detectionSource: string;
  /** Optional key used to make incident opening idempotent. */
  dedupeKey?: string;
  /** Overrides the playbook severity when triage downgrades or upgrades it. */
  severity?: ChainOutageSeverity;
}

export interface OutageIncidentStepState {
  stepId: string;
  status: OutageStepStatus;
  startedAt?: number;
  completedAt?: number;
  actor?: string;
  note?: string;
}

export interface ChainOutageIncident {
  id: string;
  chain: string;
  playbookId: string;
  outageType: ChainOutageType;
  severity: ChainOutageSeverity;
  status: OutageIncidentStatus;
  openedAt: number;
  updatedAt: number;
  openedBy: string;
  detectionSource: string;
  dedupeKey: string;
  steps: OutageIncidentStepState[];
  escalations: Array<{ at: number; role: string; reason: string }>;
  /** Names of automatic actions executed for this incident. */
  automaticActions: OutageAutomaticAction[];
  resolution?: {
    at: number;
    resolvedBy: string;
    observedSignals: string[];
    note?: string;
  };
}

export interface OpenOutageIncidentResult {
  incident: ChainOutageIncident;
  /** False when an existing active incident matched the dedupe key. */
  created: boolean;
}

export interface ResolveOutageIncidentInput {
  incidentId: string;
  resolvedBy: string;
  observedSignals: string[];
  note?: string;
}

export interface OutageIncidentFilter {
  chain?: string;
  status?: OutageIncidentStatus;
  activeOnly?: boolean;
}
