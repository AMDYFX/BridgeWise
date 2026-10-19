# Release Compatibility Gate for Contract and API

Related issue: [#1384](https://github.com/MDTechLabs/BridgeWise/issues/1384)
Code: `src/release/compatibility-gate/`

## Purpose

The last automated check before a release ships. A release candidate carries,
per contract, its baseline and candidate ABI (Hardhat/Foundry artifact or bare
ABI array), plus optionally the baseline/current OpenAPI documents. The gate
diffs both surfaces under a policy and returns:

- a **verdict** (`pass` / `fail`) with aggregate and per-check findings,
- **reproducible evidence** — canonical SHA-256 hashes of every input section
  so auditors can re-derive exactly what was gated,
- an **audit trail** for the only privileged escape hatch: a release-manager
  waiver of a failing report.

## Public interfaces

`ReleaseCompatibilityGate` (`src/release/compatibility-gate/release-compatibility-gate.service.ts`):

| Method | Behavior |
| --- | --- |
| `evaluate(candidate, policy?)` | Run contract + API checks; store and return a `GateReport`. |
| `getReport(releaseId)` | The stored report (post-waiver state included). |
| `assertPass(report)` | Throws `GATE_FAILED` unless `verdict === 'pass'` — the CI entry point. |
| `override(input)` | Waive a failing report (release-manager/admin role + justification, audited). |
| `formatReport(report)` | Human-readable evidence block for CI logs. |
| `metrics()` | evaluations, failedEvaluations, overrides, deniedOverrides, rejectedInputs. |

Contract-level helpers are exported separately
(`contract-abi-compatibility.ts`): `normalizeContractAbi` (validates and
canonicalizes an untrusted artifact) and `checkContractCompatibility`
(validate + diff in one call).

### Candidate shape

```ts
gate.evaluate(
  {
    releaseId: 'v2026.11.0',
    contracts: [{ name: 'BridgeVault', baseline: baselineArtifact, candidate: candidateArtifact }],
    api: { baseline: baselineOpenApiDoc, candidate: currentOpenApiDoc },
  },
  { failOnBreaking: true, failOnWarnings: false, allowDeprecatedRemoval: false, allowBreakingOnMajorBump: false },
);
```

## Contract rule catalogue (upgrade implications)

| Rule | Severity | Upgrade implication |
| --- | --- | --- |
| `function-removed` | breaking | Existing callers revert. |
| `function-inputs-changed` | breaking | Selector changes; old selector no longer exists. |
| `function-outputs-changed` | breaking | Callers fail to decode results. |
| `function-payable-removed` | breaking | Value-sending calls revert. |
| `function-mutability-relaxed` (view/pure → state-changing) | warning | Read-only callers now send transactions. |
| `function-payable-added`, `function-mutability-tightened` | info | Additive; calls remain valid. |
| `function-added` | info | New surface. |
| `event-removed` / `event-inputs-changed` / `event-anonymous-changed` | breaking | Indexers and relayers mis-decode or stop receiving logs. |
| `event-added` | info | — |
| `error-removed` | warning | Clients see generic reverts instead of typed errors. |
| `error-added` | info | — |
| `constructor-removed` / `constructor-inputs-changed` | breaking | Deployment/upgrade scripts fail. |
| `constructor-added` | warning | Scripts must pass new arguments. |
| `fallback-changed` | warning | Plain transfers may start or stop executing code. |

Tuple parameters are compared component-by-component (`type: 'tuple'` with
`components` is expanded to the canonical `(type1,type2)` form).

## API half

Delegates to the existing OpenAPI backward-compatibility checker
(`apps/api/src/openapi/openapi-compatibility-checker.ts`) and layers the gate
policy on top. `document-invalid` (a malformed OpenAPI document) stays a
failure even under lenient policies — an unverifiable API contract cannot
pass.

## Failure semantics (fail closed)

| Condition | Result |
| --- | --- |
| Any breaking finding (default policy) | `verdict: 'fail'` |
| Warnings with `failOnWarnings: true` | `verdict: 'fail'` |
| Malformed contract artifact (ABI not an array, bad entry, bad tuple, duplicate signatures) | throws `CompatibilityGateError('MALFORMED_CONTRACT_ARTIFACT')`; no report stored — never a silent skip |
| Candidate with no contracts and no API | throws `'INVALID_INPUT'` |
| Bad release id / contract name | throws `'INVALID_INPUT'` |
| `assertPass()` on a failing report | throws `'GATE_FAILED'` |
| `override()` without a stored report | throws `'INVALID_INPUT'` |
| `override()` on a passing or already-waived report | throws `'NOTHING_TO_WAIVE'` |
| `override()` without a release-manager/admin role | throws `'OVERRIDE_DENIED'`; audit `attempted → denied`; verdict unchanged |

A waived report keeps all of its original findings (auditors see what was
acknowledged) and records `{ by, reason, at, waivedFindings }`.

## Gas and resource impact

The gate is a **static, off-chain check**: it reads JSON documents and never
submits transactions, so it consumes no gas and changes no on-chain state.
Deployed bytecode is accepted as evidence but never gates a release (bytecode
churn is expected for any change). The *findings* the gate raises are exactly
the upgrade implications an operator must review before deploying a new
contract version or shipping a new API build.

## Reproducible verification evidence

Every report carries `evidence.releaseInputHash` and per-section
`sectionHashes` (SHA-256 over canonicalized JSON with sorted keys). The same
candidate, policy, and release id always produce the same hashes; `formatReport`
prints them into CI logs alongside the findings.

## Security and audit notes

- `override()` is the only privileged action; it is written to the privileged
  action audit log (`configuration` category) attempt-first, with the actor,
  roles, justification, and acknowledged finding counts.
- Logs and metrics carry release ids, rule ids, and counts only — never the
  ABI contents or API documents.
- Contract-level invariants: malformed input is rejected (never skipped), a
  failing verdict cannot leave the gate except through the role-checked,
  audited waiver, and evidence hashes make the evaluated inputs re-derivable.

## Tests

`src/release/compatibility-gate/release-compatibility-gate.spec.ts`
(17 tests, deterministic fixtures):

```bash
pnpm exec jest --runInBand --runTestsByPath \
  src/release/compatibility-gate/release-compatibility-gate.spec.ts \
  --moduleFileExtensions ts json js
```
