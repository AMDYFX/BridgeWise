import {
  StellarSequenceReservationService,
  SequenceReservationLimitError,
} from './stellar-sequence-reservation';

describe('StellarSequenceReservationService', () => {
  let clock = 1_000;
  const now = () => clock;
  let service: StellarSequenceReservationService;

  const testAccount1 = 'GA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5CWL5GZAIBWKGCA3';
  const testAccount2 = 'GB3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5CWL5GZAIBWKGCB4';

  beforeEach(() => {
    clock = 1_000;
    service = new StellarSequenceReservationService({
      defaultTtlMs: 10_000,
      maxActiveReservationsPerAccount: 5,
      now,
    });
  });

  describe('monotonic sequence reservation', () => {
    it('allocates strictly increasing sequences for concurrent workers', () => {
      service.syncBaseSequence(testAccount1, 100n);

      const r1 = service.reserve(testAccount1, 'tx-1');
      const r2 = service.reserve(testAccount1, 'tx-2');
      const r3 = service.reserve(testAccount1, 'tx-3');

      expect(r1.sequence).toBe(101n);
      expect(r2.sequence).toBe(102n);
      expect(r3.sequence).toBe(103n);

      const state = service.getState(testAccount1);
      expect(state?.highestReserved).toBe(103n);
      expect(state?.activeCount).toBe(3);
    });

    it('is idempotent per reservationId', () => {
      service.syncBaseSequence(testAccount1, 500n);

      const first = service.reserve(testAccount1, 'tx-idem');
      const second = service.reserve(testAccount1, 'tx-idem');

      expect(first.sequence).toBe(501n);
      expect(second.sequence).toBe(501n);
      expect(first).toBe(second);

      const state = service.getState(testAccount1);
      expect(state?.activeCount).toBe(1);
    });

    it('keeps accounts independent', () => {
      service.syncBaseSequence(testAccount1, 100n);
      service.syncBaseSequence(testAccount2, 900n);

      const rA = service.reserve(testAccount1, 'tx-a');
      const rB = service.reserve(testAccount2, 'tx-b');

      expect(rA.sequence).toBe(101n);
      expect(rB.sequence).toBe(901n);
    });
  });

  describe('release and rollback behavior', () => {
    it('rolls back highestReserved when releasing the latest reserved sequence', () => {
      service.syncBaseSequence(testAccount1, 200n);

      service.reserve(testAccount1, 'tx-1'); // 201
      service.reserve(testAccount1, 'tx-2'); // 202

      expect(service.getState(testAccount1)?.highestReserved).toBe(202n);

      // Releasing 202 (top of the stack) rolls back highestReserved to 201
      const released = service.release(testAccount1, 202n, 'rejected');
      expect(released).toBe(true);

      const state = service.getState(testAccount1);
      expect(state?.highestReserved).toBe(201n);
      expect(state?.gaps).toHaveLength(0);

      // Next reservation re-allocates 202 cleanly
      const r3 = service.reserve(testAccount1, 'tx-3');
      expect(r3.sequence).toBe(202n);
    });

    it('flags a sequence gap when a middle reservation is released', () => {
      service.syncBaseSequence(testAccount1, 300n);

      service.reserve(testAccount1, 'tx-1'); // 301
      service.reserve(testAccount1, 'tx-2'); // 302
      service.reserve(testAccount1, 'tx-3'); // 303

      // Releasing middle sequence 302 leaves a gap between 301 and 303
      service.release(testAccount1, 302n, 'network_timeout');

      const state = service.getState(testAccount1);
      expect(state?.highestReserved).toBe(303n);
      expect(state?.gaps).toEqual([302n]);
    });
  });

  describe('TTL expiration', () => {
    it('expires stale reservations past TTL and returns/rolls back sequence', () => {
      service.syncBaseSequence(testAccount1, 400n);

      service.reserve(testAccount1, 'tx-exp', 400n, 5_000); // Expires at 6_000

      clock = 5_000;
      expect(service.expireDue(testAccount1)).toHaveLength(0);

      clock = 7_000; // Past 6_000
      const expired = service.expireDue(testAccount1);
      expect(expired).toHaveLength(1);
      expect(expired[0].id).toBe('tx-exp');
      expect(expired[0].status).toBe('expired');

      // Top sequence rolled back
      expect(service.getState(testAccount1)?.highestReserved).toBe(400n);
    });
  });

  describe('confirmation and on-chain sync', () => {
    it('confirms sequence and advances base sequence', () => {
      service.syncBaseSequence(testAccount1, 10n);
      service.reserve(testAccount1, 'tx-1'); // 11

      const confirmed = service.confirm(testAccount1, 11n);
      expect(confirmed).toBe(true);

      const state = service.getState(testAccount1);
      expect(state?.baseSequence).toBe(11n);
      expect(state?.activeCount).toBe(0);
    });

    it('clears stale reservations below updated on-chain baseSequence', () => {
      service.syncBaseSequence(testAccount1, 100n);
      service.reserve(testAccount1, 'tx-1'); // 101
      service.reserve(testAccount1, 'tx-2'); // 102

      // Chain advanced to 105 through external transaction
      service.syncBaseSequence(testAccount1, 105n);

      const state = service.getState(testAccount1);
      expect(state?.baseSequence).toBe(105n);
      expect(state?.highestReserved).toBe(105n);
      expect(state?.activeCount).toBe(0);
    });
  });

  describe('concurrency limit protection', () => {
    it('rejects reservation when active limit is reached', () => {
      service.syncBaseSequence(testAccount1, 0n);

      for (let i = 0; i < 5; i++) {
        service.reserve(testAccount1, `tx-${i}`);
      }

      // Max limit is 5
      expect(() => service.reserve(testAccount1, 'tx-overflow')).toThrow(
        SequenceReservationLimitError,
      );
    });
  });
});
