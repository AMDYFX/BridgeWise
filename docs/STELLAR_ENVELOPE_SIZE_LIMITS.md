# Stellar Transaction Envelope Size Limits

## Overview

`StellarTransactionEnvelopeSizeLimiter` validates a Stellar transaction
envelope against per-network policy before it is signed or submitted. It rejects
envelopes that cannot succeed on-chain, that target the wrong network, or that
would consume more resources than the operator allows.

Location: `src/stellar/transactions/envelope/`

The limiter is dependency-free and treats all chain/RPC responses as untrusted
inputs. It never accepts raw signing material, private keys, or access tokens.

## Public Interface

```ts
import {
  StellarTransactionEnvelopeSizeLimiter,
  createDefaultEnvelopePolicies,
} from './src/stellar/transactions/envelope';

const limiter = new StellarTransactionEnvelopeSizeLimiter({
  policies: createDefaultEnvelopePolicies(),
});

// Synchronous, local policy evaluation.
const result = limiter.check({
  network: 'stellar-testnet',
  networkPassphrase: 'Test SDF Network ; September 2015',
  envelopeXdr: '<base64 envelope XDR>',
  sequence: '123456789',
  operationCount: 2,
  memoBytes: 16,
  reference: 'quote-42',
  idempotencyKey: 'route-42-attempt-1',
});

// Optional RPC passphrase verification boundary.
const verified = await limiter.checkWithRpc(
  { network: 'stellar-testnet', envelopeXdr: '<base64 envelope XDR>' },
  { getNetworkPassphrase: () => rpc.getNetworkPassphrase() },
);

if (!verified.allowed) {
  // report verified.violations (codes are stable)
}
```

### Result

| Field           | Meaning                                             |
| --------------- | --------------------------------------------------- |
| `allowed`       | `true` only when no error-severity violations exist |
| `envelopeBytes` | Decoded XDR size, or `null` when unknown            |
| `limitBytes`    | Applied network limit, or `null` when unconfigured  |
| `utilization`   | `envelopeBytes / limitBytes` (0–1+)                 |
| `fingerprint`   | Stable FNV-1a fingerprint used for dedupe/audit     |
| `violations`    | Stable codes, severity, human-readable message      |
| `cached`        | `true` when served from the idempotency cache       |
| `evaluatedAt`   | Evaluation timestamp (epoch ms)                     |

## Configuration

```ts
interface StellarEnvelopePolicy {
  network: string; // e.g. "stellar-testnet"
  networkPassphrase: string; // required identity check
  maxEnvelopeBytes: number; // decoded XDR bytes
  warningThresholdBytes?: number; // warn-only, must be <= max
  maxOperations?: number; // default 100 (protocol limit)
  maxMemoBytes?: number; // default 28 (protocol limit)
  maxSorobanTransactionDataBytes?: number;
  requireSimulation?: boolean; // default false
}

interface StellarEnvelopeSizeLimiterConfig {
  policies: StellarEnvelopePolicy[];
  allowUnlistedNetworks?: boolean; // default false (deny unknown networks)
  requireNetworkPassphrase?: boolean; // default true
  onRpcFailure?: 'deny' | 'allow'; // default 'deny'
  duplicatePolicy?: 'deny' | 'warn'; // default 'deny'
  dedupeWindowMs?: number; // default 300_000 (5 minutes)
  now?: () => number; // injectable clock
  audit?: { record(event): void }; // secret-free audit sink
}
```

`createDefaultEnvelopePolicies()` configures `stellar-public`, `stellar-testnet`,
and `stellar-futurenet` with the canonical passphrases and a 100 KiB envelope
limit. The limit is network policy, not a permanent protocol constant: pin
`maxEnvelopeBytes` to the value published for the target network and update it
when the network upgrades its ledger configuration.

Unknown networks are denied by default. If `allowUnlistedNetworks` is enabled,
evaluation continues with a `NETWORK_NOT_CONFIGURED` warning and no size cap.

## Checks

1. **Network identity** — the request passphrase must equal the configured
   passphrase. Missing passphrases are denied unless explicitly disabled.
2. **Envelope size** — `envelopeXdr` is strict canonical base64; decoded size is
   compared with `maxEnvelopeBytes`. `envelopeBytes` may be supplied directly
   but must agree with the decoded XDR. Exactly at the limit is allowed.
