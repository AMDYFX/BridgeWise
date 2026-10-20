/**
 * File: src/release/compatibility-gate/release-compatibility-gate.service.ts
 *
 * Release compatibility gate for contract and API (#1384).
 *
 * The gate is the last automated check before a release ships: it diffs the
 * release candidate's contract ABIs and OpenAPI document against their
 * baselines, applies the release policy, and returns a pass/fail verdict
 * with reproducible evidence (canonical SHA-256 input hashes) plus an audit
 * trail for the only privileged escape hatch — a release-manager waiver of a
 * failing report.
 *
 * Failure semantics (fail closed):
 *   - Malformed contract artifacts or API documents never produce a pass:
 *     malformed ABIs throw {@link CompatibilityGateError}
 *     ('MALFORMED_CONTRACT_ARTIFACT'), and malformed OpenAPI documents come
 *     back from the OpenAPI checker as a breaking `document-invalid` change.
 *   - A failing report can only leave the gate through `override()`, which
 *     requires a configured release-manager/admin role and is recorded in the
 *     privileged action audit log with the actor and justification.
 *   - `assertPass()` throws 'GATE_FAILED' so CI can simply fail the job.
 *
 * Gas/resource impact: the gate is a static, off-chain check. It reads JSON
 * documents and never submits transactions, so it has no gas cost and no
 * on-chain upgrade implications of its own; the *findings* it raises (ABI
 * changes) are exactly the upgrade implications operators must review. See
 * docs/RELEASE_COMPATIBILITY_GATE.md for the rule catalogue.
 *
 * Logs and metrics carry release ids, rule ids, and counts only — never the
 * API documents, ABIs, or any caller-supplied payloads.
 */

import { createHash } from 'crypto';
import { checkBackwardCompatibility } from '../../../apps/api/src/openapi/openapi-compatibility-checker';
import type { CompatibilityReport } from '../../../apps/api/src/openapi/openapi-compatibility-checker';
import { canonicalize } from '../../audit/privileged/sanitize';
import type { PrivilegedActionAuditLog } from '../../audit/privileged/privileged-action-audit-log';
import { checkContractCompatibility } from './contract-abi-compatibility';
import type {
  CompatibilityGateConfig,
  GateChange,
  GateCheckResult,
  GateLogEvent,
  GateMetrics,
  GatePolicy,
  GateReport,
  ReleaseCandidate,
  GateOverrideInput,
} from './release-compatibility-gate.types';
import { CompatibilityGateError } from './release-compatibility-gate.types';

export const GATE_CHECKER_ID = 'bridgewise-release-compatibility-gate/1';

/** Internal, mutable view of {@link GateMetrics}. */
interface MutableGateMetrics {
  evaluations: number;
  failedEvaluations: number;
  overrides: number;
  deniedOverrides: number;
  rejectedInputs: number;
}

const DEFAULT_OVERRIDE_ROLES = ['release-manager', 'admin'];
const MAX_RELEASE_ID_LENGTH = 128;
const MIN_OVERRIDE_REASON = 8;
const MAX_OVERRIDE_REASON = 512;

interface ApiCheckOutcome {
  readonly changes: GateChange[];
  readonly passed: boolean;
  readonly counts: { breaking: number; warning: number; info: number };
  readonly evidence: {
    baselineOperations: number;
    currentOperations: number;
    compatible: boolean;
  };
}

export class ReleaseCompatibilityGate {
  private readonly reports = new Map<string, GateReport>();
  private readonly overrideRoles: Set<string>;
  private readonly defaultPolicy: GatePolicy;
  private readonly now: () => number;
  private readonly logSink?: (event: GateLogEvent) => void;

  private counters: MutableGateMetrics = {
    evaluations: 0,
    failedEvaluations: 0,
    overrides: 0,
    deniedOverrides: 0,
    rejectedInputs: 0,
  };

  constructor(
    private readonly audit?: PrivilegedActionAuditLog,
    config: CompatibilityGateConfig = {},
  ) {
    this.now = config.now ?? (() => Date.now());
    this.overrideRoles = new Set(
      (config.overrideRoles ?? DEFAULT_OVERRIDE_ROLES).map((role) =>
        role.trim().toLowerCase(),
      ),
    );
    this.defaultPolicy = config.defaultPolicy ?? {};
    this.logSink = config.log;
  }

  // ─── Evaluation ───────────────────────────────────────────────────────────

