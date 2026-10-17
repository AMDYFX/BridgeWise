import {
  TransferAuditLog,
  AuditStatus,
  AuditSearchQuery,
  AuditSearchResult,
  AuditExportRequest,
  AuditExportResult,
  AuditStatistics,
  AuditAPIConfig,
  ExportFormat,
  IncidentEvidenceBundle,
  IncidentEvidenceExportAuditEvent,
  IncidentEvidenceExportResult,
  IncidentEvidenceRecord,
  IncidentEvidenceRequest,
} from './audit.types';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';

/**
 * Service for storing and retrieving Stellar bridge transfer audit logs.
 * Provides searchable audit trail for historical transfer records with support
 * for multiple export formats.
 *
 * @example
 * const auditAPI = new StellarTransferAuditAPI({
 *   storageBackend: 'postgres',
 *   maxSearchResults: 10000,
 *   exportRetentionDays: 90,
 *   enableCompression: true,
 * });
 *
 * auditAPI.logTransferAction({
 *   transferId: 'tx-123',
 *   action: AuditAction.TRANSFER_INITIATED,
 *   actor: 'system',
 *   sourceChain: 'stellar',
 *   destinationChain: 'ethereum',
 *   fromAddress: '0xfrom',
 *   toAddress: '0xto',
 *   amount: '100',
 *   assetCode: 'USDC',
 *   status: AuditStatus.PENDING,
 * });
 *
 * const results = await auditAPI.search({
 *   transferIds: ['tx-123'],
 *   actions: [AuditAction.TRANSFER_COMPLETED],
 *   limit: 50,
 * });
 */
export class StellarTransferAuditAPI {
  private readonly config: Required<AuditAPIConfig>;
  private readonly now: () => number;
  private auditLogs: Map<string, TransferAuditLog> = new Map();
  private exports: Map<string, AuditExportResult> = new Map();
  private indexByTransferId: Map<string, string[]> = new Map();
  private indexByAddress: Map<string, string[]> = new Map();
  private readonly onIncidentEvidenceExport?: (
    event: IncidentEvidenceExportAuditEvent,
  ) => void;

  constructor(
    config: Partial<AuditAPIConfig> = {},
    options: {
      now?: () => number;
      onIncidentEvidenceExport?: (
        event: IncidentEvidenceExportAuditEvent,
      ) => void;
    } = {},
  ) {
    this.config = {
      storageBackend: config.storageBackend ?? 'memory',
      maxSearchResults: config.maxSearchResults ?? 10000,
      auditLogRetentionDays: config.auditLogRetentionDays ?? 90,
      exportRetentionDays: config.exportRetentionDays ?? 90,
      enableCompression: config.enableCompression ?? false,
    };
    validateRetentionDays(
      'auditLogRetentionDays',
      this.config.auditLogRetentionDays,
    );
    validateRetentionDays(
      'exportRetentionDays',
      this.config.exportRetentionDays,
    );
    this.now = options.now ?? (() => Date.now());
    this.onIncidentEvidenceExport = options.onIncidentEvidenceExport;
  }

  /**
   * Log a transfer action to the audit trail
   */
  logTransferAction(
    log: Omit<TransferAuditLog, 'auditId' | 'timestamp'>,
  ): TransferAuditLog {
    const auditLog: TransferAuditLog = {
      ...log,
      auditId: randomUUID(),
      timestamp: this.now(),
    };

    this.auditLogs.set(auditLog.auditId, auditLog);
    this.updateIndexes(auditLog);

    return auditLog;
  }

