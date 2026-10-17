/**
 * File: src/audit/privileged/audited-multisig-control.service.spec.ts
 *
 * Integration tests: the real MultiSigControlService wrapped with the
 * privileged action audit log.
 */

import { MultiSigControlService } from '../../governance/multisig/multisig-control.service';
import { AuditedMultiSigControlService } from './audited-multisig-control.service';
import {
  PrivilegedActionAuditError,
  PrivilegedActionAuditLog,
} from './privileged-action-audit-log';
import { REDACTED } from './sanitize';

describe('AuditedMultiSigControlService', () => {
  let multisig: MultiSigControlService;
  let audit: PrivilegedActionAuditLog;
  let audited: AuditedMultiSigControlService;

  beforeEach(() => {
    multisig = new MultiSigControlService({
      owners: ['0xa', '0xb', '0xc'],
      requiredThreshold: 2,
      proposalTTLMs: 60_000,
    });
    audit = new PrivilegedActionAuditLog();
    audited = new AuditedMultiSigControlService(multisig, audit);
  });

  it('passes results through unchanged and records attempted → success for a proposal', () => {
    const result = audited.propose('0xa', 'Treasury', 'setFee', { fee: '0.3' });

    expect(result.success).toBe(true);
    expect(multisig.getProposal(result.proposalId!)).toBeDefined();

    const { items } = audit.query();
    expect(items.map((e) => e.outcome)).toEqual(['attempted', 'success']);
    expect(items[0].correlationId).toBe(items[1].correlationId);
    expect(items[1]).toMatchObject({
      actor: '0xa',
      action: 'multisig.propose',
      category: 'governance',
      target: 'Treasury',
      params: { operationName: 'setFee', params: { fee: '0.3' }, proposalId: result.proposalId },
    });
  });

  it('records a denied outcome with the reason when a non-owner acts', () => {
    const result = audited.propose('0xevil', 'Treasury', 'drain', {});

    expect(result.success).toBe(false);
    const { items } = audit.query();
    expect(items.map((e) => e.outcome)).toEqual(['attempted', 'denied']);
    expect(items[1].reason).toContain('not an authorized multisig owner');
    expect(items[1].actor).toBe('0xevil');
  });

  it('audits the full propose → confirm → execute lifecycle, including a denied early execution', () => {
    const { proposalId } = audited.propose('0xa', 'Treasury', 'setFee', { fee: '0.3' });

    const early = audited.execute('0xa', proposalId!);
    expect(early.success).toBe(false); // 1 of 2 confirmations

    expect(audited.confirm('0xb', proposalId!).success).toBe(true);
    expect(audited.execute('0xa', proposalId!).success).toBe(true);

    const trail = audit.query({ target: proposalId! }).items;
    expect(trail.map((e) => `${e.action}:${e.outcome}`)).toEqual([
      'multisig.execute:attempted',
      'multisig.execute:denied',
      'multisig.confirm:attempted',
      'multisig.confirm:success',
      'multisig.execute:attempted',
      'multisig.execute:success',
    ]);
    expect(trail[1].reason).toContain('Insufficient confirmations');
    expect(audit.verifyIntegrity()).toEqual({ valid: true, checked: 8 });
  });

  it('audits revocations and duplicate confirmations', () => {
    const { proposalId } = audited.propose('0xa', 'Treasury', 'setFee', {});

    expect(audited.confirm('0xa', proposalId!).success).toBe(false); // proposer already confirmed
    expect(audited.revoke('0xa', proposalId!).success).toBe(true);

    expect(audit.query({ action: 'multisig.confirm', outcome: 'denied' }).items[0].reason).toContain(
      'already confirmed',
    );
    expect(audit.query({ action: 'multisig.revoke', outcome: 'success' }).total).toBe(1);
  });

  it('records failed and rethrows when the underlying service throws', () => {
    jest.spyOn(multisig, 'execute').mockImplementation(() => {
      throw new Error('boom');
    });

    expect(() => audited.execute('0xa', 'prop-1')).toThrow('boom');

    expect(audit.query().items.map((e) => e.outcome)).toEqual(['attempted', 'failed']);
    expect(audit.query({ outcome: 'failed' }).items[0].reason).toBe('boom');
  });

  it('does not run the operation when the attempt cannot be audited (fail closed)', () => {
    const propose = jest.spyOn(multisig, 'propose');
    jest.spyOn(audit, 'record').mockImplementation(() => {
      throw new PrivilegedActionAuditError('INVALID_ACTOR', 'audit unavailable');
    });

    expect(() => audited.propose('0xa', 'Treasury', 'setFee', {})).toThrow('audit unavailable');
    expect(propose).not.toHaveBeenCalled();
  });

  it('redacts secrets in the audit trail while the operation still receives them', () => {
    const propose = jest.spyOn(multisig, 'propose');

    audited.propose('0xa', 'Gateway', 'rotateKey', { apiKey: 'live-key-123', region: 'eu' });

    expect(propose).toHaveBeenCalledWith('0xa', 'Gateway', 'rotateKey', {
      apiKey: 'live-key-123',
      region: 'eu',
    });
    const serialized = JSON.stringify(audit.exportEntries());
    expect(serialized).not.toContain('live-key-123');
    expect(audit.query().items[0].params).toMatchObject({
      params: { apiKey: REDACTED, region: 'eu' },
    });
  });

  it('exposes the wrapped service for read-only calls', () => {
    const { proposalId } = audited.propose('0xa', 'Treasury', 'setFee', {});

    expect(audited.inner.getProposal(proposalId!)?.executed).toBe(false);
    expect(audited.inner.isOwner('0xB')).toBe(true);
  });
});
