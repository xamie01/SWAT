import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchDexScreenerLiquidity,
  fetchDexScreenerPrice,
  fetchTokenMetadata,
  fetchTokenPriceUsd
} from './prices.js';

const EVM_ADDRESS = '0xAbCdEf0123456789aBCdef0123456789AbCdEf01';
const EVM_ADDRESS_LOWER = EVM_ADDRESS.toLowerCase();

function mockDexScreenerPairs(pairs: unknown[]) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ pairs })
  } as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DexScreener chain isolation', () => {
  it('ignores a higher-liquidity pair from another chain when pricing', async () => {
    const fetchMock = mockDexScreenerPairs([
      {
        chainId: 'solana',
        priceUsd: '999',
        liquidity: { usd: 10_000_000 }
      },
      {
        chainId: 'polygon',
        priceUsd: '2.50',
        liquidity: { usd: 25_000 }
      },
      {
        chainId: 'polygon',
        priceUsd: '3.75',
        liquidity: { usd: 50_000 }
      }
    ]);

    await expect(fetchTokenPriceUsd(`polygon:${EVM_ADDRESS}`)).resolves.toBe(3.75);
    await expect(fetchDexScreenerPrice(`polygon:${EVM_ADDRESS}`)).resolves.toBe(3.75);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.dexscreener.com/latest/dex/tokens/${EVM_ADDRESS_LOWER}`,
      expect.any(Object)
    );
  });

  it('returns null when DexScreener has no pair for the requested chain', async () => {
    mockDexScreenerPairs([
      {
        chainId: 'polygon',
        priceUsd: '1.25',
        liquidity: { usd: 250_000 }
      }
    ]);

    await expect(
      fetchDexScreenerPrice(`robinhood-chain:${EVM_ADDRESS}`)
    ).resolves.toBeNull();
  });

  it('selects metadata from the highest-liquidity pair on the requested chain', async () => {
    mockDexScreenerPairs([
      {
        chainId: 'robinhood',
        liquidity: { usd: 9_000_000 },
        baseToken: { name: 'Wrong Chain', symbol: 'WRONG' }
      },
      {
        chainId: 'polygon',
        liquidity: { usd: 10_000 },
        baseToken: { name: 'Low Liquidity', symbol: 'LOW' }
      },
      {
        chainId: 'polygon',
        liquidity: { usd: 80_000 },
        baseToken: { name: 'Polygon Token', symbol: 'POLY' }
      }
    ]);

    await expect(fetchTokenMetadata(`polygon:${EVM_ADDRESS}`)).resolves.toEqual({
      name: 'Polygon Token',
      symbol: 'POLY'
    });
  });

  it('maps Robinhood Chain to the DexScreener robinhood chain ID for liquidity', async () => {
    mockDexScreenerPairs([
      {
        chainId: 'polygon',
        liquidity: { usd: 7_000_000 }
      },
      {
        chainId: 'robinhood',
        liquidity: { usd: 15_000 }
      },
      {
        chainId: 'robinhood',
        liquidity: { usd: '35000' }
      }
    ]);

    await expect(
      fetchDexScreenerLiquidity(EVM_ADDRESS, 'robinhood-chain')
    ).resolves.toBe(35_000);
  });

  it('keeps bare Solana mint compatibility', async () => {
    mockDexScreenerPairs([
      {
        chainId: 'polygon',
        priceUsd: '500',
        liquidity: { usd: 1_000_000 }
      },
      {
        chainId: 'solana',
        priceUsd: '0.0042',
        liquidity: { usd: 40_000 }
      }
    ]);

    await expect(fetchDexScreenerPrice('SoLanaMint123')).resolves.toBe(0.0042);
  });

  it('rejects raw EVM addresses without an explicit chain', async () => {
    const fetchMock = mockDexScreenerPairs([]);

    await expect(fetchDexScreenerPrice(EVM_ADDRESS)).rejects.toThrow(/explicit chain/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses Robinhood official stock-token prices without a Solana CoinGecko fallback', async () => {
    const dexTokenAddress = '0x2222222222222222222222222222222222222222';
    const unknownAddress = '0x3333333333333333333333333333333333333333';
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);

      if (url === 'https://api.robinhood.com/rhj/assets') {
        return {
          ok: true,
          json: async () => ({
            assets: [
              {
                tokenSymbol: 'TEST',
                currentMultiplier: '1.25',
                status: 'ASSET_STATUS_ACTIVE',
                deployments: [
                  {
                    chainId: 4663,
                    contractAddress: EVM_ADDRESS
                  }
                ]
              }
            ]
          })
        } as Response;
      }

      if (url === 'https://api.robinhood.com/rhj/prices/TEST') {
        return {
          ok: true,
          json: async () => ({
            quotes: [
              {
                tokenSymbol: 'TEST',
                deployments: [
                  {
                    chainId: 4663,
                    contractAddress: EVM_ADDRESS
                  }
                ],
                bid: '100',
                ask: '102',
                isTradingHalt: false,
                generatedAt: new Date().toISOString()
              }
            ]
          })
        } as Response;
      }

      if (url.endsWith(`/latest/dex/tokens/${dexTokenAddress}`)) {
        return {
          ok: true,
          json: async () => ({
            pairs: [
              {
                chainId: 'polygon',
                priceUsd: '999',
                liquidity: { usd: 9_000_000 }
              },
              {
                chainId: 'robinhood',
                priceUsd: '4.20',
                liquidity: { usd: 40_000 }
              }
            ]
          })
        } as Response;
      }

      if (url.endsWith(`/latest/dex/tokens/${unknownAddress}`)) {
        return {
          ok: true,
          json: async () => ({ pairs: [] })
        } as Response;
      }

      throw new Error(`Unexpected price request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchTokenPriceUsd(`robinhood-chain:${EVM_ADDRESS}`)
    ).resolves.toBe(126.25);
    await expect(
      fetchTokenPriceUsd(`robinhood-chain:${dexTokenAddress}`)
    ).resolves.toBe(4.2);
    await expect(
      fetchTokenPriceUsd(`robinhood-chain:${unknownAddress}`)
    ).resolves.toBeNull();

    expect(
      requestedUrls.some((url) => url.includes(
        'api.coingecko.com/api/v3/simple/token_price/solana'
      ))
    ).toBe(false);
    expect(requestedUrls.filter((url) => url.endsWith('/rhj/assets'))).toHaveLength(1);
  });
});
