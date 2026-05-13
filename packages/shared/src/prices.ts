const SOL_MINT = 'So11111111111111111111111111111111111111112';

export async function fetchDexScreenerPrice(tokenMint: string): Promise<number | null> {
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`);
    if (!response.ok) return null;
    const data = await response.json() as any;
    const pairs = data.pairs || [];
    if (pairs.length === 0) return null;
    
    // Sort by liquidity to get the most accurate price
    pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    
    return parseFloat(pairs[0].priceUsd);
  } catch (error) {
    console.error(`[prices] DexScreener error for ${tokenMint}:`, error);
    return null;
  }
}

export async function fetchCoinGeckoPrice(tokenMint: string): Promise<number | null> {
  try {
    const response = await fetch(`https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${tokenMint}&vs_currencies=usd`);
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
    const response = await fetch(`https://price.jup.ag/v6/price?ids=${tokenMint}`);
    if (!response.ok) return null;
    const data = await response.json() as any;
    if (data.data && data.data[tokenMint] && data.data[tokenMint].price) {
      return data.data[tokenMint].price;
    }
    return null;
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
