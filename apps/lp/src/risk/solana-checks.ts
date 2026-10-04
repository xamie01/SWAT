import { stripChainPrefix } from '@swat/shared';
import {
  FREEZE_AUTHORITY_FLAG,
  HOLDER_CONCENTRATION_FLAG,
  LIQUIDITY_UNLOCKED_FLAG,
  MINT_AUTHORITY_FLAG,
  type TokenRiskCheck
} from './types.js';

/**
 * Solana risk checks (Tracks C1–C4) over a raw JSON-RPC port, matching the
 * indexer's hand-rolled RPC pattern. The SPL mint-account layout parsing is a
 * pure function so the authority flags are testable without a chain.
 */

export interface SolanaRpcPort {
  /** One JSON-RPC call with parsed JSON result (the indexer's heliusRpc shape). */
  call<T>(method: string, params: unknown[]): Promise<T>;
}

/** Top-10 holders of a mint, with the mint's total supply. */
export interface HolderConcentrationSnapshot {
  /** Largest ten token accounts, base-unit amounts. */
  readonly top10Amounts: readonly number[];
  readonly supply: number;
}

export async function fetchHolderConcentration(
  port: SolanaRpcPort,
  mint: string
): Promise<HolderConcentrationSnapshot> {
  const rawMint = stripChainPrefix(mint);
  const [largest, supply] = await Promise.all([
    port.call<{ value: readonly { amount: string }[] }>('getTokenLargestAccounts', [rawMint]),
    port.call<{ value: { amount: string } }>('getTokenSupply', [rawMint])
  ]);
  return {
    top10Amounts: largest.value.map((account) => Number(account.amount)),
    supply: Number(supply.value.amount)
  };
}

/**
 * The finding rule for Track C1: the top-10 share of supply. Returns a finding
 * only above `flagThreshold` — a healthy distribution is not a flag.
 */
export function holderConcentrationFinding(
  snapshot: HolderConcentrationSnapshot,
  flagThreshold = 0.5
): { flag: typeof HOLDER_CONCENTRATION_FLAG; detail: string; top10Share: number } | null {
  if (snapshot.supply <= 0) return null;
  const top10Share = snapshot.top10Amounts.reduce((sum, amount) => sum + amount, 0) / snapshot.supply;
  if (top10Share < flagThreshold) return null;
  return {
    flag: HOLDER_CONCENTRATION_FLAG,
    detail: `top-10 holders own ${(top10Share * 100).toFixed(1)}% of supply`,
    top10Share
  };
}

export function holderConcentrationCheck(port: SolanaRpcPort): TokenRiskCheck {
  return async (context) => {
    const snapshot = await fetchHolderConcentration(port, context.baseTokenMint);
    const finding = holderConcentrationFinding(snapshot);
    return finding ? [finding] : [];
  };
}

/** The fields of an SPL mint account this module reasons about. */
export interface SplMintAuthorities {
  readonly mintAuthority: string | null;
  readonly freezeAuthority: string | null;
}

/**
 * Parses an SPL token mint account (82 bytes, base64-encoded by RPC):
 * 0..4 mint-authority COption, 4..36 authority pubkey, 36..44 supply, 44
 * decimals, 45 is-initialized, 46..50 freeze-authority COption, 50..82 freeze
 * pubkey.
 */
export function parseSplMintAuthorities(base64Data: string): SplMintAuthorities {
  const data = Buffer.from(base64Data, 'base64');
  if (data.length < 82) {
    throw new Error(`mint account data is ${data.length} bytes, expected 82`);
  }
  const mintAuthorityOption = data.readUInt32LE(0);
  const freezeAuthorityOption = data.readUInt32LE(46);
  return {
    mintAuthority: mintAuthorityOption === 0 ? null : data.subarray(4, 36).toString('hex'),
    freezeAuthority: freezeAuthorityOption === 0 ? null : data.subarray(50, 82).toString('hex')
  };
}

export async function fetchSplMintAuthorities(
  port: SolanaRpcPort,
  mint: string
): Promise<SplMintAuthorities> {
  const rawMint = stripChainPrefix(mint);
  const info = await port.call<{
    value: { data: readonly [string, string] } | null;
  }>('getAccountInfo', [rawMint, { encoding: 'base64' }]);
  const account = info.value;
  if (!account) {
    throw new Error(`mint account ${mint} not found`);
  }
  return parseSplMintAuthorities(account.data[0]);
}

export function mintAuthorityFindings(authorities: SplMintAuthorities) {
  const findings: { flag: string; detail: string }[] = [];
  if (authorities.mintAuthority !== null) {
    findings.push({ flag: MINT_AUTHORITY_FLAG, detail: 'deployer can mint more supply' });
  }
  if (authorities.freezeAuthority !== null) {
    findings.push({ flag: FREEZE_AUTHORITY_FLAG, detail: 'deployer can freeze token accounts' });
  }
  return findings;
}

export function mintAuthorityCheck(port: SolanaRpcPort): TokenRiskCheck {
  return async (context) => mintAuthorityFindings(await fetchSplMintAuthorities(port, context.baseTokenMint));
}

export interface LiquidityLockSnapshot {
  /** LP token balances held by known lockers or the burn address, base units. */
  readonly lockedOrBurnedAmount: number;
  /** LP token balances held by ordinary movable wallets, base units. */
  readonly movableAmount: number;
}

const BURN_ADDRESSES = new Set(['1nc1nerator11111111111111111111111111111111', '11111111111111111111111111111111']);

export function liquidityLockFinding(
  snapshot: LiquidityLockSnapshot
): { flag: typeof LIQUIDITY_UNLOCKED_FLAG; detail: string } | null {
  const total = snapshot.lockedOrBurnedAmount + snapshot.movableAmount;
  if (total <= 0) return null;
  const movableShare = snapshot.movableAmount / total;
  // Below 10% movable the LP is effectively locked; above that, the deployer
  // (or an early LP) can pull the rug out from under the ladder.
  if (movableShare < 0.1) return null;
  return {
    flag: LIQUIDITY_UNLOCKED_FLAG,
    detail: `${(movableShare * 100).toFixed(1)}% of LP tokens sit in freely movable wallets`
  };
}

export function liquidityLockCheck(
  port: SolanaRpcPort,
  /** Resolves the pool's classic LP mint, or null — DLMM pools have none (positions are NFTs). */
  resolveLpMint: (context: { readonly poolAddress: string }) => string | null = () => null
): TokenRiskCheck {
  return async (context) => {
    const lpMint = resolveLpMint(context);
    if (!lpMint) return [];

    const [largest, supply] = await Promise.all([
      port.call<{ value: readonly { address: string; amount: string }[] }>(
        'getTokenLargestAccounts',
        [lpMint]
      ),
      port.call<{ value: { amount: string } }>('getTokenSupply', [lpMint])
    ]);
    const snapshot: LiquidityLockSnapshot = {
      lockedOrBurnedAmount: largest.value
        .filter((account) => BURN_ADDRESSES.has(account.address))
        .reduce((sum, account) => sum + Number(account.amount), 0),
      movableAmount: Number(supply.value.amount)
    };
    const finding = liquidityLockFinding(snapshot);
    return finding ? [finding] : [];
  };
}
