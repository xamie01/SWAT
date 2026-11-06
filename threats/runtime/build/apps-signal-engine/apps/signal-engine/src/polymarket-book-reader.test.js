import { describe, expect, it, vi } from 'vitest';
/**
 * `@swat/db` re-exports its own barrel, whose `client.ts` throws
 * `DATABASE_URL is required` while being evaluated. Same hoisted guard
 * `capacity-inputs.test.ts` and `fanout-enqueue.test.ts` use. Nothing here opens
 * a connection: the only `@swat/db` import in the module under test is the pure
 * `unknownLiquidity`.
 */
vi.hoisted(() => {
    process.env.DATABASE_URL ??= 'postgres://swat:swat@127.0.0.1:5432/swat_unit_tests';
});
import { createInMemoryPolymarketBookTransport, createPolymarketBookPublisher, POLYMARKET_BOOK_MAX_AGE_MS, serializePolymarketBookEntry, polymarketBookKey } from '@swat/shared';
import { createPolymarketBookLiquidityReader, polymarketBookChainMismatch, POLYMARKET_BOOK_CHAIN, usableLiquidityFromBookVerdict } from './polymarket-book-reader.js';
const TOKEN_ID = '71321045679252212594626385532706912750332728571942532289631379312455583992563';
const TOKEN_MINT = `polygon:${TOKEN_ID}`;
const NOW = 1_770_000_000_000;
/** Polygon's aggregate-impact ceiling: DEFAULT_SLIPPAGE_BPS.polygon(300) * 1/3. */
const CAP_BPS = 100;
function bookEntry(over = {}) {
    return {
        status: 'book',
        tokenId: TOKEN_ID,
        observedAt: NOW - 1_000,
        ladders: {
            bids: [{ price: 0.4, size: 5_000 }],
            asks: [
                { price: 0.5, size: 5_000 },
                { price: 0.51, size: 5_000 }
            ]
        },
        ...over
    };
}
/** A transport already holding one serialized entry, as the indexer would leave it. */
async function transportWith(entry) {
    const transport = createInMemoryPolymarketBookTransport(() => NOW);
    const publisher = createPolymarketBookPublisher({ transport });
    const result = await publisher.publish(entry);
    expect(result.ok).toBe(true);
    return transport;
}
function reader(transport, now = () => NOW) {
    return createPolymarketBookLiquidityReader({ transport, now });
}
const EMPTY_TRANSPORT = {
    get: async () => null,
    set: async () => undefined,
    mget: async (keys) => keys.map(() => null)
};
describe('polymarketBookChainMismatch', () => {
    it('passes polygon through as no mismatch', () => {
        expect(polymarketBookChainMismatch('polygon', TOKEN_MINT)).toBeNull();
    });
    it.each(['solana', 'robinhood-chain'])('returns unknown rather than throwing for %s', (chain) => {
        const result = polymarketBookChainMismatch(chain, `${chain}:whatever`);
        expect(result).not.toBeNull();
        expect(result?.basis).toBe('unknown');
        expect(result?.usableLiquidityUsd).toBeNull();
        expect(result?.chain).toBe(chain);
    });
    it('names the wrong chain in the note so the caller error is findable', () => {
        expect(polymarketBookChainMismatch('solana', 'solana:x')?.note).toContain('solana');
    });
    it('exports polygon as the book chain', () => {
        expect(POLYMARKET_BOOK_CHAIN).toBe('polygon');
    });
});
describe('usableLiquidityFromBookVerdict', () => {
    it('publishes the calibrated reserve on an assessed verdict', async () => {
        const read = await reader(await transportWith(bookEntry())).read({
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            impactCapBps: CAP_BPS
        });
        expect(read.verdict?.outcome).toBe('assessed');
        expect(read.liquidity.basis).toBe('order-book-depth');
        expect(read.liquidity.usableLiquidityUsd).toBeGreaterThan(0);
    });
    it('reports the reserve as the depth model published it, not a re-derivation', async () => {
        const read = await reader(await transportWith(bookEntry())).read({
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            impactCapBps: CAP_BPS
        });
        expect(read.liquidity.usableLiquidityUsd).toBe(read.verdict?.liquidity.usableLiquidityUsd);
    });
    it('throws on a calibration mismatch rather than pricing against the wrong cap', async () => {
        const read = await reader(await transportWith(bookEntry())).read({
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            impactCapBps: CAP_BPS
        });
        const verdict = read.verdict;
        expect(verdict).not.toBeNull();
        expect(() => usableLiquidityFromBookVerdict(verdict, CAP_BPS + 1)).toThrow(/calibrated/i);
    });
    it('accepts the verdict at the cap it was built for', async () => {
        const read = await reader(await transportWith(bookEntry())).read({
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            impactCapBps: CAP_BPS
        });
        expect(() => usableLiquidityFromBookVerdict(read.verdict, CAP_BPS)).not.toThrow();
    });
    it('refuses an assessed verdict whose basis disagrees with its figure', () => {
        const corrupted = {
            outcome: 'assessed',
            reasonCode: 'polymarket-book-depth-assessed',
            unknownCode: null,
            unassessed: [],
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            boundBps: 200,
            ageMs: 1_000,
            depth: null,
            capacity: null,
            liquidity: {
                chain: 'polygon',
                tokenMint: TOKEN_MINT,
                usableLiquidityUsd: 5_000,
                basis: 'unknown',
                approximate: false,
                note: 'corrupted on purpose',
                calibratedForImpactCapBps: CAP_BPS
            },
            detail: 'corrupted on purpose'
        };
        const result = usableLiquidityFromBookVerdict(corrupted, CAP_BPS);
        expect(result.basis).toBe('unknown');
        expect(result.usableLiquidityUsd).toBeNull();
    });
    it('refuses an assessed verdict carrying a non-finite figure', () => {
        const corrupted = {
            outcome: 'assessed',
            reasonCode: 'polymarket-book-depth-assessed',
            unknownCode: null,
            unassessed: [],
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            boundBps: 200,
            ageMs: 1_000,
            depth: null,
            capacity: null,
            liquidity: {
                chain: 'polygon',
                tokenMint: TOKEN_MINT,
                usableLiquidityUsd: Number.POSITIVE_INFINITY,
                basis: 'order-book-depth',
                approximate: false,
                note: 'corrupted on purpose',
                calibratedForImpactCapBps: CAP_BPS
            },
            detail: 'corrupted on purpose'
        };
        expect(usableLiquidityFromBookVerdict(corrupted, CAP_BPS).usableLiquidityUsd).toBeNull();
    });
    it('refuses an assessed verdict carrying a non-positive figure', () => {
        const corrupted = {
            outcome: 'assessed',
            reasonCode: 'polymarket-book-depth-assessed',
            unknownCode: null,
            unassessed: [],
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            boundBps: 200,
            ageMs: 1_000,
            depth: null,
            capacity: null,
            liquidity: {
                chain: 'polygon',
                tokenMint: TOKEN_MINT,
                usableLiquidityUsd: 0,
                basis: 'order-book-depth',
                approximate: false,
                note: 'corrupted on purpose',
                calibratedForImpactCapBps: CAP_BPS
            },
            detail: 'corrupted on purpose'
        };
        expect(usableLiquidityFromBookVerdict(corrupted, CAP_BPS).usableLiquidityUsd).toBeNull();
    });
});
describe('unknown is never a number', () => {
    it('returns unknown, not zero, when the key is missing entirely', async () => {
        const read = await reader(EMPTY_TRANSPORT).read({
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            impactCapBps: CAP_BPS
        });
        expect(read.verdict?.outcome).toBe('unknown');
        expect(read.verdict?.unknownCode).toBe('book-not-cached');
        expect(read.liquidity.usableLiquidityUsd).toBeNull();
        expect(read.liquidity.basis).toBe('unknown');
    });
    it('returns unknown, not the last value, when the entry is stale', async () => {
        const transport = await transportWith(bookEntry());
        const read = await reader(transport, () => NOW + POLYMARKET_BOOK_MAX_AGE_MS + 5_000).read({
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            impactCapBps: CAP_BPS
        });
        expect(read.verdict?.unknownCode).toBe('book-snapshot-stale');
        expect(read.liquidity.usableLiquidityUsd).toBeNull();
    });
    it('returns unknown for a post-reconnect awaiting-snapshot entry', async () => {
        const transport = await transportWith({
            status: 'awaiting-snapshot',
            tokenId: TOKEN_ID,
            since: NOW - 1_000,
            bestBid: 0.4,
            bestAsk: 0.5
        });
        const read = await reader(transport).read({
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            impactCapBps: CAP_BPS
        });
        expect(read.verdict?.unknownCode).toBe('book-awaiting-snapshot');
        expect(read.liquidity.usableLiquidityUsd).toBeNull();
    });
    it('returns unknown for a crossed book', async () => {
        const transport = await transportWith(bookEntry({ ladders: { bids: [{ price: 0.6, size: 100 }], asks: [{ price: 0.5, size: 100 }] } }));
        const read = await reader(transport).read({
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            impactCapBps: CAP_BPS
        });
        expect(read.verdict?.unknownCode).toBe('book-crossed');
        expect(read.liquidity.usableLiquidityUsd).toBeNull();
    });
    it('returns unknown for a both-sides-empty book', async () => {
        const transport = await transportWith(bookEntry({ ladders: { bids: [], asks: [] } }));
        const read = await reader(transport).read({
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            impactCapBps: CAP_BPS
        });
        expect(read.verdict?.unknownCode).toBe('book-empty');
        expect(read.liquidity.usableLiquidityUsd).toBeNull();
    });
    it('carries the stable unknown code into the note for the operator', async () => {
        const read = await reader(EMPTY_TRANSPORT).read({
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            impactCapBps: CAP_BPS
        });
        expect(read.liquidity.note).toContain('polymarket-book-not-cached');
    });
    it('distinguishes a known-zero ladder from a missing feed in the note', async () => {
        // A populated bid side against an empty ask side: the book was read, it is
        // fresh, and the side a buying cohort consumes genuinely holds nothing. That
        // is the known-zero outcome, distinct from every unknown cause above.
        const transport = await transportWith(bookEntry({ ladders: { bids: [{ price: 0.4, size: 5_000 }], asks: [] } }));
        const read = await reader(transport).read({
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            impactCapBps: CAP_BPS
        });
        expect(read.verdict?.outcome).toBe('no-depth-within-bound');
        expect(read.liquidity.usableLiquidityUsd).toBeNull();
        expect(read.liquidity.note).toMatch(/known-zero|too thin/i);
    });
});
describe('the reader never throws', () => {
    it('degrades to unknown when the transport throws', async () => {
        const exploding = {
            get: async () => {
                throw new Error('ECONNREFUSED 127.0.0.1:6379');
            },
            set: async () => undefined,
            mget: async () => {
                throw new Error('ECONNREFUSED 127.0.0.1:6379');
            }
        };
        const warn = vi.fn();
        const read = await createPolymarketBookLiquidityReader({
            transport: exploding,
            now: () => NOW,
            logger: { warn }
        }).read({ tokenMint: TOKEN_MINT, cohortDirection: 'buy', impactCapBps: CAP_BPS });
        expect(read.liquidity.usableLiquidityUsd).toBeNull();
        expect(read.liquidity.basis).toBe('unknown');
        expect(warn).toHaveBeenCalled();
    });
    it('degrades to unknown on a non-positive impact cap rather than propagating the throw', async () => {
        const warn = vi.fn();
        const read = await createPolymarketBookLiquidityReader({
            transport: await transportWith(bookEntry()),
            now: () => NOW,
            logger: { warn }
        }).read({ tokenMint: TOKEN_MINT, cohortDirection: 'buy', impactCapBps: 0 });
        expect(read.verdict).toBeNull();
        expect(read.liquidity.usableLiquidityUsd).toBeNull();
        expect(read.logLine).toMatch(/refused/i);
        expect(warn).toHaveBeenCalled();
    });
    it('names a wiring defect distinctly from a feed problem', async () => {
        const read = await createPolymarketBookLiquidityReader({
            transport: await transportWith(bookEntry()),
            now: () => NOW
        }).read({ tokenMint: TOKEN_MINT, cohortDirection: 'buy', impactCapBps: -5 });
        expect(read.liquidity.note).toMatch(/defect/i);
    });
    it('survives an undecodable value in Redis', async () => {
        const transport = createInMemoryPolymarketBookTransport(() => NOW);
        await transport.set(polymarketBookKey(TOKEN_MINT), 'not json at all', 60_000);
        const read = await reader(transport).read({
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            impactCapBps: CAP_BPS
        });
        expect(read.liquidity.usableLiquidityUsd).toBeNull();
        expect(read.verdict?.outcome).toBe('unknown');
    });
    it('survives a version-skewed payload', async () => {
        const raw = serializePolymarketBookEntry(bookEntry());
        const skewed = JSON.stringify({ ...JSON.parse(raw), v: 9_999 });
        const transport = createInMemoryPolymarketBookTransport(() => NOW);
        await transport.set(polymarketBookKey(TOKEN_MINT), skewed, 60_000);
        const read = await reader(transport).read({
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            impactCapBps: CAP_BPS
        });
        expect(read.liquidity.usableLiquidityUsd).toBeNull();
    });
    it('works without a logger configured', async () => {
        const exploding = {
            get: async () => {
                throw new Error('down');
            },
            set: async () => undefined,
            mget: async () => {
                throw new Error('down');
            }
        };
        await expect(createPolymarketBookLiquidityReader({ transport: exploding, now: () => NOW }).read({
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            impactCapBps: CAP_BPS
        })).resolves.toBeDefined();
    });
});
describe('round trip with the indexer writer', () => {
    it('reads back what the publisher wrote, priced', async () => {
        const transport = createInMemoryPolymarketBookTransport(() => NOW);
        const publisher = createPolymarketBookPublisher({ transport });
        await publisher.publish(bookEntry());
        const read = await reader(transport).read({
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            impactCapBps: CAP_BPS
        });
        expect(read.verdict?.outcome).toBe('assessed');
        expect(read.liquidity.basis).toBe('order-book-depth');
    });
    it('accepts an unprefixed token id for the same slot', async () => {
        const transport = await transportWith(bookEntry());
        const prefixed = await reader(transport).read({
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            impactCapBps: CAP_BPS
        });
        const bare = await reader(transport).read({
            tokenMint: TOKEN_ID,
            cohortDirection: 'buy',
            impactCapBps: CAP_BPS
        });
        expect(bare.liquidity.usableLiquidityUsd).toBe(prefixed.liquidity.usableLiquidityUsd);
    });
    it('prices the two cohort directions off different sides of the book', async () => {
        const transport = await transportWith(bookEntry({
            ladders: {
                bids: [{ price: 0.4, size: 100 }],
                asks: [{ price: 0.5, size: 50_000 }]
            }
        }));
        const buy = await reader(transport).read({
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            impactCapBps: CAP_BPS
        });
        const sell = await reader(transport).read({
            tokenMint: TOKEN_MINT,
            cohortDirection: 'sell',
            impactCapBps: CAP_BPS
        });
        expect(buy.liquidity.usableLiquidityUsd).not.toBe(sell.liquidity.usableLiquidityUsd);
    });
    it('does not memoise across reads: a deleted key reads unknown immediately after a hit', async () => {
        const store = new Map();
        let currentNow = NOW;
        const transport = {
            get: async (key) => store.get(key) ?? null,
            set: async (key, value) => {
                store.set(key, value);
            },
            mget: async (keys) => keys.map((key) => store.get(key) ?? null)
        };
        const instance = createPolymarketBookLiquidityReader({ transport, now: () => currentNow });
        await transport.set(polymarketBookKey(TOKEN_MINT), serializePolymarketBookEntry(bookEntry()), 60_000);
        const first = await instance.read({
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            impactCapBps: CAP_BPS
        });
        expect(first.verdict?.outcome).toBe('assessed');
        store.clear();
        currentNow = NOW + 10;
        const second = await instance.read({
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            impactCapBps: CAP_BPS
        });
        expect(second.verdict?.unknownCode).toBe('book-not-cached');
        expect(second.liquidity.usableLiquidityUsd).toBeNull();
    });
});
describe('reported budget and log line', () => {
    it('defaults the freshness budget to the shared constant', () => {
        expect(reader(EMPTY_TRANSPORT).maxAgeMs).toBe(POLYMARKET_BOOK_MAX_AGE_MS);
    });
    it('honours an explicit budget override', async () => {
        const instance = createPolymarketBookLiquidityReader({
            transport: await transportWith(bookEntry()),
            now: () => NOW,
            maxAgeMs: 500
        });
        expect(instance.maxAgeMs).toBe(500);
        // The entry is 1_000ms old, so a 500ms budget must call it stale.
        const read = await instance.read({
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            impactCapBps: CAP_BPS
        });
        expect(read.verdict?.unknownCode).toBe('book-snapshot-stale');
    });
    it('reports the transport code alongside the venue verdict', async () => {
        const read = await reader(EMPTY_TRANSPORT).read({
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            impactCapBps: CAP_BPS
        });
        expect(read.logLine).toContain('key-missing');
    });
    it('says unknown rather than a figure in the log line when unassessed', async () => {
        const read = await reader(EMPTY_TRANSPORT).read({
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            impactCapBps: CAP_BPS
        });
        expect(read.logLine).toContain('reserve unknown');
        expect(read.logLine).not.toMatch(/reserve \$/);
    });
    it('carries the cap in force in the log line', async () => {
        const read = await reader(await transportWith(bookEntry())).read({
            tokenMint: TOKEN_MINT,
            cohortDirection: 'buy',
            impactCapBps: CAP_BPS
        });
        expect(read.logLine).toContain(`${CAP_BPS}bps`);
    });
});
//# sourceMappingURL=polymarket-book-reader.test.js.map