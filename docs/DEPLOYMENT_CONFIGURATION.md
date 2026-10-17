# Deployment configuration and runtime secrets

Environment templates are versioned in `.env.example`, `.env.staging.example`, and `.env.production.example`. They document configuration names and safe placeholder values. Keep deployment specific, nonsecret values in reviewed templates or deployment manifests; supply credentials to the running process through the hosting platform's secret manager or protected runtime environment.

The API does not load dotenv files when `NODE_ENV=production`; all production settings must already be present in the process environment before startup.

## Runtime setup

- Set `NODE_ENV` to `staging` or `production` and provide the required values from `apps/api/src/config/env-schema.ts` through the deployment platform.
- Provide database passwords, API credentials, RPC provider tokens, and `VAULT_ENCRYPTION_KEY` as runtime secrets. Do not put them in source control, Docker build arguments, image layers, workflow output, or deployment logs.
- Restrict production secret access to the production workload and authorized operators. Prefer short-lived identity-based access where the hosting platform supports it, and rotate credentials on a schedule and after suspected exposure.
- Production and staging should use separate credentials, databases, and provider accounts. Enable database TLS, force HTTPS, and use explicit CORS origins.
- CI does not need production secrets: it validates the checked-in templates and builds/tests with synthetic values only.
- Startup validation checks required values, types, allowed values, valid URLs, integer numeric boundaries, and rejects obvious template placeholders. Production startup additionally requires HTTPS endpoints, `FORCE_HTTPS=true`, `DB_SSL=true`, and explicit CORS origins; invalid configuration fails closed before the application starts.

## Deterministic EVM deployments

The Hardhat deploy runner supports Ethereum, Polygon, BSC, Arbitrum, Optimism, and Base. Each network reads its `RPC_*` URL from the runtime environment, and the deployer reads `DEPLOYER_PRIVATE_KEY`; inject both through the deployment platform's protected environment. Never put the key in a plan, manifest, command argument, or repository file.

Create a reviewed JSON plan containing `chainId`, `deployerAddress`, `startingNonce`, and an ordered `deployments` list. Each deployment names a compiled contract and supplies its constructor arguments. Then run:

```sh
DEPLOYMENT_PLAN_PATH=./deployment-plan.json pnpm deploy:contracts --network ethereum
```

The runner checks the connected chain, signer, pending nonce, and every predicted CREATE address before broadcasting. Contract addresses are deterministic for the exact deployer and starting nonce; they are not the same across chains or if a different transaction consumes that nonce. The runner waits for each receipt and writes a mode-restricted JSON manifest atomically to `deployments/<chainId>-<plan-hash>.json` (override with `DEPLOYMENT_MANIFEST_PATH`). Confirmed deployments are recorded as the batch progresses, with the final manifest marked complete. Existing manifests and addresses containing code are refused rather than overwritten.

Dependencies: the selected RPC must report the intended chain and support transaction/receipt queries; the signer must have sufficient native gas balance; the contracts must already compile in the checked-out source. A failed or interrupted batch may have consumed nonces. Stop, inspect the partial manifest, confirmed transactions, and the current account nonce, then create a newly reviewed plan for remaining deployments instead of reusing the original nonce.

## Local development

Copy `.env.example` to an ignored local `.env` and replace placeholders with development-only values. Never copy production credentials to a developer workstation. `.gitignore` excludes local `.env` files; CI also fails if a non-example environment file is tracked or a sensitive assignment in a template is populated.

## Incident and operations notes

Removing an environment file from the current tree does not remove earlier commits or cached clones. If a real credential was ever committed, revoke and replace it at its issuer, review access logs, and remove the value from repository history using the repository's approved history-rewrite procedure. Coordinate the rewrite because it changes commit IDs for collaborators.

Deployment configuration changes should be reviewed alongside application changes. After changing required environment variables, update the versioned templates and this runbook, confirm the production secret store has the matching entries before rollout, and verify health checks after deployment. Missing or malformed required values should stop startup through environment validation rather than silently falling back to development credentials.

For safe configuration checks, run `node --test scripts/check-deployment-config.test.mjs`; runtime schema cases are covered by `pnpm exec jest --runInBand apps/api/src/config/env-schema.spec.ts`.
