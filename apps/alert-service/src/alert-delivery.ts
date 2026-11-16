import {
  formatOperationalAlert,
  parseQueuedAlertPayload,
  type SignalAlertPayload
} from './alert-payload.js';

import { deliverSignalNotification, type SignalNotificationDependencies } from './package24-delivery-notification.js';

export type AlertDeliveryDependencies = {
  deliverSignal?: (payload: SignalAlertPayload) => Promise<unknown>;
  notification?: SignalNotificationDependencies;
  sendOperational: (message: string) => Promise<void>;
};

export async function deliverQueuedAlert(
  value: unknown,
  dependencies: AlertDeliveryDependencies
): Promise<unknown> {
  const payload = parseQueuedAlertPayload(value);
  if (payload.kind === 'signal') {
    if (dependencies.notification) return deliverSignalNotification(payload, dependencies.notification);
    if (!dependencies.deliverSignal) throw new Error('durable signal notification adapter unavailable');
    return dependencies.deliverSignal(payload);
  }

  const message = formatOperationalAlert(payload);
  await dependencies.sendOperational(message);
  return { sent: true, kind: payload.kind };
}
