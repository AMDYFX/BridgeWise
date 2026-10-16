# Audit Log Retention Controls

`StellarTransferAuditAPI` applies separate retention periods to in-memory transfer audit records and generated exports. Both default to 90 days and must be positive whole numbers. Configure `auditLogRetentionDays` and `exportRetentionDays` when constructing the API; cleanup removes entries whose age is at least the configured period.

Call `cleanupExpiredData()` from the host application's scheduled maintenance job. It returns `{ auditLogs, exports }` removal counts for metrics. `cleanupExpiredAuditLogs()` and `cleanupExpiredExports()` are also available when the policies need separate scheduling. Removing an audit record also removes its transfer and address index references.

```ts
const audit = new StellarTransferAuditAPI({
  auditLogRetentionDays: 180,
  exportRetentionDays: 7,
});

const removed = audit.cleanupExpiredData();
metrics.increment(
  'audit_retention_removed',
  removed.auditLogs + removed.exports,
);
```

## Dependencies and limitations

- The current service stores audit records and export data in process memory. Retention runs only when its cleanup method is called; this module does not start a timer or persist cleanup across restarts.
- A database-backed audit adapter must enforce equivalent deletion in its persistent store and indexes. In-memory cleanup alone is not a database retention control.
- The host process must schedule cleanup at an interval appropriate for the configured policy and export the returned counts to its metrics/logging system.
- Keep retention periods aligned with legal, contractual, and incident-response requirements. Deletion is permanent in this in-memory service; export required evidence before its expiry.

## Troubleshooting

- **Cleanup removes nothing:** confirm the maintenance job is running and compare the injected/current clock with record timestamps. Expiry is inclusive at the retention boundary.
- **Constructor rejects configuration:** each period must be a positive integer number of days; zero, negative, fractional, `NaN`, and infinity are rejected.
- **Old records remain in a persistent store:** this in-memory implementation cannot purge external storage. Add the deletion policy to the owning adapter and verify indexes are cleaned transactionally.

Unit coverage: `src/audit/transfers/stellar/audit.service.spec.ts` checks boundary expiry, index cleanup, combined cleanup counts, and invalid periods.
