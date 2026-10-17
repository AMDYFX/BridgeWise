/**
 * File: src/audit/privileged/audited-multisig-control.service.ts
 *
 * Audited wrapper around {@link MultiSigControlService}.
 *
 * Exposes the same mutating operations (propose / confirm / revoke / execute)
 * and return values, but records each one in the privileged action audit log:
 * an `attempted` entry before the operation runs, then `success` or `denied`
 * (with the service's error as the reason) afterwards, or `failed` if the
 * underlying service throws. Because the attempt is written first, a multisig
 * operation can never take effect without leaving a trace.
 */

import { randomUUID } from 'crypto';
import type {
  MultiSigControlService,
  ProposalResult,
} from '../../governance/multisig/multisig-control.service';
import type { PrivilegedActionAuditLog } from './privileged-action-audit-log';
import type { PrivilegedActionInput } from './privileged-action-audit.types';

export class AuditedMultiSigControlService {
  constructor(
    private readonly multisig: MultiSigControlService,
    private readonly audit: PrivilegedActionAuditLog,
  ) {}

  /** The wrapped service, for read-only calls such as `getProposal`. */
  get inner(): MultiSigControlService {
    return this.multisig;
  }

  propose(
    proposer: string,
    targetContract: string,
    operationName: string,
    params: Record<string, unknown>,
  ): ProposalResult {
    return this.audited(
      'multisig.propose',
      proposer,
      targetContract,
      { operationName, params },
      () => this.multisig.propose(proposer, targetContract, operationName, params),
    );
  }

  confirm(signer: string, proposalId: string): ProposalResult {
    return this.audited('multisig.confirm', signer, proposalId, {}, () =>
      this.multisig.confirm(signer, proposalId),
    );
  }

  revoke(signer: string, proposalId: string): ProposalResult {
    return this.audited('multisig.revoke', signer, proposalId, {}, () =>
      this.multisig.revoke(signer, proposalId),
    );
  }

  execute(executor: string, proposalId: string): ProposalResult {
    return this.audited('multisig.execute', executor, proposalId, {}, () =>
      this.multisig.execute(executor, proposalId),
    );
  }

  private audited(
    action: string,
    actor: string,
    target: string,
    params: Record<string, unknown>,
    operation: () => ProposalResult,
  ): ProposalResult {
    const base: PrivilegedActionInput = {
      actor,
      action,
      category: 'governance',
      target,
      params,
      correlationId: randomUUID(),
    };

    // Written first: if the audit log rejects the event, the operation never runs.
    this.audit.record({ ...base, outcome: 'attempted' });

    let result: ProposalResult;
    try {
      result = operation();
    } catch (error) {
      this.audit.record({
        ...base,
        outcome: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    this.audit.record({
      ...base,
      outcome: result.success ? 'success' : 'denied',
      reason: result.success ? undefined : result.error,
      params: result.proposalId ? { ...params, proposalId: result.proposalId } : params,
    });
    return result;
  }
}
