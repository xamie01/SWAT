import { parseUnits } from 'viem';
import type { Chain, CopyExecutionMode } from '@swat/shared';

const PAPER_TARGETS: Record<Chain, string> = {
  solana: '11111111111111111111111111111111',
  polygon: '0x0000000000000000000000000000000000000001',
  'robinhood-chain': '0x0000000000000000000000000000000000000001'
};

const PAPER_TARGET_ENV: Record<Chain, string> = {
  solana: 'PAPER_COPY_ACCOUNT_SOLANA',
  polygon: 'PAPER_COPY_ACCOUNT_POLYGON',
  'robinhood-chain': 'PAPER_COPY_ACCOUNT_ROBINHOOD_CHAIN'
};

export function resolvePaperCopyTargetAccount(
  chain: Chain,
  env: NodeJS.ProcessEnv = process.env
): string {
  return env[PAPER_TARGET_ENV[chain]]?.trim() || PAPER_TARGETS[chain];
}

export function executionModesForChainMode(
  mode: 'paper' | 'live' | 'live+shadow'
): CopyExecutionMode[] {
  if (mode === 'live+shadow') return ['live', 'shadow'];
  return [mode];
}

export function sourceSellFractionToBps(value: string): number {
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)) {
    throw new Error('source sell fraction must be a decimal between 0 and 1');
  }
  const bps = Math.floor(Number(value) * 10_000);
  if (!Number.isSafeInteger(bps) || bps < 1 || bps > 10_000) {
    throw new Error('source sell fraction rounds outside 1..10000 basis points');
  }
  return bps;
}

export function decimalQuantityToBaseUnits(quantity: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error('token decimals must be an integer between 0 and 255');
  }
  if (!/^(?:\d+\.?\d*|\d*\.\d+)$/.test(quantity)) {
    throw new Error('token quantity must be an unsigned decimal');
  }
  const baseUnits = parseUnits(quantity, decimals);
  if (baseUnits <= 0n) throw new Error('token quantity rounds to zero base units');
  return baseUnits;
}
