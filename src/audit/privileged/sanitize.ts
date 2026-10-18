/**
 * File: src/audit/privileged/sanitize.ts
 *
 * Parameter sanitization and canonical serialization for privileged action
 * audit entries.
 *
 * - `sanitizeParams` makes arbitrary caller input safe to persist: secrets are
 *   redacted by key name, values are converted to JSON-safe forms, and depth
 *   and string length are capped so a hostile or cyclic payload cannot bloat
 *   or crash the log.
 * - `canonicalize` produces a deterministic JSON string (sorted keys) so the
 *   same entry always hashes to the same value.
 */

export const REDACTED = '[REDACTED]';

const MAX_DEPTH = 6;
const MAX_STRING_LENGTH = 1024;
const MAX_KEYS = 100;
const MAX_ARRAY_ITEMS = 100;

/** Built-in patterns for key names whose values must never be logged. */
const DEFAULT_REDACT_KEYS: RegExp[] = [
  /secret/i,
  /password/i,
  /passphrase/i,
  /private[-_]?key/i,
  /mnemonic/i,
  /seed/i,
  /api[-_]?key/i,
  /authorization/i,
  /access[-_]?token/i,
  /refresh[-_]?token/i,
  /bearer/i,
  /credential/i,
];

/** Sanitize a params object into a JSON-safe, redacted, bounded copy. */
export function sanitizeParams(
  params: Record<string, unknown> | undefined,
  extraRedactKeys: RegExp[] = [],
): Record<string, unknown> {
  if (params === undefined || params === null) return {};
  const patterns = [...DEFAULT_REDACT_KEYS, ...extraRedactKeys];
  const result = sanitizeValue(params, patterns, 0);
  return result !== null && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : { value: result };
}

function sanitizeValue(value: unknown, patterns: RegExp[], depth: number): unknown {
  if (value === null || value === undefined) return null;

  switch (typeof value) {
    case 'string':
      return value.length > MAX_STRING_LENGTH
        ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated ${value.length - MAX_STRING_LENGTH}]`
        : value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'function':
    case 'symbol':
      return '[Unserializable]';
  }

  if (depth >= MAX_DEPTH) return '[Truncated]';

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  if (value instanceof Error) {
    return { name: value.name, message: sanitizeValue(value.message, patterns, depth + 1) };
  }
  if (value instanceof Set) {
    return sanitizeValue([...value], patterns, depth);
  }
  if (value instanceof Map) {
    return sanitizeValue(Object.fromEntries(value), patterns, depth);
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((v) => sanitizeValue(v, patterns, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[${value.length - MAX_ARRAY_ITEMS} more]`);
    return items;
  }

  const out: Record<string, unknown> = {};
  const keys = Object.keys(value as Record<string, unknown>);
  for (const key of keys.slice(0, MAX_KEYS)) {
    if (key === '__proto__') continue;
    out[key] = patterns.some((p) => p.test(key))
      ? REDACTED
      : sanitizeValue((value as Record<string, unknown>)[key], patterns, depth + 1);
  }
  if (keys.length > MAX_KEYS) out['…'] = `[${keys.length - MAX_KEYS} more keys]`;
  return out;
}

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.keys(source)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys(source[key]);
        return acc;
      }, {});
  }
  return value;
}

/** Recursively freeze a value so stored entries cannot be mutated in place. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}
