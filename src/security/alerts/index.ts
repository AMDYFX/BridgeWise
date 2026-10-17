/**
 * File: src/security/alerts/index.ts
 *
 * Module barrel for suspicious transfer alerting.
 */

export { SuspiciousTransferAlertingService } from './suspicious-transfer-alerting.service';
export { createNotificationAlertSink, severityToPriority } from './notification-alert-sink';
export type { BridgeWarningNotifier } from './notification-alert-sink';
export type {
  AlertQuery,
  AlertSeverity,
  AlertSink,
  SuspiciousTransferAlert,
  SuspiciousTransferAlertingConfig,
  SuspiciousTransferRule,
  SuspiciousTransferStats,
  TransferInspectionResult,
  TransferToInspect,
} from './suspicious-transfer.types';
