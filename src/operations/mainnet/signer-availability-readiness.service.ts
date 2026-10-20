/**
 * File: src/operations/mainnet/signer-availability-readiness.service.ts
 *
 * Signer availability readiness checks (#1379).
 *
 * Readiness is evaluated per chain against an explicit quorum. Each probe is
 * bounded by a timeout and every failure is converted to a low-cardinality
 * reason code, so an untrusted or compromised probe can neither hang the
 * readiness path nor leak signing material into logs or reports.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  ChainSignerReadiness,
  SignerAvailabilityProbe,
  SignerChainRequirement,
  SignerReadinessCheckOptions,
  SignerReadinessResult,
} from './signer-availability-readiness.types';

const DEFAULT_TIMEOUT_MS = 2_000;
const SAFE_REASON_CODE = /^[a-z0-9_.:-]{1,64}$/i;

export class SignerReadinessError extends Error {
  constructor(
    public readonly chain: string,
    public readonly status: ChainSignerReadiness['status'],
    public readonly report: ChainSignerReadiness,
  ) {
    super(
      `Signer readiness for ${chain} is ${status} (${report.reasons.join(', ')})`,
    );
    this.name = 'SignerReadinessError';
  }
}

class ProbeTimeoutError extends Error {}

export interface SignerAvailabilityReadinessServiceOptions {
  /** Injectable clock for deterministic reports. */
  now?: () => number;
  /** Default per-signer probe timeout. */
  timeoutMs?: number;
}

@Injectable()
export class SignerAvailabilityReadinessService {
  private readonly logger = new Logger(SignerAvailabilityReadinessService.name);
  private readonly requirements = new Map<string, SignerChainRequirement>();
  private readonly lastReports = new Map<string, ChainSignerReadiness>();
  private readonly now: () => number;
  private readonly defaultTimeoutMs: number;