  /**
   * Evaluate a release candidate under the gate policy. Deterministic for a
   * given candidate, policy, and clock: identical inputs yield identical
   * reports, including the evidence hashes.
   */
  evaluate(candidate: ReleaseCandidate, policy: GatePolicy = {}): GateReport {
    const releaseId = requireReleaseId(
      candidate?.releaseId,
      () => this.counters.rejectedInputs++,
    );
    const effectivePolicy: Required<
      Pick<GatePolicy, 'failOnBreaking' | 'failOnWarnings'>
    > &
      GatePolicy = {
      failOnBreaking:
        policy.failOnBreaking ?? this.defaultPolicy.failOnBreaking ?? true,
      failOnWarnings:
        policy.failOnWarnings ?? this.defaultPolicy.failOnWarnings ?? false,
      allowDeprecatedRemoval:
        policy.allowDeprecatedRemoval ??
        this.defaultPolicy.allowDeprecatedRemoval ??
        false,
      allowBreakingOnMajorBump:
        policy.allowBreakingOnMajorBump ??
        this.defaultPolicy.allowBreakingOnMajorBump ??
        false,
    };

    const contracts = candidate.contracts ?? [];
    const hasApi = candidate.api !== undefined;
    if (contracts.length === 0 && !hasApi) {
      this.counters.rejectedInputs += 1;
      throw new CompatibilityGateError(
        'INVALID_INPUT',
        'a release candidate must include at least one contract or an API document',
      );
    }

    const checks: GateCheckResult[] = [];
    const sectionHashes: Record<string, string> = {};

    for (const contract of contracts) {
      const name = requireContractName(
        contract?.name,
        () => this.counters.rejectedInputs++,
      );
      sectionHashes[`contract:${name}`] = sha256(
        canonicalize({
          name,
          baseline: contract.baseline,
          candidate: contract.candidate,
        }),
      );
      const changes = checkContractCompatibility(
        name,
        contract.baseline,
        contract.candidate,
        {
          baselineBytecode: contract.baselineBytecode,
          candidateBytecode: contract.candidateBytecode,
        },
      );
      const counts = countSeverities(changes);
      checks.push({
        id: 'contract-abi',
        subject: name,
        passed: satisfiesPolicy(counts, effectivePolicy),
        changes,
        counts,
      });
    }

    if (hasApi) {
      sectionHashes.api = sha256(canonicalize(candidate.api));
      const outcome = this.checkApi(
        candidate.api.baseline,
        candidate.api.candidate,
        effectivePolicy,
      );
      checks.push({
        id: 'api-openapi',
        subject: 'api',
        passed: outcome.passed,
        changes: outcome.changes,
        counts: outcome.counts,
      });
    }

    const counts = {
      breaking: checks.reduce((sum, check) => sum + check.counts.breaking, 0),
      warning: checks.reduce((sum, check) => sum + check.counts.warning, 0),
      info: checks.reduce((sum, check) => sum + check.counts.info, 0),
    };
    const passed = checks.every((check) => check.passed);
    const generatedAt = this.now();

    const report: GateReport = {
      releaseId,
      verdict: passed ? 'pass' : 'fail',
      generatedAt,
      policy: effectivePolicy,
      checks: Object.freeze(checks),
      counts,
      evidence: {
        checker: GATE_CHECKER_ID,
        releaseInputHash: sha256(
          canonicalize({
            releaseId,
            sections: sectionHashes,
            policy: effectivePolicy,
          }),
        ),
        sectionHashes: Object.freeze(sectionHashes),
      },
    };

    this.reports.set(releaseId, report);
    this.counters.evaluations += 1;
    if (!passed) this.counters.failedEvaluations += 1;
    this.emit({
      level: passed ? 'info' : 'warn',
      code: passed ? 'GATE_PASSED' : 'GATE_FAILED',
      at: generatedAt,
      releaseId,
      message: `release ${releaseId} ${passed ? 'passed' : 'failed'} the compatibility gate (${counts.breaking} breaking, ${counts.warning} warning, ${counts.info} info)`,
    });
    return report;
  }

  /** The stored report for a release, if the gate has seen it. */
  getReport(releaseId: string): GateReport | undefined {
    return this.reports.get(releaseId);
  }

  /**
   * CI entry point: throw unless the report passed. The error message carries
   * the verdict summary and counts — never document or ABI content.
   */
  assertPass(report: GateReport): void {
    if (!report || report.verdict !== 'pass') {
      const counts = report?.counts;
      throw new CompatibilityGateError(
        'GATE_FAILED',
        `release "${report?.releaseId ?? 'unknown'}" failed the compatibility gate: ` +
          `${counts?.breaking ?? '?'} breaking, ${counts?.warning ?? '?'} warning, ${counts?.info ?? '?'} info finding(s)` +
          `${report?.waived ? ' (waived)' : ''}`,
      );
    }
  }

