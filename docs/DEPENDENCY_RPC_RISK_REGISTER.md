# Dependency and RPC Provider Risk Register

Related issue: [#1382](https://github.com/MDTechLabs/BridgeWise/issues/1382)
Code: `src/providers/risk-register/`

## Purpose

The register is the operator-facing inventory of everything the routing and
execution platform leans on but does not control: npm packages, SDKs,
oracles, and the RPC providers that answer chain queries. It answers two
questions **before** something breaks:

1. *What is at high/critical operational risk right now?* (scored, explained)
2. *If this entry fails, what goes down with it?* (provider exposure links)

## Public interfaces

`DependencyRpcRiskRegister` (`src/providers/risk-register/dependency-rpc-risk-register.service.ts`):

| Method | Behavior |
| --- | --- |
| `register(input, ctx?)` | Register a `dependency` or `rpc-provider` entry. Rejects duplicates and malformed input. |
| `update(id, patch, ctx?)` | Patch mutable risk attributes of a live entry. |
| `retire(id, actor, reason, ctx?)` | Retire an entry (idempotent). Requires an attributable actor. |
| `recordFailure(input)` | Record an observed/simulated failure. Idempotent by `eventId`. |
| `getFailureHistory(id, limit?)` | Newest-first failure history for an entry. |
| `score(id, at?)` | Deterministic 0–100 risk score with a factor breakdown. |
| `assess(at?)` | Register-wide report: worst-first, high-risk, single points of failure, dangling fallbacks, provider exposure. |
| `linkProvider(providerId, entryIds)` / `providersAffectedBy(entryId)` | Routing-boundary links: which providers lean on which entries. |
| `listEntries(filter?)` / `getEntry(id)` / `hasEntry(id)` | Queries. |
| `metrics()` | Counters: registered, retired, failure events, duplicates, assessments, rejected inputs. |

Entry ids must match `^[a-z0-9][a-z0-9._-]{1,63}$`.

## Scoring (deterministic and explained)

Score = sum of factor contributions, clamped to 0–100. Levels: `critical ≥ 75`,
`high ≥ 50`, `medium ≥ 25`, else `low`.

| Factor | Max points | Value |
| --- | --- | --- |
| criticality | 35 | critical 35, high 26, medium 15, low 6 |
| trust-model | 20 | single-vendor 20, third-party-managed 12, self-hosted 6, multi-vendor 4 |
| fallback-coverage | 20 | none 20, one fallback 8, two or more 0 |
| status | 18 | suspended 18, degraded 10, active 0 |
| recent-failures | 20 | 4 points per failure event inside the window (default 24 h), capped |
| verification-staleness | 8 | 8 when the last failure is older than the freshness window (default 7 d) |

The same entry state and clock always produce the same score, and every point
is attributable to a `RiskFactor` (`id`, `weight`, `contribution`, `detail`).

## Configuration

```ts
new DependencyRpcRiskRegister(
  {
    now: () => Date.now(),        // injectable clock (tests)
    failureWindowMs: 86_400_000,  // scoring window (default 24 h)
    staleAfterMs: 604_800_000,    // staleness threshold (default 7 d)
    maxFailureEvents: 1000,       // bounded retention, oldest evicted
    log: (event) => logger[event.level](`${event.code} ${event.entryId ?? ''} ${event.message}`),
  },
  privilegedActionAuditLog,       // optional; registers `configuration` entries
);
```

## Failure semantics

| Condition | Result |
| --- | --- |
| Malformed entry (bad id/enums/label, credential-bearing endpoint, >20 fallbacks) | throws `RiskRegisterError('INVALID_ENTRY')`; nothing stored |
| Duplicate entry id | throws `'DUPLICATE_ENTRY'` |
| Unknown entry id | throws `'ENTRY_NOT_FOUND'` |
| Failure event for an unknown entry / bad timestamp / short reason | throws `'INVALID_FAILURE_EVENT'` |
| Replay of a recorded `eventId` | returns `{ recorded: false, duplicate: true }`; no state change |
| `update`/`retire` on a retired entry | `'ENTRY_RETIRED'` (update) / no-op success (retire) |
| Retire without an actor | throws `'INVALID_ACTOR'` |

Recording a failure flips an `active` entry to `degraded` so status-driven
scoring reacts immediately.

## Security and operational notes

- **Entries are untrusted input.** Endpoint references must be bare hosts or
  http(s) origins — credentials in the URL, query strings (API keys), and
  fragments are rejected outright, so secrets never enter the register.
- **Metadata is stored sanitized** via the privileged-audit sanitizer
  (secret-ish keys redacted, depth/size capped).
- **Logs and audit params carry ids, codes, and counts only** — never hosts,
  metadata payloads, or raw caller text.
- **Integration:** `providersAffectedBy()`/`linkProvider()` connect the
  register to the provider fleet; `src/providers/health/` (dependency graph)
  remains the live-health source and can feed `recordFailure()`.

## Tests

`src/providers/risk-register/dependency-rpc-risk-register.spec.ts`
(33 tests, deterministic clock):

```bash
pnpm exec jest --runInBand --runTestsByPath \
  src/providers/risk-register/dependency-rpc-risk-register.spec.ts \
  --moduleFileExtensions ts json js
```
