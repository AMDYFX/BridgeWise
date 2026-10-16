# Multisig proposal monitoring runbook

This runbook defines the production monitoring requirements for BridgeWise governance contracts. It covers `BridgeMultiSigOwnable`, `BridgeTimelockController`, and `TimelockGuardian`. It does not provide an event indexer, metrics backend, or notification service; those are deployment dependencies and must be verified before mainnet operation.

## Sources and limitations

- Subscribe to `ProposalCreated`, `ProposalConfirmed`, `ProposalRevoked`, `ProposalExecuted`, `OwnerAdded`, `OwnerRemoved`, and `ThresholdChanged` from each deployed `BridgeMultiSigOwnable`.
- Subscribe to `OperationQueued`, `OperationExecuted`, `OperationCancelled`, and `MinDelayChange` from each `BridgeTimelockController`, and `UpgradeQueued` / `UpgradeCanceled` from each `TimelockGuardian`.
- Subscribe to OpenZeppelin `RoleGranted` and `RoleRevoked` events from the timelock and guardian contracts. Decode role identifiers against the deployed ABI and alert on changes to admin, proposer, executor, canceller, or guardian authority.
- `ProposalCreated` does not include the proposal expiration time or threshold. Read the proposal and current threshold from contract state; reconcile after each relevant event and periodically.
- The multisig has no explicit proposal-expired event. Derive expiry from `expirationTime` and current finalized chain time. An expired timelock operation is represented by `getOperationState` as `Cancelled`; distinguish expiry from an actual `OperationCancelled` event.
- Events and public contract state do not prove an operation was reviewed off-chain or is safe to execute. Keep approval records in the authorized change system.

## Required deployment configuration

Before enabling alerts, record the chain ID, RPC/indexer endpoint, contract addresses, deployment block, ABI/artifact revision, confirmation/finality policy, and alert destination in the restricted deployment inventory. Verify addresses and role membership against the deployed contracts using an independent read path. Never put RPC credentials, signer material, or private endpoints in this document or metric labels.

The monitor must persist a reorg-aware cursor per chain and contract, deduplicate by chain ID, transaction hash, and log index, backfill from the recorded deployment block, and periodically reconcile event-derived state with contract reads. Pause or mark data stale when RPC or indexing falls behind; do not treat missing events as proof that no proposal exists.

## Alerts and response

| Signal | Severity | Response |
| --- | --- | --- |
| New proposal or timelock operation queued | Info | Notify governance reviewers with chain, contract, proposal/operation ID, target, proposer, and expiry/ready time. Link to the approved change record. |
| Proposal reaches threshold or becomes executable | Warning | Recheck target, value, decoded method, calldata hash, approvals, and expiry against the approved record. Notify the authorized executor; do not execute automatically. |
| Proposal execution or timelock operation execution | Warning | Verify the transaction receipt and resulting contract state against the approved change. Escalate immediately for an unapproved or mismatched execution. |
| Owner or threshold changes; proposer/executor/canceller/guardian role changes; minimum-delay change | High | Page governance and security responders. Verify the change was approved and validate the resulting owner/role set and threshold/delay. |
| Guardian cancellation, unexpected cancellation/revocation, unexpected target or calldata, or execution without a matching approved record | Critical | Page security and incident command immediately. Preserve event references, pause dependent operations where authorized, and follow the rollback decision tree. |
| Indexer/RPC lag beyond the deployment's defined finality and freshness SLO | Warning | Mark governance status stale, alert the monitor owner, and use independent RPC/state reads before any execution decision. |

Set numeric freshness thresholds and chain finality rules per network before launch. Use bounded metric labels (chain, contract role, event kind, severity); do not label metrics with arbitrary calldata, proposer addresses, proposal IDs, or transaction hashes. Keep those as access-controlled event details. Never log signer secrets or private RPC credentials.

## Operator workflow

1. Acknowledge the alert and confirm chain, contract, event, and finalized block using a second RPC or trusted explorer.
2. Read current on-chain proposal/operation state, owner set, threshold, and relevant roles. For the custom multisig, confirmations are tracked per owner and proposal; the proposal creator's initial confirmation counts toward the threshold.
3. Compare target, value, calldata hash and decoded operation, expiry/ready time, and required approvals with the separately approved change record. Do not execute based only on an alert or decoded event.
4. If any field or approval is unexpected, stop execution, notify security/on-call, and use the incident and rollback procedures. Do not attempt to reverse an already-executed on-chain transaction as if it were a deployment rollback.
5. Record event references, block numbers, monitor freshness, approver identities, decision, and outcome in the restricted audit system. Do not copy private key material or secrets into the record.

## Readiness checks

- [ ] Contract addresses, ABIs, deployment blocks, chain IDs, and role assignments are verified and access-controlled.
- [ ] Event backfill, reorg handling, deduplication, state reconciliation, and stale-data alerting are tested.
- [ ] Alerts route to named primary and backup responders and have been exercised with synthetic events.
- [ ] No monitor automatically confirms, cancels, or executes proposals.
- [ ] Operator response links to the [mainnet change approval checklist](./MAINNET_CHANGE_APPROVAL_CHECKLIST.md), [rollback decision tree](./DEPLOYMENT_ROLLBACK_DECISION_TREE.md), and [support escalation matrix](./PRODUCTION_SUPPORT_ESCALATION_MATRIX.md).

## Dependencies

This monitoring depends on deployed governance contracts and verified ABIs, reliable chain RPC/indexing infrastructure, durable storage and alert delivery, an approved change-record system, and a staffed governance/security on-call rotation. The repository does not specify a production chain, hosting provider, indexer, numeric freshness SLO, or contacts; assign and test these per deployment before mainnet launch.