/**
 * File: src/routing/slippage/slippage-bound-enforcement.service.ts
 *
 * Implements slippage bound enforcement (#1283).
 * Validates user tolerances, calculates exact minimum output amounts using
 * high-precision integer arithmetic, and protects execution from excessive slippage.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  SlippageEnforcementConfig,
  SlippageValidationRequest,
  SlippageValidationResult,
} from './slippage-bound-enforcement.types';

@Injectable()
export class SlippageBoundEnforcementService {
  private readonly logger = new Logger(SlippageBoundEnforcementService.name);
  private config: Required<SlippageEnforcementConfig>;

  constructor(config?: SlippageEnforcementConfig) {
    this.config = {
      minAllowedSlippageBps: config?.minAllowedSlippageBps ?? 1, // 0.01%
      maxAllowedSlippageBps: config?.maxAllowedSlippageBps ?? 500, // 5.0%
      defaultSlippageBps: config?.defaultSlippageBps ?? 50, // 0.5%
      perAssetMaxSlippageBps: config?.perAssetMaxSlippageBps ?? {
        USDC: 50,
        USDT: 50,
        BUSD: 50,
        DAI: 100,
        XLM: 200,
        ETH: 200,
        BTC: 200,
      },
      strictMinOutputCheck: config?.strictMinOutputCheck ?? true,
    };
  }

  /**
   * Update configuration parameters.
   */
  public updateConfig(newConfig: Partial<SlippageEnforcementConfig>): void {
    this.config = {
      ...this.config,
      ...newConfig,
      perAssetMaxSlippageBps: {
        ...this.config.perAssetMaxSlippageBps,
        ...(newConfig.perAssetMaxSlippageBps ?? {}),
      },
    };
  }

  /**
   * Parse arbitrary decimal string into a standard 18-decimal scaled BigInt.
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
   * Convert standard 18-decimal scaled BigInt back to a formatted string.
   */
  private formatBigIntToAmount(val: bigint): string {
    const str = val.toString().padStart(19, '0');
    const intPart = str.slice(0, -18) || '0';
    let fracPart = str.slice(-18).replace(/0+$/, '');
    return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
  }

  /**
   * Calculate minimum output amount given expected output and slippage in basis points.
   * minOutput = expectedOutput * (10000 - slippageBps) / 10000
   */
  public calculateMinOutput(expectedOutput: string, slippageBps: number): string {
    if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 10000) {
      throw new Error(`Invalid slippage basis points: ${slippageBps}`);
    }

    const expectedBI = this.parseAmountToBigInt(expectedOutput);
    const bpsBI = BigInt(Math.floor(slippageBps));
    const factorBI = BigInt(10000) - bpsBI;
    const minOutputBI = (expectedBI * factorBI) / BigInt(10000);

    return this.formatBigIntToAmount(minOutputBI);
  }

  /**
   * Calculate effective slippage in basis points between expected and actual/min output.
   */
  public calculateEffectiveSlippageBps(
    expectedOutput: string,
    actualOrMinOutput: string,
  ): number {
    const expectedBI = this.parseAmountToBigInt(expectedOutput);
    const actualBI = this.parseAmountToBigInt(actualOrMinOutput);

    if (expectedBI === BigInt(0)) return 0;
    if (actualBI >= expectedBI) return 0;

    const diffBI = expectedBI - actualBI;
    const slippageBpsBI = (diffBI * BigInt(10000)) / expectedBI;
    return Number(slippageBpsBI);
  }

  /**
   * Resolve the maximum allowed slippage in basis points for an asset.
   */
  public getMaxAllowedSlippageBps(asset: string): number {
    const normalized = asset.trim().toUpperCase();
    return (
      this.config.perAssetMaxSlippageBps[normalized] ??
      this.config.maxAllowedSlippageBps
    );
  }

  /**
   * Validates a slippage request against configured boundaries.
   */
  public validateSlippage(
    request: SlippageValidationRequest,
  ): SlippageValidationResult {
    const now = Date.now();
    const asset = request.asset.trim().toUpperCase();
    const allowedMaxBps = this.getMaxAllowedSlippageBps(asset);

    // 1. Validate numeric formatting
    let expectedBI: bigint;
    let minOutputBI: bigint;
    try {
      expectedBI = this.parseAmountToBigInt(request.expectedOutput);
      minOutputBI = this.parseAmountToBigInt(request.minOutputAmount);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        routeId: request.routeId,
        asset,
        valid: false,
        effectiveSlippageBps: 0,
        effectiveSlippagePercent: 0,
        allowedMaxSlippageBps: allowedMaxBps,
        minOutputSatisfied: false,
        rejectionCode: 'INVALID_AMOUNT_FORMAT',
        rejectionMessage: msg,
        evaluatedAt: now,
      };
    }

    if (expectedBI <= BigInt(0)) {
      return {
        routeId: request.routeId,
        asset,
        valid: false,
        effectiveSlippageBps: 0,
        effectiveSlippagePercent: 0,
        allowedMaxSlippageBps: allowedMaxBps,
        minOutputSatisfied: false,
        rejectionCode: 'INVALID_SLIPPAGE_BOUNDS',
        rejectionMessage: 'Expected output amount must be strictly greater than 0.',
        evaluatedAt: now,
      };
    }

    // 2. Validate user tolerance bounds
    const requestedToleranceBps =
      request.userToleranceBps ?? this.config.defaultSlippageBps;

    if (
      !Number.isFinite(requestedToleranceBps) ||
      requestedToleranceBps < this.config.minAllowedSlippageBps
    ) {
      return {
        routeId: request.routeId,
        asset,
        valid: false,
        effectiveSlippageBps: requestedToleranceBps,
        effectiveSlippagePercent: requestedToleranceBps / 100,
        allowedMaxSlippageBps: allowedMaxBps,
        minOutputSatisfied: false,
        rejectionCode: 'SLIPPAGE_BELOW_MINIMUM',
        rejectionMessage: `Requested slippage ${requestedToleranceBps} bps is below minimum allowed ${this.config.minAllowedSlippageBps} bps.`,
        evaluatedAt: now,
      };
    }

    if (requestedToleranceBps > allowedMaxBps) {
      return {
        routeId: request.routeId,
        asset,
        valid: false,
        effectiveSlippageBps: requestedToleranceBps,
        effectiveSlippagePercent: requestedToleranceBps / 100,
        allowedMaxSlippageBps: allowedMaxBps,
        minOutputSatisfied: false,
        rejectionCode: 'SLIPPAGE_EXCEEDED',
        rejectionMessage: `Requested slippage ${requestedToleranceBps} bps exceeds maximum allowable ${allowedMaxBps} bps for ${asset}.`,
        evaluatedAt: now,
      };
    }

    // 3. Calculate implied effective slippage between expectedOutput and minOutputAmount
    const effectiveSlippageBps = this.calculateEffectiveSlippageBps(
      request.expectedOutput,
      request.minOutputAmount,
    );

    // 4. Check whether minOutputAmount satisfies the requested tolerance
    const requiredMinOutputBI =
      (expectedBI * BigInt(10000 - requestedToleranceBps)) / BigInt(10000);

    if (this.config.strictMinOutputCheck && minOutputBI < requiredMinOutputBI) {
      return {
        routeId: request.routeId,
        asset,
        valid: false,
        effectiveSlippageBps,
        effectiveSlippagePercent: effectiveSlippageBps / 100,
        allowedMaxSlippageBps: allowedMaxBps,
        minOutputSatisfied: false,
        rejectionCode: 'MIN_OUTPUT_NOT_SATISFIED',
        rejectionMessage: `Minimum output ${request.minOutputAmount} violates slippage tolerance of ${requestedToleranceBps} bps (expected at least ${this.formatBigIntToAmount(requiredMinOutputBI)}).`,
        evaluatedAt: now,
      };
    }

    // 5. If simulated output is available, verify it meets the minimum output amount
    if (request.simulatedOutput) {
      try {
        const simulatedBI = this.parseAmountToBigInt(request.simulatedOutput);
        if (simulatedBI < minOutputBI) {
          return {
            routeId: request.routeId,
            asset,
            valid: false,
            effectiveSlippageBps,
            effectiveSlippagePercent: effectiveSlippageBps / 100,
            allowedMaxSlippageBps: allowedMaxBps,
            minOutputSatisfied: false,
            rejectionCode: 'SIMULATED_OUTPUT_BELOW_MIN',
            rejectionMessage: `Simulated output ${request.simulatedOutput} falls below guaranteed minimum output ${request.minOutputAmount}.`,
            evaluatedAt: now,
          };
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          routeId: request.routeId,
          asset,
          valid: false,
          effectiveSlippageBps,
          effectiveSlippagePercent: effectiveSlippageBps / 100,
          allowedMaxSlippageBps: allowedMaxBps,
          minOutputSatisfied: false,
          rejectionCode: 'INVALID_AMOUNT_FORMAT',
          rejectionMessage: `Invalid simulated output amount: ${msg}`,
          evaluatedAt: now,
        };
      }
    }

    return {
      routeId: request.routeId,
      asset,
      valid: true,
      effectiveSlippageBps,
      effectiveSlippagePercent: effectiveSlippageBps / 100,
      allowedMaxSlippageBps: allowedMaxBps,
      minOutputSatisfied: true,
      evaluatedAt: now,
    };
  }

  /**
   * Enforces slippage bounds, throwing an error if validation fails.
   */
  public enforceSlippageOrThrow(request: SlippageValidationRequest): void {
    const result = this.validateSlippage(request);
    if (!result.valid) {
      this.logger.warn(
        `Slippage bound enforcement rejected route ${request.routeId}: ${result.rejectionCode} - ${result.rejectionMessage}`,
      );
      throw new Error(
        `Slippage enforcement failed [${result.rejectionCode}]: ${result.rejectionMessage}`,
      );
    }
  }
}
