# Reserve Reconciliation Gap Alerts

`ReserveReconciliationService` compares reported reserves with expected book balances using precision-safe decimal arithmetic. It emits one `ReserveReconciliationGapAlert` through the optional `onGap` callback whenever any asset is not within tolerance. The payload includes the timestamp, complete report, all gaps, and severity. Exact-match tolerance remains the default.

Shortfalls, missing reported balances, and invalid data are `critical`; surplus-only or missing-expected gaps are `warning`. No alert is emitted when every asset is balanced or within the configured tolerance.

```ts
const reconciliation = new ReserveReconciliationService({
  onGap: (alert) => alertQueue.enqueue('reserve-gap', alert),
  onAlertError: (error) => metrics.increment('reserve_alert_delivery_failures'),
});

const report = reconciliation.reconcile({ reported, expected });
```

Keep the callback fast and non-blocking by enqueueing to the notification system. If `onGap` throws without an `onAlertError` handler, reconciliation throws so alert-delivery failure is not silently lost. If an error handler is supplied and returns normally, the reconciliation report is still returned; an error handler that throws also propagates.

## Dependencies

- Upstream dependencies are the reported on-chain/custodian balances and expected ledger/accounting balances supplied by the caller. Their source identifiers and `asOf` timestamps should be retained by the caller so stale or mismatched inputs can be diagnosed.
- Downstream alert delivery is intentionally injected. Connect `onGap` to a queue, paging system, or operational event bus; this library does not ship an alert transport or scheduler.
- The alert callback receives reserve amounts. Treat payloads as operationally sensitive and apply the same access controls and retention policy as accounting records.

## Troubleshooting

- **No alert for a small difference:** inspect `appliedTolerance`; values within either configured tolerance band are balanced by design.
- **A gap has critical severity:** investigate shortfall, absent reported balance, or malformed amount before settlement or payout. `report.assets` identifies every asset and its status.
- **Alert delivery errors:** monitor the `onAlertError` counter/event and check the downstream queue or notifier. The original report remains available when the error handler returns.
- **Results look stale:** compare the input `asOf` timestamps and refresh the upstream balance providers; the service does not fetch balances itself.

Unit coverage: `src/reconciliation/reserves/reserve-reconciliation.service.spec.ts` covers severity, batching, tolerance boundaries, and alert callback failures.
