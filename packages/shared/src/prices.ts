const SOL_MINT = 'So11111111111111111111111111111111111111112';

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
  const cleanMint = tokenMint.includes(':') ? tokenMint.split(':')[1] : tokenMint;
  try {
    const response = await fetchWithTimeout(`https://api.dexscreener.com/latest/dex/tokens/${cleanMint}`);
    if (!response.ok) return null;
    const data = await response.json() as any;
    const pairs = data.pairs || [];
    if (pairs.length === 0) return null;
    
    // Sort by liquidity to get the most accurate price
    pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));

    const price = parseFloat(pairs[0].priceUsd);
    return Number.isFinite(price) ? price : null;
  } catch (error) {
    console.error(`[prices] DexScreener error for ${cleanMint}:`, error);
    return null;
  }
}

export async function fetchCoinGeckoPrice(tokenMint: string, chain = 'solana'): Promise<number | null> {
  const cleanMint = tokenMint.includes(':') ? tokenMint.split(':')[1] : tokenMint;
  const platform = chain === 'polygon' ? 'polygon-pos' : 'solana';
  try {
    const response = await fetchWithTimeout(`https://api.coingecko.com/api/v3/simple/token_price/${platform}?contract_addresses=${cleanMint}&vs_currencies=usd`);
    if (!response.ok) return null;
    const data = await response.json() as any;
    
    const key = cleanMint.toLowerCase();
    if (data[key] && data[key].usd) {
      return data[key].usd;
    }
    if (data[cleanMint] && data[cleanMint].usd) {
      return data[cleanMint].usd;
    }
    return null;
  } catch (error) {
    console.error(`[prices] CoinGecko error for ${cleanMint} on ${chain}:`, error);
    return null;
  }
}

export async function fetchJupiterPrice(tokenMint: string): Promise<number | null> {
  const cleanMint = tokenMint.includes(':') ? tokenMint.split(':')[1] : tokenMint;
  try {
    const response = await fetchWithTimeout(`https://lite-api.jup.ag/price/v3?ids=${cleanMint}`);
    if (!response.ok) return null;
    const data = await response.json() as Record<string, { usdPrice?: number } | undefined>;
    const price = data?.[cleanMint]?.usdPrice;
    return typeof price === 'number' && Number.isFinite(price) ? price : null;
  } catch (error) {
    console.error(`[prices] Jupiter error for ${cleanMint}:`, error);
    return null;
  }
}

export async function fetchTokenPriceUsd(tokenMint: string): Promise<number | null> {
  const chain = tokenMint.includes(':') ? tokenMint.split(':')[0] : 'solana';
  const cleanMint = tokenMint.includes(':') ? tokenMint.split(':')[1] : tokenMint;

  // Try DexScreener first (supports all chains)
  let price = await fetchDexScreenerPrice(cleanMint);
  if (price !== null && !isNaN(price)) {
    return price;
  }

  // Fallback to CoinGecko
  price = await fetchCoinGeckoPrice(cleanMint, chain);
  if (price !== null && !isNaN(price)) {
    return price;
  }

  // Fallback to Jupiter (Solana only)
  if (chain === 'solana') {
    price = await fetchJupiterPrice(cleanMint);
    if (price !== null && !isNaN(price)) {
      return price;
    }
  }

  return null;
}

export async function fetchTokenMetadata(tokenMint: string): Promise<{ name: string; symbol: string } | null> {
  const chain = tokenMint.includes(':') ? tokenMint.split(':')[0] : 'solana';
  const cleanMint = tokenMint.includes(':') ? tokenMint.split(':')[1] : tokenMint;

  // 1. Try Helius DAS API getAsset (Solana only)
  if (chain === 'solana') {
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
            params: { id: cleanMint }
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
        console.error(`[prices] Helius getAsset error for ${cleanMint}:`, error);
      }
    }
  }

  // 2. Fallback to DexScreener (supports all chains)
  try {
    const response = await fetchWithTimeout(`https://api.dexscreener.com/latest/dex/tokens/${cleanMint}`);
    if (response.ok) {
      const data = await response.json() as any;
      const base = data?.pairs?.[0]?.baseToken;
      if (base?.name && base?.symbol) {
        return { name: base.name, symbol: base.symbol };
      }
    }
  } catch (error) {
    console.error(`[prices] DexScreener metadata error for ${cleanMint}:`, error);
  }

  return null;
}
