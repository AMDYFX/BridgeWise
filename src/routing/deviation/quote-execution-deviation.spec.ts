/**
 * File: src/routing/deviation/quote-execution-deviation.spec.ts
 *
 * Tests for QuoteExecutionDeviationService (#1286).
 */

import {
  DEFAULT_DEVIATION_THRESHOLDS,
  QuoteExecutionDeviationService,
} from './quote-execution-deviation.service';
import { ExecutionRecord, QuoteRecord } from './quote-execution-deviation.types';

describe('QuoteExecutionDeviationService', () => {
  let service: QuoteExecutionDeviationService;

  beforeEach(() => {
    service = new QuoteExecutionDeviationService();
  });

  const baseQuote: QuoteRecord = {
    quoteId: 'quote-100',
    routeId: 'route-stellar-polygon',
    fromChain: 'stellar',
    toChain: 'polygon',
    fromToken: 'USDC',
    toToken: 'USDC',
    inputAmount: '1000.0',
    expectedOutputAmount: '998.0', // expected price = 0.998
    maxAllowedSlippageBps: 50, // 0.5%
    quotedAt: Date.now() - 5000,
    expiresAt: Date.now() + 60000,
  };

  describe('Quote Registration & Validation', () => {
    it('registers valid quote successfully', () => {
      service.registerQuote(baseQuote);
      const retrieved = service.getQuote('quote-100');
      expect(retrieved).toBeDefined();
      expect(retrieved?.expectedEffectivePrice).toBeCloseTo(0.998, 4);
    });

    it('throws when quoteId is empty', () => {
      expect(() =>
        service.registerQuote({ ...baseQuote, quoteId: '' }),
      ).toThrow('Quote ID must be a non-empty string.');
    });

    it('throws when chains are missing', () => {
      expect(() =>
        service.registerQuote({ ...baseQuote, fromChain: '' }),
      ).toThrow('fromChain and toChain must be specified.');
    });

    it('throws when tokens are missing', () => {
      expect(() =>
        service.registerQuote({ ...baseQuote, toToken: '' }),
      ).toThrow('fromToken and toToken must be specified.');
    });

    it('throws for invalid inputAmount or expectedOutputAmount', () => {
      expect(() =>
        service.registerQuote({ ...baseQuote, inputAmount: '-10' }),
      ).toThrow('Invalid quote inputAmount: -10');

      expect(() =>
        service.registerQuote({ ...baseQuote, expectedOutputAmount: '0' }),
      ).toThrow('Invalid quote expectedOutputAmount: 0');
    });
  });

  describe('Execution Deviation Calculation & Severity', () => {
    beforeEach(() => {
      service.registerQuote(baseQuote);
    });

    it('evaluates exact execution as neutral', () => {
      const exec: ExecutionRecord = {
        executionId: 'exec-1',
        quoteId: 'quote-100',
        txHash: '0xabc1',
        executedOutputAmount: '998.0',
        executedAt: Date.now(),
      };

      const report = service.recordExecution(exec);
      expect(report.severity).toBe('neutral');
      expect(report.priceDeviationBps).toBe(0);
      expect(report.isAcceptable).toBe(true);
      expect(report.actionRequired).toBe('none');
    });

    it('evaluates favorable execution (price improvement)', () => {
      const exec: ExecutionRecord = {
        executionId: 'exec-2',
        quoteId: 'quote-100',
        txHash: '0xabc2',
        executedOutputAmount: '1002.0', // received more than expected
        executedAt: Date.now(),
      };

      const report = service.recordExecution(exec);
      expect(report.severity).toBe('favorable');
      expect(report.priceDeviationBps).toBeLessThan(0);
      expect(report.isAcceptable).toBe(true);
      expect(report.actionRequired).toBe('none');
    });

    it('evaluates acceptable slippage within maxAllowedSlippageBps', () => {
      // 995 output instead of 998: delta = 3 -> 3/998 = ~30 bps (<= 50 bps)
      const exec: ExecutionRecord = {
        executionId: 'exec-3',
        quoteId: 'quote-100',
        txHash: '0xabc3',
        executedOutputAmount: '995.0',
        executedAt: Date.now(),
      };

      const report = service.recordExecution(exec);
      expect(report.severity).toBe('acceptable_slippage');
      expect(report.priceDeviationBps).toBe(30);
      expect(report.isAcceptable).toBe(true);
      expect(report.actionRequired).toBe('none');
    });

    it('evaluates warning slippage when above acceptable cap but below critical', () => {
      // 985 output instead of 998: delta = 13 -> 13/998 = ~130 bps (> 50 bps, <= 150 bps)
      const exec: ExecutionRecord = {
        executionId: 'exec-4',
        quoteId: 'quote-100',
        txHash: '0xabc4',
        executedOutputAmount: '985.0',
        executedAt: Date.now(),
      };

      const report = service.recordExecution(exec);
      expect(report.severity).toBe('warning_slippage');
      expect(report.priceDeviationBps).toBe(130);
      expect(report.isAcceptable).toBe(false);
      expect(report.actionRequired).toBe('log_warning');
    });

    it('evaluates critical breach when slippage exceeds critical threshold', () => {
      // 960 output instead of 998: delta = 38 -> 38/998 = ~381 bps (> 300 bps)
      const exec: ExecutionRecord = {
        executionId: 'exec-5',
        quoteId: 'quote-100',
        txHash: '0xabc5',
        executedOutputAmount: '960.0',
        executedAt: Date.now(),
      };

      const report = service.recordExecution(exec);
      expect(report.severity).toBe('critical_breach');
      expect(report.priceDeviationBps).toBe(381);
      expect(report.isAcceptable).toBe(false);
      expect(report.actionRequired).toBe('operator_escalation');
    });

    it('throws error when recording execution for non-existent quote', () => {
      const exec: ExecutionRecord = {
        executionId: 'exec-missing',
        quoteId: 'quote-nonexistent',
        txHash: '0xabc',
        executedOutputAmount: '900.0',
        executedAt: Date.now(),
      };

      expect(() => service.recordExecution(exec)).toThrow(
        'Quote quote-nonexistent not found.',
      );
    });
  });

  describe('Idempotency & Concurrency Safety', () => {
    beforeEach(() => {
      service.registerQuote(baseQuote);
    });

    it('returns identical report on duplicate execution submissions without duplicate state', () => {
      const exec: ExecutionRecord = {
        executionId: 'exec-idempotent-1',
        quoteId: 'quote-100',
        txHash: '0xidemp1',
        executedOutputAmount: '997.0',
        executedAt: Date.now(),
      };

      const firstReport = service.recordExecution(exec);
      const secondReport = service.recordExecution(exec);

      expect(firstReport).toBe(secondReport);
      expect(service.queryReports().length).toBe(1);
    });
  });

  describe('Transaction Replacement & Reorg Handling', () => {
    beforeEach(() => {
      service.registerQuote(baseQuote);
    });

    it('handles replacement transaction correctly', () => {
      const original: ExecutionRecord = {
        executionId: 'exec-orig',
        quoteId: 'quote-100',
        txHash: '0xorig',
        executedOutputAmount: '990.0',
        executedAt: Date.now(),
      };

      service.recordExecution(original);

      const replacement: ExecutionRecord = {
        executionId: 'exec-orig',
        quoteId: 'quote-100',
        txHash: '0xspeedup',
        executedOutputAmount: '996.0',
        executedAt: Date.now() + 1000,
      };

      const updatedReport = service.handleReplacement('0xorig', replacement);
      expect(updatedReport.txHash).toBe('0xspeedup');
      expect(updatedReport.replacementTxHash).toBe('0xspeedup');
      expect(updatedReport.executedOutputAmount).toBe('996.0');
      expect(updatedReport.severity).toBe('acceptable_slippage');
      expect(service.queryReports().length).toBe(1);
    });

    it('handles reorg event with adjusted output', () => {
      const original: ExecutionRecord = {
        executionId: 'exec-reorg',
        quoteId: 'quote-100',
        txHash: '0xreorg1',
        executedOutputAmount: '997.0',
        executedAt: Date.now(),
        blockNumber: 15000000,
      };

      service.recordExecution(original);

      // Reorg at depth 3 resulted in different output: 965.0
      const reorgReport = service.handleReorg('exec-reorg', {
        newBlockNumber: 15000004,
        newOutputAmount: '965.0',
        reorgDepth: 3,
      });

      expect(reorgReport.reorgDepth).toBe(3);
      expect(reorgReport.executedOutputAmount).toBe('965.0');
      expect(reorgReport.severity).toBe('critical_breach');
      expect(reorgReport.actionRequired).toBe('operator_escalation');
    });

    it('throws error when handling reorg for untracked execution', () => {
      expect(() =>
        service.handleReorg('unknown-exec', {
          newBlockNumber: 100,
          newOutputAmount: '100',
          reorgDepth: 1,
        }),
      ).toThrow('Execution unknown-exec not found for reorg update.');
    });
  });

  describe('Query Filters & Metrics Summary', () => {
    beforeEach(() => {
      service.registerQuote(baseQuote);
      service.registerQuote({
        ...baseQuote,
        quoteId: 'quote-eth',
        routeId: 'route-eth-solana',
        fromChain: 'ethereum',
        toChain: 'solana',
        fromToken: 'WETH',
        toToken: 'SOL',
        inputAmount: '10.0',
        expectedOutputAmount: '200.0',
      });

      service.recordExecution({
        executionId: 'e1',
        quoteId: 'quote-100',
        txHash: '0x1',
        executedOutputAmount: '998.0',
        executedAt: 1000,
      }); // neutral (0 bps)

      service.recordExecution({
        executionId: 'e2',
        quoteId: 'quote-100',
        txHash: '0x2',
        executedOutputAmount: '1005.0',
        executedAt: 2000,
      }); // favorable (-70 bps)

      service.recordExecution({
        executionId: 'e3',
        quoteId: 'quote-eth',
        txHash: '0x3',
        executedOutputAmount: '190.0',
        executedAt: 3000,
      }); // warning / critical (500 bps)
    });

    it('filters reports by chain and route', () => {
      const stellarReports = service.queryReports({ fromChain: 'stellar' });
      expect(stellarReports.length).toBe(2);

      const ethReports = service.queryReports({ fromChain: 'ethereum' });
      expect(ethReports.length).toBe(1);

      const routeReports = service.queryReports({ routeId: 'route-stellar-polygon' });
      expect(routeReports.length).toBe(2);
    });

    it('filters reports by severity and minDeviationBps', () => {
      const favorable = service.queryReports({ severity: 'favorable' });
      expect(favorable.length).toBe(1);

      const highDev = service.queryReports({ minDeviationBps: 100 });
      expect(highDev.length).toBe(1);
      expect(highDev[0].executionId).toBe('e3');
    });

    it('calculates comprehensive metrics summary', () => {
      const metrics = service.getMetricsSummary();
      expect(metrics.totalTracked).toBe(3);
      expect(metrics.favorableCount).toBe(1);
      expect(metrics.acceptableCount).toBe(1); // neutral counted under acceptable
      expect(metrics.criticalCount).toBe(1);
      expect(metrics.maxDeviationBps).toBe(500);
    });

    it('allows customizing thresholds', () => {
      service.setThresholds({ acceptableBps: 20, criticalBps: 100 });
      const current = service.getThresholds();
      expect(current.acceptableBps).toBe(20);
      expect(current.criticalBps).toBe(100);
      expect(current.warningBps).toBe(DEFAULT_DEVIATION_THRESHOLDS.warningBps);
    });
  });
});
