/**
 * File: src/security/alerts/notification-alert-sink.ts
 *
 * Adapter that delivers suspicious transfer alerts through the Stellar
 * transfer notification service as `bridge.warning` notifications.
 *
 * The notifier is typed structurally so any object exposing
 * `notifyBridgeWarning` (the real `StellarTransferNotificationService`, or a
 * test double) can be used without a hard dependency on its construction.
 */

import { NotificationPriority } from '../../notifications/stellar/notification.types';
import type {
  AlertSeverity,
  AlertSink,
  SuspiciousTransferAlert,
} from './suspicious-transfer.types';

/** The slice of the notification service this adapter relies on. */
export interface BridgeWarningNotifier {
  notifyBridgeWarning(data: {
    routeId: string;
    status: string;
    message: string;
    priority?: NotificationPriority;
    details?: Record<string, unknown>;
  }): Promise<void>;
}

const PRIORITY_BY_SEVERITY: Record<AlertSeverity, NotificationPriority> = {
  low: NotificationPriority.LOW,
  medium: NotificationPriority.MEDIUM,
  high: NotificationPriority.HIGH,
  critical: NotificationPriority.CRITICAL,
};

/** Map an alert severity to the notification priority used for delivery. */
export function severityToPriority(severity: AlertSeverity): NotificationPriority {
  return PRIORITY_BY_SEVERITY[severity];
}

/** Create an {@link AlertSink} that forwards alerts to the notification service. */
export function createNotificationAlertSink(notifier: BridgeWarningNotifier): AlertSink {
  return async (alert: SuspiciousTransferAlert) => {
    await notifier.notifyBridgeWarning({
      routeId: alert.transferId,
      status: `suspicious_transfer:${alert.rule}`,
      message: `[${alert.severity.toUpperCase()}] ${alert.message}`,
      priority: severityToPriority(alert.severity),
      details: {
        alertId: alert.id,
        rule: alert.rule,
        sender: alert.sender,
        recipient: alert.recipient,
        asset: alert.asset,
        amount: alert.amount,
        ...alert.details,
      },
    });
  };
}
