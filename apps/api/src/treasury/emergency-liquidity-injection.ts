import { PoolKey, poolKey } from './liquidity-reservation';

export type InjectionStatus = 'pending' | 'approved' | 'rejected';

export interface InjectionRequest {
  id: string;
  pool: PoolKey;
  amount: bigint;
  reason: string;
  requestedBy: string;
  status: InjectionStatus;
  decidedBy?: string;
  decidedAt?: number;
}

export interface AuditEntry {
  at: number;
  action: 'requested' | 'approved' | 'rejected';
  requestId: string;
  actor: string;
}

/**
 * Emergency liquidity injection with a two-person rule: the approver must differ from the requester.
 * Approval credits the pool exactly once; repeating an approval is a no-op, and every step is audited.
 */
export class EmergencyLiquidityInjection {
  private readonly requests = new Map<string, InjectionRequest>();
  readonly audit: AuditEntry[] = [];

  constructor(
    private readonly totals: Map<string, bigint>,
    private readonly now: () => number = Date.now,
    private readonly maxPerInjection: bigint = 10n ** 30n,
  ) {}

  request(id: string, pool: PoolKey, amount: bigint, reason: string, requestedBy: string): InjectionRequest {
    const existing = this.requests.get(id);
    if (existing) return existing;
    if (amount <= 0n || amount > this.maxPerInjection) throw new Error('injection amount out of bounds');
    if (!reason.trim()) throw new Error('a reason is required');
    const request: InjectionRequest = { id, pool, amount, reason, requestedBy, status: 'pending' };
    this.requests.set(id, request);
    this.audit.push({ at: this.now(), action: 'requested', requestId: id, actor: requestedBy });
    return request;
  }

  approve(id: string, approver: string): InjectionRequest {
    const request = this.mustGet(id);
    if (request.status === 'approved') return request;
    if (request.status !== 'pending') throw new Error(`request ${id} is ${request.status}`);
    if (approver === request.requestedBy) throw new Error('approver must differ from requester');
    request.status = 'approved';
    request.decidedBy = approver;
    request.decidedAt = this.now();
    const key = poolKey(request.pool);
    this.totals.set(key, (this.totals.get(key) ?? 0n) + request.amount);
    this.audit.push({ at: request.decidedAt, action: 'approved', requestId: id, actor: approver });
    return request;
  }

  reject(id: string, approver: string): InjectionRequest {
    const request = this.mustGet(id);
    if (request.status !== 'pending') throw new Error(`request ${id} is ${request.status}`);
    request.status = 'rejected';
    request.decidedBy = approver;
    request.decidedAt = this.now();
    this.audit.push({ at: request.decidedAt, action: 'rejected', requestId: id, actor: approver });
    return request;
  }

  private mustGet(id: string): InjectionRequest {
    const request = this.requests.get(id);
    if (!request) throw new Error(`unknown injection request ${id}`);
    return request;
  }
}
