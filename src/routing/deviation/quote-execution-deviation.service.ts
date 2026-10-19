/**
 * File: src/routing/deviation/quote-execution-deviation.service.ts
 *
 * Implements quote-to-execution price deviation tracking (#1286).
 * Preserves asset and chain boundaries, guarantees idempotency against
 * duplicate executions, handles replacements and reorgs, and provides
 * operator diagnostics and metrics.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  DeviationActionRequired,
  DeviationMetricsSummary,
  DeviationQueryFilter,
  DeviationSeverity,
  DeviationThresholds,
  ExecutionRecord,
  PriceDeviationReport,
  QuoteRecord,
} from './quote-execution-deviation.types';

export const DEFAULT_DEVIATION_THRESHOLDS: DeviationThresholds = {
  acceptableBps: 50, // 0.50%
  warningBps: 150, // 1.50%
  criticalBps: 300, // 3.00%
  maxHardToleranceBps: 500, // 5.00%
};

@Injectable()
export class QuoteExecutionDeviationService {
  private readonly logger = new Logger(QuoteExecutionDeviationService.name);

  private readonly quotes = new Map<string, QuoteRecord>();
  private readonly reports = new Map<string, PriceDeviationReport>();
  private readonly txToExecutionMap = new Map<string, string>();
  private thresholds: DeviationThresholds = { ...DEFAULT_DEVIATION_THRESHOLDS };

  /**
   * Configure deviation thresholds.
   */
  public setThresholds(thresholds: Partial<DeviationThresholds>): void {
    this.thresholds = {
      ...this.thresholds,
      ...thresholds,
    };
    this.logger.log(
      `Updated deviation thresholds: acceptable=${this.thresholds.acceptableBps}bps, warning=${this.thresholds.warningBps}bps, critical=${this.thresholds.criticalBps}bps, maxHard=${this.thresholds.maxHardToleranceBps}bps`,
    );
  }

  public getThresholds(): DeviationThresholds {
    return { ...this.thresholds };
  }

  /**
   * Register a generated quote for later execution reconciliation.
   */
  public registerQuote(quote: QuoteRecord): void {
    if (!quote.quoteId || typeof quote.quoteId !== 'string') {
      throw new Error('Quote ID must be a non-empty string.');
    }
    if (!quote.fromChain || !quote.toChain) {
      throw new Error('fromChain and toChain must be specified.');
    }
    if (!quote.fromToken || !quote.toToken) {
      throw new Error('fromToken and toToken must be specified.');
    }

    const inputNum = parseFloat(quote.inputAmount);
    const outputNum = parseFloat(quote.expectedOutputAmount);

    if (isNaN(inputNum) || inputNum <= 0) {
      throw new Error(`Invalid quote inputAmount: ${quote.inputAmount}`);
    }
    if (isNaN(outputNum) || outputNum <= 0) {
      throw new Error(`Invalid quote expectedOutputAmount: ${quote.expectedOutputAmount}`);
    }

    const expectedPrice = quote.expectedEffectivePrice ?? outputNum / inputNum;

    this.quotes.set(quote.quoteId, {
      ...quote,
      expectedEffectivePrice: expectedPrice,
    });

    this.logger.debug(
      `Registered quote ${quote.quoteId} for route ${quote.routeId} (${quote.fromChain}:${quote.fromToken} -> ${quote.toChain}:${quote.toToken})`,
    );
  }

  /**
   * Retrieve a stored quote.
   */
  public getQuote(quoteId: string): QuoteRecord | undefined {
    return this.quotes.get(quoteId);
  }

  /**
   * Record an execution and compute price deviation against the registered quote.
   * Guarantees idempotency: multiple calls with the same executionId return the existing report.
   */
  public recordExecution(execution: ExecutionRecord): PriceDeviationReport {
    if (!execution.executionId || typeof execution.executionId !== 'string') {
      throw new Error('Execution ID must be a non-empty string.');
    }
    if (!execution.quoteId || typeof execution.quoteId !== 'string') {
      throw new Error('Quote ID must be a non-empty string.');
    }

    // Idempotent return if already evaluated
    const existing = this.reports.get(execution.executionId);
    if (existing) {
      this.logger.debug(
        `Returning existing deviation report for executionId: ${execution.executionId} (idempotent)`,
      );
      return existing;
    }

    const quote = this.quotes.get(execution.quoteId);
    if (!quote) {
      throw new Error(
        `Cannot record execution: Quote ${execution.quoteId} not found. Ensure registerQuote() is called first.`,
      );
    }

    const inputNum = parseFloat(quote.inputAmount);
    const expectedOutputNum = parseFloat(quote.expectedOutputAmount);
    const executedOutputNum = parseFloat(execution.executedOutputAmount);

    if (isNaN(executedOutputNum) || executedOutputNum < 0) {
      throw new Error(
        `Invalid executedOutputAmount: ${execution.executedOutputAmount}`,
      );
    }

    const expectedPrice = quote.expectedEffectivePrice ?? expectedOutputNum / inputNum;
    const executedPrice = executedOutputNum / inputNum;

    // Price deviation: positive = adverse slippage (received less than expected), negative = favorable
    const priceDelta = expectedPrice - executedPrice;
    const percentageDeviation = (priceDelta / expectedPrice) * 100;
    const priceDeviationBps = Math.round((priceDelta / expectedPrice) * 10000);

    const severity = this.evaluateSeverity(priceDeviationBps, quote.maxAllowedSlippageBps);
    const actionRequired = this.determineAction(severity);
    const isAcceptable =
      severity === 'favorable' ||
      severity === 'neutral' ||
      severity === 'acceptable_slippage';

    const report: PriceDeviationReport = {
      quoteId: quote.quoteId,
      executionId: execution.executionId,
      routeId: quote.routeId,
      fromChain: quote.fromChain,
      toChain: quote.toChain,
      fromToken: quote.fromToken,
      toToken: quote.toToken,
      inputAmount: quote.inputAmount,
      expectedOutputAmount: quote.expectedOutputAmount,
      executedOutputAmount: execution.executedOutputAmount,
      expectedPrice,
      executedPrice,
      priceDeviationBps,
      percentageDeviation,
      severity,
      isAcceptable,
      actionRequired,
      txHash: execution.txHash,
      replacementTxHash: execution.replacementTxHash,
      reorgDepth: execution.reorgDepth,
      timestamp: execution.executedAt || Date.now(),
    };

    this.reports.set(execution.executionId, report);
    if (execution.txHash) {
      this.txToExecutionMap.set(execution.txHash, execution.executionId);
    }

    if (severity === 'critical_breach') {
      this.logger.error(
        `CRITICAL price deviation breach for execution ${execution.executionId}: deviation=${priceDeviationBps}bps, action=${actionRequired}`,
      );
    } else if (severity === 'warning_slippage') {
      this.logger.warn(
        `High price deviation for execution ${execution.executionId}: deviation=${priceDeviationBps}bps`,
      );
    } else {
      this.logger.log(
        `Recorded execution ${execution.executionId}: deviation=${priceDeviationBps}bps (${severity})`,
      );
    }

    return report;
  }

  /**
   * Handle transaction replacement (e.g. speed-up or cancel/replace on-chain).
   */
  public handleReplacement(
    originalTxHash: string,
    replacement: ExecutionRecord,
  ): PriceDeviationReport {
    const originalExecutionId = this.txToExecutionMap.get(originalTxHash);
    const quote = this.quotes.get(replacement.quoteId);

    if (!quote) {
      throw new Error(`Quote not found for replacement: ${replacement.quoteId}`);
    }

    const updatedRecord: ExecutionRecord = {
      ...replacement,
      executionId: replacement.executionId || originalExecutionId || `exec-repl-${Date.now()}`,
      replacementTxHash: replacement.txHash,
      status: 'replaced',
    };

    // Remove old report if replacing an existing one
    if (originalExecutionId && this.reports.has(originalExecutionId)) {
      this.reports.delete(originalExecutionId);
    }

    return this.recordExecution(updatedRecord);
  }

  /**
   * Handle block reorg affecting an executed transaction.
   */
  public handleReorg(
    executionId: string,
    reorgData: { newBlockNumber: number; newOutputAmount: string; reorgDepth: number },
  ): PriceDeviationReport {
    const existing = this.reports.get(executionId);
    if (!existing) {
      throw new Error(`Execution ${executionId} not found for reorg update.`);
    }

    const quote = this.quotes.get(existing.quoteId);
    if (!quote) {
      throw new Error(`Quote ${existing.quoteId} not found for reorg re-evaluation.`);
    }

    // Delete existing cached report to allow recalculation
    this.reports.delete(executionId);

    const updatedExecution: ExecutionRecord = {
      executionId: existing.executionId,
      quoteId: existing.quoteId,
      txHash: existing.txHash,
      replacementTxHash: existing.replacementTxHash,
      executedOutputAmount: reorgData.newOutputAmount,
      executedAt: Date.now(),
      blockNumber: reorgData.newBlockNumber,
      reorgDepth: reorgData.reorgDepth,
      status: 'reorg_detected',
    };

    this.logger.warn(
      `Re-evaluating execution ${executionId} following reorg depth ${reorgData.reorgDepth} at block ${reorgData.newBlockNumber}`,
    );

    return this.recordExecution(updatedExecution);
  }

  /**
   * Evaluate deviation severity based on bps and optional quote max slippage cap.
   */
  private evaluateSeverity(
    deviationBps: number,
    quoteMaxSlippageBps?: number,
  ): DeviationSeverity {
    if (deviationBps < -10) {
      return 'favorable';
    }
    if (deviationBps >= -10 && deviationBps <= 10) {
      return 'neutral';
    }

    const acceptableLimit = quoteMaxSlippageBps ?? this.thresholds.acceptableBps;

    if (deviationBps <= acceptableLimit) {
      return 'acceptable_slippage';
    }
    if (deviationBps <= this.thresholds.warningBps) {
      return 'warning_slippage';
    }
    return 'critical_breach';
  }

  /**
   * Determine required system action based on severity.
   */
  private determineAction(severity: DeviationSeverity): DeviationActionRequired {
    switch (severity) {
      case 'favorable':
      case 'neutral':
      case 'acceptable_slippage':
        return 'none';
      case 'warning_slippage':
        return 'log_warning';
      case 'critical_breach':
        return 'operator_escalation';
      default:
        return 'none';
    }
  }

  /**
   * Query evaluated deviation reports with filters.
   */
  public queryReports(filter: DeviationQueryFilter = {}): PriceDeviationReport[] {
    let result = Array.from(this.reports.values());

    if (filter.routeId) {
      result = result.filter((r) => r.routeId === filter.routeId);
    }
    if (filter.fromChain) {
      result = result.filter((r) => r.fromChain.toLowerCase() === filter.fromChain?.toLowerCase());
    }
    if (filter.toChain) {
      result = result.filter((r) => r.toChain.toLowerCase() === filter.toChain?.toLowerCase());
    }
    if (filter.fromToken) {
      result = result.filter((r) => r.fromToken.toUpperCase() === filter.fromToken?.toUpperCase());
    }
    if (filter.toToken) {
      result = result.filter((r) => r.toToken.toUpperCase() === filter.toToken?.toUpperCase());
    }
    if (filter.severity) {
      result = result.filter((r) => r.severity === filter.severity);
    }
    if (filter.minDeviationBps !== undefined) {
      result = result.filter((r) => r.priceDeviationBps >= filter.minDeviationBps!);
    }
    if (filter.sinceTimestamp !== undefined) {
      result = result.filter((r) => r.timestamp >= filter.sinceTimestamp!);
    }

    return result;
  }

  /**
   * Get metrics summary across all recorded deviations.
   */
  public getMetricsSummary(): DeviationMetricsSummary {
    const all = Array.from(this.reports.values());

    if (all.length === 0) {
      return {
        totalTracked: 0,
        favorableCount: 0,
        acceptableCount: 0,
        warningCount: 0,
        criticalCount: 0,
        averageDeviationBps: 0,
        maxDeviationBps: 0,
      };
    }

    let favorableCount = 0;
    let acceptableCount = 0;
    let warningCount = 0;
    let criticalCount = 0;
    let totalBps = 0;
    let maxBps = -Infinity;

    for (const r of all) {
      if (r.severity === 'favorable') favorableCount++;
      else if (r.severity === 'acceptable_slippage' || r.severity === 'neutral') acceptableCount++;
      else if (r.severity === 'warning_slippage') warningCount++;
      else if (r.severity === 'critical_breach') criticalCount++;

      totalBps += r.priceDeviationBps;
      if (r.priceDeviationBps > maxBps) {
        maxBps = r.priceDeviationBps;
      }
    }

    return {
      totalTracked: all.length,
      favorableCount,
      acceptableCount,
      warningCount,
      criticalCount,
      averageDeviationBps: Math.round(totalBps / all.length),
      maxDeviationBps: maxBps === -Infinity ? 0 : maxBps,
    };
  }

  /**
   * Reset in-memory state.
   */
  public clear(): void {
    this.quotes.clear();
    this.reports.clear();
    this.txToExecutionMap.clear();
  }
}
