# Deployment rollback decision tree

Use this procedure when a release, configuration change, governance action, or contract deployment is suspected of causing an incident. Safety and transaction integrity take precedence over restoring traffic quickly. Assign an incident commander and record the triggering signal, affected release, chains, and current impact in the approved incident system.

## Decide the action

1. **Is there an active risk of unauthorized signing, duplicate execution, incorrect balances, or loss of key control?**
   - **Yes:** Treat as a critical security incident. Disable affected write/signing paths using the authorized control plane; revoke a compromised credential at its issuer, or use the chain-specific custody containment procedure for signing keys. Page security and the incident commander. Do not replay ambiguous submissions.
   - **No:** Continue to step 2.
2. **Did the incident begin with an application or relayer release, and is the prior release known-good?**
   - **Yes:** Roll traffic back to the prior release using the authenticated deployment control plane. For canary routing, set candidate traffic to zero and invoke rollback on every replica; the router state is in-process and is not shared. Follow [CANARY_ROLLOUT_RUNBOOK.md](./CANARY_ROLLOUT_RUNBOOK.md).
   - **No:** Continue to step 3.
3. **Did it begin with a runtime configuration or secret version change?**
   - **Yes:** Restore the last known-good nonsecret configuration or secret-manager version, restart/roll all affected instances, and verify health. For credential compromise, do not restore the compromised credential; revoke it and issue a replacement. Follow [DEPLOYMENT_CONFIGURATION.md](./DEPLOYMENT_CONFIGURATION.md) and [KEY_MANAGEMENT_RUNBOOK.md](./KEY_MANAGEMENT_RUNBOOK.md).
   - **No:** Continue to step 4.
4. **Did it involve a contract deployment or on-chain governance execution?**
   - **Yes:** Do not assume the transaction or deployed bytecode can be rolled back. Repository EVM contracts are deployed directly, without a proxy-based implementation upgrade path. Stop further dependent actions, pause affected operations only where an authorized and tested control exists, preserve finalized transaction evidence, and prepare a governed mitigation, redeployment, migration, or compensation plan. Escalate to security, governance, and chain operations.
   - **No:** Continue to step 5.
5. **Is the cause unclear or rollback unsafe?**
   - **Yes:** Freeze risky changes, preserve read-only service where safe, and escalate to the service owner and incident commander. Do not retry transactions unless idempotency and on-chain state have been checked.
   - **No:** Apply the narrowest approved mitigation and continue monitoring.

## Execute and verify

1. Obtain incident commander authorization; for security or governance actions, include the security/governance approver. Record who approved and which control was used.
2. Capture the current release/configuration identifiers and sanitized health and transaction telemetry. Never include secrets, private keys, environment dumps, or customer payloads.
3. Apply the selected rollback or mitigation through authenticated, audited controls. Confirm it reached every replica, region, chain worker, and relevant ingress route.
4. Validate health checks and critical user journeys. Reconcile queued, submitted, finalized, failed, and ambiguous transactions before restoring writes or retries.
5. Keep the mitigation in place until the incident commander confirms the recovery criteria and the relevant service objectives are stable for the deployment's defined observation window.
6. Record the result and open follow-up actions for missing controls, monitoring, tests, or documentation. Re-enable the changed path only after a reviewed fix and a new approval.

## Boundaries and dependencies

- Application rollback requires immutable release artifacts, a known-good prior version, and an authenticated deployment/traffic control plane with replica-wide propagation.
- Configuration rollback requires versioned configuration and secrets-manager history. A suspected compromised secret must be revoked, not restored.
- Contract response requires verified deployment addresses, a chain RPC/explorer, authorized governance signers, and a chain-specific migration plan. On-chain execution is generally irreversible; a subsequent compensating transaction is not equivalent to undoing it.
- The repository does not define provider-specific rollback commands, production addresses, numeric recovery objectives, or emergency contacts. Each deployment must fill those in and rehearse this decision tree before launch.