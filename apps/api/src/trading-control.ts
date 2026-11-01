import {
  activateAllChainEmergencyOff,
  resolveChainModes,
  setChainExecutionMode,
  type ChainModeResolution
} from '@swat/db';
import type { Chain, ExecutionMode } from '@swat/shared';
import { z } from 'zod';

export const tradingChains = ['solana', 'polygon', 'robinhood-chain', 'base', 'ethereum', 'bsc'] as const satisfies readonly Chain[];

const tradingChainSchema = z.enum(tradingChains);
const executionModeSchema = z.enum(['off', 'paper', 'live', 'live+shadow']);

export const executionModeUpdateSchema = z.object({
  chain: tradingChainSchema,
  mode: executionModeSchema
}).strict();

export interface TradingModeUpdate {
  chain: Chain;
  mode: ExecutionMode;
}

export interface TradingControlStatus {
  modes: Record<Chain, ChainModeResolution>;
  killSwitchActive: boolean;
}

export async function getTradingControlStatus(): Promise<TradingControlStatus> {
  const modes = await resolveChainModes(tradingChains);
  const killSwitchActive = tradingChains.every(
    (chain) => modes[chain].effectiveMode === 'off'
      && modes[chain].reason === 'Global kill switch active (*)'
  );

  return { modes, killSwitchActive };
}

export async function updateTradingMode(update: TradingModeUpdate): Promise<TradingControlStatus> {
  await setChainExecutionMode(update.chain, update.mode);
  return getTradingControlStatus();
}

export async function emergencyOff(): Promise<TradingControlStatus> {
  await activateAllChainEmergencyOff();
  return getTradingControlStatus();
}
