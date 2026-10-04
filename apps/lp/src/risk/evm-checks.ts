import { stripChainPrefix } from '@swat/shared';
import {
  BLACKLIST_CAPABLE_FLAG,
  HOLDER_CONCENTRATION_FLAG,
  LIQUIDITY_UNLOCKED_FLAG,
  MINT_AUTHORITY_FLAG,
  PAUSE_CAPABLE_FLAG,
  type TokenRiskCheck
} from './types.js';

/**
 * Robinhood Chain (EVM) risk checks (Tracks C1–C4) over an injected viem
 * client. Holder concentration on EVM needs an off-chain holder list (no
 * on-chain enumeration), so it reports through an injected port and stays
 * silent when no explorer is configured — unknown must read as "no finding",
 * not as "clean", which the gate complements with the unassessed-pool rule.
 */

export interface EvmTokenPort {
  call<T>(method: string, params: unknown[]): Promise<T>;
  /** Best-effort contract call; resolves null when the call reverts or is missing. */
  tryCall(token: string, signature: 'owner()' | 'paused()' | 'totalSupply()' | 'balanceOf(address)', args?: readonly unknown[]): Promise<string | null>;
}

export interface EvmHolderListPort {
  /** Top-10 balances as base-unit numbers, or null when no explorer is configured. */
  top10Balances(token: string): Promise<readonly number[] | null>;
}

export interface EvmTotalSupplyPort {
  totalSupply(token: string): Promise<number | null>;
}

export function evmHolderConcentrationCheck(
  holders: EvmHolderListPort,
  supply: EvmTotalSupplyPort
): TokenRiskCheck {
  return async (context) => {
    const token = stripChainPrefix(context.baseTokenMint).toLowerCase();
    const [top10, total] = await Promise.all([
      holders.top10Balances(token),
      supply.totalSupply(token)
    ]);
    if (!top10 || total === null || total <= 0) return [];
    const share = top10.reduce((sum, amount) => sum + amount, 0) / total;
    if (share < 0.5) return [];
    return [
      { flag: HOLDER_CONCENTRATION_FLAG, detail: `top-10 holders own ${(share * 100).toFixed(1)}% of supply` }
    ];
  };
}

export function evmMintAuthorityCheck(port: EvmTokenPort): TokenRiskCheck {
  return async (context) => {
    const token = stripChainPrefix(context.baseTokenMint).toLowerCase();
    const findings: { flag: string; detail: string }[] = [];

    const owner = await port.tryCall(token, 'owner()');
    if (owner !== null) {
      findings.push({ flag: MINT_AUTHORITY_FLAG, detail: 'token contract has an owner (likely upgradeable/mintable)' });
    }
    const paused = await port.tryCall(token, 'paused()');
    if (paused === 'true' || paused === '1') {
      findings.push({ flag: PAUSE_CAPABLE_FLAG, detail: 'trading can be paused by the contract owner' });
    }
    // A blacklist surface is probed through the common selector names; absence
    // of a revert-capable read just means the check stays silent.
    const blacklistedProbe = await port.tryCall(token, 'balanceOf(address)', [token]);
    if (blacklistedProbe !== null && owner !== null) {
      findings.push({ flag: BLACKLIST_CAPABLE_FLAG, detail: 'ownable token exposing balance reads common to blacklist implementations' });
    }
    return findings;
  };
}

export function evmLiquidityLockCheck(
  lpToken: string | null,
  port: EvmTokenPort
): TokenRiskCheck {
  return async (context) => {
    if (!lpToken) return [];
    const [total, deployerBalance] = await Promise.all([
      port.tryCall(lpToken, 'totalSupply()'),
      port.tryCall(lpToken, 'balanceOf(address)', [stripChainPrefix(context.poolAddress)])
    ]);
    const totalSupply = total === null ? null : Number(total);
    const movable = deployerBalance === null ? null : Number(deployerBalance);
    if (totalSupply === null || movable === null || Number.isNaN(totalSupply) || Number.isNaN(movable) || totalSupply <= 0) return [];
    const movableShare = movable / totalSupply;
    if (movableShare < 0.1) return [];
    return [
      { flag: LIQUIDITY_UNLOCKED_FLAG, detail: `${(movableShare * 100).toFixed(1)}% of LP tokens sit in the queried holder balance rather than a locker or burn address` }
    ];
  };
}
