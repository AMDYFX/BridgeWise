/**
 * OpenAPI backward compatibility checking.
 *
 * `openapi-contract-validator` answers "is this document a good contract?".
 * This module answers the other half of the question: "does this version of the
 * contract still work for clients built against the previous one?".
 *
 * It diffs a *baseline* document (what consumers integrated against) with the
 * *current* one and classifies every difference from a consumer's point of view:
 *
 *   - breaking: an existing, correctly written client can fail
 *   - warning:  likely to affect clients, but not necessarily (e.g. a new enum
 *               value in a response that a client switches over)
 *   - info:     additive or cosmetic — safe
 *
 * Everything here is a pure function over document objects, so it is testable
 * without booting the application.
 *
 * Known limits (documented in docs/API_BACKWARD_COMPATIBILITY.md): `oneOf` /
 * `anyOf` variants, value constraints (`maxLength`, `minimum`, `pattern`), and
 * non-local `$ref`s are not compared.
 */

import { pathTemplateParams } from './openapi-contract-validator';

export type ChangeSeverity = 'breaking' | 'warning' | 'info';

export interface CompatibilityChange {
  /** Stable machine-readable rule id, e.g. `operation-removed`. */
  rule: string;
  severity: ChangeSeverity;
  message: string;
  /** JSON-pointer-ish location, e.g. `paths./transactions.get.responses.200`. */
  location: string;
}

export interface CompatibilityOptions {
  /**
   * Allow removing an operation that the baseline already marked
   * `deprecated: true` (reported as info instead of breaking). Off by default.
   */
  allowDeprecatedRemoval?: boolean;
  /**
   * Treat breaking changes as acceptable when `info.version` has a higher major
   * version than the baseline. Off by default.
   */
  allowBreakingOnMajorBump?: boolean;
  /** Treat warnings as failures too. Off by default. */
  strictWarnings?: boolean;
}

export interface CompatibilityReport {
  /** True when the current document is safe to ship under the given options. */
  compatible: boolean;
  changes: CompatibilityChange[];
  breakingCount: number;
  warningCount: number;
  infoCount: number;
  baselineOperations: number;
  currentOperations: number;
  /** True when the current major version is higher than the baseline's. */
  majorVersionBump: boolean;
}

/** OpenAPI documents are untyped JSON by nature. */
type Json = Record<string, any>;
type Direction = 'request' | 'response';
type AddChange = (
  rule: string,
  severity: ChangeSeverity,
  message: string,
  location: string,
) => void;

