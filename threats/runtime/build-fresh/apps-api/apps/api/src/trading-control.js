import { activateAllChainEmergencyOff, resolveChainModes, setChainExecutionMode } from '@swat/db';
import { z } from 'zod';
export const tradingChains = ['solana', 'polygon', 'robinhood-chain', 'base', 'ethereum', 'bsc'];
const tradingChainSchema = z.enum(tradingChains);
const executionModeSchema = z.enum(['off', 'paper', 'live', 'live+shadow']);
export const executionModeUpdateSchema = z.object({
    chain: tradingChainSchema,
    mode: executionModeSchema
}).strict();
export async function getTradingControlStatus() {
    const modes = await resolveChainModes(tradingChains);
    const killSwitchActive = tradingChains.every((chain) => modes[chain].effectiveMode === 'off'
        && modes[chain].reason === 'Global kill switch active (*)');
    return { modes, killSwitchActive };
}
export async function updateTradingMode(update) {
    await setChainExecutionMode(update.chain, update.mode);
    return getTradingControlStatus();
}
export async function emergencyOff() {
    await activateAllChainEmergencyOff();
    return getTradingControlStatus();
}
//# sourceMappingURL=trading-control.js.map