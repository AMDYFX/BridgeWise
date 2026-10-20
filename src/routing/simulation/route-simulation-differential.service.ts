/**
 * File: src/routing/simulation/route-simulation-differential.service.ts
 *
 * Implements differential route simulation tests (#1282).
 * Compares simulation outputs across independent simulation engines or dry-runs,
 * calculates divergence in basis points using high-precision BigInt arithmetic,
 * checks revert consistency, and produces diagnostic reports without leaking sensitive data.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  EngineSimulationResult,
  ISimulationEngine,
  RouteSimulationDifferentialReport,
  RouteSimulationTarget,
  SimulationDifferentialConfig,
} from './route-simulation-differential.types';

@Injectable()
export class RouteSimulationDifferentialService {
  private readonly logger = new Logger(RouteSimulationDifferentialService.name);
  private config: SimulationDifferentialConfig;
  private readonly registeredEngines = new Map<string, ISimulationEngine>();

  constructor(config?: Partial<SimulationDifferentialConfig>) {
    this.config = {
      maxAllowedOutputDivergenceBps: config?.maxAllowedOutputDivergenceBps ?? 25, // 0.25%
      maxAllowedFeeDivergenceBps: config?.maxAllowedFeeDivergenceBps ?? 500, // 5.0%
      requireRevertConsensus: config?.requireRevertConsensus ?? true,
      minRequiredEngines: config?.minRequiredEngines ?? 2,
    };
  }

  /**
   * Register a simulation engine.
   */
  public registerEngine(engine: ISimulationEngine): void {
    this.registeredEngines.set(engine.engineId, engine);
  }

  /**
   * Remove a simulation engine.
   */
  public unregisterEngine(engineId: string): boolean {
    return this.registeredEngines.delete(engineId);
  }

  /**
   * Get all registered engine IDs.
   */
  public getRegisteredEngineIds(): string[] {
    return Array.from(this.registeredEngines.keys());
  }

  /**
   * Configure differential thresholds.
   */
  public updateConfig(newConfig: Partial<SimulationDifferentialConfig>): void {
    this.config = {
      ...this.config,
      ...newConfig,
    };
  }

  /**
   * Parse numeric decimal string to 18-decimal fixed-point BigInt.
   */
  private parseAmountToBigInt(amount: string): bigint {
    const trimmed = amount.trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
      throw new Error(`Invalid numeric amount format: "${trimmed}"`);
    }
    const [intPart, fracPart = ''] = trimmed.split('.');
    const paddedFrac = fracPart.padEnd(18, '0').slice(0, 18);
    return BigInt(intPart + paddedFrac);
  }

  /**
   * Compute basis points divergence between two amounts:
   * deltaBps = abs(a - b) * 10000 / max(a, b)
   */
  public calculateDivergenceBps(amountA: string, amountB: string): number {
    const biA = this.parseAmountToBigInt(amountA);
    const biB = this.parseAmountToBigInt(amountB);

    if (biA === BigInt(0) && biB === BigInt(0)) return 0;
    const maxVal = biA > biB ? biA : biB;
    if (maxVal === BigInt(0)) return 0;

    const diff = biA > biB ? biA - biB : biB - biA;
    return Number((diff * BigInt(10000)) / maxVal);
  }

  /**
   * Run differential simulation across all registered engines (or specified subset).
   */
  public async evaluateRouteDifferential(
    route: RouteSimulationTarget,
    engineIds?: string[],
  ): Promise<RouteSimulationDifferentialReport> {
    const evaluatedAt = Date.now();
    const targetEngines = (
      engineIds
        ? engineIds.map((id) => this.registeredEngines.get(id)).filter(Boolean)
        : Array.from(this.registeredEngines.values())
    ) as ISimulationEngine[];

    if (targetEngines.length < this.config.minRequiredEngines) {
      return {
        routeId: route.routeId,
        status: 'INSUFFICIENT_ENGINES',
        isAcceptable: false,
        primaryEngineId: targetEngines[0]?.engineId ?? 'none',
        engineCount: targetEngines.length,
        outputDivergenceBps: 0,
        feeDivergenceBps: 0,
        engineResults: [],
        diagnosticEvidence: {
          discrepancyDescription: `Available engines (${targetEngines.length}) below minimum required (${this.config.minRequiredEngines}).`,
          recommendedAction: 'HOLD_FOR_REVIEW',
        },
        evaluatedAt,
      };
    }

    // Execute simulations across engines in parallel with isolated error handling
    const executionPromises = targetEngines.map(async (engine) => {
      const start = Date.now();
      try {
        const res = await engine.simulate(route);
        return res;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const result: EngineSimulationResult = {
          engineId: engine.engineId,
          success: false,
          revertReason: `Engine execution threw exception: ${message}`,
          executionDurationMs: Date.now() - start,
        };
        return result;
      }
    });

    const engineResults = await Promise.all(executionPromises);
    const primaryEngine = engineResults[0];

    // Check for revert consensus
    const successfulEngines = engineResults.filter((r) => r.success);
    const failedEngines = engineResults.filter((r) => !r.success);

    if (this.config.requireRevertConsensus && successfulEngines.length > 0 && failedEngines.length > 0) {
      return {
        routeId: route.routeId,
        status: 'REVERT_MISMATCH',
        isAcceptable: false,
        primaryEngineId: primaryEngine.engineId,
        engineCount: engineResults.length,
        outputDivergenceBps: 0,
        feeDivergenceBps: 0,
        engineResults,
        diagnosticEvidence: {
          agreedOnRevert: false,
          discrepancyDescription: `Engines disagreed on success/revert: ${successfulEngines.length} succeeded, ${failedEngines.length} failed.`,
          recommendedAction: 'REJECT_ROUTE',
        },
        evaluatedAt,
      };
    }

    if (successfulEngines.length === 0) {
      // All engines reverted
      return {
        routeId: route.routeId,
        status: 'MATCH',
        isAcceptable: false,
        primaryEngineId: primaryEngine.engineId,
        engineCount: engineResults.length,
        outputDivergenceBps: 0,
        feeDivergenceBps: 0,
        engineResults,
        diagnosticEvidence: {
          agreedOnRevert: true,
          discrepancyDescription: 'All simulation engines unanimously reverted execution.',
          recommendedAction: 'REJECT_ROUTE',
        },
        evaluatedAt,
      };
    }

    // Compare outputs across successful engines
    let maxOutputDivergenceBps = 0;
    let maxFeeDivergenceBps = 0;
    const secondaryDetails: { engineId: string; output: string; deltaBps: number }[] = [];

    const primaryOutput = primaryEngine.simulatedOutputAmount ?? '0';
    const primaryFee = primaryEngine.simulatedFeeAmount ?? '0';

    for (let i = 1; i < successfulEngines.length; i++) {
      const secEngine = successfulEngines[i];
      const secOutput = secEngine.simulatedOutputAmount ?? '0';
      const secFee = secEngine.simulatedFeeAmount ?? '0';

      const outputBps = this.calculateDivergenceBps(primaryOutput, secOutput);
      const feeBps = this.calculateDivergenceBps(primaryFee, secFee);

      secondaryDetails.push({
        engineId: secEngine.engineId,
        output: secOutput,
        deltaBps: outputBps,
      });

      if (outputBps > maxOutputDivergenceBps) {
        maxOutputDivergenceBps = outputBps;
      }
      if (feeBps > maxFeeDivergenceBps) {
        maxFeeDivergenceBps = feeBps;
      }
    }

    // Evaluate divergence against bounds
    if (maxOutputDivergenceBps > this.config.maxAllowedOutputDivergenceBps) {
      return {
        routeId: route.routeId,
        status: 'DIVERGENT_OUTPUT',
        isAcceptable: false,
        primaryEngineId: primaryEngine.engineId,
        engineCount: engineResults.length,
        outputDivergenceBps: maxOutputDivergenceBps,
        feeDivergenceBps: maxFeeDivergenceBps,
        engineResults,
        diagnosticEvidence: {
          discrepancyDescription: `Output divergence of ${maxOutputDivergenceBps} bps exceeds threshold of ${this.config.maxAllowedOutputDivergenceBps} bps.`,
          recommendedAction: 'REJECT_ROUTE',
          divergenceDetails: {
            primaryOutput,
            secondaryOutputs: secondaryDetails,
          },
        },
        evaluatedAt,
      };
    }

    if (maxFeeDivergenceBps > this.config.maxAllowedFeeDivergenceBps) {
      return {
        routeId: route.routeId,
        status: 'DIVERGENT_FEES',
        isAcceptable: false,
        primaryEngineId: primaryEngine.engineId,
        engineCount: engineResults.length,
        outputDivergenceBps: maxOutputDivergenceBps,
        feeDivergenceBps: maxFeeDivergenceBps,
        engineResults,
        diagnosticEvidence: {
          discrepancyDescription: `Fee divergence of ${maxFeeDivergenceBps} bps exceeds threshold of ${this.config.maxAllowedFeeDivergenceBps} bps.`,
          recommendedAction: 'HOLD_FOR_REVIEW',
          divergenceDetails: {
            primaryOutput,
            secondaryOutputs: secondaryDetails,
          },
        },
        evaluatedAt,
      };
    }

    return {
      routeId: route.routeId,
      status: 'MATCH',
      isAcceptable: true,
      primaryEngineId: primaryEngine.engineId,
      engineCount: engineResults.length,
      outputDivergenceBps: maxOutputDivergenceBps,
      feeDivergenceBps: maxFeeDivergenceBps,
      engineResults,
      diagnosticEvidence: {
        recommendedAction: 'PROCEED',
        divergenceDetails: {
          primaryOutput,
          secondaryOutputs: secondaryDetails,
        },
      },
      evaluatedAt,
    };
  }
}
