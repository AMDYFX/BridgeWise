/**
 * File: src/audit/privileged/index.ts
 *
 * Module barrel for privileged action audit logs.
 */

export {
  GENESIS_HASH,
  PrivilegedActionAuditError,
  PrivilegedActionAuditLog,
  PrivilegedActionDeniedError,
} from './privileged-action-audit-log';
export type { PrivilegedAuditErrorCode } from './privileged-action-audit-log';
export { AuditedMultiSigControlService } from './audited-multisig-control.service';
export { REDACTED, sanitizeParams } from './sanitize';
export type {
  AuditIntegrityReport,
  PrivilegedActionAuditConfig,
  PrivilegedActionAuditEntry,
  PrivilegedActionCategory,
  PrivilegedActionInput,
  PrivilegedActionOutcome,
  PrivilegedActionQuery,
  PrivilegedActionQueryResult,
  PrivilegedAuditSink,
  PrivilegedAuditStats,
} from './privileged-action-audit.types';