  /**
   * Search audit logs with flexible query parameters
   */
  async search(query: AuditSearchQuery): Promise<AuditSearchResult> {
    let logs = Array.from(this.auditLogs.values());

    // Filter by transfer IDs
    if (query.transferIds && query.transferIds.length > 0) {
      const transferIdSet = new Set(query.transferIds);
      logs = logs.filter((log) => transferIdSet.has(log.transferId));
    }

    // Filter by actions
    if (query.actions && query.actions.length > 0) {
      const actionSet = new Set(query.actions);
      logs = logs.filter((log) => actionSet.has(log.action));
    }

    // Filter by addresses
    if (query.fromAddress) {
      logs = logs.filter((log) => log.fromAddress === query.fromAddress);
    }
    if (query.toAddress) {
      logs = logs.filter((log) => log.toAddress === query.toAddress);
    }

    // Filter by chains
    if (query.sourceChain) {
      logs = logs.filter((log) => log.sourceChain === query.sourceChain);
    }
    if (query.destinationChain) {
      logs = logs.filter(
        (log) => log.destinationChain === query.destinationChain,
      );
    }

    // Filter by asset code
    if (query.assetCode) {
      logs = logs.filter((log) => log.assetCode === query.assetCode);
    }

    // Filter by status
    if (query.status && query.status.length > 0) {
      const statusSet = new Set(query.status);
      logs = logs.filter((log) => statusSet.has(log.status));
    }

    // Filter by time range
    if (query.startTime !== undefined) {
      logs = logs.filter((log) => log.timestamp >= query.startTime);
    }
    if (query.endTime !== undefined) {
      logs = logs.filter((log) => log.timestamp <= query.endTime);
    }

    // Sort by timestamp (newest first)
    logs.sort((a, b) => b.timestamp - a.timestamp);

    // Apply pagination
    const offset = query.offset || 0;
    const limit = Math.min(
      query.limit || this.config.maxSearchResults,
      this.config.maxSearchResults,
    );
    const paginatedLogs = logs.slice(offset, offset + limit);

    return {
      total: logs.length,
      offset,
      limit,
      items: paginatedLogs,
    };
  }

  /**
   * Get all audit logs for a specific transfer
   */
  async getTransferHistory(transferId: string): Promise<TransferAuditLog[]> {
    const result = await this.search({ transferIds: [transferId] });
    return result.items;
  }

  /**
   * Export audit logs in specified format
   */
  async export(request: AuditExportRequest): Promise<AuditExportResult> {
    const searchResult = await this.search(request.query);
    const exportId = randomUUID();

    let data: string | Uint8Array;

    switch (request.format) {
      case ExportFormat.JSON:
        data = JSON.stringify(searchResult.items, null, 2);
        break;

      case ExportFormat.CSV:
        data = this.logsToCSV(searchResult.items);
        break;

      case ExportFormat.PDF:
        // In a real implementation, would use a PDF library
        data = this.logsToPDF(searchResult.items);
        break;
    }

    const createdAt = this.now();
    const exportResult: AuditExportResult = {
      exportId,
      format: request.format,
      itemCount: searchResult.items.length,
      createdAt,
      expiresAt:
        createdAt + this.config.exportRetentionDays * 24 * 60 * 60 * 1000,
      data: this.config.enableCompression ? await this.compress(data) : data,
    };

    this.exports.set(exportId, exportResult);
    return exportResult;
  }

  /** Build a bounded, redacted, integrity-verifiable incident evidence bundle. */
  async exportIncidentEvidence(
    request: IncidentEvidenceRequest,
  ): Promise<IncidentEvidenceExportResult> {
    validateIncidentEvidenceRequest(request);
    if (!this.onIncidentEvidenceExport) {
      throw new Error('Incident evidence export requires an audit callback');
    }
    const result = await this.search({
      startTime: request.startTime,
      endTime: request.endTime,
      transferIds: request.transferIds,
      limit: this.config.maxSearchResults,
    });
    if (result.total > result.items.length) {
      throw new RangeError(
        'Incident evidence exceeds the configured maximum; narrow the time range or transfer IDs',
      );
    }

    const records = result.items
      .map(toIncidentEvidenceRecord)
      .sort(
        (left, right) =>
          left.timestamp - right.timestamp ||
          left.auditId.localeCompare(right.auditId),
      );
    const createdAt = this.now();
    const expiresAt =
      createdAt + this.config.exportRetentionDays * 24 * 60 * 60 * 1000;
    const payload = {
      schemaVersion: 1 as const,
      type: 'bridgewise-incident-evidence' as const,
      incidentId: request.incidentId.trim(),
      generatedAt: createdAt,
      timeWindow: { startTime: request.startTime, endTime: request.endTime },
      recordCount: records.length,
      redaction: 'addresses-and-amounts-omitted' as const,
      records,
    };
    const integrityHash = createHash('sha256')
      .update(stableSerialize(payload))
      .digest('hex');
    const bundle: IncidentEvidenceBundle = { ...payload, integrityHash };
    const exportId = randomUUID();
    const serialized = JSON.stringify(bundle, null, 2);
    const exportResult: IncidentEvidenceExportResult = {
      exportId,
      incidentId: request.incidentId.trim(),
      integrityHash,
      format: ExportFormat.JSON,
      itemCount: records.length,
      createdAt,
      expiresAt,
      data: this.config.enableCompression
        ? await this.compress(serialized)
        : serialized,
    };

    this.onIncidentEvidenceExport?.({
      exportId,
      incidentId: request.incidentId.trim(),
      requestedBy: request.requestedBy.trim(),
      createdAt,
      expiresAt,
      itemCount: records.length,
      integrityHash,
    });
    this.exports.set(exportId, exportResult);
    return exportResult;
  }

