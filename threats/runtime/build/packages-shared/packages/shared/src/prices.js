// Re-exported from the authority module rather than redeclared. Two independent
// literals for the same chain id in one package is exactly what drifts: a future
// testnet or chain-id change would be applied to one and not the other, and the
// symptom (prices resolve, permissions deny) would look unrelated to the cause.
import { ROBINHOOD_CHAIN_ID } from './authority/permission-policy.js';
import { resolveChainValue } from './address.js';
const PRICE_FETCH_TIMEOUT_MS = Number(process.env.PRICE_FETCH_TIMEOUT_MS ?? 8000);
const ROBINHOOD_API_BASE_URL = 'https://api.robinhood.com/rhj';
const ROBINHOOD_ASSET_CACHE_MS = 5 * 60 * 1000;
const ROBINHOOD_PRICE_MAX_AGE_MS = 2 * 60 * 1000;
const DEX_SCREENER_CHAIN_IDS = {
    solana: 'solana',
    polygon: 'polygon',
    'robinhood-chain': 'robinhood',
    base: 'base',
    ethereum: 'ethereum',
    bsc: 'bsc'
};
let robinhoodAssetCache = null;
let robinhoodAssetRequest = null;
async function fetchWithTimeout(url, timeoutMs = PRICE_FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    }
    finally {
        clearTimeout(timer);
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function parsePositiveNumber(value) {
    const parsed = typeof value === 'number'
        ? value
        : typeof value === 'string'
            ? Number(value)
            : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function hasRobinhoodDeployment(value, tokenAddress) {
    if (!Array.isArray(value))
        return false;
    return value.some((deployment) => (isRecord(deployment)
        && deployment.chainId === ROBINHOOD_CHAIN_ID
        && typeof deployment.contractAddress === 'string'
        && deployment.contractAddress.toLowerCase() === tokenAddress));
}
function parseRobinhoodAssetIndex(data) {
    const byAddress = new Map();
    if (!isRecord(data) || !Array.isArray(data.assets))
        return byAddress;
    for (const asset of data.assets) {
        if (!isRecord(asset)
            || asset.status !== 'ASSET_STATUS_ACTIVE'
            || typeof asset.tokenSymbol !== 'string'
            || asset.tokenSymbol.length === 0) {
            continue;
        }
        const multiplier = parsePositiveNumber(asset.currentMultiplier);
        if (multiplier === null || !Array.isArray(asset.deployments))
            continue;
        for (const deployment of asset.deployments) {
            if (!isRecord(deployment)
                || deployment.chainId !== ROBINHOOD_CHAIN_ID
                || typeof deployment.contractAddress !== 'string') {
                continue;
            }
            byAddress.set(deployment.contractAddress.toLowerCase(), {
                symbol: asset.tokenSymbol,
                multiplier
            });
        }
    }
    return byAddress;
}
async function getRobinhoodAssetIndex() {
    const now = Date.now();
    if (robinhoodAssetCache && robinhoodAssetCache.expiresAt > now) {
        return robinhoodAssetCache.byAddress;
    }
    if (robinhoodAssetRequest)
        return robinhoodAssetRequest;
    robinhoodAssetRequest = (async () => {
        const response = await fetchWithTimeout(`${ROBINHOOD_API_BASE_URL}/assets`);
        if (!response.ok)
            return null;
        const byAddress = parseRobinhoodAssetIndex(await response.json());
        robinhoodAssetCache = {
            expiresAt: Date.now() + ROBINHOOD_ASSET_CACHE_MS,
            byAddress
        };
        return byAddress;
    })();
    try {
        return await robinhoodAssetRequest;
    }
    finally {
        robinhoodAssetRequest = null;
    }
}
export function getDexScreenerChainId(chain) {
    return DEX_SCREENER_CHAIN_IDS[chain];
}
function getPairLiquidityUsd(pair) {
    const rawLiquidity = pair.liquidity?.usd;
    const liquidity = typeof rawLiquidity === 'number'
        ? rawLiquidity
        : typeof rawLiquidity === 'string'
            ? Number(rawLiquidity)
            : 0;
    return Number.isFinite(liquidity) ? liquidity : 0;
}
export function selectDexScreenerPair(pairs, chain) {
    if (!Array.isArray(pairs))
        return null;
    const expectedChainId = getDexScreenerChainId(chain);
    let selected = null;
    for (const candidate of pairs) {
        if (!isRecord(candidate)
            || !('chainId' in candidate)
            || candidate.chainId !== expectedChainId) {
            continue;
        }
        const pair = candidate;
        if (selected === null || getPairLiquidityUsd(pair) > getPairLiquidityUsd(selected)) {
            selected = pair;
        }
    }
    return selected;
}
async function fetchDexScreenerPair(tokenMint, requestedChain) {
    const { chain, raw: cleanMint } = resolveChainValue(tokenMint, requestedChain);
    const response = await fetchWithTimeout(`https://api.dexscreener.com/latest/dex/tokens/${cleanMint}`);
    if (!response.ok)
        return null;
    const data = await response.json();
    return selectDexScreenerPair(data.pairs, chain);
}
export async function fetchDexScreenerPrice(tokenMint, requestedChain) {
    const resolved = resolveChainValue(tokenMint, requestedChain);
    try {
        const pair = await fetchDexScreenerPair(resolved.raw, resolved.chain);
        if (!pair)
            return null;
        const rawPrice = pair.priceUsd;
        const price = typeof rawPrice === 'number'
            ? rawPrice
            : typeof rawPrice === 'string'
                ? Number.parseFloat(rawPrice)
                : Number.NaN;
        return Number.isFinite(price) ? price : null;
    }
    catch (error) {
        console.error(`[prices] DexScreener error for ${resolved.raw} on ${resolved.chain}:`, error);
        return null;
    }
}
export async function fetchDexScreenerLiquidity(tokenMint, requestedChain) {
    const resolved = resolveChainValue(tokenMint, requestedChain);
    try {
        const pair = await fetchDexScreenerPair(resolved.raw, resolved.chain);
        return pair ? getPairLiquidityUsd(pair) : null;
    }
    catch (error) {
        console.error(`[prices] DexScreener liquidity error for ${resolved.raw} on ${resolved.chain}:`, error);
        return null;
    }
}
export async function fetchRobinhoodChainPrice(tokenMint) {
    const { raw: cleanMint } = resolveChainValue(tokenMint, 'robinhood-chain');
    try {
        const assetIndex = await getRobinhoodAssetIndex();
        const asset = assetIndex?.get(cleanMint);
        if (!asset)
            return null;
        const response = await fetchWithTimeout(`${ROBINHOOD_API_BASE_URL}/prices/${encodeURIComponent(asset.symbol)}`);
        if (!response.ok)
            return null;
        const data = await response.json();
        if (!isRecord(data) || !Array.isArray(data.quotes))
            return null;
        const quote = data.quotes.find((candidate) => (isRecord(candidate)
            && candidate.tokenSymbol === asset.symbol
            && candidate.isTradingHalt === false
            && hasRobinhoodDeployment(candidate.deployments, cleanMint)));
        if (!isRecord(quote))
            return null;
        const bid = parsePositiveNumber(quote.bid);
        const ask = parsePositiveNumber(quote.ask);
        if (bid === null || ask === null || typeof quote.generatedAt !== 'string')
            return null;
        const generatedAt = Date.parse(quote.generatedAt);
        const ageMs = Date.now() - generatedAt;
        if (!Number.isFinite(generatedAt)
            || ageMs < -30_000
            || ageMs > ROBINHOOD_PRICE_MAX_AGE_MS) {
            return null;
        }
        const price = ((bid + ask) / 2) * asset.multiplier;
        return Number.isFinite(price) && price > 0 ? price : null;
    }
    catch (error) {
        console.error(`[prices] Robinhood Chain price error for ${cleanMint}:`, error);
        return null;
    }
}
export async function fetchCoinGeckoPrice(tokenMint, chain = 'solana') {
    const cleanMint = tokenMint.includes(':') ? tokenMint.split(':')[1] : tokenMint;
    const platform = chain === 'polygon' ? 'polygon-pos' : 'solana';
    try {
        const response = await fetchWithTimeout(`https://api.coingecko.com/api/v3/simple/token_price/${platform}?contract_addresses=${cleanMint}&vs_currencies=usd`);
        if (!response.ok)
            return null;
        const data = await response.json();
        const key = cleanMint.toLowerCase();
        if (data[key] && data[key].usd) {
            return data[key].usd;
        }
        if (data[cleanMint] && data[cleanMint].usd) {
            return data[cleanMint].usd;
        }
        return null;
    }
    catch (error) {
        console.error(`[prices] CoinGecko error for ${cleanMint} on ${chain}:`, error);
        return null;
    }
}
export async function fetchJupiterPrice(tokenMint) {
    const cleanMint = tokenMint.includes(':') ? tokenMint.split(':')[1] : tokenMint;
    try {
        const response = await fetchWithTimeout(`https://lite-api.jup.ag/price/v3?ids=${cleanMint}`);
        if (!response.ok)
            return null;
        const data = await response.json();
        const price = data?.[cleanMint]?.usdPrice;
        return typeof price === 'number' && Number.isFinite(price) ? price : null;
    }
    catch (error) {
        console.error(`[prices] Jupiter error for ${cleanMint}:`, error);
        return null;
    }
}
export async function fetchTokenPriceUsd(tokenMint) {
    const { chain, raw: cleanMint } = resolveChainValue(tokenMint);
    if (chain === 'robinhood-chain') {
        const officialPrice = await fetchRobinhoodChainPrice(cleanMint);
        if (officialPrice !== null)
            return officialPrice;
        const dexPrice = await fetchDexScreenerPrice(cleanMint, chain);
        return dexPrice !== null && !isNaN(dexPrice) ? dexPrice : null;
    }
    // Try DexScreener first (supports all chains)
    let price = await fetchDexScreenerPrice(cleanMint, chain);
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
export async function fetchTokenMetadata(tokenMint) {
    const { chain, raw: cleanMint } = resolveChainValue(tokenMint);
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
                    const json = await response.json();
                    if (!json.error && json.result?.content?.metadata) {
                        const name = json.result.content.metadata.name || 'Unknown';
                        const symbol = json.result.content.metadata.symbol || 'UNKNOWN';
                        return { name, symbol };
                    }
                }
            }
            catch (error) {
                console.error(`[prices] Helius getAsset error for ${cleanMint}:`, error);
            }
        }
    }
    // 2. Fallback to DexScreener (supports all chains)
    try {
        const pair = await fetchDexScreenerPair(cleanMint, chain);
        const base = pair?.baseToken;
        if (base?.name && base?.symbol) {
            return { name: base.name, symbol: base.symbol };
        }
    }
    catch (error) {
        console.error(`[prices] DexScreener metadata error for ${cleanMint} on ${chain}:`, error);
    }
    return null;
}
//# sourceMappingURL=prices.js.map