3. **Sequence** — must be a positive int64 sequence (`> 0`, `<= 2^63-1`).
4. **Resources** — operation count (`1..100` by default), memo bytes, and
   optional Soroban transaction-data bytes.
5. **Simulation** — an unsafe `SimulationCheckResult` (from
   `StellarTransactionSimulationChecker`) denies submission; policies may
   require simulation entirely.
6. **Duplicates/idempotency** — an accepted fingerprint seen again inside
   `dedupeWindowMs` is flagged `DUPLICATE_ENVELOPE` (deny by default). The same
   `idempotencyKey` returns the original decision with `cached: true`.

## Failure Semantics

| Situation                                  | Decision        | Code                                                                          |
| ------------------------------------------ | --------------- | ----------------------------------------------------------------------------- |
| Unknown network                            | deny            | `NETWORK_NOT_CONFIGURED`                                                      |
| Missing passphrase                         | deny            | `NETWORK_PASSPHRASE_MISSING`                                                  |
| Wrong passphrase                           | deny            | `NETWORK_PASSPHRASE_MISMATCH`                                                 |
| Size missing/unparseable                   | deny            | `ENVELOPE_SIZE_MISSING`, `INVALID_ENVELOPE_ENCODING`, `INVALID_ENVELOPE_SIZE` |
| Size over limit                            | deny            | `ENVELOPE_TOO_LARGE`                                                          |
| At/above warning threshold                 | allow + warning | `ENVELOPE_NEAR_LIMIT`                                                         |
| Invalid sequence                           | deny            | `INVALID_SEQUENCE`, `SEQUENCE_OUT_OF_RANGE`                                   |
| Too many operations                        | deny            | `TOO_MANY_OPERATIONS`                                                         |
| Memo/Soroban data too large                | deny            | `MEMO_TOO_LARGE`, `SOROBAN_DATA_TOO_LARGE`                                    |
| Simulation failed or missing when required | deny            | `SIMULATION_REJECTED`, `SIMULATION_REQUIRED`                                  |
| RPC passphrase lookup failed               | deny (default)  | `RPC_UNAVAILABLE`                                                             |
| RPC returned malformed data                | deny            | `RPC_RESPONSE_INVALID`                                                        |
| RPC failed with `onRpcFailure: 'allow'`    | allow + warning | `NETWORK_UNVERIFIED`                                                          |
| Duplicate envelope                         | deny (default)  | `DUPLICATE_ENVELOPE`                                                          |

The limiter fails closed. Operators can opt into `onRpcFailure: 'allow'` only
when a separate passphrase source is already trusted.

## Observability and Audit

- `check()` is pure policy evaluation; wall-clock use is limited to dedupe and
  audit timestamps and can be injected with `now`.
- `getMetrics()` exposes `evaluations`, `allowed`, `denied`, `duplicates`, and
  `rpcFailures` counters.
- `getStatus(network)` exposes the active limit and resource policy for
  monitoring.
- Audit events contain only network, decision, fingerprint, sizes, violation
  codes, optional reference/idempotency key, and timestamp. Raw envelopes,
  passphrases, keys, and transaction payloads are never logged.
- `reset()` clears caches and metrics for restarts or tests.

## Recovery and Escalation

- `ENVELOPE_TOO_LARGE` — rebuild the transaction with fewer operations or a
  smaller Soroban footprint/contract arguments; never retry the same envelope.
- `NETWORK_PASSPHRASE_MISMATCH` — treat as a configuration error: confirm the
  signing network configuration and RPC endpoint before retrying.
- `RPC_UNAVAILABLE` — retry with backoff; if the outage persists, escalate to
  the on-call operator. Do not switch `onRpcFailure` to `allow` during an
  incident without an independent passphrase source.
- `DUPLICATE_ENVELOPE` — return the original decision to the caller; if a new
  attempt is intended, build a new envelope (new sequence) and use a new
  idempotency key.
- `SIMULATION_REJECTED` — inspect the failing simulation codes, adjust the
  transaction, and re-simulate. Do not bypass with a manual signature.

## Tests

- Unit: `src/stellar/transactions/envelope/stellar-transaction-envelope-size-limiter.spec.ts`
- Integration (RPC + simulation boundaries):
  `tests/stellar/transactions/envelope/stellar-transaction-envelope-size-limiter.integration.spec.ts`

All fixtures are synthetic and deterministic; no production keys or live
network state are used.