  /**
   * Get export statistics for given time period
   */
  async getStatistics(
    startTime?: number,
    endTime?: number,
  ): Promise<AuditStatistics> {
    const result = await this.search({
      startTime,
      endTime,
      limit: this.config.maxSearchResults,
    });

    const completedLogs = result.items.filter(
      (log) => log.status === AuditStatus.COMPLETED,
    );
    const failedLogs = result.items.filter(
      (log) => log.status === AuditStatus.FAILED,
    );

    const uniqueAddresses = new Set([
      ...result.items.map((log) => log.fromAddress),
      ...result.items.map((log) => log.toAddress),
    ]);

    const totalVolume = result.items.reduce((sum, log) => {
      const amount = parseFloat(log.amount) || 0;
      return sum + amount;
    }, 0);

    return {
      totalTransfers: result.total,
      successfulTransfers: completedLogs.length,
      failedTransfers: failedLogs.length,
      averageAmountUSD:
        result.items.length > 0 ? totalVolume / result.items.length : 0,
      totalVolumeUSD: totalVolume,
      uniqueAddresses: uniqueAddresses.size,
      lastAuditTime: result.items.length > 0 ? result.items[0].timestamp : 0,
    };
  }

  /**
   * Get a specific audit log by ID
   */
  getAuditLog(auditId: string): TransferAuditLog | undefined {
    return this.auditLogs.get(auditId);
  }

  /**
   * Get all audit logs for an address (as sender or receiver)
   */
  async getAddressHistory(address: string): Promise<TransferAuditLog[]> {
    const result = await this.search({
      limit: this.config.maxSearchResults,
    });
    return result.items.filter(
      (log) => log.fromAddress === address || log.toAddress === address,
    );
  }

  /**
   * Cleanup expired exports
   */
  cleanupExpiredExports(): number {
    const now = this.now();
    let removed = 0;

    const entriesToDelete: string[] = [];
    for (const [exportId, exportResult] of this.exports.entries()) {
      if (exportResult.expiresAt <= now) {
        entriesToDelete.push(exportId);
      }
    }

    for (const exportId of entriesToDelete) {
      this.exports.delete(exportId);
      removed++;
    }

    return removed;
  }

  /** Remove audit records at or beyond the configured retention boundary. */
  cleanupExpiredAuditLogs(): number {
    const cutoff =
      this.now() - this.config.auditLogRetentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;

    for (const [auditId, log] of this.auditLogs.entries()) {
      if (log.timestamp > cutoff) continue;

      this.auditLogs.delete(auditId);
      this.removeFromIndex(this.indexByTransferId, log.transferId, auditId);
      this.removeFromIndex(this.indexByAddress, log.fromAddress, auditId);
      if (log.toAddress !== log.fromAddress) {
        this.removeFromIndex(this.indexByAddress, log.toAddress, auditId);
      }
      removed++;
    }

    return removed;
  }

  /** Run both retention policies; suitable for a scheduled maintenance job. */
  cleanupExpiredData(): { auditLogs: number; exports: number } {
    return {
      auditLogs: this.cleanupExpiredAuditLogs(),
      exports: this.cleanupExpiredExports(),
    };
  }

  /**
   * Get export by ID
   */
  getExport(exportId: string): AuditExportResult | undefined {
    return this.exports.get(exportId);
  }

  // Private methods

  private updateIndexes(log: TransferAuditLog): void {
    // Index by transfer ID
    const transferLogs = this.indexByTransferId.get(log.transferId) || [];
    transferLogs.push(log.auditId);
    this.indexByTransferId.set(log.transferId, transferLogs);

    // Index by address
    const addressLogs = this.indexByAddress.get(log.fromAddress) || [];
    if (!addressLogs.includes(log.auditId)) {
      addressLogs.push(log.auditId);
    }
    this.indexByAddress.set(log.fromAddress, addressLogs);

    if (log.toAddress !== log.fromAddress) {
      const toAddressLogs = this.indexByAddress.get(log.toAddress) || [];
      if (!toAddressLogs.includes(log.auditId)) {
        toAddressLogs.push(log.auditId);
      }
      this.indexByAddress.set(log.toAddress, toAddressLogs);
    }
  }

