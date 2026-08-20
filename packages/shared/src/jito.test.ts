import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  JITO_TIP_ACCOUNTS,
  JITO_TIP_ACCOUNTS_CACHE_MAX_ENTRIES,
  JITO_TIP_ACCOUNTS_CACHE_TTL_MS,
  JITO_TIP_ACCOUNTS_FALLBACK_TTL_MS,
  clearJitoTipAccountsCache,
  getJitoTipAccounts,
  jitoTipAccountsCacheSize,
  lamportsToUsd,
  selectJitoTip,
  selectTipAccount,
  type JitoClientOptions,
  type JitoTipFloor
} from './jito.js';

const floor: JitoTipFloor = {
  p25: 1_000,
  p50: 10_000,
  p75: 100_000,
  p95: 1_000_000,
  p99: 10_000_000
};

describe('jito tip sizing', () => {
  it('targets the requested percentile', () => {
    expect(
      selectJitoTip({ floor, percentile: 'p50', maxTipLamports: 50_000_000, fallbackTipLamports: 5_000 })
    ).toBe(10_000);
    expect(
      selectJitoTip({ floor, percentile: 'p95', maxTipLamports: 50_000_000, fallbackTipLamports: 5_000 })
    ).toBe(1_000_000);
  });

  it('never exceeds the cap, however high the floor climbs', () => {
    // The cap is the only thing standing between a congestion spike (or a
    // malformed floor response) and unbounded SOL spend per trade.
    expect(
      selectJitoTip({ floor, percentile: 'p95', maxTipLamports: 50_000, fallbackTipLamports: 5_000 })
    ).toBe(50_000);
  });

  it('falls back when the floor is unreadable rather than abandoning the trade', () => {
    expect(
      selectJitoTip({ floor: null, percentile: 'p75', maxTipLamports: 50_000_000, fallbackTipLamports: 7_777 })
    ).toBe(7_777);
  });

  it('treats a zero percentile as no-data, not as free', () => {
    // A zero tip never lands. Reading "0" as a valid tip would silently produce
    // bundles that are never built, which looks identical to a dead executor.
    const zeroFloor: JitoTipFloor = { p25: 0, p50: 0, p75: 0, p95: 0, p99: 0 };
    expect(
      selectJitoTip({ floor: zeroFloor, percentile: 'p50', maxTipLamports: 1_000_000, fallbackTipLamports: 9_000 })
    ).toBe(9_000);
  });

  it('never returns a tip below 1 lamport', () => {
    expect(
      selectJitoTip({ floor, percentile: 'p50', maxTipLamports: 0, fallbackTipLamports: 0 })
    ).toBe(1);
  });

  it('rounds to whole lamports', () => {
    const fractional: JitoTipFloor = { p25: 0, p50: 1234.7, p75: 0, p95: 0, p99: 0 };
    const tip = selectJitoTip({
      floor: fractional,
      percentile: 'p50',
      maxTipLamports: 1_000_000,
      fallbackTipLamports: 1
    });
    expect(Number.isInteger(tip)).toBe(true);
    expect(tip).toBe(1235);
  });
});

describe('tip account selection', () => {
  it('always returns a real tip account', () => {
    // A tip to any other address is simply a donation — the bundle is ignored.
    for (const seed of ['a', 'signal-123', '', 'x'.repeat(200)]) {
      expect(JITO_TIP_ACCOUNTS).toContain(selectTipAccount(seed, JITO_TIP_ACCOUNTS));
    }
  });

  it('is deterministic for the same seed and the same set', () => {
    expect(selectTipAccount('signal-42', JITO_TIP_ACCOUNTS)).toBe(
      selectTipAccount('signal-42', JITO_TIP_ACCOUNTS)
    );
  });

  it('spreads across the account set', () => {
    const seen = new Set(
      Array.from({ length: 200 }, (_, i) => selectTipAccount(`signal-${i}`, JITO_TIP_ACCOUNTS))
    );
    // Not a uniformity proof — just that it is not pinned to one account, which
    // would concentrate load and make the spread pointless.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('picks only from the set it was given, never from the hard-coded one', () => {
    // The whole point of S4-P18: once the live set is resolved at runtime, paying
    // an address that is no longer in it means the block engine ignores the
    // bundle, nothing lands, and the executor still reports success.
    const live = [fakeTipAccount('LiveTip1'), fakeTipAccount('LiveTip2')];
    for (const seed of ['a', 'signal-123', '', 'x'.repeat(200)]) {
      const picked = selectTipAccount(seed, live);
      expect(live).toContain(picked);
      expect(JITO_TIP_ACCOUNTS).not.toContain(picked);
    }
  });

  it('falls back rather than tipping nobody when handed an empty set', () => {
    // `hash % 0` is NaN and the lookup would be undefined — a tip transfer to no
    // address at all. `getJitoTipAccounts` never returns empty, but this function
    // is exported and a future caller might.
    expect(JITO_TIP_ACCOUNTS).toContain(selectTipAccount('signal-1', []));
  });

  it('may pick a different account after the set changes, and that is fine', () => {
    // Determinism is per-set, not absolute: `hash % length` moves when the length
    // does. Nothing downstream keys off *which* tip account was used, only that
    // it is a currently-valid one, and the tip account is chosen once per bundle.
    const seed = 'signal-42';
    const shrunk = JITO_TIP_ACCOUNTS.slice(0, 3);
    expect(shrunk).toContain(selectTipAccount(seed, shrunk));
  });
});

