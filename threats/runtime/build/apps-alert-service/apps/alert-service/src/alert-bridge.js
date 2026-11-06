import { createHash } from 'node:crypto';
import { AlertPayloadValidationError, parsePublishedAlertMessage } from './alert-payload.js';
const DEDUPLICATION_TTL_MS = 5 * 60_000;
function deduplicationId(payload) {
    return createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('hex');
}
/** One-way bridge from Redis Pub/Sub into the durable BullMQ alert queue. */
export function createRedisAlertBridge(dependencies) {
    return {
        async handleMessage(channel, message) {
            if (channel !== dependencies.channel) {
                return { accepted: false, reason: 'unexpected_channel' };
            }
            let payload;
            try {
                payload = parsePublishedAlertMessage(message);
            }
            catch (error) {
                const reason = error instanceof AlertPayloadValidationError
                    ? error.message
                    : 'unexpected alert validation failure';
                dependencies.logRejected?.(`[alert-service] rejected published alert: ${reason}`, error);
                return { accepted: false, reason: 'invalid_payload' };
            }
            const id = deduplicationId(payload);
            await dependencies.enqueue(payload.kind === 'expectancy' ? 'expectancy-alert' : 'system-alert', payload, {
                attempts: 4,
                backoff: { type: 'exponential', delay: 2_000 },
                deduplication: { id, ttl: DEDUPLICATION_TTL_MS },
                removeOnComplete: true,
                removeOnFail: 1_000
            });
            return { accepted: true, kind: payload.kind, deduplicationId: id };
        }
    };
}
//# sourceMappingURL=alert-bridge.js.map