  private removeFromIndex(
    index: Map<string, string[]>,
    key: string,
    auditId: string,
  ): void {
    const ids = index.get(key);
    if (!ids) return;
    const remaining = ids.filter((id) => id !== auditId);
    if (remaining.length === 0) index.delete(key);
    else index.set(key, remaining);
  }

  private logsToCSV(logs: TransferAuditLog[]): string {
    const headers = [
      'auditId',
      'transferId',
      'timestamp',
      'action',
      'actor',
      'sourceChain',
      'destinationChain',
      'fromAddress',
      'toAddress',
      'amount',
      'assetCode',
      'status',
      'txHash',
    ];

    const rows = logs.map((log) => [
      log.auditId,
      log.transferId,
      new Date(log.timestamp).toISOString(),
      log.action,
      log.actor,
      log.sourceChain,
      log.destinationChain,
      log.fromAddress,
      log.toAddress,
      log.amount,
      log.assetCode,
      log.status,
      log.txHash || '',
    ]);

    const csv = [
      headers.join(','),
      ...rows.map((row) => row.map((cell) => `"${cell}"`).join(',')),
    ].join('\n');

    return csv;
  }

  private logsToPDF(logs: TransferAuditLog[]): string {
    // In a real implementation, this would generate actual PDF
    // For now, return a simple text representation
    const lines = [
      'STELLAR TRANSFER AUDIT REPORT',
      `Generated: ${new Date().toISOString()}`,
      `Total Records: ${logs.length}`,
      '---',
      ...logs.map(
        (log) =>
          `${log.transferId} - ${log.action} - ${new Date(log.timestamp).toISOString()}`,
      ),
    ];

    return lines.join('\n');
  }

  private async compress(data: string | Uint8Array): Promise<Uint8Array> {
    // In a real implementation, would use gzip or similar
    // For now, return as-is
    if (typeof data === 'string') {
      return new TextEncoder().encode(data);
    }
    return data;
  }
}

function validateRetentionDays(name: string, days: number): void {
  if (!Number.isInteger(days) || days < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

export function verifyIncidentEvidenceBundle(
  value: unknown,
): value is IncidentEvidenceBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const bundle = value as Partial<IncidentEvidenceBundle>;
  if (
    bundle.schemaVersion !== 1 ||
    bundle.type !== 'bridgewise-incident-evidence' ||
    typeof bundle.integrityHash !== 'string'
  ) {
    return false;
  }
  const { integrityHash, ...payload } = bundle;
  const expected = createHash('sha256')
    .update(stableSerialize(payload))
    .digest('hex');
  return integrityHash === expected;
}

function validateIncidentEvidenceRequest(
  request: IncidentEvidenceRequest,
): void {
  if (
    typeof request.incidentId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(request.incidentId.trim())
  ) {
    throw new TypeError('incidentId must be a short, opaque identifier');
  }
  if (
    typeof request.requestedBy !== 'string' ||
    !request.requestedBy.trim() ||
    request.requestedBy.length > 160 ||
    /[\r\n\0]/.test(request.requestedBy)
  ) {
    throw new TypeError('requestedBy must be a non-empty audit identity');
  }
  if (
    !Number.isSafeInteger(request.startTime) ||
    request.startTime < 0 ||
    !Number.isSafeInteger(request.endTime) ||
    request.endTime < request.startTime
  ) {
    throw new RangeError(
      'Incident evidence time window must be valid and ordered',
    );
  }
  if (
    request.transferIds !== undefined &&
    (!Array.isArray(request.transferIds) ||
      request.transferIds.length === 0 ||
      request.transferIds.some((id) => typeof id !== 'string' || !id.trim()))
  ) {
    throw new TypeError('transferIds must contain non-empty strings');
  }
}

function toIncidentEvidenceRecord(
  log: TransferAuditLog,
): IncidentEvidenceRecord {
  return {
    auditId: log.auditId,
    transferId: log.transferId,
    timestamp: log.timestamp,
    action: log.action,
    status: log.status,
    sourceChain: log.sourceChain,
    destinationChain: log.destinationChain,
    assetCode: log.assetCode,
    fromAddressFingerprint: fingerprintSensitiveField(log.fromAddress),
    toAddressFingerprint: fingerprintSensitiveField(log.toAddress),
    transactionHint: transactionHint(log.txHash),
  };
}

function fingerprintSensitiveField(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  return createHash('sha256').update(value).digest('hex');
}

function transactionHint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^0x[a-f0-9]{64}$/i.test(value)) {
    return `${value.slice(0, 10)}...${value.slice(-8)}`;
  }
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