/** Base58 without `0`, `O`, `I`, `l`, padded to the 32-char minimum. */
function fakeTipAccount(label: string): string {
  return label.padEnd(32, 'z');
}

const JITO: JitoClientOptions = { baseUrl: 'https://mainnet.block-engine.jito.wtf' };

function stubTipAccountsResponse(body: unknown, init: { ok?: boolean } = {}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: init.ok ?? true,
    json: async () => body
  } as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * The tip-account allowlist is resolved at runtime (checklist S4-P18).
 *
 * It used to be a hard-coded 8-entry array. Jito rotates those addresses, and a
 * stale entry fails in the worst available way: the tip goes to an address the
 * block engine no longer recognises, so the bundle is silently ignored — nothing
 * lands, and the executor still reports a successful submission. Nothing in the
 * system notices, which is exactly why these tests exist.
 *
 * The fallback matters just as much in the other direction: an unreadable
 * endpoint must never block an otherwise-valid trade.
 */
describe('tip account resolution', () => {
  beforeEach(() => {
    vi.useRealTimers();
    clearJitoTipAccountsCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearJitoTipAccountsCache();
  });

  it('asks the block engine bundle endpoint for getTipAccounts', async () => {
    const fetchMock = stubTipAccountsResponse({ result: [fakeTipAccount('LiveTip1')] });

    await getJitoTipAccounts(JITO);

    const [url, init] = fetchMock.mock.calls[0]!;
    // Verified against Jito's own client (`jito-labs/jito-js-rpc`): tip accounts
    // come from the same `/bundles` JSON-RPC endpoint as `sendBundle`, not from
    // the `bundles.jito.wtf` REST host that serves the tip *floor*.
    expect(url).toBe('https://mainnet.block-engine.jito.wtf/api/v1/bundles');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({
      jsonrpc: '2.0',
      method: 'getTipAccounts',
      params: []
    });
  });

  it('yields the live set when the endpoint answers', async () => {
    const live = [fakeTipAccount('LiveTip1'), fakeTipAccount('LiveTip2')];
    stubTipAccountsResponse({ result: live });

    const accounts = await getJitoTipAccounts(JITO);

    expect(accounts).toEqual(live);
    // A rotation is only picked up if the live answer actually wins.
    expect(accounts).not.toEqual(JITO_TIP_ACCOUNTS);
  });

  it('falls back to the hard-coded set when the endpoint is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    // Not an empty set and not a throw: a tip-address lookup must never be the
    // reason an otherwise-valid trade fails to submit.
    await expect(getJitoTipAccounts(JITO)).resolves.toEqual(JITO_TIP_ACCOUNTS);
  });

  it('falls back when the endpoint answers with an HTTP error', async () => {
    stubTipAccountsResponse({ result: [fakeTipAccount('LiveTip1')] }, { ok: false });
    await expect(getJitoTipAccounts(JITO)).resolves.toEqual(JITO_TIP_ACCOUNTS);
  });

  it('falls back when the endpoint answers with a JSON-RPC error', async () => {
    stubTipAccountsResponse({ error: { code: -32601, message: 'Method not found' } });
    await expect(getJitoTipAccounts(JITO)).resolves.toEqual(JITO_TIP_ACCOUNTS);
  });

  it.each([
    ['a non-array result', { result: 'not-an-array' }],
    ['an empty array', { result: [] }],
    ['non-string entries', { result: [123, null, { address: 'x' }] }],
    ['entries that are not base58 addresses', { result: ['0xdeadbeef', 'not an address'] }],
    ['no result at all', {}]
  ])('falls back on a malformed response: %s', async (_label, body) => {
    stubTipAccountsResponse(body);
    await expect(getJitoTipAccounts(JITO)).resolves.toEqual(JITO_TIP_ACCOUNTS);
  });

  it('never widens the allowlist with an entry it cannot parse', async () => {
    // This list is a payment allowlist — every address in it gets real SOL. A
    // partially-garbage response must contribute only what it can be trusted for.
    const good = fakeTipAccount('LiveTip1');
    stubTipAccountsResponse({ result: [good, 'not an address', 42, `${good}!!!`] });

    await expect(getJitoTipAccounts(JITO)).resolves.toEqual([good]);
  });

  it('deduplicates a repeated address', async () => {
    const good = fakeTipAccount('LiveTip1');
    stubTipAccountsResponse({ result: [good, good] });
    await expect(getJitoTipAccounts(JITO)).resolves.toEqual([good]);
  });

  it('falls back when no block engine is configured, without a request', async () => {
    const fetchMock = stubTipAccountsResponse({ result: [fakeTipAccount('LiveTip1')] });

    await expect(getJitoTipAccounts({ baseUrl: '  ' })).resolves.toEqual(JITO_TIP_ACCOUNTS);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves a repeat lookup from cache without a second request', async () => {
    const fetchMock = stubTipAccountsResponse({ result: [fakeTipAccount('LiveTip1')] });

    await getJitoTipAccounts(JITO);
    await getJitoTipAccounts(JITO);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight lookup between concurrent callers', async () => {
    // A batch of submits arriving together would otherwise stampede the block
    // engine on every cold cache.
    const fetchMock = stubTipAccountsResponse({ result: [fakeTipAccount('LiveTip1')] });

    await Promise.all([
      getJitoTipAccounts(JITO),
      getJitoTipAccounts(JITO),
      getJitoTipAccounts(JITO)
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('holds a resolved set for exactly the TTL and no longer', async () => {
    vi.useFakeTimers();
    const fetchMock = stubTipAccountsResponse({ result: [fakeTipAccount('LiveTip1')] });
    await getJitoTipAccounts(JITO);

    vi.advanceTimersByTime(JITO_TIP_ACCOUNTS_CACHE_TTL_MS - 1);
    await getJitoTipAccounts(JITO);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // One millisecond past the boundary the set is refetched. Without this the
    // cache is just the hard-coded array with extra steps: a rotation that
    // happens after boot would never be observed.
    vi.advanceTimersByTime(1);
    await getJitoTipAccounts(JITO);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('picks up a rotation once the TTL expires', async () => {
    vi.useFakeTimers();
    const rotated = fakeTipAccount('Rotated1');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: [fakeTipAccount('LiveTip1')] }) })
      .mockResolvedValue({ ok: true, json: async () => ({ result: [rotated] }) });
    vi.stubGlobal('fetch', fetchMock);

    await getJitoTipAccounts(JITO);
    vi.advanceTimersByTime(JITO_TIP_ACCOUNTS_CACHE_TTL_MS);

    await expect(getJitoTipAccounts(JITO)).resolves.toEqual([rotated]);
  });

  it('retries a failed resolution sooner than it would refresh a good one', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getJitoTipAccounts(JITO)).resolves.toEqual(JITO_TIP_ACCOUNTS);

    // Held briefly so a misconfigured endpoint does not add a failing round trip
    // to every trade...
    vi.advanceTimersByTime(JITO_TIP_ACCOUNTS_FALLBACK_TTL_MS - 1);
    await getJitoTipAccounts(JITO);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // ...but retried well inside the success TTL, so a transient outage does not
    // pin the executor to a possibly-stale array for five minutes.
    vi.advanceTimersByTime(1);
    await getJitoTipAccounts(JITO);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JITO_TIP_ACCOUNTS_FALLBACK_TTL_MS).toBeLessThan(JITO_TIP_ACCOUNTS_CACHE_TTL_MS);
  });

  it('recovers the live set on the retry after a transient outage', async () => {
    vi.useFakeTimers();
    const live = [fakeTipAccount('LiveTip1')];
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue({ ok: true, json: async () => ({ result: live }) });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getJitoTipAccounts(JITO)).resolves.toEqual(JITO_TIP_ACCOUNTS);
    vi.advanceTimersByTime(JITO_TIP_ACCOUNTS_FALLBACK_TTL_MS);

    await expect(getJitoTipAccounts(JITO)).resolves.toEqual(live);
  });

  it('sweeps expired entries instead of retaining them forever', async () => {
    vi.useFakeTimers();
    stubTipAccountsResponse({ result: [fakeTipAccount('LiveTip1')] });

    await getJitoTipAccounts({ baseUrl: 'https://retired.block-engine.test' });
    expect(jitoTipAccountsCacheSize()).toBe(1);

    vi.advanceTimersByTime(JITO_TIP_ACCOUNTS_CACHE_TTL_MS + 1);
    // The sweep runs on write, so one unrelated lookup collects the dead entry.
    await getJitoTipAccounts(JITO);

    expect(jitoTipAccountsCacheSize()).toBe(1);
  });

  it('stays bounded when keyed by many distinct endpoints', async () => {
    stubTipAccountsResponse({ result: [fakeTipAccount('LiveTip1')] });

    for (let i = 0; i < JITO_TIP_ACCOUNTS_CACHE_MAX_ENTRIES + 10; i++) {
      await getJitoTipAccounts({ baseUrl: `https://engine-${i}.test` });
    }

    // The key is operator config today and per-tenant config under fan-out. An
    // unbounded map keyed by anything caller-derived, inside the process that
    // holds the signing key, is the last place to leak memory.
    expect(jitoTipAccountsCacheSize()).toBeLessThanOrEqual(
      JITO_TIP_ACCOUNTS_CACHE_MAX_ENTRIES
    );
  });

  it('keys the cache per endpoint so one block engine cannot serve another', async () => {
    const first = [fakeTipAccount('Engine1a')];
    const second = [fakeTipAccount('Engine2a')];
    const fetchMock = vi.fn().mockImplementation((url: string) => ({
      ok: true,
      json: async () => ({ result: url.includes('one') ? first : second })
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getJitoTipAccounts({ baseUrl: 'https://one.test' })).resolves.toEqual(first);
    await expect(getJitoTipAccounts({ baseUrl: 'https://two.test' })).resolves.toEqual(second);
  });
});

