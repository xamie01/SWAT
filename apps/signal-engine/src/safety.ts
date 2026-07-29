import { createPublicClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { query } from '@swat/db';
import {
  fetchDexScreenerLiquidity,
  getChainPrefix,
  prefixChainValue,
  stripChainPrefix
} from '@swat/shared';
import type { Chain } from '@swat/shared';

export type SafetyResult = {
  isSafe: boolean;
  passed: boolean;  // alias for !hasHardFlags
  flags: string[];
  warnings: string[];
  liquidity?: number | null;
  top10HolderPct?: number | null;
};

// Define Robinhood Chain custom definition
const robinhoodChain = {
  id: 4663,
  name: 'Robinhood Chain',
  network: 'robinhood-chain',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: { http: [process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'] },
    public: { http: [process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'] },
  },
} as const;

function getPublicClient(chain: string) {
  if (chain === 'polygon') {
    const url = process.env.POLYGON_RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com';
    return createPublicClient({ chain: polygon, transport: http(url) });
  } else if (chain === 'robinhood-chain') {
    const url = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
    return createPublicClient({ chain: robinhoodChain, transport: http(url) });
  }
  throw new Error(`Unsupported chain: ${chain}`);
}

const heliusApiKey = process.env.HELIUS_API_KEY;
const heliusRpcUrl = heliusApiKey
  ? `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`
  : null;

// ─── Live On-Chain Solana Mint Info ───────────────────────────────────────────

type MintInfo = {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  decimals: number;
};

async function getMintInfoFromChain(tokenMint: string): Promise<MintInfo | null> {
  if (!heliusRpcUrl) return null;
  try {
    const response = await fetch(heliusRpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'getMintInfo',
        method: 'getAccountInfo',
        params: [tokenMint, { encoding: 'jsonParsed' }]
      })
    });
    if (!response.ok) return null;
    const json = await response.json() as any;
    const info = json.result?.value?.data?.parsed?.info;
    if (!info) return null;
    return {
      mintAuthority: info.mintAuthority ?? null,
      freezeAuthority: info.freezeAuthority ?? null,
      decimals: info.decimals ?? 9
    };
  } catch (e) {
    console.error('[safety] getMintInfo error:', e);
    return null;
  }
}

// ─── Solana Top Holder Concentration ──────────────────────────────────────────

async function getTop10HolderPct(tokenMint: string): Promise<number | null> {
  if (!heliusRpcUrl) return null;
  try {
    const [accountsResponse, supplyResponse] = await Promise.all([
      fetch(heliusRpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'getTopHolders',
          method: 'getTokenLargestAccounts',
          params: [tokenMint, { commitment: 'finalized' }]
        })
      }),
      fetch(heliusRpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'getTokenSupply',
          method: 'getTokenSupply',
          params: [tokenMint, { commitment: 'finalized' }]
        })
      })
    ]);
    if (!accountsResponse.ok || !supplyResponse.ok) return null;

    const accountsJson = await accountsResponse.json() as any;
    const supplyJson = await supplyResponse.json() as any;
    const accounts = accountsJson.result?.value as Array<{ amount?: string }> | undefined;
    const supplyAmount = supplyJson.result?.value?.amount;
    if (!accounts || accounts.length === 0) return null;
    if (typeof supplyAmount !== 'string') return null;

    const totalSupply = BigInt(supplyAmount);
    if (totalSupply <= 0n) return null;
    const top10 = accounts.slice(0, 10).reduce(
      (sum, account) => sum + BigInt(account.amount ?? '0'),
      0n
    );
    return Number((top10 * 10_000n) / totalSupply) / 100;
  } catch (e) {
    console.error('[safety] getTopHolderPct error:', e);
    return null;
  }
}

// ─── EVM Contract Owner Read ──────────────────────────────────────────────────

async function getEvmContractOwner(client: any, address: `0x${string}`) {
  try {
    const owner = await client.readContract({
      address,
      abi: [{ name: 'owner', type: 'function', inputs: [], outputs: [{ type: 'address' }] }],
      functionName: 'owner'
    });
    return String(owner);
  } catch {
    return null;
  }
}

// ─── Main Safety Check ────────────────────────────────────────────────────────