  // ─── Privileged escape hatch ──────────────────────────────────────────────

  /**
   * Waive a failing report. Requires a configured release-manager/admin role
   * and a justification; both are recorded in the privileged action audit log
   * under the `configuration` category. Unauthorized attempts are audited as
   * `denied` and leave the failing verdict untouched.
   */
  override(input: GateOverrideInput): GateReport {
    const releaseId = requireReleaseId(
      input?.releaseId,
      () => this.counters.rejectedInputs++,
    );
    const actor = requireActor(
      input?.actor,
      () => this.counters.rejectedInputs++,
    );
    const reason = requireReason(
      input?.reason,
      () => this.counters.rejectedInputs++,
    );

    const report = this.reports.get(releaseId);
    if (!report) {
      this.counters.rejectedInputs += 1;
      throw new CompatibilityGateError(
        'INVALID_INPUT',
        `no gate report is stored for release "${releaseId}"; evaluate() it first`,
      );
    }
    if (report.verdict === 'pass' || report.waived) {
      this.counters.rejectedInputs += 1;
      throw new CompatibilityGateError(
        'NOTHING_TO_WAIVE',
        `release "${releaseId}" is not a failing, unwaived report`,
      );
    }

    const roles = Array.isArray(input?.actorRoles)
      ? input.actorRoles.filter(
          (role): role is string => typeof role === 'string',
        )
      : [];
    const normalized = roles.map((role) => role.trim().toLowerCase());
    const allowedRoles = [...this.overrideRoles].sort();
    const correlationId = input.correlationId ?? `gate-override-${releaseId}`;
    const auditBase = {
      actor,
      action: 'compatibility-gate.override',
      category: 'configuration' as const,
      target: releaseId,
      correlationId,
      params: {
        reason,
        roles: normalized,
        allowedRoles,
        breaking: report.counts.breaking,
        warning: report.counts.warning,
      },
    };

    // Written first: if the audit log rejects it, nothing is waived.
    this.audit?.record({ ...auditBase, outcome: 'attempted' });

    if (!normalized.some((role) => this.overrideRoles.has(role))) {
      this.audit?.record({
        ...auditBase,
        outcome: 'denied',
        reason: 'actor lacks a release override role',
      });
      this.counters.deniedOverrides += 1;
      throw new CompatibilityGateError(
        'OVERRIDE_DENIED',
        `actor "${actor}" is not authorized to waive the release gate (requires one of: ${allowedRoles.join(', ')})`,
      );
    }

    const at = this.now();
    const waived: GateReport['waived'] = {
      by: actor,
      reason,
      at,
      waivedFindings: {
        breaking: report.counts.breaking,
        warning: report.counts.warning,
      },
    };
    const overridden: GateReport = { ...report, verdict: 'pass', waived };
    this.reports.set(releaseId, overridden);
    this.audit?.record({ ...auditBase, outcome: 'success' });
    this.counters.overrides += 1;
    this.emit({
      level: 'warn',
      code: 'GATE_OVERRIDDEN',
      at,
      releaseId,
      message: `release ${releaseId} gate waived by ${actor} (${report.counts.breaking} breaking findings acknowledged)`,
    });
    return overridden;
  }

  metrics(): GateMetrics {
    return { ...this.counters };
  }

