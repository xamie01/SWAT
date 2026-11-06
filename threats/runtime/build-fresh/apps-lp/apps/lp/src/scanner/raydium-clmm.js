import bs58 from 'bs58';
import { prefixChainValue } from '@swat/shared';
import { createActiveTvlCalculator } from './active-tvl.js';
export const RAYDIUM_CLMM_PROGRAM_ID = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const POOL_TOKEN_MINT_0_OFFSET = 73;
const POOL_TOKEN_MINT_1_OFFSET = 105;
const POOL_MINT_0_DECIMALS_OFFSET = 233;
const POOL_MINT_1_DECIMALS_OFFSET = 234;
const POOL_TICK_SPACING_OFFSET = 235;
const POOL_LIQUIDITY_OFFSET = 237;
const POOL_SQRT_PRICE_X64_OFFSET = 253;
const POOL_TICK_CURRENT_OFFSET = 269;
const POOL_FEE_RATE_OFFSET = 277;
export function decodeRaydiumPoolState(address, buffer) {
    if (buffer.length < 281) {
        throw new Error(`Raydium pool account data too short: ${buffer.length} bytes`);
    }
    const tokenMint0 = bs58.encode(buffer.subarray(POOL_TOKEN_MINT_0_OFFSET, POOL_TOKEN_MINT_0_OFFSET + 32));
    const tokenMint1 = bs58.encode(buffer.subarray(POOL_TOKEN_MINT_1_OFFSET, POOL_TOKEN_MINT_1_OFFSET + 32));
    const mint0Decimals = buffer.readUInt8(POOL_MINT_0_DECIMALS_OFFSET);
    const mint1Decimals = buffer.readUInt8(POOL_MINT_1_DECIMALS_OFFSET);
    const tickSpacing = buffer.readUInt16LE(POOL_TICK_SPACING_OFFSET);
    const liquidity = (BigInt(buffer.readBigUInt64LE(POOL_LIQUIDITY_OFFSET + 8)) << 64n) | BigInt(buffer.readBigUInt64LE(POOL_LIQUIDITY_OFFSET));
    const sqrtPriceX64 = (BigInt(buffer.readBigUInt64LE(POOL_SQRT_PRICE_X64_OFFSET + 8)) << 64n) | BigInt(buffer.readBigUInt64LE(POOL_SQRT_PRICE_X64_OFFSET));
    const tickCurrent = buffer.readInt32LE(POOL_TICK_CURRENT_OFFSET);
    const feeRate = buffer.readUInt32LE(POOL_FEE_RATE_OFFSET);
    return {
        address,
        tokenMint0,
        tokenMint1,
        mint0Decimals,
        mint1Decimals,
        tickSpacing,
        liquidity,
        sqrtPriceX64,
        tickCurrent,
        feeRate
    };
}
export function createRpcRaydiumPort(rpcUrl) {
    let nextId = 0;
    return {
        async getAccountInfoBase64(address) {
            const response = await fetch(rpcUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: ++nextId,
                    method: 'getAccountInfo',
                    params: [address, { encoding: 'base64' }]
                })
            });
            if (!response.ok)
                throw new Error(`HTTP ${response.status} from Solana RPC`);
            const payload = (await response.json());
            if (payload.error)
                throw new Error(payload.error.message ?? 'Solana RPC error');
            const data = payload.result?.value?.data;
            return data ? data[0] : null;
        }
    };
}
export function createRaydiumClmmPoolFetcher(options) {
    const activeTickRange = options.activeTickRange ?? 1200;
    const activeTvlCalculator = createActiveTvlCalculator();
    return {
        chain: 'solana',
        protocol: 'raydium-clmm',
        async fetch() {
            const pools = [];
            for (const poolAddress of options.configuredPools) {
                const rawAddress = poolAddress.startsWith('solana:') ? poolAddress.slice(7) : poolAddress;
                const base64 = await options.rpcPort.getAccountInfoBase64(rawAddress);
                if (!base64)
                    continue;
                const buffer = Buffer.from(base64, 'base64');
                const state = decodeRaydiumPoolState(rawAddress, buffer);
                // Price = (sqrtPriceX64 / 2^64)^2 * 10^(decimals0 - decimals1)
                const sqrt = Number(state.sqrtPriceX64) / 2 ** 64;
                const currentPrice = sqrt * sqrt * 10 ** (state.mint0Decimals - state.mint1Decimals);
                // Single active band estimate around current tick
                const tickBand = {
                    tickLower: state.tickCurrent - activeTickRange,
                    tickUpper: state.tickCurrent + activeTickRange,
                    liquidity: Number(state.liquidity)
                };
                const baseToken = state.tokenMint0;
                const quoteToken = state.tokenMint1;
                const externalBasePrice = await options.priceSource?.priceUsd(baseToken);
                const externalQuotePrice = await options.priceSource?.priceUsd(quoteToken);
                const quotePriceUsd = externalQuotePrice ?? (quoteToken === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' ? 1 : null);
                const basePriceUsd = externalBasePrice ??
                    (quotePriceUsd !== null && quotePriceUsd !== undefined ? currentPrice * quotePriceUsd : null);
                const activeTvlUsd = basePriceUsd !== null && quotePriceUsd !== null
                    ? activeTvlCalculator.calculateActiveTvl({
                        protocol: 'raydium-clmm',
                        bands: [tickBand],
                        currentTick: state.tickCurrent,
                        range: activeTickRange,
                        basePriceUsd,
                        quotePriceUsd,
                        baseTokenDecimals: state.mint0Decimals,
                        quoteTokenDecimals: state.mint1Decimals
                    })
                    : null;
                const volume24h = (await options.volumeSource?.volume24hUsd(rawAddress)) ?? 0;
                pools.push({
                    chain: 'solana',
                    protocol: 'raydium-clmm',
                    poolAddress: prefixChainValue(rawAddress, 'solana'),
                    pairLabel: `${state.tokenMint0.slice(0, 4)}..${state.tokenMint0.slice(-4)}/${state.tokenMint1.slice(0, 4)}..${state.tokenMint1.slice(-4)}`,
                    baseTokenMint: prefixChainValue(state.tokenMint0, 'solana'),
                    quoteTokenMint: prefixChainValue(state.tokenMint1, 'solana'),
                    feeBps: state.feeRate / 100, // feeRate in hundredths of bps
                    binStep: null,
                    tickSpacing: state.tickSpacing,
                    currentPrice,
                    tvl: activeTvlUsd ?? 0,
                    activeTvlUsd: activeTvlUsd ?? 0,
                    activeTvlExact: activeTvlUsd !== null,
                    volume24h,
                    fees24h: 0,
                    fees7d: null
                });
            }
            return pools;
        }
    };
}
//# sourceMappingURL=raydium-clmm.js.map