export async function checkTokenSafety(tokenMint: string): Promise<SafetyResult> {
  const flags: string[] = [];
  const warnings: string[] = [];

  const prefixChain = getChainPrefix(tokenMint);
  const tokenRows = prefixChain
    ? []
    : await query<{ chain: Chain }>(
        `SELECT chain FROM tokens WHERE mint LIKE '%:' || $1 LIMIT 1`,
        [stripChainPrefix(tokenMint)]
      );
  const chain: Chain = prefixChain ?? tokenRows[0]?.chain ?? 'solana';
  const storedMint = prefixChainValue(tokenMint, chain);
  const rawMint = stripChainPrefix(storedMint);

  let top10Pct: number | null = null;
  let liquidity: number | null = null;

  if (chain === 'solana') {
    // ─── SOLANA SAFETY FLOW ───────────────────
    const mintInfo = await getMintInfoFromChain(rawMint);

    if (!mintInfo) {
      // Helius not configured — fall back to DB values and warn
      const rows = await query<{ mint_authority_disabled: boolean; freeze_authority_disabled: boolean }>(
        `SELECT mint_authority_disabled, freeze_authority_disabled FROM tokens WHERE mint = $1`,
        [storedMint]
      );
      const token = rows[0];
      if (!token) {
        return {
          isSafe: false,
          passed: false,
          flags: ['unverified_token'],
          warnings: ['Token not indexed — cannot verify safety'],
          liquidity: null,
          top10HolderPct: null
        };
      }
      if (!token.mint_authority_disabled) {
        flags.push('MINT_AUTHORITY_ACTIVE');
      }
      if (!token.freeze_authority_disabled) {
        warnings.push('FREEZE_AUTHORITY_SET');
      }
    } else {
      // Live on-chain check
      if (mintInfo.mintAuthority !== null) {
        flags.push('MINT_AUTHORITY_ACTIVE');
      }
      if (mintInfo.freezeAuthority !== null) {
        warnings.push('FREEZE_AUTHORITY_SET');
      }

      // Persist results back to DB so they're cached
      await query(
        `UPDATE tokens SET
           mint_authority_disabled = $1,
           freeze_authority_disabled = $2,
           decimals = $3
         WHERE mint = $4`,
        [
          mintInfo.mintAuthority === null,
          mintInfo.freezeAuthority === null,
          mintInfo.decimals,
          storedMint
        ]
      );
    }

    // Top holder concentration check (Solana largest accounts via Helius)
    top10Pct = await getTop10HolderPct(rawMint);
    if (top10Pct !== null) {
      if (top10Pct > 60) {
        flags.push(`TOP_10_HOLD_${top10Pct}PCT`);
      } else if (top10Pct > 35) {
        warnings.push(`TOP_10_HOLD_${top10Pct}PCT`);
      }
    }

  } else {
    // ─── EVM / EVM L2 SAFETY FLOW ───────────────
    try {
      const client = getPublicClient(chain);
      const owner = await getEvmContractOwner(client, rawMint as `0x${string}`);

      if (owner !== null) {
        const isRenounced = owner === '0x0000000000000000000000000000000000000000';
        if (!isRenounced) {
          flags.push('OWNER_ACTIVE');
        }

        // Cache in existing DB columns to avoid schema bloat
        await query(
          `UPDATE tokens SET
             mint_authority_disabled = $1,
             freeze_authority_disabled = true
           WHERE mint = $2`,
          [isRenounced, storedMint]
        );
      } else {
        warnings.push('CONTRACT_OWNER_UNVERIFIED');
      }
    } catch (err) {
      console.warn(`[safety] EVM contract owner query failed for ${tokenMint}:`, err);
      warnings.push('CHAIN_RPC_UNREACHABLE');
    }
  }

  // DexScreener liquidity check (works for all chains)
  liquidity = await fetchDexScreenerLiquidity(rawMint, chain);
  if (liquidity !== null && liquidity < 25_000) {
    flags.push(`LOW_LIQUIDITY_${Math.round(liquidity / 1000)}K`);
  } else if (liquidity === null) {
    warnings.push('LIQUIDITY_UNVERIFIED');
  }

  const isSafe = flags.length === 0;

  return {
    isSafe,
    passed: isSafe,
    flags,
    warnings,
    liquidity,
    top10HolderPct: top10Pct
  };
}
