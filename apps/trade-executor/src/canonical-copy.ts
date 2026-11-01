import { parseUnits } from 'viem';
import type { Chain, CopyExecutionMode } from '@swat/shared';

const PAPER_TARGETS: Record<Chain, string> = {
  solana: '11111111111111111111111111111111',
  polygon: '0x0000000000000000000000000000000000000001',
  'robinhood-chain': '0x0000000000000000000000000000000000000001',
  base: '0x0000000000000000000000000000000000000001',
  ethereum: '0x0000000000000000000000000000000000000001',
  bsc: '0x0000000000000000000000000000000000000001'
};

/**
 * The synthetic account paper executions settle "from".
 *
 * ONE address per chain, shared by every paper user — deliberately, and this is
 * now correct rather than merely tolerated. Paper mode has no counterparty, so
 * there is no real address to name; minting a per-user fake address would
 * invent one, and every downstream consumer that reasonably assumes an address
 * corresponds to something on-chain (grant lookups, reconcilers, explorer
 * links, user_execution_grants.uq_ueg_account) would then be reading a fiction.
 *
 * Before migration 050_copy_tenancy.sql the sharing WAS a bug, because
 * copy_positions was keyed (target_account, chain, token_mint): every paper
 * user on a chain collapsed onto one row, so A's buy inflated B's
 * confirmed_quantity and B's exit computed P&L against A's cost basis. The fix
 * was to put user_id in the key, not to make the address per-user.
 *
 * So: do NOT make this per-user. If two paper users appear to share a position,
 * the missing piece is a userId that was not threaded to
 * requestCopyExecution / claimSourceSignalForCopyExecution, not this address.
 *
 * NOT YET PROVEN: S4-10's acceptance test — two paper users on one chain and
 * token holding independent quantities and cost bases, written so that it fails
 * against the old three-column key — has not been written. Until it exists this
 * comment describes the intent of 050, not a verified property.
 */
const PAPER_TARGET_ENV: Record<Chain, string> = {
  solana: 'PAPER_COPY_ACCOUNT_SOLANA',
  polygon: 'PAPER_COPY_ACCOUNT_POLYGON',
  'robinhood-chain': 'PAPER_COPY_ACCOUNT_ROBINHOOD_CHAIN',
  base: 'PAPER_COPY_ACCOUNT_BASE',
  ethereum: 'PAPER_COPY_ACCOUNT_ETHEREUM',
  bsc: 'PAPER_COPY_ACCOUNT_BSC'
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
