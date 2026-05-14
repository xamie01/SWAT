import { query } from '@swat/db';

export type SafetyResult = {
  isSafe: boolean;
  passed: boolean;  // alias for !hasHardFlags
  flags: string[];
  warnings: string[];
  liquidity?: number | null;
  top10HolderPct?: number | null;
};

const heliusApiKey = process.env.HELIUS_API_KEY;
const heliusRpcUrl = heliusApiKey
  ? `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`
  : null;

// ─── Live On-Chain Mint Info ──────────────────────────────────────────────────

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

// ─── Top Holder Concentration ─────────────────────────────────────────────────

async function getTop10HolderPct(tokenMint: string): Promise<number | null> {
  if (!heliusRpcUrl) return null;
  try {
    const response = await fetch(heliusRpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'getTopHolders',
        method: 'getTokenLargestAccounts',
        params: [tokenMint, { commitment: 'finalized' }]
      })
    });
    if (!response.ok) return null;
    const json = await response.json() as any;
    const accounts = json.result?.value as Array<{ uiAmount: number }> | undefined;
    if (!accounts || accounts.length === 0) return null;

    const total = accounts.reduce((sum, a) => sum + (a.uiAmount ?? 0), 0);
    if (total === 0) return null;
    const top10 = accounts.slice(0, 10).reduce((sum, a) => sum + (a.uiAmount ?? 0), 0);
    return Math.round((top10 / total) * 100);
  } catch (e) {
    console.error('[safety] getTopHolderPct error:', e);
    return null;
  }
}

// ─── DexScreener Liquidity ────────────────────────────────────────────────────

async function getDexScreenerLiquidity(tokenMint: string): Promise<number | null> {
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`);
    if (!response.ok) return null;
    const data = await response.json() as any;
    const pairs = data.pairs || [];
    if (pairs.length === 0) return null;
    pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    return pairs[0]?.liquidity?.usd ?? null;
  } catch (e) {
    console.error('[safety] getDexScreenerLiquidity error:', e);
    return null;
  }
}

// ─── Main Safety Check ────────────────────────────────────────────────────────

export async function checkTokenSafety(tokenMint: string): Promise<SafetyResult> {
  const flags: string[] = [];
  const warnings: string[] = [];

  // 1. Fetch live mint info from chain
  const mintInfo = await getMintInfoFromChain(tokenMint);

  if (!mintInfo) {
    // Helius not configured — fall back to DB values and warn
    const rows = await query<{ mint_authority_disabled: boolean; freeze_authority_disabled: boolean }>(
      `SELECT mint_authority_disabled, freeze_authority_disabled FROM tokens WHERE mint = $1`,
      [tokenMint]
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
        tokenMint
      ]
    );
  }

  // 2. Top holder concentration check
  const top10Pct = await getTop10HolderPct(tokenMint);
  if (top10Pct !== null) {
    if (top10Pct > 60) {
      flags.push(`TOP_10_HOLD_${top10Pct}PCT`);
    } else if (top10Pct > 35) {
      warnings.push(`TOP_10_HOLD_${top10Pct}PCT`);
    }
  }

  // 3. Liquidity check via DexScreener
  const liquidity = await getDexScreenerLiquidity(tokenMint);
  if (liquidity !== null && liquidity < 50_000) {
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
