import { ExecutionPauseService } from './pause/execution-pause.service';
import { StuckExecutionFilterService } from './monitoring/stuck-execution-filter.service';
import { ExecutionCompensationService } from './compensation/execution-compensation.service';
import { TransactionReplacementAuditService } from './replacement/transaction-replacement-audit.service';
import { ExecutionRecord } from './types/execution-operations.types';

describe('Execution Operations Services (#1232, #1233, #1235, #1236)', () => {
  describe('ExecutionPauseService (#1232)', () => {
    let service: ExecutionPauseService;

    beforeEach(() => {
      service = new ExecutionPauseService();
    });

    it('should pause and check route status', () => {
      expect(service.isRoutePaused('route-stellar-evm')).toBe(false);

      service.pauseRoute(
        'route-stellar-evm',
        'stellar',
        'ethereum',
        'operator-1',
        'High congestion',
      );
      expect(service.isRoutePaused('route-stellar-evm')).toBe(true);

      const paused = service.getPausedRoutes();
      expect(paused.length).toBe(1);
      expect(paused[0].routeId).toBe('route-stellar-evm');

      service.resumeRoute('route-stellar-evm');
      expect(service.isRoutePaused('route-stellar-evm')).toBe(false);
    });

    it('should filter paused routes by source and destination chains', () => {
      service.pauseRoute('r1', 'stellar', 'polygon', 'op');
      service.pauseRoute('r2', 'ethereum', 'polygon', 'op');

      const stellarRoutes = service.getPausedRoutes({ sourceChain: 'stellar' });
      expect(stellarRoutes.length).toBe(1);
      expect(stellarRoutes[0].routeId).toBe('r1');
    });
  });

  describe('StuckExecutionFilterService (#1233)', () => {
    let service: StuckExecutionFilterService;

    beforeEach(() => {
      service = new StuckExecutionFilterService();
    });

    it('should identify stuck executions based on heartbeat threshold', () => {
      const now = Date.now();
      const stuckRecord: ExecutionRecord = {
        executionId: 'exec-1',
        routeId: 'route-1',
        sourceChain: 'stellar',
        destinationChain: 'ethereum',
        sourceAddress: 'G...',
        destinationAddress: '0x...',
        amount: '1000',
        token: 'USDC',
        state: 'bridging',
        createdAt: now - 600000,
        updatedAt: now - 600000,
        lastHeartbeatAt: now - 600000, // 10 min ago
        retryCount: 2,
        stuckReason: 'stalled_relay',
      };

      const freshRecord: ExecutionRecord = {
        ...stuckRecord,
        executionId: 'exec-2',
        lastHeartbeatAt: now - 60000, // 1 min ago
      };

      service.trackExecution(stuckRecord);
      service.trackExecution(freshRecord);

      const stuck = service.findStuckExecutions({ thresholdMs: 300000 });
      expect(stuck.length).toBe(1);
      expect(stuck[0].executionId).toBe('exec-1');
    });

    it('should filter by stuck reason and retry count', () => {
      const now = Date.now();
      const record: ExecutionRecord = {
        executionId: 'exec-retry',
        routeId: 'route-1',
        sourceChain: 'stellar',
        destinationChain: 'ethereum',
        sourceAddress: 'G...',
        destinationAddress: '0x...',
        amount: '1000',
        token: 'USDC',
        state: 'bridging',
        createdAt: now - 600000,
        updatedAt: now - 600000,
        lastHeartbeatAt: now - 600000,
        retryCount: 5,
        stuckReason: 'gas_price_spike',
      };
      service.trackExecution(record);

      const res = service.findStuckExecutions({
        thresholdMs: 300000,
        stuckReason: 'gas_price_spike',
        minRetryCount: 3,
      });
      expect(res.length).toBe(1);

      const noMatch = service.findStuckExecutions({
        thresholdMs: 300000,
        stuckReason: 'timeout',
      });
      expect(noMatch.length).toBe(0);
    });
  });

  describe('ExecutionCompensationService (#1235)', () => {
    let service: ExecutionCompensationService;

    beforeEach(() => {
      service = new ExecutionCompensationService();
    });

    it('should handle lifecycle of compensation records', () => {
      const record = service.createRecord(
        'exec-1',
        '0xRecipient',
        '50',
        'USDC',
        'refund',
        'Stuck execution timeout refund',
      );
      expect(record.status).toBe('pending');

      const approved = service.approveRecord(record.compensationId, 'admin-1');
      expect(approved?.status).toBe('approved');
      expect(approved?.approvedBy).toBe('admin-1');

      const executed = service.executeCompensation(record.compensationId, '0xTxHash');
      expect(executed?.status).toBe('executed');
      expect(executed?.executedTxHash).toBe('0xTxHash');

      const records = service.getByExecutionId('exec-1');
      expect(records.length).toBe(1);
    });
  });

  describe('TransactionReplacementAuditService (#1236)', () => {
    let service: TransactionReplacementAuditService;

    beforeEach(() => {
      service = new TransactionReplacementAuditService();
    });

    it('should record and audit transaction replacements', () => {
      const record = service.recordReplacement(
        'exec-1',
        '0xOldHash',
        '0xNewHash',
        42,
        'speedup',
        '20',
        '35',
        'operator-bob',
      );
      expect(record.originalTxHash).toBe('0xOldHash');
      expect(record.newTxHash).toBe('0xNewHash');
      expect(record.confirmed).toBe(false);

      const confirmed = service.markConfirmed('exec-1', record.replacementId);
      expect(confirmed).toBe(true);

      const all = service.getReplacements('exec-1');
      expect(all.length).toBe(1);
      expect(all[0].confirmed).toBe(true);
    });
  });
});
