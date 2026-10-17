/**
 * File: src/security/alerts/suspicious-transfer-alerting.service.spec.ts
 *
 * Unit and integration tests for suspicious transfer alerting.
 */

import { StellarTransferNotificationService } from '../../notifications/stellar';
import { NotificationPriority } from '../../notifications/stellar/notification.types';
import { createNotificationAlertSink } from './notification-alert-sink';
import { SuspiciousTransferAlertingService } from './suspicious-transfer-alerting.service';
import type {
  SuspiciousTransferAlert,
  SuspiciousTransferAlertingConfig,
  TransferToInspect,
} from './suspicious-transfer.types';

const T0 = 1_700_000_000_000;
const MINUTE = 60 * 1000;

describe('SuspiciousTransferAlertingService', () => {
  let clock = T0;
  let seq = 0;

  const make = (config: SuspiciousTransferAlertingConfig = {}) =>
    new SuspiciousTransferAlertingService({ now: () => clock, ...config });

  const tx = (partial: Partial<TransferToInspect> = {}): TransferToInspect => ({
    transferId: `tx-${++seq}`,
    sender: 'GSENDER',
    recipient: 'GRECIPIENT',
    asset: 'USDC',
    amount: '100',
    ...partial,
  });

  beforeEach(() => {
    clock = T0;
    seq = 0;
  });

  it('does not alert on an ordinary transfer', async () => {
    const service = make({ largeTransferThresholds: { USDC: '10000' } });
    const result = await service.inspect(tx());

    expect(result.suspicious).toBe(false);
    expect(result.alerts).toEqual([]);
    expect(service.getStats()).toMatchObject({ inspected: 1, alertsRaised: 0 });
  });

  it('flags a large transfer at the threshold but not just below it (boundary)', async () => {
    const service = make({ largeTransferThresholds: { USDC: '10000' } });

    const below = await service.inspect(tx({ amount: '9999.99', sender: 'GA' }));
    expect(below.alerts.map((a) => a.rule)).not.toContain('LARGE_TRANSFER');

    const atThreshold = await service.inspect(tx({ amount: '10000', sender: 'GB' }));
    expect(atThreshold.alerts).toHaveLength(1);
    expect(atThreshold.alerts[0]).toMatchObject({
      rule: 'LARGE_TRANSFER',
      severity: 'high',
      details: { threshold: '10000', observed: '10000' },
    });
  });

  it('falls back to the default large-transfer threshold for unlisted assets', async () => {
    const service = make({
      largeTransferThresholds: { USDC: '10000' },
      defaultLargeTransferThreshold: '500',
    });

    const result = await service.inspect(tx({ asset: 'xlm', amount: '500' }));
    expect(result.alerts[0].rule).toBe('LARGE_TRANSFER');
  });

  it('raises a critical alert for a watchlisted sender or recipient, case-insensitively', async () => {
    const service = make({ watchlist: ['GBAD'] });

    const bySender = await service.inspect(tx({ sender: 'gbad' }));
    const byRecipient = await service.inspect(tx({ recipient: 'GBAD' }));

    expect(bySender.alerts[0]).toMatchObject({
      rule: 'WATCHLISTED_ADDRESS',
      severity: 'critical',
      details: { matched: 'sender' },
    });
    expect(byRecipient.alerts[0].details).toEqual({ matched: 'recipient' });
  });

  it('supports updating the watchlist at runtime', async () => {
    const service = make();
    expect((await service.inspect(tx({ recipient: 'GNEW' }))).suspicious).toBe(false);

    service.addToWatchlist('GNEW');
    expect((await service.inspect(tx({ recipient: 'GNEW' }))).suspicious).toBe(true);

    expect(service.removeFromWatchlist('gnew')).toBe(true);
    expect((await service.inspect(tx({ recipient: 'GNEW' }))).suspicious).toBe(false);
  });

  it('alerts on velocity only once the per-window limit is exceeded (boundary)', async () => {
    const service = make({ maxTransfersPerWindow: 3 });

    for (let i = 0; i < 3; i++) {
      expect((await service.inspect(tx())).suspicious).toBe(false);
    }
    const fourth = await service.inspect(tx());

    expect(fourth.alerts).toHaveLength(1);
    expect(fourth.alerts[0]).toMatchObject({
      rule: 'HIGH_VELOCITY',
      severity: 'medium',
      details: { observed: 4, limit: 3 },
    });
  });

  it('rate-limits repeat aggregate alerts with a cooldown, then re-alerts', async () => {
    const service = make({ maxTransfersPerWindow: 1, cooldownMs: 5 * MINUTE });
    await service.inspect(tx());
    expect((await service.inspect(tx())).alerts).toHaveLength(1); // first breach

    const repeat = await service.inspect(tx());
    expect(repeat.alerts).toEqual([]);
    expect(repeat.suppressed).toBe(1);

    clock = T0 + 5 * MINUTE - 1;
    expect((await service.inspect(tx())).suppressed).toBe(1); // still cooling down

    clock = T0 + 5 * MINUTE; // cooldown elapsed exactly
    const after = await service.inspect(tx());
    expect(after.alerts).toHaveLength(1);
    expect(service.getStats().suppressed).toBe(2);
  });

  it('never suppresses per-transfer rules', async () => {
    const service = make({ watchlist: ['GBAD'], cooldownMs: 60 * MINUTE });

    expect((await service.inspect(tx({ sender: 'GBAD' }))).alerts).toHaveLength(1);
    expect((await service.inspect(tx({ sender: 'GBAD' }))).alerts).toHaveLength(1);
  });

  it('alerts when cumulative sender volume exceeds the cap (boundary)', async () => {
    const service = make({ cumulativeVolumeThresholds: { USDC: '1000' } });

    expect((await service.inspect(tx({ amount: '600' }))).suspicious).toBe(false);
    expect((await service.inspect(tx({ amount: '400' }))).suspicious).toBe(false); // == cap
    const over = await service.inspect(tx({ amount: '1' }));

    expect(over.alerts[0]).toMatchObject({
      rule: 'HIGH_CUMULATIVE_VOLUME',
      severity: 'high',
      details: { observed: '1001', threshold: '1000' },
    });
  });

  it('detects structuring: repeated transfers just below the large threshold', async () => {
    const service = make({ largeTransferThresholds: { USDC: '10000' } });

    expect((await service.inspect(tx({ amount: '9000' }))).suspicious).toBe(false);
    expect((await service.inspect(tx({ amount: '8500' }))).suspicious).toBe(false);
    const third = await service.inspect(tx({ amount: '9500' }));

    expect(third.alerts).toHaveLength(1);
    expect(third.alerts[0]).toMatchObject({
      rule: 'STRUCTURING',
      severity: 'high',
      details: { observed: 3, lowerBound: '8000', threshold: '10000' },
    });
  });

  it('ignores transfers below the structuring band', async () => {
    const service = make({ largeTransferThresholds: { USDC: '10000' } });

    for (const amount of ['7999.99', '7999.99', '7999.99', '7999.99']) {
      expect((await service.inspect(tx({ amount }))).suspicious).toBe(false);
    }
  });

  it('drops transfers that fall outside the rolling window (boundary)', async () => {
    const service = make({ windowMs: 1000, maxTransfersPerWindow: 2 });

    await service.inspect(tx({ timestamp: T0 }));
    await service.inspect(tx({ timestamp: T0 + 1 }));
    clock = T0 + 1000; // the T0 transfer is now exactly windowMs old

    const third = await service.inspect(tx({ timestamp: T0 + 1000 }));
    expect(third.suspicious).toBe(false);
  });

  it('raises a MALFORMED_TRANSFER alert instead of skipping bad input', async () => {
    const service = make();

    const badAmount = await service.inspect(tx({ amount: 'abc' }));
    expect(badAmount.alerts[0]).toMatchObject({ rule: 'MALFORMED_TRANSFER', severity: 'medium' });

    const noSender = await service.inspect(tx({ sender: '  ' }));
    expect(noSender.alerts[0].message).toBe('sender is missing');

    const nothing = await service.inspect(null as unknown as TransferToInspect);
    expect(nothing.alerts[0].message).toBe('transfer payload is missing');
    expect(nothing.transferId).toBe('unknown');

    expect(service.getStats().trackedSenders).toBe(0); // bad input is not tracked
  });

  it('isolates failing sinks and still delivers to the rest', async () => {
    const delivered: SuspiciousTransferAlert[] = [];
    const service = make({
      watchlist: ['GBAD'],
      sinks: [
        () => {
          throw new Error('sync sink down');
        },
        async () => {
          throw new Error('async sink down');
        },
        (alert) => {
          delivered.push(alert);
        },
      ],
    });

    const result = await service.inspect(tx({ sender: 'GBAD' }));

    expect(result.suspicious).toBe(true);
    expect(result.sinkFailures).toBe(2);
    expect(delivered).toHaveLength(1);
    expect(service.getStats().sinkFailures).toBe(2);
  });

  it('returns retained alerts newest first with filters and a limit', async () => {
    const service = make({ watchlist: ['GBAD'], largeTransferThresholds: { USDC: '1000' } });
    await service.inspect(tx({ sender: 'GBAD', amount: '1' }));
    await service.inspect(tx({ sender: 'GOTHER', amount: '2000' }));
    await service.inspect(tx({ sender: 'GBAD', amount: '3000' }));

    expect(service.getAlerts().map((a) => a.rule)).toEqual([
      'LARGE_TRANSFER',
      'WATCHLISTED_ADDRESS',
      'LARGE_TRANSFER',
      'WATCHLISTED_ADDRESS',
    ]);
    expect(service.getAlerts({ severity: 'critical' })).toHaveLength(2);
    expect(service.getAlerts({ sender: 'gother' })).toHaveLength(1);
    expect(service.getAlerts({ limit: 1 })).toHaveLength(1);
    expect(service.getAlerts({ limit: 0 })).toEqual([]);
  });

  it('bounds retained alerts and tracked senders', async () => {
    const service = make({ watchlist: ['GBAD'], maxRetainedAlerts: 2, maxTrackedSenders: 2 });

    for (const sender of ['GBAD', 'GBAD', 'GBAD']) {
      await service.inspect(tx({ sender }));
    }
    expect(service.getAlerts()).toHaveLength(2);

    await service.inspect(tx({ sender: 'G1' }));
    await service.inspect(tx({ sender: 'G2' }));
    await service.inspect(tx({ sender: 'G3' }));
    expect(service.getStats().trackedSenders).toBe(2);
  });

  it('fails fast on misconfiguration instead of silently disabling a control', () => {
    expect(() => make({ largeTransferThresholds: { USDC: 'ten thousand' } })).toThrow(/USDC/);
    expect(() => make({ defaultLargeTransferThreshold: '-1' })).toThrow();
    expect(() => make({ windowMs: 0 })).toThrow();
    expect(() => make({ maxTransfersPerWindow: 1.5 })).toThrow();
    expect(() => make({ structuringBandPercent: 100 })).toThrow();
    expect(() => make({ cooldownMs: -1 })).toThrow();
  });

  it('resets history, alerts and counters', async () => {
    const service = make({ watchlist: ['GBAD'] });
    await service.inspect(tx({ sender: 'GBAD' }));

    service.reset();

    expect(service.getAlerts()).toEqual([]);
    expect(service.getStats()).toEqual({
      inspected: 0,
      alertsRaised: 0,
      suppressed: 0,
      sinkFailures: 0,
      trackedSenders: 0,
    });
  });

  describe('integration with the transfer notification service', () => {
    it('forwards alerts as bridge warnings with severity-mapped priority', async () => {
      const notifier = new StellarTransferNotificationService();
      const spy = jest.spyOn(notifier, 'notifyBridgeWarning').mockResolvedValue(undefined);
      const service = make({
        watchlist: ['GBAD'],
        largeTransferThresholds: { USDC: '1000' },
        sinks: [createNotificationAlertSink(notifier)],
      });

      await service.inspect(tx({ transferId: 'tx-critical', sender: 'GBAD', amount: '5' }));
      await service.inspect(tx({ transferId: 'tx-high', amount: '1000' }));

      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          routeId: 'tx-critical',
          status: 'suspicious_transfer:WATCHLISTED_ADDRESS',
          priority: NotificationPriority.CRITICAL,
          details: expect.objectContaining({ rule: 'WATCHLISTED_ADDRESS', asset: 'USDC' }),
        }),
      );
      expect(spy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          routeId: 'tx-high',
          status: 'suspicious_transfer:LARGE_TRANSFER',
          priority: NotificationPriority.HIGH,
          message: expect.stringContaining('[HIGH]'),
        }),
      );
    });

    it('counts a failing notifier as a sink failure without losing the alert', async () => {
      const notifier = {
        notifyBridgeWarning: jest.fn().mockRejectedValue(new Error('delivery down')),
      };
      const service = make({
        watchlist: ['GBAD'],
        sinks: [createNotificationAlertSink(notifier)],
      });

      const result = await service.inspect(tx({ sender: 'GBAD' }));

      expect(result.suspicious).toBe(true);
      expect(result.sinkFailures).toBe(1);
      expect(service.getAlerts()).toHaveLength(1);
    });
  });
});
