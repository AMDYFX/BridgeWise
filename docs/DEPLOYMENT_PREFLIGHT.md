# EVM Deployment Preflight

`pnpm deployment:preflight` performs read-only checks before an EVM deployment. It does not sign, submit, or retry transactions. A failed check sets a non-zero exit status; the JSON report identifies failed checks without including RPC error text or credentials.

## Inputs

Provide three files/settings through the protected deployment environment:

- `DEPLOYMENT_PREFLIGHT_PLAN_PATH`: reviewed JSON with `chainId`, `deployerAddress`, `expectedNonce`, `minimumBalanceWei`, and `requiredContracts` (`name` and `address` pairs).
- `DEPLOYMENT_ALLOWLIST_PATH`: reviewed JSON mapping numeric chain IDs to approved contract addresses, for example `{ "chains": { "1": ["0x..."], "42161": ["0x..."] } }`.
- `DEPLOYMENT_DEPLOYER_ADDRESS`: non-secret configured deployer address, which must match the reviewed plan.

The allowlist is loaded into an isolated `ChainAssetAllowlistService` with built-in demo/default entries disabled. Each required contract must be approved for the selected chain and return non-empty runtime code. The configured RPC must report the expected chain, the deployer must meet its minimum native balance, and its pending nonce must exactly match the reviewed nonce.

## Run

For a configured Hardhat network:

```sh
DEPLOYMENT_PREFLIGHT_PLAN_PATH=/secure/path/preflight.json \
DEPLOYMENT_ALLOWLIST_PATH=/secure/path/contract-allowlist.json \
DEPLOYMENT_DEPLOYER_ADDRESS=0x... \
pnpm deployment:preflight -- --network ethereum
```

Supported named networks are Ethereum, Polygon, BSC, Arbitrum, and Optimism. Each requires its `RPC_*` environment variable. The preflight needs no private key; provide `RPC_*` through a protected runtime setting because provider URLs may contain credentials. Do not put RPC URLs or production addresses in command transcripts, examples, logs, or source-control allowlists.

## Dependencies and failure handling

- Upstream: the selected RPC/provider must answer chain ID, balance, pending nonce, and runtime-code queries; the plan and allowlist must be reviewed and refer to the same chain.
- The deployer address is intentionally public configuration, not signing authority. Actual deployment tooling must independently load its signer from the approved secret manager and verify it against the same reviewed address.
- A preflight pass is a point-in-time observation, not a lock. Another transaction can consume the nonce or the chain can change before deployment. Repeat the preflight immediately before a deployment and keep the deployment process's own chain/signer/nonce checks.
- Network errors, rejected allowlist lookups, insufficient funds, nonce drift, missing code, malformed addresses, and unapproved contracts fail closed. RPC exception strings are intentionally omitted from the report to avoid leaking endpoint credentials.

Troubleshooting: verify the selected `--network` and its expected chain ID, refresh the reviewed nonce after any transaction from the deployer, ensure allowlist entries are approved by the appropriate change-control owner, and confirm dependencies are already deployed with runtime code. Do not weaken a failed check to proceed; update the reviewed inputs and rerun.

Focused unit coverage is run in CI from `scripts/deployment-preflight.spec.ts` and `src/config/allowlist/chain-asset-allowlist.service.spec.ts`.
