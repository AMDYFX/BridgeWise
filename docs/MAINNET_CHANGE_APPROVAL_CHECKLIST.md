# Mainnet change approval checklist

Use this checklist for production deployments, configuration changes, secret rotations, privileged role changes, and governed contract operations. A missing owner, approver, rollback/mitigation path, or verification result is a **no-go**. Store approval evidence in the deployment's restricted change system; do not place secrets or private signing material in this checklist or a pull request.

## Change record

- [ ] Change ID, objective, scope, risk, affected services/chains, and customer impact are recorded.
- [ ] Service owner and implementation operator are named; an independent production/security approver is assigned. The requester does not approve their own change.
- [ ] Start/end window, maintenance impact, communications owner, and support coverage are confirmed.
- [ ] Dependencies are identified: upstream providers, secret manager, deployment platform, RPC/indexer, contract addresses/roles, and downstream integrations as applicable.
- [ ] The approved artifact is immutable and identified by repository revision, build artifact digest, configuration version, or on-chain calldata hash as applicable.

## Preflight

- [ ] Required unit, integration, security, and deployment checks passed for the touched scope; failures and exceptions are recorded and explicitly approved.
- [ ] Staging validation and health checks passed using nonproduction accounts and synthetic data.
- [ ] The target environment, chain ID, account/contract addresses, deployment bytecode or artifact, function selector/calldata, value, and expected post-state were independently verified.
- [ ] For privileged actions, current owner/role membership, multisig threshold, timelock delay, proposal expiry, and required confirmations match the governance record. Check the [multisig proposal monitoring runbook](./MULTISIG_PROPOSAL_MONITORING.md).
- [ ] Signing authority is provided by the approved HSM/custody or multisig workflow. No private key or seed phrase is present in CI, shell history, logs, or the change record.
- [ ] Monitoring, alert routing, transaction reconciliation, and an authorized stop/mitigation control are available and have an owner.
- [ ] Database or external-state migrations have a tested recovery/backfill plan. Contract bytecode changes account for the absence of a proxy upgrade path.

## Approval and execution

- [ ] Required service owner and independent production/security approvals are recorded before execution.
- [ ] Any chain-specific governance threshold/timelock has been met; a UI status or monitor alert is not itself approval to execute.
- [ ] Operator announces start, verifies the target one final time, and executes only the approved artifact or transaction.
- [ ] Canary or phased rollout is used where supported; each phase has explicit pause/stop criteria.
- [ ] Execution ID, release/artifact digest, transaction hash or secret version identifier, timestamps, operator, and approvals are recorded without secret values.

## Post-change and closeout

- [ ] Service health, security signals, chain/provider status, and relevant balances/state are verified against the pre-change baseline.
- [ ] Submitted and pending transactions are reconciled; no duplicate, unauthorized, or ambiguous execution remains unaddressed.
- [ ] Rollback decision and recovery owner are confirmed. For immutable on-chain changes, record the mitigation/migration plan instead of promising transaction reversal; use the [deployment rollback decision tree](./DEPLOYMENT_ROLLBACK_DECISION_TREE.md).
- [ ] Stakeholders are notified, temporary access is removed, and the audit/change record is closed with evidence and follow-up owners.

## No-go conditions

Stop and escalate if the chain/environment or artifact cannot be independently verified; required approvals or governance threshold are missing; monitoring or stop controls are unavailable; signer access is uncertain; tests or staging evidence do not support the change; the change differs from the approved calldata/artifact; or rollback/mitigation would risk duplicate or unauthorized transactions.

## Dependencies

This process depends on the repository's CI and artifact provenance, staging environment, deployment platform, secret manager/HSM or custody provider, chain RPC and event monitor, approval/audit system, and named primary/backup responders. Populate environment-specific values and rehearsal evidence in the restricted deployment record before mainnet launch; this generic checklist does not establish that any particular deployment is ready.