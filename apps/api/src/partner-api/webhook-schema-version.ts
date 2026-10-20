/** Webhook payload schema versions are dates (YYYY-MM-DD) and compare lexicographically. */
export const SUPPORTED_WEBHOOK_VERSIONS = ['2025-01-15', '2025-09-01'] as const;
export const DEFAULT_WEBHOOK_VERSION = '2025-01-15';

const VERSION_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

export class UnsupportedSchemaVersionError extends Error {
  constructor(
    readonly requested: string[],
    readonly supported: readonly string[],
  ) {
    super(`unsupported webhook schema version(s) ${requested.join(', ')}; supported: ${supported.join(', ')}`);
    this.name = 'UnsupportedSchemaVersionError';
  }
}

/**
 * Picks the schema version for a webhook endpoint. `requested` is the partner's ordered preference
 * (or a single pinned version); the first supported one wins. Nothing requested means the default, so
 * existing endpoints keep receiving the payload shape they were built against.
 */
export function negotiateWebhookVersion(
  requested: string | readonly string[] | undefined,
  supported: readonly string[] = SUPPORTED_WEBHOOK_VERSIONS,
  defaultVersion: string = DEFAULT_WEBHOOK_VERSION,
): string {
  const preferences = (typeof requested === 'string' ? [requested] : [...(requested ?? [])]).map((v) => v.trim());
  if (preferences.length === 0) return defaultVersion;
  const invalid = preferences.filter((v) => !VERSION_FORMAT.test(v));
  if (invalid.length > 0) throw new UnsupportedSchemaVersionError(invalid, supported);
  const match = preferences.find((v) => supported.includes(v));
  if (!match) throw new UnsupportedSchemaVersionError(preferences, supported);
  return match;
}

/** Parses an `X-Webhook-Version: 2025-09-01, 2025-01-15` style header into an ordered preference list. */
export function parseVersionHeader(header: string | undefined): string[] {
  return (header ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}
