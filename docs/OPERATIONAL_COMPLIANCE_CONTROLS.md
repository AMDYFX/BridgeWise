# Operational Compliance Controls

This runbook describes the operational controls needed to protect BridgeWise production systems and preserve investigation records. It records intended operating practice; it does not claim that this repository itself provides durable log storage, identity management, or regulatory certification.

## Access and change control

- Grant production access through named identities and least-privilege roles. Require MFA for the identity provider and privileged operator accounts; review access at least quarterly and promptly revoke access when roles change.
- Store RPC credentials, database credentials, API secrets, and encryption keys in the deployment platform's secret manager. Inject secrets at runtime, restrict them to the workload and authorized operators, rotate them after suspected exposure, and keep them out of plans, allowlists, images, command arguments, logs, and issue comments. Follow [Key Management](KEY_MANAGEMENT_RUNBOOK.md).
- Protect changes to deployment plans, contract allowlists, environment templates, and policy documentation with code review and the repository's branch protection. Record the approving change and deployment manifest together.
- Require a second authorized reviewer for production allowlist changes and privileged role changes. Verify the chain, address, deployed code, and intended owner before approval; monitor contract and role events after rollout.

## Deployment and configuration

- Run [deployment preflight](DEPLOYMENT_PREFLIGHT.md) immediately before deployment. It verifies the RPC chain, configured deployer, minimum balance, pending nonce, allowlisted dependencies, and dependency runtime code. It is read-only and does not replace signer validation in the deployment tool.
- Validate runtime configuration before startup. Production must use HTTPS endpoints, database TLS, explicit CORS origins, and real secret values; keep versioned `.env.*.example` files free of credentials. See [Deployment Configuration](DEPLOYMENT_CONFIGURATION.md).
- Review network, signer, contract address, and nonce changes as production-impacting changes. Preserve deployment records and transaction hashes in the approved change-management system.

## Audit and incident evidence

- Restrict audit and incident evidence access to responders with an operational need. Audit records can include transfer identifiers and metadata; handle them as sensitive operational data.
- The transfer audit implementation and incident evidence exports in this repository are in-memory. They are not a durable compliance archive. Forward export audit events and evidence bundles to an access-controlled, encrypted, retention-managed system before relying on them for an investigation or legal obligation.
- Incident exports require a time window, opaque incident ID, and requester identity. The requester identity must come from an authenticated server-side principal, not a user-controlled request field. The default bundle omits raw addresses, amounts, arbitrary metadata, and provider error text; its digest detects content changes but does not prove who created the source records.
- Preserve chain of custody in the receiving system: record the requester, export timestamp, digest, storage object/version, access history, retention deadline, and any legal hold. Verify the bundle digest after transfer and before analysis. Do not edit the original bundle; annotate a working copy.
- Follow [Audit Logging](AUDIT_LOGGING.md) and [Incident Response](SERVICE_OBJECTIVES_AND_INCIDENT_RESPONSE.md). Never place credentials, signing material, mnemonics, or raw customer payloads in incident tickets.

## Monitoring, retention, and review

- Alert on failed deployment preflight checks, unauthorized allowlist changes, missing/failed audit-export callbacks, and incidents involving transaction integrity or signing control.
- Configure log and evidence retention in the host platform to match approved legal, contractual, and operational requirements. Verify purge jobs and legal holds with periodic sampling; this repository's in-memory exports expire by configured `exportRetentionDays` and disappear on process restart.
- Reconcile production contract addresses and code against the approved deployment records after release and on a scheduled basis. Investigate any address, code, role, or chain mismatch before resuming affected write paths.
- Review this control set quarterly and after a security incident, material architecture change, or regulatory requirement change. Assign an owner and due date to every control gap.

## Dependencies and troubleshooting

- Identity, MFA, access reviews, secret distribution, durable audit storage, retention enforcement, legal holds, and alert delivery are supplied by the production platform and its operations owners.
- If evidence disappears after a restart, the in-memory store was not forwarded to durable storage. Restore from the approved archive, record any evidence gap, and add or verify the export sink before further incident use.
- If a preflight fails, do not bypass it. Check RPC health and chain ID, compare current pending nonce with the reviewed plan, verify balance thresholds, and obtain explicit approval for any allowlist change.
- If bundle integrity verification fails, preserve the original artifact, stop analysis on the altered copy, retrieve the original from the controlled archive, and document the discrepancy.
