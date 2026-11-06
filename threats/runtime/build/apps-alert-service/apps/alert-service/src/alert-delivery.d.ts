import { type SignalAlertPayload } from './alert-payload.js';
export type AlertDeliveryDependencies = {
    deliverSignal: (payload: SignalAlertPayload) => Promise<unknown>;
    sendOperational: (message: string) => Promise<void>;
};
export declare function deliverQueuedAlert(value: unknown, dependencies: AlertDeliveryDependencies): Promise<unknown>;
//# sourceMappingURL=alert-delivery.d.ts.map