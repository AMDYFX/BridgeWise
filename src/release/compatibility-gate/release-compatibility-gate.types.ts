/**
 * File: src/release/compatibility-gate/release-compatibility-gate.types.ts
 *
 * Types for the release compatibility gate for contract and API (#1384).
 *
 * The gate is the last automated check before a release ships. A release
 * candidate carries, per contract, its baseline and candidate ABI (or a full
 * artifact), and optionally the baseline/current OpenAPI documents. The gate
 * diffs them under a policy and returns a verdict plus reproducible evidence
 * (canonical input hashes) that CI and auditors can re-derive.
 *
 * Everything crossing this boundary is untrusted input: ABIs and API
 * documents are validated before they are diffed, and malformed artifacts
 * fail closed with {@link CompatibilityGateError} rather than being skipped.
 */

/** A breaking/warning/info classification, mirroring the OpenAPI checker. */
export type GateSeverity = 'breaking' | 'warning' | 'info';

export type GateCheckId = 'contract-abi' | 'api-openapi';

export interface GateChange {
  /** Stable rule id, e.g. `function-removed`. */
  readonly rule: string;
  readonly severity: GateSeverity;
  readonly message: string;
  /** Dotted location, e.g. `contracts.BridgeVault.functions.withdraw(uint256)`. */
  readonly location: string;
}

/** One contract's baseline→candidate comparison input. */
export interface ContractReleaseInput {
  /** Contract name; all findings are scoped under it. */
  readonly name: string;
  /** Baseline ABI (array of ABI entries) or a full artifact with `.abi`. */
  readonly baseline: unknown;
  /** Candidate ABI or artifact with `.abi`. */
  readonly candidate: unknown;
  /** Optional deployment bytecode, recorded as evidence only (never gated). */
  readonly baselineBytecode?: string;
  readonly candidateBytecode?: string;
}

export interface ApiReleaseInput {
  readonly baseline: unknown;
  readonly candidate: unknown;
}

export interface ReleaseCandidate {
  readonly releaseId: string;
  readonly contracts?: readonly ContractReleaseInput[];
  readonly api?: ApiReleaseInput;
}

export interface GatePolicy {
  /** Gate fails on breaking findings (default true). */
  readonly failOnBreaking?: boolean;
  /** Gate also fails on warnings (default false). */
  readonly failOnWarnings?: boolean;
  /** Passed through to the OpenAPI checker: allow removal of deprecated ops. */
  readonly allowDeprecatedRemoval?: boolean;
  /** Passed through to the OpenAPI checker: breaking changes ok on major bump. */
  readonly allowBreakingOnMajorBump?: boolean;
}

export interface GateCheckResult {
  readonly id: GateCheckId;
  /** Contract name or `api`. */
  readonly subject: string;
  readonly passed: boolean;
  readonly changes: readonly GateChange[];
  readonly counts: { breaking: number; warning: number; info: number };
}

export interface GateEvidence {
  /** Identifies this checker implementation for audit. */
  readonly checker: string;
  /** SHA-256 over the canonicalized full release input. */
  readonly releaseInputHash: string;
  /** Per-section input hashes, e.g. `contract:BridgeVault`. */
  readonly sectionHashes: Readonly<Record<string, string>>;
}

export interface GateWaiver {
  readonly by: string;
  readonly reason: string;
  readonly at: number;
  /** Findings that were waived, at the time of the waiver. */
  readonly waivedFindings: {
    readonly breaking: number;
    readonly warning: number;
  };
}

export interface GateReport {
  readonly releaseId: string;
  readonly verdict: 'pass' | 'fail';
  readonly generatedAt: number;
  readonly policy: Required<
    Pick<GatePolicy, 'failOnBreaking' | 'failOnWarnings'>
  > &
    GatePolicy;
  readonly checks: readonly GateCheckResult[];
  readonly counts: { breaking: number; warning: number; info: number };
  readonly evidence: GateEvidence;
  /** Present only when a release-manager waived a failing report. */
  readonly waived?: GateWaiver;
}

export interface GateOverrideInput {
  readonly releaseId: string;
  readonly actor: string;
  readonly actorRoles: readonly string[];
  /** Justification recorded in the audit trail; min 8 characters. */
  readonly reason: string;
  readonly correlationId?: string;
}

export interface GateMetrics {
  readonly evaluations: number;
  readonly failedEvaluations: number;
  readonly overrides: number;
  readonly deniedOverrides: number;
  readonly rejectedInputs: number;
}

export type GateLogLevel = 'info' | 'warn';

/** Structured, secret-free log line; payloads carry ids and counts only. */
export interface GateLogEvent {
  readonly level: GateLogLevel;
  readonly code: string;
  readonly at: number;
  readonly releaseId: string;
  readonly message: string;
}

export interface CompatibilityGateConfig {
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Roles allowed to waive a failing gate (default below). */
  overrideRoles?: readonly string[];
  /** Default policy for evaluations that do not specify one. */
  defaultPolicy?: GatePolicy;
  /** Structured, secret-free log sink. */
  log?: (event: GateLogEvent) => void;
}

export type CompatibilityGateErrorCode =
  | 'INVALID_INPUT'
  | 'MALFORMED_CONTRACT_ARTIFACT'
  | 'MALFORMED_API_SPEC'
  | 'GATE_FAILED'
  | 'OVERRIDE_DENIED'
  | 'NOTHING_TO_WAIVE';

/**
 * Thrown for malformed candidate input, unauthorized overrides, and explicit
 * `assertPass` failures. Untrusted input never yields a silent pass.
 */
export class CompatibilityGateError extends Error {
  constructor(
    public readonly code: CompatibilityGateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CompatibilityGateError';
  }
}
