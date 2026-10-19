/**
 * File: src/operations/mainnet/mainnet-operations.coordinator.ts
 *
 * Coordinates the four mainnet operations controls (#1378-#1381):
 * chain outage playbooks, signer readiness, chain-scoped rollouts, and canary
 * transfers.
 *
 * The coordinator is deliberately read-only for rollout state: it never
 * advances a percentage by itself. It gates canary execution and produces one
 * chain assessment that operators and API layers can expose safely.
 */

import { Injectable } from '@nestjs/common';
import { ChainOutagePlaybookService } from './chain-outage-playbook.service';
import { ChainFeatureRolloutService } from './chain-feature-rollout.service';
import {
  FeatureRolloutSnapshot,
  RolloutDecision,
} from './chain-feature-rollout.types';
import {
  CanaryTransferDependencies,
  CanaryTransferGuard,
  MainnetCanaryTransferPlan,
  MainnetCanaryTransferResult,
  RunCanaryTransferOptions,
} from './mainnet-canary-transfer.types';
import { MainnetCanaryTransferService } from './mainnet-canary-transfer.service';
import { ChainSignerReadiness } from './signer-availability-readiness.types';
import { SignerAvailabilityReadinessService } from './signer-availability-readiness.service';

export interface AssessChainOptions {
  /** Optional feature whose chain-scoped decision should be included. */
  featureKey?: string;
  /** Subject used for a deterministic rollout decision. */
  subjectId?: string;
}

export interface MainnetChainAssessment {
  chain: string;
  operational: boolean;
  reasons: string[];
  activeOutageIncidentIds: string[];
  signerReadiness?: ChainSignerReadiness;
  featureDecision?: RolloutDecision;
  featureSnapshot?: FeatureRolloutSnapshot;
}

@Injectable()
export class MainnetOperationsCoordinator {
  constructor(
    private readonly outages: ChainOutagePlaybookService,
    private readonly signers: SignerAvailabilityReadinessService,
    private readonly rollouts: ChainFeatureRolloutService,
    private readonly canaries: MainnetCanaryTransferService,
  ) {}

  /**
   * Assess whether a chain may originate mainnet activity.
   *
   * Missing signer readiness configuration is treated as not operational:
   * the coordinator fails closed instead of assuming a quorum exists.
   */
  public async assessChain(
    chain: string,
    options: AssessChainOptions = {},
  ): Promise<MainnetChainAssessment> {
    const normalizedChain = chain.trim().toLowerCase();
    const reasons: string[] = [];
    const activeIncidents =
      this.outages.getActiveIncidentsForChain(normalizedChain);
    const outageBlocked = this.outages.isChainBlocked(normalizedChain);
    if (outageBlocked) {
      reasons.push('active_chain_outage');
    } else if (activeIncidents.length > 0) {
      reasons.push('active_chain_incident');
    }

    let signerReadiness: ChainSignerReadiness | undefined;
    const requirement = this.signers.getRequirement(normalizedChain);
    if (!requirement) {
      reasons.push('signer_readiness_not_configured');
    } else {
      signerReadiness = await this.signers.checkChain(normalizedChain);
      if (signerReadiness.status !== 'ready') {
        reasons.push(`signer_readiness_${signerReadiness.status}`);
      }
    }

    const operational =
      !outageBlocked &&
      signerReadiness?.status === 'ready' &&
      Boolean(requirement);

    let featureDecision: RolloutDecision | undefined;
    let featureSnapshot: FeatureRolloutSnapshot | undefined;
    if (options.featureKey && options.subjectId) {
      featureDecision = this.rollouts.evaluate(options.featureKey, {
        chain: normalizedChain,
        subjectId: options.subjectId,
      });
      featureSnapshot = this.rollouts.getSnapshot(options.featureKey);
    }

    return {
      chain: normalizedChain,
      operational,
      reasons,
      activeOutageIncidentIds: activeIncidents.map((incident) => incident.id),
      signerReadiness,
      featureDecision,
      featureSnapshot,
    };
  }

  /**
   * Execute a canary only when the chain is operational at submission time.
   * The guard re-checks outage and signer state after the caller's preflight,
   * closing the gap between assessment and submission. Any extra guard is
   * combined with AND semantics.
   */
  public async runCanary(
    plan: MainnetCanaryTransferPlan,
    dependencies: CanaryTransferDependencies,
    options: RunCanaryTransferOptions = {},
  ): Promise<MainnetCanaryTransferResult> {
    const guard: CanaryTransferGuard = async (context) => {
      if (this.outages.isChainBlocked(context.chain)) {
        return { allowed: false, reasonCode: 'chain_outage' };
      }
      if (!this.signers.getRequirement(context.chain)) {
        return {
          allowed: false,
          reasonCode: 'signer_readiness_not_configured',
        };
      }
      const readiness = await this.signers.checkChain(context.chain);
      if (readiness.status !== 'ready') {
        return {
          allowed: false,
          reasonCode: `signer_readiness_${readiness.status}`,
        };
      }
      if (options.guard) {
        return options.guard(context);
      }
      return { allowed: true };
    };

    return this.canaries.run(plan, dependencies, {
      ...options,
      guard,
    });
  }
}
