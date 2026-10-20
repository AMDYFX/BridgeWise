/**
 * Daily Bridge Accounting Invariant Report
 * Validates accounting invariants across the bridge system
 */

export interface InvariantCheck {
  name: string;
  passed: boolean;
  value: number;
  expected: number;
  tolerance?: number;
  message: string;
}

export interface AccountingReport {
  date: string;
  timestamp: number;
  invariants: InvariantCheck[];
  overallStatus: 'passed' | 'failed' | 'warning';
  summary: {
    total: number;
    passed: number;
    failed: number;
    warnings: number;
  };
}

export interface BridgeState {
  sourceChain: string;
  targetChain: string;
  asset: string;
  lockedAmount: number;
  mintedAmount: number;
  burnedAmount: number;
  releasedAmount: number;
}

export class AccountingInvariantReportService {
  /**
   * Check if locked amount equals minted amount for a bridge
   */
  private checkLockMintInvariant(bridge: BridgeState): InvariantCheck {
    const tolerance = 0.0001; // Small tolerance for floating point
    const diff = Math.abs(bridge.lockedAmount - bridge.mintedAmount);
    const passed = diff <= tolerance;

    return {
      name: 'Lock-Mint Balance',
      passed,
      value: bridge.lockedAmount,
      expected: bridge.mintedAmount,
      tolerance,
      message: passed
        ? 'Locked amount matches minted amount'
        : `Lock-mint mismatch: locked=${bridge.lockedAmount}, minted=${bridge.mintedAmount}`,
    };
  }

  /**
   * Check if burned amount equals released amount for a bridge
   */
  private checkBurnReleaseInvariant(bridge: BridgeState): InvariantCheck {
    const tolerance = 0.0001;
    const diff = Math.abs(bridge.burnedAmount - bridge.releasedAmount);
    const passed = diff <= tolerance;

    return {
      name: 'Burn-Release Balance',
      passed,
      value: bridge.burnedAmount,
      expected: bridge.releasedAmount,
      tolerance,
      message: passed
        ? 'Burned amount matches released amount'
        : `Burn-release mismatch: burned=${bridge.burnedAmount}, released=${bridge.releasedAmount}`,
    };
  }

  /**
   * Check that amounts are non-negative
   */
  private checkNonNegativeInvariant(bridge: BridgeState): InvariantCheck {
    const amounts = [
      bridge.lockedAmount,
      bridge.mintedAmount,
      bridge.burnedAmount,
      bridge.releasedAmount,
    ];

    const allNonNegative = amounts.every((amount) => amount >= 0);
    const minValue = Math.min(...amounts);

    return {
      name: 'Non-Negative Amounts',
      passed: allNonNegative,
      value: minValue,
      expected: 0,
      message: allNonNegative
        ? 'All amounts are non-negative'
        : `Negative amount detected: ${minValue}`,
    };
  }

  /**
   * Generate daily accounting report for a set of bridges
   */
  generateReport(bridges: BridgeState[]): AccountingReport {
    const invariants: InvariantCheck[] = [];

    for (const bridge of bridges) {
      invariants.push(this.checkLockMintInvariant(bridge));
      invariants.push(this.checkBurnReleaseInvariant(bridge));
      invariants.push(this.checkNonNegativeInvariant(bridge));
    }

    const passed = invariants.filter((inv) => inv.passed).length;
    const failed = invariants.filter((inv) => !inv.passed).length;
    const warnings = 0; // Can be extended for warning-level invariants

    const overallStatus: 'passed' | 'failed' | 'warning' =
      failed > 0 ? 'failed' : 'passed';

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];

    return {
      date: dateStr,
      timestamp: now.getTime(),
      invariants,
      overallStatus,
      summary: {
        total: invariants.length,
        passed,
        failed,
        warnings,
      },
    };
  }

  /**
   * Generate report for a single bridge
   */
  generateSingleBridgeReport(bridge: BridgeState): AccountingReport {
    return this.generateReport([bridge]);
  }

  /**
   * Check if report indicates a failure
   */
  isReportFailed(report: AccountingReport): boolean {
    return report.overallStatus === 'failed';
  }

  /**
   * Get failed invariants from a report
   */
  getFailedInvariants(report: AccountingReport): InvariantCheck[] {
    return report.invariants.filter((inv) => !inv.passed);
  }

  /**
   * Format report as JSON string
   */
  formatReportJson(report: AccountingReport): string {
    return JSON.stringify(report, null, 2);
  }

  /**
   * Format report as human-readable text
   */
  formatReportText(report: AccountingReport): string {
    const lines: string[] = [];
    lines.push(`=== Accounting Invariant Report ===`);
    lines.push(`Date: ${report.date}`);
    lines.push(`Status: ${report.overallStatus.toUpperCase()}`);
    lines.push(`Summary: ${report.summary.passed}/${report.summary.total} passed`);
    lines.push('');

    for (const invariant of report.invariants) {
      const status = invariant.passed ? '✓' : '✗';
      lines.push(
        `${status} ${invariant.name}: ${invariant.message}`,
      );
    }

    return lines.join('\n');
  }
}
