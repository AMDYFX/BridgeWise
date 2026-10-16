import {
  StellarTransferAuditAPI,
  verifyIncidentEvidenceBundle,
} from './audit.service';
import {
  AuditAction,
  AuditStatus,
  ExportFormat,
  IncidentEvidenceRequest,
} from './audit.types';

const DAY_MS = 24 * 60 * 60 * 1000;

const request: IncidentEvidenceRequest = {
  incidentId: 'INC-2026-0042',
  requestedBy: 'operator-17',
  startTime: 100,
  endTime: 200,
};

function transfer(transferId: string) {
  return {
    transferId,
    action: AuditAction.TRANSFER_FAILED,
    actor: 'sensitive-operator-email@example.com',
    sourceChain: 'ethereum',
    destinationChain: 'stellar',
    fromAddress: 'GRAW-SOURCE-ADDRESS',
    toAddress: 'GRAW-DESTINATION-ADDRESS',
    amount: '987654.321',
    assetCode: 'USDC',
    status: AuditStatus.FAILED,
    txHash: `0x${'a'.repeat(64)}`,
    errorMessage: 'sensitive provider credential: do-not-export',
    details: { accessToken: 'do-not-export' },
    metadata: { customerPayload: 'do-not-export' },
  };
}

function retentionLog(transferId: string) {
  return {
    transferId,
    action: AuditAction.TRANSFER_INITIATED,
    actor: 'system',
    sourceChain: 'stellar',
    destinationChain: 'ethereum',
    fromAddress: 'GFROM',
    toAddress: 'GTO',
    amount: '10',
    assetCode: 'USDC',
    status: AuditStatus.PENDING,
  };
}