  constructor(
    private readonly probe: SignerAvailabilityProbe,
    options: SignerAvailabilityReadinessServiceOptions = {},
  ) {
    if (!probe || typeof probe.check !== 'function') {
      throw new Error('A signer availability probe is required');
    }
    this.now = options.now ?? Date.now;
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.defaultTimeoutMs) || this.defaultTimeoutMs <= 0) {
      throw new Error('timeoutMs must be a positive number');
    }
  }

  public registerRequirement(
    requirement: SignerChainRequirement,
  ): SignerChainRequirement {
    const normalized = this.normalizeRequirement(requirement);
    this.requirements.set(normalized.chain, normalized);
    return this.copyRequirement(normalized);
  }

  public removeRequirement(chain: string): boolean {
    return this.requirements.delete(normalizeChain(chain));
  }

  public getRequirement(chain: string): SignerChainRequirement | undefined {
    const requirement = this.requirements.get(normalizeChain(chain));
    return requirement ? this.copyRequirement(requirement) : undefined;
  }

  public listRequirements(): SignerChainRequirement[] {
    return Array.from(this.requirements.values()).map((requirement) =>
      this.copyRequirement(requirement),
    );
  }

  /**
   * Probe every configured signer for a chain and compute the chain verdict.
   * Throws when the chain has no registered readiness requirement.
   */
  public async checkChain(
    chain: string,
    options: SignerReadinessCheckOptions = {},
  ): Promise<ChainSignerReadiness> {
    const normalizedChain = normalizeChain(chain);
    const requirement = this.requirements.get(normalizedChain);
    if (!requirement) {
      throw new Error(
        `No signer readiness requirement registered for ${normalizedChain}`,
      );
    }

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('timeoutMs must be a positive number');
    }

    const signers = await Promise.all(
      requirement.signerIds.map((signerId) =>
        this.checkSigner(signerId, normalizedChain, requirement, timeoutMs),
      ),
    );

    const ready = signers.filter((s) => s.status === 'ready').length;
    const degraded = signers.filter((s) => s.status === 'degraded').length;
    const unavailable = signers.filter(
      (s) => s.status === 'unavailable',
    ).length;
    const healthy = ready + degraded;

    let status: ChainSignerReadiness['status'];
    const reasons: string[] = [];
    if (healthy < requirement.minAvailable) {
      status = 'unavailable';
      reasons.push('below_minimum_available_signers');
    } else if (ready < requirement.minAvailable) {
      status = 'degraded';
      reasons.push('signer_latency_exceeded');
    } else {
      status = 'ready';
      reasons.push('all_requirements_met');
    }
    if (unavailable > 0) {
      reasons.push('signer_probe_failed');
    }

    const report: ChainSignerReadiness = {
      chain: normalizedChain,
      status,
      checkedAt: this.now(),
      requiredAvailable: requirement.minAvailable,
      ready,
      degraded,
      unavailable,
      signers,
      reasons: Array.from(new Set(reasons)),
    };

    this.lastReports.set(normalizedChain, report);
    if (status === 'unavailable') {
      this.logger.warn(
        `Signer readiness unavailable chain=${normalizedChain} ready=${ready} degraded=${degraded} unavailable=${unavailable} required=${requirement.minAvailable}`,
      );
    } else if (status === 'degraded') {
      this.logger.warn(
        `Signer readiness degraded chain=${normalizedChain} ready=${ready} degraded=${degraded} required=${requirement.minAvailable}`,
      );
    }

    return this.copyReport(report);
  }

  public async checkAll(
    options: SignerReadinessCheckOptions = {},
  ): Promise<ChainSignerReadiness[]> {
    return Promise.all(
      Array.from(this.requirements.keys()).map((chain) =>
        this.checkChain(chain, options),
      ),
    );
  }

  public getLastReport(chain: string): ChainSignerReadiness | undefined {
    const report = this.lastReports.get(normalizeChain(chain));
    return report ? this.copyReport(report) : undefined;
  }

  public isReady(chain: string): boolean {
    return this.getLastReport(chain)?.status === 'ready';
  }

  /**
   * Fail-closed guard for transfer submission paths.
   */
  public async assertReady(chain: string): Promise<ChainSignerReadiness> {
    const report = await this.checkChain(chain);
    if (report.status !== 'ready') {
      throw new SignerReadinessError(report.chain, report.status, report);
    }
    return report;
  }

  public clear(): void {
    this.requirements.clear();
    this.lastReports.clear();
  }

  private async checkSigner(
    signerId: string,
    chain: string,
    requirement: SignerChainRequirement,
    timeoutMs: number,
  ): Promise<SignerReadinessResult> {
    const checkedAt = this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const probePromise = (async () => this.probe.check(signerId, chain))();
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ProbeTimeoutError('probe timed out')),
          timeoutMs,
        );
      });

      const result = await Promise.race([probePromise, timeoutPromise]);
      const latencyMs =
        typeof result.latencyMs === 'number' &&
        Number.isFinite(result.latencyMs)
          ? Math.max(0, result.latencyMs)
          : undefined;

      if (!result.available) {
        return {
          signerId,
          status: 'unavailable',
          latencyMs,
          reasonCode: sanitizeReasonCode(
            result.reasonCode ?? 'probe_unavailable',
          ),
          checkedAt,
        };
      }

      if (latencyMs !== undefined && latencyMs > requirement.maxLatencyMs) {
        return {
          signerId,
          status: 'degraded',
          latencyMs,
          reasonCode: 'signer_latency_exceeded',
          checkedAt,
        };
      }

      return {
        signerId,
        status: 'ready',
        latencyMs,
        reasonCode: 'available',
        checkedAt,
      };
    } catch (error) {
      const timedOut = error instanceof ProbeTimeoutError;
      return {
        signerId,
        status: 'unavailable',
        reasonCode: timedOut ? 'probe_timeout' : 'probe_error',
        checkedAt,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private normalizeRequirement(
    requirement: SignerChainRequirement,
  ): SignerChainRequirement {
    const chain = normalizeChain(requirement?.chain);
    if (
      !Array.isArray(requirement.signerIds) ||
      requirement.signerIds.length === 0
    ) {
      throw new Error('signerIds must contain at least one signer');
    }

    const signerIds = requirement.signerIds.map((signerId) => {
      if (typeof signerId !== 'string' || signerId.trim() === '') {
        throw new Error('signerIds must be non-empty strings');
      }
      return signerId.trim();
    });
    if (new Set(signerIds).size !== signerIds.length) {
      throw new Error('signerIds must be unique per chain');
    }
    if (
      !Number.isInteger(requirement.minAvailable) ||
      requirement.minAvailable < 1
    ) {
      throw new Error('minAvailable must be a positive integer');
    }
    if (requirement.minAvailable > signerIds.length) {
      throw new Error('minAvailable cannot exceed the configured signer count');
    }
    if (
      !Number.isFinite(requirement.maxLatencyMs) ||
      requirement.maxLatencyMs <= 0
    ) {
      throw new Error('maxLatencyMs must be a positive number');
    }

    return {
      chain,
      signerIds,
      minAvailable: requirement.minAvailable,
      maxLatencyMs: requirement.maxLatencyMs,
    };
  }

  private copyRequirement(
    requirement: SignerChainRequirement,
  ): SignerChainRequirement {
    return { ...requirement, signerIds: [...requirement.signerIds] };
  }

  private copyReport(report: ChainSignerReadiness): ChainSignerReadiness {
    return {
      ...report,
      signers: report.signers.map((signer) => ({ ...signer })),
      reasons: [...report.reasons],
    };
  }
}

function normalizeChain(chain: string): string {
  if (typeof chain !== 'string' || chain.trim() === '') {
    throw new Error('chain must be a non-empty string');
  }
  return chain.trim().toLowerCase();
}

function sanitizeReasonCode(reasonCode: unknown): string {
  if (typeof reasonCode === 'string' && SAFE_REASON_CODE.test(reasonCode)) {
    return reasonCode.toLowerCase();
  }
  return 'unspecified';
}
