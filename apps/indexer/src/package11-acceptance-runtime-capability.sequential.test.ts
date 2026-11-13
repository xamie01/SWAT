import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchConfirmedPolymarketTradePages } from './polymarket.js';
import { parseConfirmedPolymarketTrade } from './polymarket-helpers.js';

// This acceptance probe invokes only the public page reader and pure parser.
// No database implementation or service entrypoint is loaded.
vi.mock('@swat/db', () => ({}));

const nativeParse = JSON.parse;
const wallet = `0x${'1'.repeat(40)}`;
const wireTrade = `{"proxyWallet":"${wallet}","timestamp":1719397500,"conditionId":"0x${'a'.repeat(64)}","asset":"1234567890","size":9007199254.740993,"price":0.640000000000000001,"side":"BUY","transactionHash":"0x${'b'.repeat(64)}","outcome":"Yes","title":"Offline runtime capability probe"}`;

function response(body: string): Response {
  return new Response(`{"data":[${body}],"pagination":{"next_cursor":null,"has_more":false}}`, {
    headers: { 'content-type': 'application/json' }
  });
}

function emulateParserWithoutSourceContext(): void {
  // Delegate syntax parsing to the native implementation, but expose only the
  // historical two-argument reviver contract to production's callback.
  vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => nativeParse(text,
    reviver ? (key, value) => reviver(key, value) : undefined));
}

afterEach(() => vi.restoreAllMocks());

describe('package11 offline acceptance: runtime JSON number capability', () => {
  it('retains original numeric economics through the installed runtime and public reader', async () => {
    const fetchImpl = vi.fn(async () => response(wireTrade));
    const rows = await fetchConfirmedPolymarketTradePages({ user: wallet, fetchImpl, pageLimit: 1 });
    const trade = parseConfirmedPolymarketTrade(rows[0]);
    expect(trade.size).toBe('9007199254.740993');
    expect(trade.price).toBe('0.640000000000000001');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    console.log(`[package11-acceptance-runtime] ${process.version}; exact public-reader numeric lexemes retained`);
  });

  it('refuses numeric economics rather than accepting rounded values when source context is unavailable', async () => {
    emulateParserWithoutSourceContext();
    const fetchImpl = vi.fn(async () => response(wireTrade));
    await expect(fetchConfirmedPolymarketTradePages({ user: wallet, fetchImpl, pageLimit: 1 }))
      .rejects.toThrow('Polymarket exact JSON number parsing unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('preserves provider-quoted economics without relying on numeric source context', async () => {
    emulateParserWithoutSourceContext();
    const quotedTrade = wireTrade.replace('"size":9007199254.740993', '"size":"9007199254.740993"')
      .replace('"price":0.640000000000000001', '"price":"0.640000000000000001"');
    const fetchImpl = vi.fn(async () => response(quotedTrade));
    const rows = await fetchConfirmedPolymarketTradePages({ user: wallet, fetchImpl, pageLimit: 1 });
    const trade = parseConfirmedPolymarketTrade(rows[0]);
    expect(trade.size).toBe('9007199254.740993');
    expect(trade.price).toBe('0.640000000000000001');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
