# Incident Evidence Export

`StellarTransferAuditAPI.exportIncidentEvidence()` creates a JSON evidence bundle from audit entries in a caller-specified time window, optionally restricted to transfer IDs. It returns an `IncidentEvidenceExportResult` that can be fetched through the existing `getExport()` API until its `exportRetentionDays` deadline.

```ts
const evidence = await auditApi.exportIncidentEvidence({
  incidentId: 'INC-2026-0042',
  requestedBy: authenticatedOperator.id,
  startTime: incidentStartMs,
  endTime: incidentEndMs,
  transferIds: affectedTransferIds,
});

const bundle = JSON.parse(evidence.data as string);
if (!verifyIncidentEvidenceBundle(bundle)) {
  throw new Error('Incident evidence integrity check failed');
}
```

The bundle contains schema version, incident ID, generation time, query window, record count, redacted audit entries, and a SHA-256 digest over a canonical serialization. It omits raw addresses and amounts, actor names, arbitrary `details`/`metadata`, and provider error strings. Address fields are represented by SHA-256 fingerprints; EVM transaction hashes are shortened and other transaction identifiers are fingerprinted. This supports correlation while reducing unnecessary disclosure; it is not anonymization.

The export fails instead of returning a truncated bundle when matching entries exceed `maxSearchResults`. Invalid identifiers, missing requester attribution, invalid time windows, an explicitly empty transfer-ID filter, a missing `onIncidentEvidenceExport` audit sink, or a failing audit sink also fail the request. The export audit callback receives only export ID, incident ID, requester ID, times, count, and digest; it runs before the bundle is retained/returned. A failing callback prevents the export from being stored in this in-memory service.

## Security and operational dependencies

- Authenticate and authorize the operator in the API/controller layer. Populate `requestedBy` from the authenticated principal; never accept it as authoritative client input.
- The audit store and export map are in-memory. Forward the returned bundle and audit callback event to encrypted, access-controlled durable storage before relying on them for incident response, compliance, or legal evidence.
- Configure retention and legal holds in the receiving system. The local `exportRetentionDays` setting is an operational cache lifetime, not a records-retention guarantee.
- The digest detects accidental or unauthorized modification after generation; it does not authenticate the source logs, establish trusted time, or replace signed storage, access logs, and chain-of-custody records.
- Treat bundles and address fingerprints as sensitive because they can be correlated with other information. Restrict download permissions and avoid logging bundle contents.

Troubleshooting: narrow the time window or specify affected transfer IDs if the export exceeds the configured result limit; check the export audit sink if the method rejects without retaining a bundle; verify the digest before analysis; and retrieve the durable original if a local export has expired or the process restarted.

Focused coverage is in `src/audit/transfers/stellar/audit.service.spec.ts` and is included in the production-readiness CI test step.