  /** Human-readable evidence block for CI logs and incident notes. */
  formatReport(report: GateReport): string {
    const lines: string[] = [];
    const waiver = report.waived ? ` (waived by ${report.waived.by})` : '';
    lines.push(
      `Release compatibility gate: ${report.verdict.toUpperCase()}${waiver}`,
    );
    lines.push(`  release: ${report.releaseId}`);
    lines.push(
      `  findings: ${report.counts.breaking} breaking, ${report.counts.warning} warning, ${report.counts.info} info`,
    );
    lines.push(`  checker: ${report.evidence.checker}`);
    lines.push(`  input hash: ${report.evidence.releaseInputHash}`);
    for (const check of report.checks) {
      lines.push(
        `  [${check.passed ? 'PASS' : 'FAIL'}] ${check.id} ${check.subject} ` +
          `(${check.counts.breaking}/${check.counts.warning}/${check.counts.info})`,
      );
      for (const change of check.changes) {
        if (change.severity === 'info') continue;
        lines.push(
          `      - ${change.severity}: ${change.rule} @ ${change.location}: ${change.message}`,
        );
      }
    }
    return lines.join('\n');
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  /**
   * API half: delegate to the OpenAPI backward-compatibility checker and
   * layer the gate policy on top (warnings can be made release-blocking).
   */
  private checkApi(
    baseline: unknown,
    candidate: unknown,
    policy: Required<Pick<GatePolicy, 'failOnBreaking' | 'failOnWarnings'>> &
      GatePolicy,
  ): ApiCheckOutcome {
    let compatibility: CompatibilityReport;
    try {
      compatibility = checkBackwardCompatibility(baseline, candidate, {
        allowDeprecatedRemoval: policy.allowDeprecatedRemoval,
        allowBreakingOnMajorBump: policy.allowBreakingOnMajorBump,
      });
    } catch (error) {
      this.counters.rejectedInputs += 1;
      throw new CompatibilityGateError(
        'MALFORMED_API_SPEC',
        `the API documents could not be compared: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const changes: GateChange[] = compatibility.changes.map((change) => ({
      rule: change.rule,
      severity: change.severity,
      message: change.message,
      location: change.location,
    }));
    const counts = countSeverities(changes);

    // The checker fails closed on unusable documents; that stays a failure
    // here even under lenient gate policies, because an unverifiable API
    // contract is not a passing compatibility check.
    const documentInvalid = compatibility.changes.some(
      (change) => change.rule === 'document-invalid',
    );
    const passed =
      !documentInvalid &&
      compatibility.compatible &&
      (!policy.failOnWarnings || counts.warning === 0);

    return {
      changes,
      passed,
      counts,
      evidence: {
        baselineOperations: compatibility.baselineOperations,
        currentOperations: compatibility.currentOperations,
        compatible: compatibility.compatible,
      },
    };
  }

  private emit(event: GateLogEvent): void {
    this.logSink?.(event);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function countSeverities(changes: readonly GateChange[]): {
  breaking: number;
  warning: number;
  info: number;
} {
  const counts = { breaking: 0, warning: 0, info: 0 };
  for (const change of changes) {
    if (change.severity === 'breaking') counts.breaking += 1;
    else if (change.severity === 'warning') counts.warning += 1;
    else counts.info += 1;
  }
  return counts;
}

function satisfiesPolicy(
  counts: { breaking: number; warning: number; info: number },
  policy: Required<Pick<GatePolicy, 'failOnBreaking' | 'failOnWarnings'>>,
): boolean {
  if (policy.failOnBreaking && counts.breaking > 0) return false;
  if (policy.failOnWarnings && counts.warning > 0) return false;
  return true;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireReleaseId(value: unknown, onReject: () => void): string {
  const releaseId = typeof value === 'string' ? value.trim() : '';
  if (
    !releaseId ||
    releaseId.length > MAX_RELEASE_ID_LENGTH ||
    hasControlCharacters(releaseId)
  ) {
    onReject();
    throw new CompatibilityGateError(
      'INVALID_INPUT',
      `releaseId must be 1..${MAX_RELEASE_ID_LENGTH} characters without control characters`,
    );
  }
  return releaseId;
}

function requireContractName(value: unknown, onReject: () => void): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (
    !name ||
    name.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
  ) {
    onReject();
    throw new CompatibilityGateError(
      'INVALID_INPUT',
      'each contract input needs a plain name (letters, digits, . _ -)',
    );
  }
  return name;
}

function requireActor(value: unknown, onReject: () => void): string {
  const actor = typeof value === 'string' ? value.trim() : '';
  if (!actor || actor.length > 256) {
    onReject();
    throw new CompatibilityGateError(
      'INVALID_INPUT',
      'override actor must be 1..256 characters',
    );
  }
  return actor;
}

function requireReason(value: unknown, onReject: () => void): string {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (
    reason.length < MIN_OVERRIDE_REASON ||
    reason.length > MAX_OVERRIDE_REASON
  ) {
    onReject();
    throw new CompatibilityGateError(
      'INVALID_INPUT',
      `override reason must be ${MIN_OVERRIDE_REASON}..${MAX_OVERRIDE_REASON} characters`,
    );
  }
  return stripControlCharacters(reason);
}

/** True when the untrusted text contains C0/DEL control characters. */
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Replace C0/DEL control characters with spaces. */
function stripControlCharacters(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    result += code < 0x20 || code === 0x7f ? ' ' : character;
  }
  return result;
}