interface Context {
  baseDoc: Json;
  currDoc: Json;
  add: AddChange;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const MAX_SCHEMA_DEPTH = 16;
const MAX_REF_DEPTH = 16;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Compare a current OpenAPI document with a baseline and report every change
 * that can affect existing consumers.
 *
 * Fails closed: if either document is unusable the result is incompatible.
 */
export function checkBackwardCompatibility(
  baseline: unknown,
  current: unknown,
  options: CompatibilityOptions = {},
): CompatibilityReport {
  const changes: CompatibilityChange[] = [];
  const add: AddChange = (rule, severity, message, location) =>
    changes.push({ rule, severity, message, location });

  const invalid = (which: string, doc: unknown): boolean => {
    if (!isObject(doc) || !isObject((doc as Json).paths)) {
      add(
        'document-invalid',
        'breaking',
        `The ${which} document is missing or has no \`paths\` object, so compatibility cannot be verified.`,
        '$',
      );
      return true;
    }
    return false;
  };
  const baselineInvalid = invalid('baseline', baseline);
  const currentInvalid = invalid('current', current);
  if (baselineInvalid || currentInvalid) {
    return buildReport(changes, 0, 0, false, options);
  }

  // The casts are required: the closure above cannot narrow `baseline`/`current`, and `eslint --fix`
  // would otherwise strip them as "unnecessary".
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const baseDoc = baseline as Json;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const currDoc = current as Json;
  const ctx: Context = { baseDoc, currDoc, add };

  const currentByTemplate = new Map<string, { path: string; item: Json }>();
  for (const [path, item] of Object.entries<Json>(currDoc.paths)) {
    const key = normalizePath(path);
    if (!currentByTemplate.has(key)) currentByTemplate.set(key, { path, item: item ?? {} });
  }

  let baselineOperations = 0;
  const matchedCurrent = new Set<string>();

  for (const [basePath, baseItem] of Object.entries<Json>(baseDoc.paths)) {
    const match = currentByTemplate.get(normalizePath(basePath));

    for (const method of HTTP_METHODS) {
      const baseOp = baseItem?.[method];
      if (!isObject(baseOp)) continue;
      baselineOperations++;

      const where = `paths.${basePath}.${method}`;
      const currOp = match?.item?.[method];

      if (!isObject(currOp)) {
        if (baseOp.deprecated === true && options.allowDeprecatedRemoval) {
          add('deprecated-operation-removed', 'info', 'A deprecated operation was removed.', where);
        } else {
          add(
            'operation-removed',
            'breaking',
            `Operation ${method.toUpperCase()} ${basePath} no longer exists.`,
            where,
          );
        }
        continue;
      }

      matchedCurrent.add(`${normalizePath(basePath)}|${method}`);
      compareOperation(
        { op: baseOp, item: baseItem, path: basePath },
        { op: currOp, item: match!.item, path: match!.path },
        where,
        ctx,
      );
    }
  }

  let currentOperations = 0;
  for (const [path, item] of Object.entries<Json>(currDoc.paths)) {
    for (const method of HTTP_METHODS) {
      if (!isObject(item?.[method])) continue;
      currentOperations++;
      if (!matchedCurrent.has(`${normalizePath(path)}|${method}`)) {
        add(
          'operation-added',
          'info',
          `New operation ${method.toUpperCase()} ${path}.`,
          `paths.${path}.${method}`,
        );
      }
    }
  }

  const majorVersionBump = isMajorBump(baseDoc.info?.version, currDoc.info?.version);
  return buildReport(changes, baselineOperations, currentOperations, majorVersionBump, options);
}

/** Human-readable report, mirroring the contract validator's format. */
export function formatCompatibilityReport(report: CompatibilityReport): string {
  const verdict = report.compatible ? 'COMPATIBLE' : 'INCOMPATIBLE';
  const header =
    `API compatibility: ${verdict} — ${report.breakingCount} breaking, ` +
    `${report.warningCount} warning(s), ${report.infoCount} info ` +
    `(${report.baselineOperations} baseline → ${report.currentOperations} current operations).`;

  if (report.changes.length === 0) {
    return `${header}\nNo differences.\n`;
  }

  const lines = [header, ''];
  for (const severity of ['breaking', 'warning', 'info'] as const) {
    const matching = report.changes.filter((c) => c.severity === severity);
    if (matching.length === 0) continue;

    lines.push(`${severity.toUpperCase()}:`);
    for (const change of matching) {
      lines.push(`  [${change.rule}] ${change.location}`);
      lines.push(`      ${change.message}`);
    }
    lines.push('');
  }
  if (!report.compatible && report.majorVersionBump === false) {
    lines.push('Tip: breaking changes are only accepted with a major version bump and --allow-major-bump.');
    lines.push('');
  }
  return lines.join('\n');
}

// ─── Operation comparison ────────────────────────────────────────────────────

interface Side {
  op: Json;
  item: Json;
  path: string;
}

function compareOperation(base: Side, curr: Side, where: string, ctx: Context): void {
  const { add } = ctx;

  if (base.op.operationId && base.op.operationId !== curr.op.operationId) {
    add(
      'operation-id-changed',
      'breaking',
      `operationId changed from "${base.op.operationId}" to "${curr.op.operationId ?? '(none)'}"; generated SDK methods are renamed.`,
      where,
    );
  }

  if (curr.op.deprecated === true && base.op.deprecated !== true) {
    add('operation-deprecated', 'info', 'Operation is newly marked deprecated.', where);
  }

  if (!requiresAuth(base.op, ctx.baseDoc) && requiresAuth(curr.op, ctx.currDoc)) {
    add(
      'authentication-added',
      'breaking',
      'Operation now requires authentication; unauthenticated clients will be rejected.',
      where,
    );
  }

  compareParameters(base, curr, where, ctx);
  compareRequestBody(base.op, curr.op, where, ctx);
  compareResponses(base.op, curr.op, where, ctx);
}

// ─── Parameters ──────────────────────────────────────────────────────────────

interface KeyedParameter {
  key: string;
  label: string;
  required: boolean;
  schema: Json | undefined;
}

function keyedParameters(side: Side, doc: Json): Map<string, KeyedParameter> {
  const templateNames = pathTemplateParams(side.path);
  const merged = new Map<string, KeyedParameter>();

  // Path-level parameters first so operation-level ones override them.
  for (const raw of [...asArray(side.item.parameters), ...asArray(side.op.parameters)]) {
    const parameter = deref(raw, doc);
    if (!parameter || typeof parameter.name !== 'string' || typeof parameter.in !== 'string') {
      continue;
    }
    // Path parameters are matched by position, so a pure rename
    // (`/tx/{id}` → `/tx/{txId}`) is not reported as a removal plus an addition.
    const key =
      parameter.in === 'path'
        ? `path:${templateNames.indexOf(parameter.name)}`
        : `${parameter.in}:${parameter.name}`;
    merged.set(key, {
      key,
      label: `${parameter.in}.${parameter.name}`,
      required: parameter.in === 'path' || parameter.required === true,
      schema: parameter.schema,
    });
  }
  return merged;
}

function compareParameters(base: Side, curr: Side, where: string, ctx: Context): void {
  const baseParams = keyedParameters(base, ctx.baseDoc);
  const currParams = keyedParameters(curr, ctx.currDoc);

  for (const [key, baseParam] of baseParams) {
    const location = `${where}.parameters.${baseParam.label}`;
    const currParam = currParams.get(key);

    if (!currParam) {
      ctx.add(
        'parameter-removed',
        'warning',
        `Parameter "${baseParam.label}" was removed; clients that still send it will have it ignored.`,
        location,
      );
      continue;
    }
    if (!baseParam.required && currParam.required) {
      ctx.add(
        'parameter-became-required',
        'breaking',
        `Parameter "${baseParam.label}" is now required; existing calls that omit it will fail.`,
        location,
      );
    }
    compareSchema(baseParam.schema, currParam.schema, 'request', location, ctx);
  }

  for (const [key, currParam] of currParams) {
    if (baseParams.has(key)) continue;
    const location = `${where}.parameters.${currParam.label}`;
    if (currParam.required) {
      ctx.add(
        'required-parameter-added',
        'breaking',
        `New required parameter "${currParam.label}"; existing calls do not send it.`,
        location,
      );
    } else {
      ctx.add('optional-parameter-added', 'info', `New optional parameter "${currParam.label}".`, location);
    }
  }
}

// ─── Request body ────────────────────────────────────────────────────────────

function compareRequestBody(baseOp: Json, currOp: Json, where: string, ctx: Context): void {
  const baseBody = deref(baseOp.requestBody, ctx.baseDoc);
  const currBody = deref(currOp.requestBody, ctx.currDoc);
  const location = `${where}.requestBody`;

  if (!baseBody && currBody) {
    if (currBody.required === true) {
      ctx.add(
        'request-body-required-added',
        'breaking',
        'A required request body was added; existing calls send none.',
        location,
      );
    } else {
      ctx.add('request-body-added', 'info', 'An optional request body was added.', location);
    }
    return;
  }
  if (baseBody && !currBody) {
    ctx.add(
      'request-body-removed',
      'warning',
      'The request body was removed; clients that still send one will have it ignored.',
      location,
    );
    return;
  }
  if (!baseBody || !currBody) return;

  if (baseBody.required !== true && currBody.required === true) {
    ctx.add(
      'request-body-became-required',
      'breaking',
      'The request body is now required; existing calls that omit it will fail.',
      location,
    );
  }

  const baseContent = baseBody.content ?? {};
  const currContent = currBody.content ?? {};
  for (const mediaType of Object.keys(baseContent)) {
    const mediaLocation = `${location}.${mediaType}`;
    if (!(mediaType in currContent)) {
      ctx.add(
        'request-media-type-removed',
        'breaking',
        `Request media type "${mediaType}" is no longer accepted.`,
        mediaLocation,
      );
      continue;
    }
    compareSchema(
      baseContent[mediaType]?.schema,
      currContent[mediaType]?.schema,
      'request',
      mediaLocation,
      ctx,
    );
  }
}

// ─── Responses ───────────────────────────────────────────────────────────────

function compareResponses(baseOp: Json, currOp: Json, where: string, ctx: Context): void {
  const baseResponses: Json = baseOp.responses ?? {};
  const currResponses: Json = currOp.responses ?? {};

  for (const code of Object.keys(baseResponses)) {
    const location = `${where}.responses.${code}`;

    if (!(code in currResponses)) {
      if (isSuccessCode(code)) {
        ctx.add(
          'success-response-removed',
          'breaking',
          `Success response ${code} is no longer returned; clients checking for it will misclassify results.`,
          location,
        );
      } else {
        ctx.add(
          'response-removed',
          'warning',
          `Response ${code} is no longer documented.`,
          location,
        );
      }
      continue;
    }

    const baseResponse = deref(baseResponses[code], ctx.baseDoc);
    const currResponse = deref(currResponses[code], ctx.currDoc);
    const baseContent: Json = baseResponse?.content ?? {};
    const currContent: Json = currResponse?.content ?? {};

    for (const mediaType of Object.keys(baseContent)) {
      const mediaLocation = `${location}.${mediaType}`;
      if (!(mediaType in currContent)) {
        ctx.add(
          'response-media-type-removed',
          'breaking',
          `Response media type "${mediaType}" is no longer returned for ${code}.`,
          mediaLocation,
        );
        continue;
      }
      compareSchema(
        baseContent[mediaType]?.schema,
        currContent[mediaType]?.schema,
        'response',
        mediaLocation,
        ctx,
      );
    }
  }

  for (const code of Object.keys(currResponses)) {
    if (!(code in baseResponses) && isSuccessCode(code)) {
      ctx.add('success-response-added', 'info', `New success response ${code}.`, `${where}.responses.${code}`);
    }
  }
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

function compareSchema(
  baseNode: Json | undefined,
  currNode: Json | undefined,
  direction: Direction,
  location: string,
  ctx: Context,
  depth = 0,
  refStack: Set<string> = new Set(),
): void {
  if (!baseNode || !currNode || depth > MAX_SCHEMA_DEPTH) return;

  // Guard against recursive schemas (e.g. a tree node that references itself).
  const refKey =
    typeof baseNode.$ref === 'string' || typeof currNode.$ref === 'string'
      ? `${baseNode.$ref}|${currNode.$ref}`
      : undefined;
  if (refKey) {
    if (refStack.has(refKey)) return;
    refStack.add(refKey);
  }

  try {
    const base = resolveSchema(baseNode, ctx.baseDoc);
    const curr = resolveSchema(currNode, ctx.currDoc);
    if (!base || !curr) return;

    if (base.type && curr.type && base.type !== curr.type) {
      const widening = direction === 'request' && base.type === 'integer' && curr.type === 'number';
      ctx.add(
        'schema-type-changed',
        widening ? 'info' : 'breaking',
        `Type changed from "${base.type}" to "${curr.type}".`,
        location,
      );
      return;
    }

    compareEnum(base, curr, direction, location, ctx);
    compareProperties(base, curr, direction, location, ctx, depth, refStack);

    if (base.items && curr.items) {
      compareSchema(base.items, curr.items, direction, `${location}[]`, ctx, depth + 1, refStack);
    }
  } finally {
    if (refKey) refStack.delete(refKey);
  }
}

function compareEnum(
  base: Json,
  curr: Json,
  direction: Direction,
  location: string,
  ctx: Context,
): void {
  const baseEnum: unknown[] | undefined = Array.isArray(base.enum) ? base.enum : undefined;
  const currEnum: unknown[] | undefined = Array.isArray(curr.enum) ? curr.enum : undefined;

  if (!baseEnum && currEnum) {
    if (direction === 'request') {
      ctx.add(
        'enum-constraint-added',
        'breaking',
        'A free-form request value is now restricted to an enum.',
        location,
      );
    }
    return;
  }
  if (!baseEnum || !currEnum) return;

  const removed = baseEnum.filter((value) => !currEnum.includes(value));
  const added = currEnum.filter((value) => !baseEnum.includes(value));

  if (direction === 'request') {
    if (removed.length > 0) {
      ctx.add(
        'enum-value-removed',
        'breaking',
        `Request values no longer accepted: ${removed.map(String).join(', ')}.`,
        location,
      );
    }
    if (added.length > 0) {
      ctx.add('enum-value-added', 'info', `New accepted request values: ${added.map(String).join(', ')}.`, location);
    }
  } else {
    if (added.length > 0) {
      ctx.add(
        'enum-value-added',
        'warning',
        `Responses may now contain new values clients may not handle: ${added.map(String).join(', ')}.`,
        location,
      );
    }
    if (removed.length > 0) {
      ctx.add('enum-value-removed', 'info', `Response values no longer returned: ${removed.map(String).join(', ')}.`, location);
    }
  }
}

function compareProperties(
  base: Json,
  curr: Json,
  direction: Direction,
  location: string,
  ctx: Context,
  depth: number,
  refStack: Set<string>,
): void {
  const baseProps: Json = base.properties ?? {};
  const currProps: Json = curr.properties ?? {};
  const baseRequired = new Set<string>(asArray(base.required));
  const currRequired = new Set<string>(asArray(curr.required));

  for (const name of Object.keys(baseProps)) {
    const propLocation = `${location}.${name}`;

    if (!(name in currProps)) {
      if (direction === 'response') {
        ctx.add(
          'response-property-removed',
          'breaking',
          `Response property "${name}" is no longer returned.`,
          propLocation,
        );
      } else {
        ctx.add(
          'request-property-removed',
          'warning',
          `Request property "${name}" was removed; clients that still send it will have it ignored.`,
          propLocation,
        );
      }
      continue;
    }

    if (direction === 'request' && !baseRequired.has(name) && currRequired.has(name)) {
      ctx.add(
        'request-property-became-required',
        'breaking',
        `Request property "${name}" is now required.`,
        propLocation,
      );
    }
    if (direction === 'response' && baseRequired.has(name) && !currRequired.has(name)) {
      ctx.add(
        'response-property-became-optional',
        'breaking',
        `Response property "${name}" may now be absent; clients that rely on it will break.`,
        propLocation,
      );
    }

    compareSchema(baseProps[name], currProps[name], direction, propLocation, ctx, depth + 1, refStack);
  }

  for (const name of Object.keys(currProps)) {
    if (name in baseProps) continue;
    const propLocation = `${location}.${name}`;
    if (direction === 'request' && currRequired.has(name)) {
      ctx.add(
        'request-property-required-added',
        'breaking',
        `New required request property "${name}"; existing calls do not send it.`,
        propLocation,
      );
    } else {
      ctx.add('property-added', 'info', `New property "${name}".`, propLocation);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildReport(
  changes: CompatibilityChange[],
  baselineOperations: number,
  currentOperations: number,
  majorVersionBump: boolean,
  options: CompatibilityOptions,
): CompatibilityReport {
  const count = (severity: ChangeSeverity) => changes.filter((c) => c.severity === severity).length;
  const breakingCount = count('breaking');
  const warningCount = count('warning');

  const breakingAllowed = options.allowBreakingOnMajorBump === true && majorVersionBump;
  const hasBlockingBreaking = breakingCount > 0 && !breakingAllowed;
  const hasBlockingWarning = options.strictWarnings === true && warningCount > 0 && !breakingAllowed;

  return {
    compatible: !hasBlockingBreaking && !hasBlockingWarning,
    changes,
    breakingCount,
    warningCount,
    infoCount: count('info'),
    baselineOperations,
    currentOperations,
    majorVersionBump,
  };
}

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

/** `/tx/{id}` and `/tx/{txId}` are the same route. */
function normalizePath(path: string): string {
  return path.replace(/\{[^}]+\}/g, '{}');
}

function isSuccessCode(code: string): boolean {
  if (code === 'default') return false;
  const numeric = Number(code);
  return Number.isFinite(numeric) && numeric >= 200 && numeric < 300;
}

/** An operation needs auth unless it has no requirements or allows anonymous (`{}`). */
function requiresAuth(operation: Json, doc: Json): boolean {
  const security = operation.security ?? doc.security;
  if (!Array.isArray(security) || security.length === 0) return false;
  return !security.some((requirement) => isObject(requirement) && Object.keys(requirement).length === 0);
}

function majorOf(version: unknown): number | undefined {
  if (typeof version !== 'string') return undefined;
  const match = /^v?(\d+)/.exec(version.trim());
  return match ? Number(match[1]) : undefined;
}

function isMajorBump(baseline: unknown, current: unknown): boolean {
  const before = majorOf(baseline);
  const after = majorOf(current);
  return before !== undefined && after !== undefined && after > before;
}

/** Follows local `$ref`s (`#/components/...`); returns undefined if unresolvable or cyclic. */
function deref(node: Json | undefined, doc: Json): Json | undefined {
  let current: Json | undefined = node;
  const seen = new Set<string>();

  for (let hops = 0; hops < MAX_REF_DEPTH; hops++) {
    if (!isObject(current) || typeof current.$ref !== 'string') return current;
    const ref: string = current.$ref;
    if (seen.has(ref)) return undefined;
    seen.add(ref);
    current = lookupRef(ref, doc);
  }
  return undefined;
}

function lookupRef(ref: string, doc: Json): Json | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let node: any = doc;
  for (const segment of ref.slice(2).split('/')) {
    let key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    try {
      key = decodeURIComponent(key);
    } catch {
      // keep the undecoded segment
    }
    node = node?.[key];
    if (node === undefined) return undefined;
  }
  return node;
}

/** Resolves a schema and flattens `allOf` into a single object schema. */
function resolveSchema(node: Json | undefined, doc: Json, depth = 0): Json | undefined {
  const schema = deref(node, doc);
  if (!schema || !Array.isArray(schema.allOf) || depth > 8) return schema;

  const merged: Json = { ...schema, properties: { ...(schema.properties ?? {}) } };
  const required: string[] = [...asArray(schema.required)];
  delete merged.allOf;

  for (const part of schema.allOf) {
    const resolved = resolveSchema(part, doc, depth + 1);
    if (!resolved) continue;
    merged.type ??= resolved.type;
    merged.enum ??= resolved.enum;
    merged.items ??= resolved.items;
    Object.assign(merged.properties, resolved.properties ?? {});
    required.push(...asArray(resolved.required));
  }
  merged.required = required;
  return merged;
}
