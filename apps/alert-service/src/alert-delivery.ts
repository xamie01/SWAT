import {
  formatOperationalAlert,
  parseQueuedAlertPayload,
  type SignalAlertPayload
} from './alert-payload.js';

export type AlertDeliveryDependencies = {
  deliverSignal: (payload: SignalAlertPayload) => Promise<unknown>;
  sendOperational: (message: string) => Promise<void>;
};

export async function deliverQueuedAlert(
  value: unknown,
  dependencies: AlertDeliveryDependencies
): Promise<unknown> {
  const payload = parseQueuedAlertPayload(value);
  if (payload.kind === 'signal') {
    return dependencies.deliverSignal(payload);
  }

  const message = formatOperationalAlert(payload);
  await dependencies.sendOperational(message);
  return { sent: true, kind: payload.kind };
}
