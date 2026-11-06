import { describe, expect, it, vi } from 'vitest';
import { createTelegramRobinhoodOpsAlertEmitter } from './ops-alerts.js';
describe('Robinhood ops alert delivery', () => {
    it('delivers a readiness failure through the configured Telegram channel', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
        const emit = createTelegramRobinhoodOpsAlertEmitter({
            botToken: 'bot-token',
            chatId: 'chat-id',
            fetchImpl
        });
        await emit({
            type: 'ROBINHOOD_LIVE_NOT_READY',
            chain: 'robinhood-chain',
            severity: 'critical',
            reason: 'router bytecode missing',
            checkedAt: '2026-07-26T10:00:00.000Z',
            requestedMode: 'live'
        });
        expect(fetchImpl).toHaveBeenCalledWith('https://api.telegram.org/botbot-token/sendMessage', expect.objectContaining({ method: 'POST' }));
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
            chat_id: 'chat-id',
            text: expect.stringContaining('router bytecode missing')
        });
    });
    it('refuses to create a no-op emitter when the channel is not configured', () => {
        expect(() => createTelegramRobinhoodOpsAlertEmitter({ botToken: '', chatId: '' }))
            .toThrow('Telegram ops alert channel is not configured');
    });
});
//# sourceMappingURL=ops-alerts.test.js.map