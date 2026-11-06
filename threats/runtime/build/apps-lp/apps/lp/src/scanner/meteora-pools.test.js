import { describe, expect, it } from 'vitest';
import { createMeteoraPoolFetcher } from './meteora-pools.js';
const apiRow = (overrides = {}) => ({
    address: '3ucNos4Nbum3ZNF6ndRiMKK4sjKbLRPmv4V7WtH2sApY',
    name: 'SOL-USDC',
    token_x: {
        address: 'So11111111111111111111111111111111111111112',
        price: 150
    },
    token_y: {
        address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        price: 1
    },
    pool_config: {
        bin_step: 10,
        base_fee_pct: 0.02
    },
    current_price: 150.25,
    tvl: 1_000_000,
    volume: { '24h': 900_000 },
    fees: { '24h': 420 },
    ...overrides
});
const response = (rows, overrides = {}) => ({
    total: rows.length,
    pages: 1,
    current_page: 1,
    page_size: rows.length,
    data: rows,
    ...overrides
});
function fetcherWith(payloads, options = {}) {
    const urls = [];
    let call = 0;
    return {
        urls,
        fetcher: createMeteoraPoolFetcher({
            apiBase: 'https://dlmm.datapi.test',
            fetchImpl: (async (input) => {
                urls.push(new URL(String(input)));
                const body = payloads[Math.min(call++, payloads.length - 1)];
                return new Response(JSON.stringify(body), {
                    status: 200,
                    headers: { 'content-type': 'application/json' }
                });
            }),
            ...options
        })
    };
}
describe('createMeteoraPoolFetcher', () => {
    it('normalizes the current paginated API schema and fee units', async () => {
        const { fetcher } = fetcherWith([response([apiRow()])], { maxPairs: 1 });
        const pools = await fetcher.fetch();
        expect(pools).toHaveLength(1);
        const pool = pools[0];
        expect(pool.poolAddress).toBe('solana:3ucNos4Nbum3ZNF6ndRiMKK4sjKbLRPmv4V7WtH2sApY');
        expect(pool.baseTokenMint).toBe('solana:So11111111111111111111111111111111111111112');
        expect(pool.quoteTokenMint).toBe('solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
        expect(pool.feeBps).toBeCloseTo(2, 9); // 0.02 percent = 2 bps
        expect(pool.binStep).toBe(10);
        expect(pool.tvl).toBe(1_000_000);
        expect(pool.volume24h).toBe(900_000);
        expect(pool.fees24h).toBe(420);
        expect(pool.fees7d).toBeNull();
        expect(pool.activeTvlExact).toBe(false);
    });
    it('uses API token prices for exact active TVL', async () => {
        const { fetcher } = fetcherWith([response([apiRow()])], {
            maxPairs: 1,
            binSource: {
                fetchBins: async () => ({
                    activeBinId: 100,
                    bins: [
                        { binId: 100, price: 150, baseAmount: 2, quoteAmount: 100 },
                        { binId: 300, price: 160, baseAmount: 50, quoteAmount: 0 }
                    ]
                })
            }
        });
        const pool = (await fetcher.fetch())[0];
        expect(pool.activeTvlExact).toBe(true);
        expect(pool.activeTvlUsd).toBeCloseTo(45_100, 9);
    });
    it('lets explicit token prices override API token prices', async () => {
        const { fetcher } = fetcherWith([response([apiRow()])], {
            maxPairs: 1,
            tokenPrices: {
                prices: new Map([
                    ['solana:So11111111111111111111111111111111111111112', 100],
                    ['solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 2]
                ])
            },
            binSource: {
                fetchBins: async () => ({
                    bins: [{ binId: 100, price: 150, baseAmount: 2, quoteAmount: 100 }],
                    activeBinId: 100
                })
            }
        });
        const pool = (await fetcher.fetch())[0];
        expect(pool.activeTvlUsd).toBeCloseTo(30_200, 9);
    });
    it('maps query and paginates until maxPairs is reached', async () => {
        const first = [apiRow({ address: '11111111111111111111111111111111', name: 'FIRST' })];
        const second = [apiRow({ address: '22222222222222222222222222222222', name: 'SECOND' })];
        const { fetcher, urls } = fetcherWith([
            response(first, { total: 2, pages: 2, page_size: 1 }),
            response(second, { total: 2, pages: 2, current_page: 2, page_size: 1 })
        ], { searchTerm: 'SOL', maxPairs: 2 });
        const pools = await fetcher.fetch();
        expect(pools).toHaveLength(2);
        expect(urls).toHaveLength(2);
        expect(urls[0].pathname).toBe('/pools');
        expect(urls[0].searchParams.get('page')).toBe('1');
        expect(urls[0].searchParams.get('page_size')).toBe('2');
        expect(urls[0].searchParams.get('query')).toBe('SOL');
        expect(urls[1].searchParams.get('page')).toBe('2');
    });
    it('returns no rows when maxPairs is zero', async () => {
        const { fetcher } = fetcherWith([], { maxPairs: 0 });
        await expect(fetcher.fetch()).resolves.toEqual([]);
    });
    it('skips malformed rows instead of failing the whole scan', async () => {
        const { fetcher } = fetcherWith([response([
                apiRow(),
                { ...apiRow({ address: '' }) }
            ])], { maxPairs: 2 });
        const pools = await fetcher.fetch();
        expect(pools).toHaveLength(1);
    });
    it('throws on an API error status', async () => {
        const fetcher = createMeteoraPoolFetcher({
            apiBase: 'https://dlmm.datapi.test',
            fetchImpl: (async () => new Response('boom', { status: 503 }))
        });
        await expect(fetcher.fetch()).rejects.toThrow('503');
    });
    it('throws on an invalid paginated payload', async () => {
        const fetcher = createMeteoraPoolFetcher({
            apiBase: 'https://dlmm.datapi.test',
            fetchImpl: (async () => new Response(JSON.stringify([]), { status: 200 }))
        });
        await expect(fetcher.fetch()).rejects.toThrow('invalid paginated payload');
    });
});
//# sourceMappingURL=meteora-pools.test.js.map