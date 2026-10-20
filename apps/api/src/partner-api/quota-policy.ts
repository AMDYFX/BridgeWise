export type PartnerTier = 'free' | 'standard' | 'enterprise';

export interface TierQuota {
  requestsPerMinute: number;
  requestsPerDay: number;
}

export const TIER_QUOTAS: Record<PartnerTier, TierQuota> = {
  free: { requestsPerMinute: 20, requestsPerDay: 1_000 },
  standard: { requestsPerMinute: 120, requestsPerDay: 25_000 },
  enterprise: { requestsPerMinute: 600, requestsPerDay: 500_000 },
};

export interface QuotaDecision {
  allowed: boolean;
  /** Which window blocked the request, if any. */
  limitedBy?: 'minute' | 'day';
  remainingMinute: number;
  remainingDay: number;
  /** Epoch ms when the blocking (or nearest) window resets. */
  resetAt: number;
  retryAfterSeconds: number;
}

const MINUTE = 60_000;
const DAY = 86_400_000;

interface Window {
  start: number;
  count: number;
}

/** Fixed-window quota per partner, sized by the partner's tier. */
export class QuotaPolicy {
  private readonly minute = new Map<string, Window>();
  private readonly day = new Map<string, Window>();

  constructor(private readonly quotas: Record<PartnerTier, TierQuota> = TIER_QUOTAS) {}

  private current(map: Map<string, Window>, partnerId: string, size: number, now: number): Window {
    const start = Math.floor(now / size) * size;
    const existing = map.get(partnerId);
    if (existing && existing.start === start) return existing;
    const fresh = { start, count: 0 };
    map.set(partnerId, fresh);
    return fresh;
  }

  /** Counts the request when allowed; blocked requests do not consume quota. */
  consume(partnerId: string, tier: PartnerTier, now: number): QuotaDecision {
    const quota = this.quotas[tier];
    const minute = this.current(this.minute, partnerId, MINUTE, now);
    const day = this.current(this.day, partnerId, DAY, now);

    const limitedBy = minute.count >= quota.requestsPerMinute ? 'minute' : day.count >= quota.requestsPerDay ? 'day' : undefined;
    if (!limitedBy) {
      minute.count += 1;
      day.count += 1;
    }
    const resetAt = limitedBy === 'day' ? day.start + DAY : minute.start + MINUTE;
    return {
      allowed: !limitedBy,
      limitedBy,
      remainingMinute: Math.max(0, quota.requestsPerMinute - minute.count),
      remainingDay: Math.max(0, quota.requestsPerDay - day.count),
      resetAt,
      retryAfterSeconds: limitedBy ? Math.ceil((resetAt - now) / 1000) : 0,
    };
  }
}
