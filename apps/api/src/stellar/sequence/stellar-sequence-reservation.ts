/**
 * Stellar Account Sequence Reservation Service.
 *
 * Atomically manages and allocates monotonic sequence numbers for Stellar source accounts
 * across concurrent bridge execution workers. Prevents sequence collisions (txBadSeq),
 * handles TTL expiration, and tracks sequence gaps for operator reconciliation.
 *
 * @see Issue #1326 — Implement Stellar account sequence reservation
 */

export type SequenceReservationStatus = 'active' | 'confirmed' | 'released' | 'expired';

export interface SequenceReservation {
  id: string;
  accountId: string;
  sequence: bigint;
  reservedAt: number;
  expiresAt: number;
  status: SequenceReservationStatus;
  releaseReason?: string;
}

export interface AccountSequenceState {
  accountId: string;
  baseSequence: bigint;
  highestReserved: bigint;
  activeCount: number;
  gaps: bigint[];
}

export interface SequenceReservationConfig {
  defaultTtlMs?: number;
  maxActiveReservationsPerAccount?: number;
  now?: () => number;
}

export class SequenceReservationLimitError extends Error {
  constructor(accountId: string, limit: number) {
    super(`Active sequence reservation limit reached (${limit}) for account ${accountId}`);
    this.name = 'SequenceReservationLimitError';
  }
}

export class SequenceGapDetectedError extends Error {
  constructor(accountId: string, gapSequence: bigint) {
    super(`Sequence gap detected for account ${accountId} at sequence ${gapSequence}`);
    this.name = 'SequenceGapDetectedError';
  }
}

export class StellarSequenceReservationService {
  private readonly accounts = new Map<
    string,
    {
      baseSequence: bigint;
      highestReserved: bigint;
      reservations: Map<string, SequenceReservation>;
      sequenceToId: Map<bigint, string>;
      gaps: Set<bigint>;
    }
  >();

  private readonly defaultTtlMs: number;
  private readonly maxActiveLimit: number;
  private readonly now: () => number;

  constructor(config: SequenceReservationConfig = {}) {
    this.defaultTtlMs = config.defaultTtlMs ?? 30_000;
    this.maxActiveLimit = config.maxActiveReservationsPerAccount ?? 100;
    this.now = config.now ?? Date.now;
  }

  private getOrCreateAccount(accountId: string, initialBaseSequence: bigint = 0n) {
    let account = this.accounts.get(accountId);
    if (!account) {
      account = {
        baseSequence: initialBaseSequence,
        highestReserved: initialBaseSequence,
        reservations: new Map(),
        sequenceToId: new Map(),
        gaps: new Set(),
      };
      this.accounts.set(accountId, account);
    }
    return account;
  }

  /**
   * Initializes or synchronizes the on-chain base sequence for an account.
   */
  syncBaseSequence(accountId: string, onChainSequence: bigint): void {
    if (onChainSequence < 0n) throw new RangeError('onChainSequence must be non-negative');
    const account = this.getOrCreateAccount(accountId, onChainSequence);

    account.baseSequence = onChainSequence;
    if (account.highestReserved < onChainSequence) {
      account.highestReserved = onChainSequence;
    }

    // Clear any reservations and gaps strictly at or below on-chain sequence
    for (const [id, r] of Array.from(account.reservations.entries())) {
      if (r.sequence <= onChainSequence) {
        account.reservations.delete(id);
        account.sequenceToId.delete(r.sequence);
      }
    }
    for (const gap of Array.from(account.gaps)) {
      if (gap <= onChainSequence) {
        account.gaps.delete(gap);
      }
    }
  }

