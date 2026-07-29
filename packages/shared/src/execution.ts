import { Chain, ExecutionMode } from './types.js';

/**
 * Parses an execution mode securely.
 * Fails-closed: any unknown or invalid value returns 'paper'.
 * @param value The string to parse
 * @returns ExecutionMode ('off' | 'paper' | 'live' | 'live+shadow')
 */
export function parseExecutionMode(value: string | undefined | null): ExecutionMode {
  if (!value) return 'paper';
  if (value === 'off') return 'off';
  if (value === 'live') return 'live';
  if (value === 'live+shadow') return 'live+shadow';
  if (value === 'paper') return 'paper';
  
  // Any unrecognized value defaults safely to paper
  return 'paper';
}

/**
 * Maps a legacy TRADING_MODE value to an ExecutionMode for a specific chain.
 * Live execution is strictly clamped to 'paper' if the chain is not in the certified allowlist.
 */
export function mapLegacyTradingMode(
  legacyMode: string | undefined | null,
  chain: Chain,
  liveEnabledChains: Chain[]
): ExecutionMode {
  const parsed = parseExecutionMode(legacyMode);
  
  if (parsed === 'live' || parsed === 'live+shadow') {
    if (liveEnabledChains.includes(chain)) {
      return parsed;
    }
    return 'paper'; // Clamp uncertified chains
  }
  
  return parsed;
}

/**
 * Parses the LIVE_ENABLED_CHAINS environment variable.
 */
export function parseLiveEnabledChains(envValue: string | undefined | null): Chain[] {
  if (!envValue) return [];
  const parts = envValue.split(',').map(s => s.trim().toLowerCase());
  return parts.filter(p => p === 'solana' || p === 'polygon' || p === 'robinhood-chain') as Chain[];
}
