# Mainnet Operations and Governance

This module implements the mainnet operations controls for BridgeWise:

| Feature | Issue | Entry point |
| --- | --- | --- |
| Chain outage response playbooks | [#1378](https://github.com/MDTechLabs/BridgeWise/issues/1378) | `ChainOutagePlaybookService` |
| Signer availability readiness checks | [#1379](https://github.com/MDTechLabs/BridgeWise/issues/1379) | `SignerAvailabilityReadinessService` |
| Controlled feature rollout by chain | [#1380](https://github.com/MDTechLabs/BridgeWise/issues/1380) | `ChainFeatureRolloutService` |
| Mainnet canary transfer procedure | [#1381](https://github.com/MDTechLabs/BridgeWise/issues/1381) | `MainnetCanaryTransferService` |
| Cross-boundary coordination | #1378-#1381 | `MainnetOperationsCoordinator` |

All state is process-local and dependency-injected. Signing material stays
behind the `CanaryTransferDependencies.submit` boundary, and signer probes only
report liveness, latency, and opaque reason codes.

## Configuration surface

### Chain outage playbooks (#1378)

Register one playbook per `chain` + `outageType` pair:

```ts
const outages = new ChainOutagePlaybookService({ loadDefaults: true });
outages.registerPlaybook({
  id: 'stellar-mainnet-rpc-unavailable',
  chain: 'stellar-mainnet',
  outageType: 'rpc_unavailable',
  severity: 'sev1',
  summary: 'Stellar RPC unavailable',
  steps: [
    {
      id: 'pause',
      order: 1,
      title: 'Pause Stellar routes',
      ownerRole: 'oncall-engineer',
      slaSeconds: 180,
      required: true,
      action: 'pause_routes',
    },
  ],
  escalation: {
    primaryRole: 'oncall-engineer',
    secondaryRole: 'bridge-ops-lead',
    notifyAfterSeconds: 600,
  },
  recovery: {
    signals: ['rpc_healthy', 'routes_reopened'],
    observationWindowSeconds: 900,
  },
});
```

`DEFAULT_CHAIN_OUTAGE_PLAYBOOKS` ships playbooks for `stellar-mainnet`,
`ethereum-mainnet`, and `arbitrum-mainnet`. Pass `{ loadDefaults: false }` for
isolated deployments and `{ replace: true }` to override a playbook.

Incidents are opened with `openIncident({ chain, outageType, openedBy,
detectionSource, dedupeKey? })`. Opening is idempotent per chain + outage type +
dedupe key while an incident is active. Steps must be started in order;
required steps cannot be skipped. Starting a step with an `action` emits
`automatic_action` and records the action name in the incident audit.
`resolveIncident` requires every required step to be completed **and** every
`recovery.signals` entry to be supplied. `isChainBlocked` returns true for
active `sev1`/`sev2` incidents.

### Signer readiness (#1379)

```ts
const signers = new SignerAvailabilityReadinessService(probe, {
  timeoutMs: 2000,
});
signers.registerRequirement({
  chain: 'stellar-mainnet',
  signerIds: ['signer-a', 'signer-b', 'signer-c'],
  minAvailable: 2,
  maxLatencyMs: 200,
});
```

`checkChain(chain)` probes all configured signers concurrently. A signer is:

- `ready` when reachable within `maxLatencyMs`;
- `degraded` when reachable but slower than `maxLatencyMs`;
- `unavailable` when it reports unavailable, throws, or exceeds `timeoutMs`.

The chain is `ready` when ready signers meet `minAvailable`, `degraded` when
only the ready + degraded total meets it, and `unavailable` otherwise.
`assertReady(chain)` throws `SignerReadinessError` with the full report for
fail-closed submission paths. Probe failures are reduced to safe codes
(`probe_timeout`, `probe_error`, sanitized `reasonCode`).

### Chain feature rollout (#1380)

```ts
const rollouts = new ChainFeatureRolloutService({ maxStepIncrease: 25 });
rollouts.defineFeature({
  key: 'soroban-settlement-v2',
  updatedBy: 'release-manager',
  chains: [
    { chain: 'stellar-mainnet', percentage: 5, allowlist: ['release-bot'] },
    { chain: 'ethereum-mainnet', percentage: 0 },
  ],
});
rollouts.setChainRollout('soroban-settlement-v2', 'stellar-mainnet', 25, 'release-manager');
```

Evaluation is fail-closed and returns a `RolloutDecision` with an auditable
reason: `unknown_feature`, `feature_disabled`, `feature_paused`,
`chain_not_targeted`, `chain_percentage_zero`, `cohort_excluded`,
`allowlisted`, or `enabled`.

Cohorts are assigned by FNV-1a hash of `featureKey:subjectId`, so the same
subject always receives the same treatment across processes and restarts.
Allowlisted subjects bypass the percentage gate, including 0%. Percentage
increases are limited to `maxStepIncrease` (default 25); reductions are always
allowed. Use `addChainTarget` before `setChainRollout` for a new chain, and
`{ force: true }` only for audited break-glass expansion. Every mutation is
recorded in `getSnapshot(featureKey).audit`.

### Mainnet canary transfer (#1381)

```ts
const canaries = new MainnetCanaryTransferService();
canaries.registerChainPolicy({
  chain: 'stellar-mainnet',
  assets: ['USDC'],
  maxAmount: '0.05',
  requiredConfirmations: 2,
  timeoutMs: 300000,
});

const result = await canaries.run(
  {
    canaryId: 'canary-stellar-usdc-2026-10-19',
    chain: 'stellar-mainnet',
    routeId: 'route-stellar-ethereum',
    asset: 'USDC',
    amount: '0.01',
    destination: 'G...',
    requestedBy: 'release-manager',
  },
  { submit, getConfirmations, verifySettlement },
);
canaries.authorizeFullRollout(result.record.canaryId);
```

Only registered chain policies are accepted. Amounts are compared as fixed
18-decimal integers (no float rounding) against the per-chain cap. Plans may
raise `requiredConfirmations` (up to 1,000) and lower `timeoutMs` (up to the
policy value), but cannot weaken either policy bound.

`run` is idempotent per `canaryId`: a stored outcome, including a failure, is
returned without resubmitting, and concurrent replays share one in-flight
promise. A second active canary on the same route is blocked. Records expose
`destinationMasked`, never the full destination. `authorizeFullRollout` throws
unless the canary is `confirmed`.

### Coordinator

`MainnetOperationsCoordinator.assessChain(chain, { featureKey?, subjectId? })`
combines active incidents, signer readiness, and an optional rollout decision.
Missing signer readiness configuration is treated as not operational.

`runCanary(plan, dependencies)` re-checks outage and signer state at submission
time and invokes the canary service with an internal guard, closing the window
between assessment and execution. Any extra guard is combined with AND
semantics.

## Failure semantics

| Condition | Result |
| --- | --- |
| Active sev1/sev2 incident | `assessChain.operational = false`; canary denied with `chain_outage` |
| No signer requirement | `assessChain.operational = false`; canary denied with `signer_readiness_not_configured` |
| Signer below quorum | Chain `unavailable`; canary denied with `signer_readiness_unavailable` |
| Slow quorum | Chain `degraded`; canary denied with `signer_readiness_degraded` |
| Unknown/paused/untargeted feature | Decision disabled with a named reason |
| Amount above cap | Canary `blocked` with `amount_exceeds_cap`, no submission |
| Duplicate active canary on route | Canary `blocked` with `duplicate_active_canary` |
| Submit throws | Canary `failed` with `submission_failed`; no retry on same id |
| Confirmations never reach target | Canary `failed` with `confirmation_timeout` |
| Settlement verification false | Canary `failed` with `verification_failed` |
| Previous canary failed | `authorizeFullRollout` throws; rollout must not advance |

## Observability and secret handling

- Logs include chain, feature key, canary id, route id, counts, and reason
  codes only. Destinations, signed payloads, private keys, and access tokens are
  never logged.
- Canary records mask destinations and sanitize error codes before storing them.
- Signer reports contain no key material or public keys, only signer ids,
  latency, status, and reason codes.
- Incident and rollout mutations are auditable through copies returned by
  `getIncident`, `listIncidents`, `getSnapshot`, and `getAuditTrail`.

## Verification

```bash
npx jest src/operations/mainnet --runInBand
npx tsc --noEmit -p tsconfig.json
npx eslint src/operations/mainnet
```

The integration suite (`mainnet-operations.coordinator.spec.ts`) exercises the
combined lifecycle: outage opening, signer quorum checks, canary denial and
recovery, confirmed canary authorization, bounded rollout expansion, and chain
isolation. All dependency failures in tests are deterministic; no live RPC,
network, or signing service is required.