  /**
   * Atomically reserves the next available sequence number for an account.
   * Idempotent per reservationId (txId).
   */
  reserve(
    accountId: string,
    reservationId: string,
    initialBaseSequence: bigint = 0n,
    ttlMs: number = this.defaultTtlMs,
  ): SequenceReservation {
    if (!accountId || accountId.length < 5) throw new Error('Invalid accountId');
    if (!reservationId) throw new Error('reservationId is required');

    const account = this.getOrCreateAccount(accountId, initialBaseSequence);

    // Idempotency: return existing reservation if still active
    const existing = account.reservations.get(reservationId);
    if (existing && existing.status === 'active') {
      return existing;
    }

    this.expireDue(accountId);

    // Count currently active reservations
    let activeCount = 0;
    for (const r of account.reservations.values()) {
      if (r.status === 'active') activeCount++;
    }

    if (activeCount >= this.maxActiveLimit) {
      throw new SequenceReservationLimitError(accountId, this.maxActiveLimit);
    }

    // Allocate next sequence strictly greater than highest reserved and baseSequence
    const nextSequence = (account.highestReserved > account.baseSequence
      ? account.highestReserved
      : account.baseSequence) + 1n;

    account.highestReserved = nextSequence;

    const reservation: SequenceReservation = {
      id: reservationId,
      accountId,
      sequence: nextSequence,
      reservedAt: this.now(),
      expiresAt: this.now() + ttlMs,
      status: 'active',
    };

    account.reservations.set(reservationId, reservation);
    account.sequenceToId.set(nextSequence, reservationId);

    return reservation;
  }

  /**
   * Confirms that a reserved sequence was successfully submitted and included in a ledger.
   */
  confirm(accountId: string, sequence: bigint): boolean {
    const account = this.accounts.get(accountId);
    if (!account) return false;

    const id = account.sequenceToId.get(sequence);
    if (!id) return false;

    const r = account.reservations.get(id);
    if (!r) return false;

    r.status = 'confirmed';
    if (sequence > account.baseSequence) {
      account.baseSequence = sequence;
    }

    account.reservations.delete(id);
    account.sequenceToId.delete(sequence);
    account.gaps.delete(sequence);
    return true;
  }

  /**
   * Releases a sequence when a transaction fails or is cancelled before submission.
   * If top-of-stack, decrements highestReserved.
   * If middle-of-stack, marks a gap so operators/reconcilers can heal it.
   */
  release(accountId: string, sequence: bigint, reason: string = 'cancelled'): boolean {
    const account = this.accounts.get(accountId);
    if (!account) return false;

    const id = account.sequenceToId.get(sequence);
    if (!id) return false;

    const r = account.reservations.get(id);
    if (!r || r.status !== 'active') return false;

    r.status = 'released';
    r.releaseReason = reason;

    account.reservations.delete(id);
    account.sequenceToId.delete(sequence);

    // If releasing the highest reserved sequence, roll it back safely
    if (sequence === account.highestReserved) {
      account.highestReserved = sequence - 1n;
    } else if (sequence > account.baseSequence) {
      // Middle sequence was released: marks a gap!
      account.gaps.add(sequence);
    }

    return true;
  }

  /**
   * Sweeps and expires stale active reservations past their TTL.
   */
  expireDue(accountId?: string): SequenceReservation[] {
    const now = this.now();
    const expired: SequenceReservation[] = [];

    const accountsToCheck = accountId
      ? [this.accounts.get(accountId)].filter(Boolean)
      : Array.from(this.accounts.values());

    for (const account of accountsToCheck) {
      if (!account) continue;
      for (const [id, r] of Array.from(account.reservations.entries())) {
        if (r.status === 'active' && r.expiresAt <= now) {
          r.status = 'expired';
          r.releaseReason = 'ttl_expired';
          expired.push(r);

          account.reservations.delete(id);
          account.sequenceToId.delete(r.sequence);

          if (r.sequence === account.highestReserved) {
            account.highestReserved = r.sequence - 1n;
          } else if (r.sequence > account.baseSequence) {
            account.gaps.add(r.sequence);
          }
        }
      }
    }

    return expired;
  }

  /**
   * Gets account sequence state for diagnostics and health monitoring.
   */
  getState(accountId: string): AccountSequenceState | null {
    const account = this.accounts.get(accountId);
    if (!account) return null;

    let activeCount = 0;
    for (const r of account.reservations.values()) {
      if (r.status === 'active') activeCount++;
    }

    return {
      accountId,
      baseSequence: account.baseSequence,
      highestReserved: account.highestReserved,
      activeCount,
      gaps: Array.from(account.gaps).sort((a, b) => (a < b ? -1 : 1)),
    };
  }
}
