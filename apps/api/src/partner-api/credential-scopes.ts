export type Scope =
  | 'quotes:read'
  | 'executions:read'
  | 'executions:create'
  | 'executions:cancel'
  | 'webhooks:manage'
  | 'sandbox:use';

export interface PartnerCredential {
  partnerId: string;
  /** Granted scopes; `resource:*` grants every action on a resource, `*` grants everything. */
  scopes: readonly string[];
}

export class MissingScopeError extends Error {
  constructor(readonly missing: string[]) {
    super(`credential is missing required scope(s): ${missing.join(', ')}`);
    this.name = 'MissingScopeError';
  }
}

export function hasScope(granted: readonly string[], required: string): boolean {
  if (granted.includes('*') || granted.includes(required)) return true;
  if (!required.includes(':')) return false;
  const [resource] = required.split(':');
  return granted.includes(`${resource}:*`);
}

/** Least privilege: every required scope must be granted; the error names exactly what is missing. */
export function requireScopes(credential: PartnerCredential, required: readonly string[]): void {
  const missing = required.filter((scope) => !hasScope(credential.scopes, scope));
  if (missing.length > 0) throw new MissingScopeError(missing);
}
