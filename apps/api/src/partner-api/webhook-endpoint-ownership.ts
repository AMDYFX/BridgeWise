import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type EndpointStatus = 'pending' | 'verified';

export interface WebhookEndpoint {
  id: string;
  partnerId: string;
  url: string;
  status: EndpointStatus;
  challenge: string;
  challengeExpiresAt: number;
}

const CHALLENGE_TTL_MS = 15 * 60_000;

/**
 * Proves a partner controls the endpoint it registers: we send a challenge to the URL and the endpoint
 * must echo back the HMAC of that challenge. Deliveries are only allowed to verified endpoints.
 */
export class WebhookEndpointOwnership {
  private readonly endpoints = new Map<string, WebhookEndpoint>();

  constructor(
    private readonly secret: string,
    private readonly now: () => number = Date.now,
  ) {
    if (secret.length < 16) throw new Error('verification secret is too short');
  }

  /** The value a legitimate endpoint must return for a challenge. */
  expectedResponse(endpointId: string, challenge: string): string {
    return createHmac('sha256', this.secret).update(`${endpointId}.${challenge}`).digest('hex');
  }

  register(id: string, partnerId: string, url: string): WebhookEndpoint {
    if (new URL(url).protocol !== 'https:') throw new Error('webhook endpoints must use https');
    const endpoint: WebhookEndpoint = {
      id,
      partnerId,
      url,
      status: 'pending',
      challenge: randomBytes(24).toString('hex'),
      challengeExpiresAt: this.now() + CHALLENGE_TTL_MS,
    };
    this.endpoints.set(id, endpoint);
    return endpoint;
  }

  verify(id: string, partnerId: string, response: string): boolean {
    const endpoint = this.endpoints.get(id);
    if (!endpoint || endpoint.partnerId !== partnerId) return false;
    if (endpoint.status === 'verified') return true;
    if (this.now() > endpoint.challengeExpiresAt) return false;
    const expected = Buffer.from(this.expectedResponse(id, endpoint.challenge));
    const given = Buffer.from(response);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    endpoint.status = 'verified';
    return true;
  }

  canDeliver(id: string): boolean {
    return this.endpoints.get(id)?.status === 'verified';
  }
}
