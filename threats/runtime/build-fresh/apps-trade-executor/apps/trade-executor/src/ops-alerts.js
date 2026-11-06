export function createTelegramRobinhoodOpsAlertEmitter(options) {
    if (!options.botToken.trim() || !options.chatId.trim()) {
        throw new Error('Telegram ops alert channel is not configured');
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    return async (alert) => {
        const text = [
            'SWAT CRITICAL OPS ALERT',
            `Chain: ${alert.chain}`,
            `Requested mode: ${alert.requestedMode}`,
            'Effective mode: paper (startup clamp)',
            `Reason: ${alert.reason}`,
            `Checked at: ${alert.checkedAt}`
        ].join('\n');
        const response = await fetchImpl(`https://api.telegram.org/bot${options.botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: options.chatId, text })
        });
        if (!response.ok) {
            throw new Error(`Telegram ops alert returned HTTP ${response.status}`);
        }
    };
}
//# sourceMappingURL=ops-alerts.js.map