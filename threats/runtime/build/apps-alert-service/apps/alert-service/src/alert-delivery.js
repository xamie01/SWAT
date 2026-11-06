import { formatOperationalAlert, parseQueuedAlertPayload } from './alert-payload.js';
export async function deliverQueuedAlert(value, dependencies) {
    const payload = parseQueuedAlertPayload(value);
    if (payload.kind === 'signal') {
        return dependencies.deliverSignal(payload);
    }
    const message = formatOperationalAlert(payload);
    await dependencies.sendOperational(message);
    return { sent: true, kind: payload.kind };
}
//# sourceMappingURL=alert-delivery.js.map