describe('StellarTransferAuditAPI', () => {
  describe('retention', () => {
    let currentTime: number;
    let auditAPI: StellarTransferAuditAPI;

    beforeEach(() => {
      currentTime = 1_000;
      auditAPI = new StellarTransferAuditAPI(
        { auditLogRetentionDays: 1, exportRetentionDays: 1 },
        { now: () => currentTime },
      );
    });

    it('removes expired audit logs and their search indexes at the boundary', async () => {
      auditAPI.logTransferAction(retentionLog('expired-transfer'));
      currentTime += DAY_MS;
      auditAPI.logTransferAction(retentionLog('retained-transfer'));

      expect(auditAPI.cleanupExpiredAuditLogs()).toBe(1);
      expect(await auditAPI.getTransferHistory('expired-transfer')).toEqual([]);
      expect(await auditAPI.getAddressHistory('GFROM')).toHaveLength(1);
      expect(
        (await auditAPI.search({})).items.map((item) => item.transferId),
      ).toEqual(['retained-transfer']);
    });

    it('removes exports at their exact expiry time', async () => {
      auditAPI.logTransferAction(retentionLog('transfer-1'));
      const result = await auditAPI.export({
        query: {},
        format: ExportFormat.JSON,
      });
      currentTime = result.expiresAt;

      expect(auditAPI.cleanupExpiredExports()).toBe(1);
      expect(auditAPI.getExport(result.exportId)).toBeUndefined();
    });

    it('runs both retention policies and returns removal counts', async () => {
      auditAPI.logTransferAction(retentionLog('transfer-1'));
      await auditAPI.export({ query: {}, format: ExportFormat.JSON });
      currentTime += DAY_MS;

      expect(auditAPI.cleanupExpiredData()).toEqual({
        auditLogs: 1,
        exports: 1,
      });
    });

    it('rejects non-positive or fractional retention periods', () => {
      expect(
        () => new StellarTransferAuditAPI({ auditLogRetentionDays: 0 }),
      ).toThrow(RangeError);
      expect(
        () => new StellarTransferAuditAPI({ exportRetentionDays: 1.5 }),
      ).toThrow(RangeError);
    });
  });

  describe('incident evidence export', () => {
    it('exports a redacted bounded bundle with a verifiable integrity hash', async () => {
      const events: unknown[] = [];
      let currentTime = 100;
      const audit = new StellarTransferAuditAPI(
        { exportRetentionDays: 2 },
        {
          now: () => currentTime,
          onIncidentEvidenceExport: (event) => events.push(event),
        },
      );
      const first = audit.logTransferAction(transfer('transfer-1'));
      currentTime = 200;
      const second = audit.logTransferAction(transfer('transfer-2'));
      currentTime = 201;
      audit.logTransferAction(transfer('outside-window'));

      const result = await audit.exportIncidentEvidence(request);
      const bundle = JSON.parse(result.data as string);

      expect(result.itemCount).toBe(2);
      expect(result.expiresAt).toBe(201 + 2 * 24 * 60 * 60 * 1000);
      expect(
        bundle.records.map((record: { auditId: string }) => record.auditId),
      ).toEqual([first.auditId, second.auditId]);
      expect(bundle.records[0].fromAddressFingerprint).toHaveLength(64);
      expect(bundle.records[0].transactionHint).toBe('0xaaaaaaaa...aaaaaaaa');
      expect(verifyIncidentEvidenceBundle(bundle)).toBe(true);
      expect(events).toEqual([
        expect.objectContaining({
          exportId: result.exportId,
          incidentId: request.incidentId,
          requestedBy: request.requestedBy,
          itemCount: 2,
          integrityHash: result.integrityHash,
        }),
      ]);

      const encoded = JSON.stringify(bundle);
      for (const sensitiveValue of [
        'GRAW-SOURCE-ADDRESS',
        'GRAW-DESTINATION-ADDRESS',
        '987654.321',
        'sensitive-operator-email@example.com',
        'do-not-export',
      ]) {
        expect(encoded).not.toContain(sensitiveValue);
      }
    });

    it('detects modifications to exported evidence', async () => {
      const audit = new StellarTransferAuditAPI(
        {},
        { now: () => 150, onIncidentEvidenceExport: () => undefined },
      );
      audit.logTransferAction(transfer('transfer-1'));
      const result = await audit.exportIncidentEvidence(request);
      const bundle = JSON.parse(result.data as string);

      bundle.records[0].status = AuditStatus.COMPLETED;
      expect(verifyIncidentEvidenceBundle(bundle)).toBe(false);
    });

    it('rejects invalid incident IDs, time windows, and missing attribution', async () => {
      const audit = new StellarTransferAuditAPI();

      await expect(
        audit.exportIncidentEvidence({ ...request, incidentId: 'INC\n42' }),
      ).rejects.toThrow(/incidentId/);
      await expect(
        audit.exportIncidentEvidence({
          ...request,
          startTime: 201,
          endTime: 200,
        }),
      ).rejects.toThrow(/time window/);
      await expect(
        audit.exportIncidentEvidence({ ...request, requestedBy: '  ' }),
      ).rejects.toThrow(/requestedBy/);
      await expect(
        audit.exportIncidentEvidence({ ...request, transferIds: [] }),
      ).rejects.toThrow(/transferIds/);
    });

    it('refuses to return a truncated evidence export', async () => {
      let currentTime = 100;
      const clockedAudit = new StellarTransferAuditAPI(
        { maxSearchResults: 1 },
        { now: () => currentTime, onIncidentEvidenceExport: () => undefined },
      );
      clockedAudit.logTransferAction(transfer('transfer-1'));
      currentTime = 200;
      clockedAudit.logTransferAction(transfer('transfer-2'));

      await expect(
        clockedAudit.exportIncidentEvidence(request),
      ).rejects.toThrow(/exceeds the configured maximum/);
    });

    it('does not retain evidence when the required export audit callback fails', async () => {
      let attemptedExportId = '';
      const audit = new StellarTransferAuditAPI(
        {},
        {
          now: () => 150,
          onIncidentEvidenceExport: (event) => {
            attemptedExportId = event.exportId;
            throw new Error('audit sink unavailable');
          },
        },
      );
      audit.logTransferAction(transfer('transfer-1'));

      await expect(audit.exportIncidentEvidence(request)).rejects.toThrow(
        /audit sink unavailable/,
      );
      expect(audit.getExport(attemptedExportId)).toBeUndefined();
    });

    it('refuses evidence exports when no audit attribution sink is configured', async () => {
      const audit = new StellarTransferAuditAPI({}, { now: () => 150 });
      audit.logTransferAction(transfer('transfer-1'));

      await expect(audit.exportIncidentEvidence(request)).rejects.toThrow(
        /requires an audit callback/,
      );
    });
  });
});
