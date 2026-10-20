import { ExecutionCancellation, CancellableExecution } from './execution-cancellation';
import { MissingScopeError, hasScope, requireScopes } from './credential-scopes';
import { QuotaPolicy } from './quota-policy';
import { WebhookEndpointOwnership } from './webhook-endpoint-ownership';

describe('cancellation before irreversible submission', () => {
  function setup(initial: CancellableExecution) {
    let stored = initial;
    const released: string[] = [];
    const service = new ExecutionCancellation(
      (id) => (id === stored.id ? stored : undefined),
      (e) => (stored = e),
      (r) => released.push(r),
    );
    return { service, released, get stored() { return stored; } };
  }

  it('cancels pre-submission executions and releases the reservation once', () => {
    const ctx = setup({ id: 'e1', state: 'reserved', reservationId: 'r1' });
    expect(ctx.service.cancel('e1')).toEqual({ cancelled: true, alreadyCancelled: false, releasedReservation: true });
    expect(ctx.service.cancel('e1')).toEqual({ cancelled: true, alreadyCancelled: true, releasedReservation: false });
    expect(ctx.released).toEqual(['r1']);
    expect(ctx.stored.state).toBe('cancelled');
  });

  it('refuses once submitted or terminal and for unknown executions', () => {
    expect(setup({ id: 'e1', state: 'submitted' }).service.cancel('e1')).toEqual({ cancelled: false, reason: 'irreversible' });
    expect(setup({ id: 'e1', state: 'confirmed' }).service.cancel('e1')).toEqual({ cancelled: false, reason: 'terminal' });
    expect(setup({ id: 'e1', state: 'created' }).service.cancel('nope')).toEqual({ cancelled: false, reason: 'not_found' });
  });
});

describe('partner credential scopes', () => {
  const credential = { partnerId: 'p1', scopes: ['quotes:read', 'executions:*'] };

  it('supports exact, resource wildcard and global grants', () => {
    expect(hasScope(credential.scopes, 'quotes:read')).toBe(true);
    expect(hasScope(credential.scopes, 'executions:cancel')).toBe(true);
    expect(hasScope(credential.scopes, 'webhooks:manage')).toBe(false);
    expect(hasScope(['*'], 'webhooks:manage')).toBe(true);
    expect(hasScope(['quotes:*'], 'quotes')).toBe(false);
  });

  it('names exactly the missing scopes', () => {
    expect(() => requireScopes(credential, ['quotes:read', 'executions:create'])).not.toThrow();
    try {
      requireScopes(credential, ['webhooks:manage', 'sandbox:use', 'quotes:read']);
      fail('expected MissingScopeError');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingScopeError);
      expect((err as MissingScopeError).missing).toEqual(['webhooks:manage', 'sandbox:use']);
    }
  });
});

describe('quota policy by tier', () => {
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);

  it('enforces the per-minute limit for the tier and resets next minute', () => {
    const policy = new QuotaPolicy();
    for (let i = 0; i < 20; i++) expect(policy.consume('p1', 'free', t0).allowed).toBe(true);
    const blocked = policy.consume('p1', 'free', t0 + 1_000);
    expect(blocked).toMatchObject({ allowed: false, limitedBy: 'minute', retryAfterSeconds: 59 });
    expect(policy.consume('p1', 'free', t0 + 60_000).allowed).toBe(true);
  });

  it('gives higher tiers more room and isolates partners', () => {
    const policy = new QuotaPolicy();
    for (let i = 0; i < 20; i++) policy.consume('p1', 'free', t0);
    expect(policy.consume('p1', 'free', t0).allowed).toBe(false);
    expect(policy.consume('p2', 'standard', t0).allowed).toBe(true);
    for (let i = 0; i < 100; i++) policy.consume('p3', 'enterprise', t0);
    expect(policy.consume('p3', 'enterprise', t0).allowed).toBe(true);
  });

  it('enforces the daily limit and does not charge blocked requests', () => {
    const policy = new QuotaPolicy({ ...{ free: { requestsPerMinute: 100, requestsPerDay: 3 } }, standard: { requestsPerMinute: 1, requestsPerDay: 1 }, enterprise: { requestsPerMinute: 1, requestsPerDay: 1 } });
    for (let i = 0; i < 3; i++) expect(policy.consume('p', 'free', t0 + i * 61_000).allowed).toBe(true);
    const blocked = policy.consume('p', 'free', t0 + 4 * 61_000);
    expect(blocked).toMatchObject({ allowed: false, limitedBy: 'day', remainingDay: 0 });
    expect(policy.consume('p', 'free', t0 + 86_400_000).allowed).toBe(true);
  });
});

describe('webhook endpoint ownership verification', () => {
  const secret = 'a-sufficiently-long-secret';

  it('verifies only with the correct HMAC response and only for the owning partner', () => {
    const ownership = new WebhookEndpointOwnership(secret);
    const endpoint = ownership.register('w1', 'p1', 'https://partner.example/hooks');
    expect(ownership.canDeliver('w1')).toBe(false);
    expect(ownership.verify('w1', 'p1', 'wrong')).toBe(false);
    const good = ownership.expectedResponse('w1', endpoint.challenge);
    expect(ownership.verify('w1', 'p2', good)).toBe(false);
    expect(ownership.verify('w1', 'p1', good)).toBe(true);
    expect(ownership.canDeliver('w1')).toBe(true);
  });

  it('expires challenges, requires https and rejects weak secrets', () => {
    let clock = 0;
    const ownership = new WebhookEndpointOwnership(secret, () => clock);
    const endpoint = ownership.register('w1', 'p1', 'https://partner.example/hooks');
    clock = 16 * 60_000;
    expect(ownership.verify('w1', 'p1', ownership.expectedResponse('w1', endpoint.challenge))).toBe(false);
    expect(() => ownership.register('w2', 'p1', 'http://partner.example')).toThrow('https');
    expect(() => new WebhookEndpointOwnership('short')).toThrow('too short');
  });
});
