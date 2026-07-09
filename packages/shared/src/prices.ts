const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Default per-request timeout. Without it a stalled price host (e.g. an IPv4
// route that black-holes) hangs the whole backfill on undici's long default.
const PRICE_FETCH_TIMEOUT_MS = Number(process.env.PRICE_FETCH_TIMEOUT_MS ?? 8000);

async function fetchWithTimeout(url: string, timeoutMs = PRICE_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchDexScreenerPrice(tokenMint: string): Promise<number | null> {
  try {
    const response = await fetchWithTimeout(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`);
    if (!response.ok) return null;
    const data = await response.json() as any;
    const pairs = data.pairs || [];
    if (pairs.length === 0) return null;
    
    // Sort by liquidity to get the most accurate price
    pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));

    // priceUsd may be missing/non-numeric; honour the number|null contract
    // rather than returning NaN.
    const price = parseFloat(pairs[0].priceUsd);
    return Number.isFinite(price) ? price : null;
  } catch (error) {
    console.error(`[prices] DexScreener error for ${tokenMint}:`, error);
    return null;
  }
}

export async function fetchCoinGeckoPrice(tokenMint: string): Promise<number | null> {
  try {
    const response = await fetchWithTimeout(`https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${tokenMint}&vs_currencies=usd`);
    if (!response.ok) return null;
    const data = await response.json() as any;
    if (data[tokenMint] && data[tokenMint].usd) {
      return data[tokenMint].usd;
    }
    return null;
  } catch (error) {
    console.error(`[prices] CoinGecko error for ${tokenMint}:`, error);
    return null;
  }
}

export async function fetchJupiterPrice(tokenMint: string): Promise<number | null> {
  try {
    // The old `price.jup.ag/v6` host was retired (DNS no longer resolves). The
    // live endpoint is the Price API v3 on lite-api.jup.ag, which returns
    //   { "<mint>": { "usdPrice": <number>, ... } }
    const response = await fetchWithTimeout(`https://lite-api.jup.ag/price/v3?ids=${tokenMint}`);
    if (!response.ok) return null;
    const data = await response.json() as Record<string, { usdPrice?: number } | undefined>;
    const price = data?.[tokenMint]?.usdPrice;
    return typeof price === 'number' && Number.isFinite(price) ? price : null;
  } catch (error) {
    console.error(`[prices] Jupiter error for ${tokenMint}:`, error);
    return null;
  }
}

export async function fetchTokenPriceUsd(tokenMint: string): Promise<number | null> {
  // Try DexScreener first
  let price = await fetchDexScreenerPrice(tokenMint);
  if (price !== null && !isNaN(price)) {
    return price;
  }

  // Fallback to CoinGecko
  price = await fetchCoinGeckoPrice(tokenMint);
  if (price !== null && !isNaN(price)) {
    return price;
  }

  // Fallback to Jupiter (reads on-chain AMM pools)
  price = await fetchJupiterPrice(tokenMint);
  if (price !== null && !isNaN(price)) {
    return price;
  }

  return null;
}

export async function fetchTokenMetadata(tokenMint: string): Promise<{ name: string; symbol: string } | null> {
  // 1. Try Helius DAS API getAsset
  const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
  if (HELIUS_API_KEY) {
    try {
      const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'token-metadata',
          method: 'getAsset',
          params: { id: tokenMint }
        })
      });
      if (response.ok) {
        const json = await response.json() as any;
        if (!json.error && json.result?.content?.metadata) {
          const name = json.result.content.metadata.name || 'Unknown';
          const symbol = json.result.content.metadata.symbol || 'UNKNOWN';
          return { name, symbol };
        }
      }
    } catch (error) {
      console.error(`[prices] Helius getAsset error for ${tokenMint}:`, error);
    }
  }

  // 2. Fallback to DexScreener
  try {
    const response = await fetchWithTimeout(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`);
    if (response.ok) {
      const data = await response.json() as any;
      const base = data?.pairs?.[0]?.baseToken;
      if (base?.name && base?.symbol) {
        return { name: base.name, symbol: base.symbol };
      }
    }
  } catch (error) {
    console.error(`[prices] DexScreener metadata error for ${tokenMint}:`, error);
  }

  return null;
}

