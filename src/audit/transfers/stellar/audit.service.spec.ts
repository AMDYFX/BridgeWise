import { StellarTransferAuditAPI } from './audit.service';
import { AuditAction, AuditStatus, ExportFormat } from './audit.types';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('StellarTransferAuditAPI retention', () => {
  let currentTime: number;
  let auditAPI: StellarTransferAuditAPI;

  const logPayload = (transferId: string) => ({
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
  });

  beforeEach(() => {
    currentTime = 1_000;
    auditAPI = new StellarTransferAuditAPI(
      { auditLogRetentionDays: 1, exportRetentionDays: 1 },
      { now: () => currentTime },
    );
  });

  it('removes expired audit logs and their search indexes at the boundary', async () => {
    auditAPI.logTransferAction(logPayload('expired-transfer'));
    currentTime += DAY_MS;
    auditAPI.logTransferAction(logPayload('retained-transfer'));

    expect(auditAPI.cleanupExpiredAuditLogs()).toBe(1);
    expect(await auditAPI.getTransferHistory('expired-transfer')).toEqual([]);
    expect(await auditAPI.getAddressHistory('GFROM')).toHaveLength(1);
    expect(
      (await auditAPI.search({})).items.map((item) => item.transferId),
    ).toEqual(['retained-transfer']);
  });

  it('removes exports at their exact expiry time', async () => {
    auditAPI.logTransferAction(logPayload('transfer-1'));
    const result = await auditAPI.export({
      query: {},
      format: ExportFormat.JSON,
    });

    currentTime = result.expiresAt;

    expect(auditAPI.cleanupExpiredExports()).toBe(1);
    expect(auditAPI.getExport(result.exportId)).toBeUndefined();
  });

  it('runs both retention policies and returns removal counts', async () => {
    auditAPI.logTransferAction(logPayload('transfer-1'));
    await auditAPI.export({ query: {}, format: ExportFormat.JSON });
    currentTime += DAY_MS;

    expect(auditAPI.cleanupExpiredData()).toEqual({ auditLogs: 1, exports: 1 });
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
