# Production support escalation matrix

This matrix defines role-based escalation for production incidents. Populate each role with a named primary, backup, paging route, and response-time objective in the restricted on-call directory before launch. Do not commit personal phone numbers, private channels, customer details, or production credentials here.

## Severity and ownership

| Severity | Trigger examples | Initial owner | Escalate to | Required action |
| --- | --- | --- | --- | --- |
| SEV-1 Critical | Confirmed key/signing compromise; unauthorized or duplicate execution; incorrect asset movement; broad critical service outage; unexpected privileged governance execution | Primary on-call / incident commander | Security lead, service owner, chain operations, executive incident contact | Page immediately; disable affected risky writes/signing where authorized; preserve evidence; communicate impact and next update time. |
| SEV-2 High | Sustained SLO breach; one chain/provider materially degraded; governance monitor stale during an active proposal; failed deployment with customer impact but no confirmed asset risk | Primary on-call | Service owner, provider/chain owner, security if trust boundary is unclear | Acknowledge, mitigate, open incident record, and reassess severity as impact changes. |
| SEV-3 Moderate | Degraded noncritical workflow, isolated errors with safe workaround, nonurgent alert or operational backlog | Service owner or support engineer | Component owner; on-call if impact expands | Track in an incident/ticket, assign a due time, and monitor for escalation conditions. |
| SEV-4 Low | Documentation, access review, or nonurgent maintenance issue without current customer or security impact | Component owner | Service owner as needed | Record and schedule through normal change management. |

Use the alert thresholds in [SERVICE_OBJECTIVES_AND_INCIDENT_RESPONSE.md](./SERVICE_OBJECTIVES_AND_INCIDENT_RESPONSE.md) for API incidents. A confirmed security event or risk of unauthorized/duplicate transaction execution is SEV-1 regardless of request volume.

## Escalation sequence

1. The first responder acknowledges the alert, records the incident start and known impact, and becomes incident commander until explicitly handed over.
2. Page the primary role through the deployment's approved paging system. If no acknowledgement within the deployment's documented response objective, page the backup, then the service owner.
3. For any key, signing, multisig, timelock, or privileged-role concern, page security and chain/governance operations in parallel; do not wait for ordinary service triage.
4. Assign an operator to investigate and a communications owner. Restrict incident records to approved systems; keep secrets, private keys, seed phrases, and customer payloads out of logs and updates.
5. Apply mitigations only through authorized controls. Use the [deployment rollback decision tree](./DEPLOYMENT_ROLLBACK_DECISION_TREE.md) and reconcile transaction state before enabling retries or writes.
6. During SEV-1, provide updates at the interval defined by the incident commander and customer communications policy. State verified impact, mitigation, and next update time without speculating.
7. Hand off explicitly with current severity, timeline, actions, unresolved risks, and next decision owner. Close only after recovery checks and follow-up ownership are recorded.

## Required contact directory fields

Keep the following in an access-controlled on-call directory, not in this repository:

- Primary and backup on-call names, paging route, timezone, and escalation timing for API/platform, security, chain operations, governance/multisig, and communications.
- Incident commander authority and the person authorized to stop writes, disable a deployment, pause a chain integration, or request signer/custody containment.
- External provider support routes and account identifiers that are safe to disclose; do not store provider passwords or API tokens in the directory.
- Coverage schedule, acknowledgement test date, backup coverage, and out-of-hours escalation route.

## Readiness and dependencies

- [ ] All roles have staffed primary and backup coverage, tested paging routes, and documented response objectives.
- [ ] Security, chain operations, and governance are paged in parallel for signing or privileged-action incidents.
- [ ] Incident commander can reach the authenticated deployment controls and knows their limits and approval requirements.
- [ ] Pager tests and a tabletop exercise for key compromise, unexpected multisig execution, and application rollback have been completed and recorded.
- [ ] Contact directory access, incident record access, customer communications policy, and provider escalation routes are reviewed periodically.

This matrix depends on a staffed on-call provider, incident management/paging system, service telemetry, deployment control plane, security response process, and chain/custody support. The repository intentionally contains no production contact details; launch is blocked until the deployment owner fills and tests the directory.