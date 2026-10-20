# Emergency Route Disablement with Audit

Related issue: [#1383](https://github.com/MDTechLabs/BridgeWise/issues/1383)
Code: `src/routing/emergency/`

## Purpose

Break-glass switch for the routing boundary. When a route looks unsafe
(exploited bridge contract, poisoned liquidity, compromised relayer), an
operator stops new executions on it **now**, without waiting for governance —
and the incident record writes itself.

Asymmetric by design:

- **Disabling is cheap** — any actor holding a `disableRoles` role.
- **Restoring is expensive** — only `restoreRoles` (admin/governance).
- **Everything is audited** — `emergency.route.disable` / `emergency.route.restore`
  entries in the privileged action audit log, attempted-entry-first.

## Public interfaces

`EmergencyRouteDisableService` (`src/routing/emergency/emergency-route-disable.service.ts`):

| Method | Behavior |
| --- | --- |
| `disableRoute(input)` | Disable a route. Returns `{ record, alreadyDisabled }`. |
| `restoreRoute(input)` | Re-enable. Requires an elevated role. Returns `{ restored, ... }`. |
| `isRouteDisabled(routeId, at?)` | Router read path: true while disabled and unexpired. |
| `getActiveDisable(routeId, at?)` | The active disable record, if any. |
| `listDisabledRoutes(filter?)` | Active (default) or historical records, filterable by corridor and incident id. |
| `getAuditTrail(routeId)` | Full per-route emergency audit trail, oldest first. |
| `getRestoreHistory()` | Append-only restore history for incident review. |

`EmergencyDisableInput` fields: `routeId`, `actor`, `actorRoles`, `reason`
(min 8 chars), optional `sourceChain`/`destinationChain` (corridor scope),
`incidentId`, `ttlMs`, `correlationId`.

## Configuration

```ts
new EmergencyRouteDisableService(privilegedActionAuditLog, {
  now: () => Date.now(),                 // injectable clock (tests)
  disableRoles: ['operator', 'emergency-operator', 'incident-commander', 'admin'],
  restoreRoles: ['admin', 'governance'],
  maxActiveDisables: 100,                // capacity guard
  minReasonLength: 8,
  maxReasonLength: 512,
  maxRouteIdLength: 128,
  onStateChange: (event) => router.applyEmergencyState(event), // integration hook
});
```

## Behavior and failure semantics

| Condition | Result |
| --- | --- |
| Valid disable request | record created; audit `attempted → success`; `route-disabled` event |
| Replay of an active disable (same corridor) | idempotent: same record, `requestCount`/`version` bumped, audit `success` with "idempotent replay", `disable-replayed` event — **no second disable** |
| Replay for a different corridor | throws `'CHAIN_MISMATCH'`; audit `denied`; active record untouched |
| Actor without a disable role | throws `'UNAUTHORIZED'`; audit `attempted → denied`; route stays live |
| Malformed input (empty routeId, short reason, control characters, bad `ttlMs`, bad chain ids, empty actor/incident) | throws `'INVALID_INPUT'` **before** any state change or audit entry |
| Active disable cap reached | throws `'LIMIT_EXCEEDED'`; audit `denied` |
| Actor without a restore role (including the operator who disabled it) | throws `'UNAUTHORIZED'`; audit `denied` — the disable stays active |
| Restore of a non-disabled route | successful no-op `{ restored: false, code: 'NOT_DISABLED' }`, still audited |
| TTL expiry | lazy: stops matching when `now >= expiresAt`; record remains queryable with `activeOnly: false` until restored or superseded |

## Integration notes

- **Router/execution boundary:** consult `isRouteDisabled()` before offering
  a route, or subscribe to `onStateChange` (`route-disabled`,
  `disable-replayed`, `route-restored`) and mirror the state into the
  execution pause boundary (`src/execution/pause/`).
- **Chain-specific behavior:** the disable record carries the corridor scope;
  a corridor-scoped disable never silently answers a request for another
  corridor (`CHAIN_MISMATCH`).
- **Recovery/escalation:** TTL'd disables self-expire (safe default for
  suspected-but-unconfirmed incidents); permanent disables require a
  governance-role restore, which is exactly the escalation path.
- **Idempotency:** replay-safe by design — retried automation and multiple
  operators reporting the same incident converge on one record.
- **Audit:** attempt-first ordering means a disable can never take effect
  without leaving a trace, and `getAuditTrail()` gives the per-route incident
  record (integrity-verifiable via `audit.verifyIntegrity()`).

## Security notes

- The audit log's built-in sanitizer redacts secret-like param keys; the
  service only passes ids, reasons, chain ids, and counts — never payloads.
- Reasons and ids are control-character-stripped and length-capped.

## Tests

`src/routing/emergency/emergency-route-disable.spec.ts` (17 tests,
deterministic clock):

```bash
pnpm exec jest --runInBand --runTestsByPath \
  src/routing/emergency/emergency-route-disable.spec.ts \
  --moduleFileExtensions ts json js
```