/**
 * Lamports → USD (checklist S4-P18).
 *
 * This value becomes `feeUsd` on a trade row and feeds cost-basis arithmetic, so
 * a wrong number is strictly worse than a missing one: a missing fee is visibly
 * absent, a wrong fee silently misstates realised P&L forever.
 */
describe('tip pricing', () => {
  it('converts lamports at 10^9 to the SOL price', () => {
    expect(lamportsToUsd(1_000_000_000, 200)).toBe(200);
    expect(lamportsToUsd(20_000, 200)).toBeCloseTo(0.004, 12);
  });

  it('returns null rather than zero when the price is unavailable', () => {
    // `fetchTokenPriceUsd` answers null when every upstream fails. Letting that
    // become a 0 would assert the trade cost nothing, which is a different and
    // false claim.
    expect(lamportsToUsd(20_000, null)).toBe(null);
  });

  it.each([
    ['a zero price', 0],
    ['a negative price', -5],
    ['a NaN price', Number.NaN],
    ['an infinite price', Number.POSITIVE_INFINITY]
  ])('returns null for %s', (_label, price) => {
    expect(lamportsToUsd(20_000, price)).toBe(null);
  });

  it.each([
    ['a negative tip', -1],
    ['a NaN tip', Number.NaN],
    ['an infinite tip', Number.POSITIVE_INFINITY]
  ])('returns null for %s', (_label, lamports) => {
    expect(lamportsToUsd(lamports, 200)).toBe(null);
  });

  it('prices a zero tip as zero, since no tip really is free', () => {
    // Distinct from `null`: a tip of zero lamports is an observed cost of nothing,
    // not an unknown cost. The runtime never books this — `selectJitoTip` floors
    // at 1 lamport — but the conversion itself should not lie about it.
    expect(lamportsToUsd(0, 200)).toBe(0);
  });
});
