import type { JobsOptions } from 'bullmq';
import { type OperationalAlertPayload } from './alert-payload.js';
export type AlertBridgeEnqueue = (name: 'system-alert' | 'expectancy-alert', payload: OperationalAlertPayload, options: JobsOptions) => Promise<unknown>;
export type RedisAlertBridgeDependencies = {
    channel: string;
    enqueue: AlertBridgeEnqueue;
    logRejected?: (message: string, error?: unknown) => void;
};
export type AlertBridgeResult = {
    accepted: true;
    kind: OperationalAlertPayload['kind'];
    deduplicationId: string;
} | {
    accepted: false;
    reason: 'unexpected_channel' | 'invalid_payload';
};
/** One-way bridge from Redis Pub/Sub into the durable BullMQ alert queue. */
export declare function createRedisAlertBridge(dependencies: RedisAlertBridgeDependencies): {
    handleMessage(channel: string, message: string): Promise<AlertBridgeResult>;
};
//# sourceMappingURL=alert-bridge.d.ts.map