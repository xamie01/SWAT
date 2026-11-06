import { assessPusdWithdrawalPath } from '@swat/shared';
export function formatPusdOpsMessage(verdict) {
    const isImpaired = verdict.outcome === 'impaired';
    const heading = isImpaired
        ? 'SWAT PUSD WITHDRAWAL IMPAIRMENT ALERT'
        : 'SWAT PUSD WITHDRAWAL STATUS';
    const lines = [
        `<b>${heading}</b>`,
        '',
        `<b>Outcome:</b> ${verdict.outcome.toUpperCase()}`,
        `<b>Reason Code:</b> ${verdict.reasonCode}`,
        `<b>Detail:</b> ${verdict.detail}`
    ];
    if (verdict.failures.length > 0) {
        lines.push(`<b>Failures:</b> ${verdict.failures.join(', ')}`);
    }
    if (verdict.unassessed.length > 0) {
        lines.push(`<b>Unassessed:</b> ${verdict.unassessed.join(', ')}`);
    }
    return lines.join('\n');
}
/**
 * Polls and assesses pUSD withdrawal-pool liquidity and offramp health (`S4-M42`).
 *
 * Dispatches Telegram operational alerts when `outcome === 'impaired'`.
 */
export async function checkPusdLiquidity(dependencies) {
    try {
        const input = await dependencies.loadInputs();
        const verdict = assessPusdWithdrawalPath(input);
        if (verdict.outcome === 'impaired') {
            await dependencies.sendAlert(formatPusdOpsMessage(verdict));
        }
        await dependencies.onVerdict?.(verdict);
        return verdict;
    }
    catch (error) {
        dependencies.logError?.('[alert-service] pUSD liquidity check failed', error);
        return null;
    }
}
//# sourceMappingURL=pusd-monitor.js.map