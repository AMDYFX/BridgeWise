# API backward compatibility checks

Detects changes to the BridgeWise OpenAPI document that would break clients
built against a previous version.

## Why

[OpenAPI contract validation](./OPENAPI_CONTRACT_VALIDATION.md) answers *"is this
document a good contract?"*. It cannot answer *"does this version still work for
the SDKs and integrations already shipped?"* — a perfectly valid document can
still remove an endpoint, rename an `operationId`, or make a previously optional
parameter required.

The compatibility checker diffs a **baseline** document (what consumers
integrated against) with the **current** one and classifies each difference from
a consumer's point of view.

## Usage

### From code

```ts
import {
  checkBackwardCompatibility,
  formatCompatibilityReport,
} from './openapi/openapi-compatibility-checker';

const report = checkBackwardCompatibility(baselineDocument, currentDocument);
if (!report.compatible) {
  console.error(formatCompatibilityReport(report));
}
```

### From the command line

```bash
node dist/openapi/check-api-compat.js baseline.json current.json
node dist/openapi/check-api-compat.js baseline.json current.json --allow-major-bump
node dist/openapi/check-api-compat.js baseline.json current.json --strict
```

| Flag | Effect |
|---|---|
| `--allow-major-bump` | Accept breaking changes when `info.version` has a higher major version than the baseline |
| `--allow-deprecated-removal` | Report removing an operation the baseline already marked `deprecated` as info instead of breaking |
| `--strict` | Treat warnings as failures too |

Exit codes: `0` compatible, `1` incompatible, `2` usage or parse failure.

### Producing the two documents

Serialise the document the same way as for contract validation (see
[OPENAPI_CONTRACT_VALIDATION.md](./OPENAPI_CONTRACT_VALIDATION.md)). The
baseline is typically the document published with the last release; store it as a
release artifact and fetch it in CI.

## Severity

| Severity | Meaning | Fails the check? |
|---|---|---|
| `breaking` | A correctly written existing client can fail | Yes |
| `warning` | Likely to affect some clients, but not necessarily | Only with `--strict` |
| `info` | Additive or cosmetic | No |

The checker **fails closed**: if either document is missing or has no `paths`
object, the result is incompatible (`document-invalid`) — and a major bump never
excuses that.

## Rules

### Breaking

| Rule | Trigger |
|---|---|
| `document-invalid` | Either document is unusable |
| `operation-removed` | A baseline path + method no longer exists |
| `operation-id-changed` | `operationId` differs; generated SDK methods are renamed |
| `authentication-added` | Operation now requires auth (an anonymous `{}` alternative counts as not required) |
| `required-parameter-added` | A new required parameter |
| `parameter-became-required` | An optional parameter is now required |
| `request-body-required-added` | A required request body was added |
| `request-body-became-required` | An optional request body is now required |
| `request-media-type-removed` | A request content type is no longer accepted |
| `request-property-required-added` | A new required request property |
| `request-property-became-required` | An optional request property is now required |
| `enum-value-removed` | A request enum value is no longer accepted |
| `enum-constraint-added` | A free-form request value is restricted to an enum |
| `success-response-removed` | A baseline 2xx status is no longer returned |
| `response-media-type-removed` | A response content type is no longer returned |
| `response-property-removed` | A response property is no longer returned |
| `response-property-became-optional` | A response property may now be absent |
| `schema-type-changed` | A `type` changed (request `integer` → `number` is the only safe widening) |

### Warning

| Rule | Trigger |
|---|---|
| `parameter-removed` | A parameter was removed (clients that send it have it ignored) |
| `request-body-removed` | The request body was removed |
| `request-property-removed` | A request property was removed |
| `response-removed` | A non-2xx or `default` response is no longer documented |
| `enum-value-added` (response) | A response enum gained a value that exhaustive clients may not handle |

### Info

`operation-added`, `optional-parameter-added`, `request-body-added`,
`property-added`, `success-response-added`, `operation-deprecated`,
`deprecated-operation-removed` (with `--allow-deprecated-removal`),
`enum-value-added` (request), `enum-value-removed` (response).

## Matching rules worth knowing

- **Path parameter renames are compatible.** `/tx/{id}` and `/tx/{txId}` are the
  same route, and path parameters are matched by position.
- **Direction matters.** Adding a required request property is breaking; adding a
  required *response* property is not. Removing a response property is breaking;
  removing a request property is only a warning.
- **`$ref` is followed** for schemas, parameters, request bodies and responses
  (local `#/...` refs only). `allOf` is flattened before comparing. Recursive
  schemas are handled, and a change in a shared schema is reported at every place
  it is used.

## Releasing a breaking change

1. Bump the **major** version in `info.version`.
2. Run with `--allow-major-bump` so the check passes *only* because the bump is
   deliberate. Breaking changes are still listed in the output.
3. Prefer deprecating first: mark the operation `deprecated: true` in one
   release and remove it in the next with `--allow-deprecated-removal`.

## Wiring into CI

Not wired in by default, because it needs a stored baseline and a serialised
current spec — where those live is a repo-level decision. Once they exist:

```yaml
- name: Check API backward compatibility
  run: node apps/api/dist/openapi/check-api-compat.js baseline/openapi.json openapi.json
```

## Known limits

Not compared: `oneOf` / `anyOf` variants, value constraints (`minimum`,
`maxLength`, `pattern`, `format`), non-local `$ref`s, and response headers. A
tightened constraint can therefore pass this check; treat it as a strong
guardrail, not a proof of compatibility.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `operation-id-changed` after a refactor | A controller method was renamed; pin the id with `@ApiOperation({ operationId })` |
| `operation-removed` for a route that still exists | Its path template changed shape (a segment was added or removed), not just a parameter name |
| `document-invalid` | The file is not an OpenAPI document or has no `paths`; check the serialisation step |
| Incompatible despite `--allow-major-bump` | `info.version` was not actually increased past the baseline's major |
