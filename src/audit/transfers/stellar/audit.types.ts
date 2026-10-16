/**
 * Audit log entry for a Stellar bridge transfer
 */
export interface TransferAuditLog {
  auditId: string;
  transferId: string;
  timestamp: number;
  action: AuditAction;
  actor: string;
  sourceChain: string;
  destinationChain: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
  assetCode: string;
  status: AuditStatus;
  txHash?: string;
  details?: Record<string, unknown>;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Types of audit actions
 */
export enum AuditAction {
  TRANSFER_INITIATED = 'transfer.initiated',
  TRANSFER_SUBMITTED = 'transfer.submitted',
  TRANSFER_CONFIRMED = 'transfer.confirmed',
  TRANSFER_COMPLETED = 'transfer.completed',
  TRANSFER_FAILED = 'transfer.failed',
  TRANSFER_ROLLED_BACK = 'transfer.rolled_back',
  AUDIT_ACCESSED = 'audit.accessed',
  AUDIT_EXPORTED = 'audit.exported',
}

/**
 * Status of the transfer at the time of audit
 */
export enum AuditStatus {
  PENDING = 'pending',
  SUBMITTED = 'submitted',
  CONFIRMED = 'confirmed',
  COMPLETED = 'completed',
  FAILED = 'failed',
  ROLLED_BACK = 'rolled_back',
}

/**
 * Query parameters for searching audit logs
 */
export interface AuditSearchQuery {
  transferIds?: string[];
  actions?: AuditAction[];
  fromAddress?: string;
  toAddress?: string;
  sourceChain?: string;
  destinationChain?: string;
  assetCode?: string;
  status?: AuditStatus[];
  startTime?: number;
  endTime?: number;
  limit?: number;
  offset?: number;
}

/**
 * Result of audit log search
 */
export interface AuditSearchResult {
  total: number;
  offset: number;
  limit: number;
  items: TransferAuditLog[];
}

/**
 * Audit log export format
 */
export interface AuditExportRequest {
  query: AuditSearchQuery;
  format: ExportFormat;
}

/**
 * Supported export formats
 */
export enum ExportFormat {
  JSON = 'json',
  CSV = 'csv',
  PDF = 'pdf',
}

/**
 * Result of audit export operation
 */
export interface AuditExportResult {
  exportId: string;
  format: ExportFormat;
  itemCount: number;
  createdAt: number;
  expiresAt: number;
  downloadUrl?: string;
  data?: string | Uint8Array;
}

export interface IncidentEvidenceRequest {
  incidentId: string;
  requestedBy: string;
  startTime: number;
  endTime: number;
  transferIds?: string[];
}

export interface IncidentEvidenceRecord {
  auditId: string;
  transferId: string;
  timestamp: number;
  action: AuditAction;
  status: AuditStatus;
  sourceChain: string;
  destinationChain: string;
  assetCode: string;
  fromAddressFingerprint?: string;
  toAddressFingerprint?: string;
  transactionHint?: string;
}

export interface IncidentEvidenceBundle {
  schemaVersion: 1;
  type: 'bridgewise-incident-evidence';
  incidentId: string;
  generatedAt: number;
  timeWindow: { startTime: number; endTime: number };
  recordCount: number;
  redaction: 'addresses-and-amounts-omitted';
  records: IncidentEvidenceRecord[];
  integrityHash: string;
}

export interface IncidentEvidenceExportResult extends AuditExportResult {
  incidentId: string;
  integrityHash: string;
}

export interface IncidentEvidenceExportAuditEvent {
  exportId: string;
  incidentId: string;
  requestedBy: string;
  createdAt: number;
  expiresAt: number;
  itemCount: number;
  integrityHash: string;
}

/**
 * Summary statistics for audit logs
 */
export interface AuditStatistics {
  totalTransfers: number;
  successfulTransfers: number;
  failedTransfers: number;
  averageAmountUSD: number;
  totalVolumeUSD: number;
  uniqueAddresses: number;
  lastAuditTime: number;
}

/**
 * Configuration for the audit API
 */
export interface AuditAPIConfig {
  storageBackend: 'memory' | 'postgres' | 'mongodb';
  maxSearchResults: number;
  auditLogRetentionDays?: number;
  exportRetentionDays: number;
  enableCompression: boolean;
}
