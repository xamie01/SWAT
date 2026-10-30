import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildJupiterSwap,
  type JupiterSwapBuildResponse
} from './jupiter-swap.js';
import type { JupiterQuote } from './jupiter.js';

const TAKER_PUBKEY = '11111111111111111111111111111111';
const INPUT_MINT = 'So11111111111111111111111111111111111111112';
const OUTPUT_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function mockQuote(overrides: Partial<JupiterQuote> = {}): JupiterQuote {
  return {
    inputMint: INPUT_MINT,
    outputMint: OUTPUT_MINT,
    inAmount: '1000000000',
    outAmount: '150000000',
    otherAmountThreshold: '148000000',
    swapMode: 'ExactIn',
    slippageBps: 150,
    priceImpactPct: '0.1',
    routePlan: [],
    contextSlot: 300_000_000,
    ...overrides
  };
}

function sampleV2Response(): JupiterSwapBuildResponse {
  return {
    blockhashWithMetadata: {
      blockhash: 'EkSnNWid2cvwEVnPx9aZaWuQ4AxmpTueGnw63wvDDivg',
      lastValidBlockHeight: 350000000
    },
    computeBudgetInstructions: [
      {
        programId: 'ComputeBudget111111111111111111111111111111',
        accounts: [],
        data: Buffer.from([2, 0, 0, 0, 64, 66, 15, 0]).toString('base64')
      }
    ],
    setupInstructions: [],
    swapInstruction: {
      programId: '11111111111111111111111111111111',
      accounts: [
        {
          pubkey: TAKER_PUBKEY,
          isWritable: true,
          isSigner: true
        }
      ],
      data: Buffer.alloc(0).toString('base64')
    },
    cleanupInstruction: null,
    addressesByLookupTableAddress: {
      '11111111111111111111111111111111': [TAKER_PUBKEY]
    }
  };
}

function mockFetchResponse(payload: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' }
    })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Jupiter Swap API V2 /build (S4-M34)', () => {
  it('requests /swap/v2/build with forJitoBundle=true and wrapAndUnwrapSol=true', async () => {
    const fetchMock = mockFetchResponse(sampleV2Response());

    const result = await buildJupiterSwap({
      quote: mockQuote(),
      userPublicKey: TAKER_PUBKEY,
      apiKey: 'test-api-key'
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    const url = new URL(calledUrl);

    expect(url.pathname).toBe('/swap/v2/build');
    expect(url.searchParams.get('inputMint')).toBe(INPUT_MINT);
    expect(url.searchParams.get('outputMint')).toBe(OUTPUT_MINT);
    expect(url.searchParams.get('amount')).toBe('1000000000');
    expect(url.searchParams.get('taker')).toBe(TAKER_PUBKEY);
    expect(url.searchParams.get('forJitoBundle')).toBe('true');
    expect(url.searchParams.get('wrapAndUnwrapSol')).toBe('true');
    expect(url.searchParams.get('slippageBps')).toBe('150');

    expect(calledInit.method).toBe('GET');
    expect(calledInit.headers).toMatchObject({
      'x-api-key': 'test-api-key',
      Accept: 'application/json'
    });

    expect(result).not.toBeNull();
    expect(result?.lastValidBlockHeight).toBe(350000000);
    expect(typeof result?.swapTransaction).toBe('string');
  });

  it('assembles a valid VersionedTransaction from raw instructions and ALTs', async () => {
    mockFetchResponse(sampleV2Response());

    const result = await buildJupiterSwap({
      quote: mockQuote(),
      userPublicKey: TAKER_PUBKEY
    });

    expect(result).not.toBeNull();
    expect(result?.swapTransaction).toBeTruthy();
    const rawBuffer = Buffer.from(result!.swapTransaction, 'base64');
    expect(rawBuffer.length).toBeGreaterThan(0);
  });

  it('supports 32-byte array blockhash in blockhashWithMetadata', async () => {
    const byteBlockhash = new Array(32).fill(7);
    const payload = {
      ...sampleV2Response(),
      blockhashWithMetadata: {
        blockhash: byteBlockhash,
        lastValidBlockHeight: 440000000
      }
    };
    mockFetchResponse(payload);

    const result = await buildJupiterSwap({
      quote: mockQuote(),
      userPublicKey: TAKER_PUBKEY
    });

    expect(result).not.toBeNull();
    expect(result?.lastValidBlockHeight).toBe(440000000);
    expect(typeof result?.swapTransaction).toBe('string');
  });

  it('preserves pre-assembled swapTransaction for backward compatibility and mocks', async () => {
    mockFetchResponse({
      swapTransaction: 'base64-mock-tx',
      lastValidBlockHeight: 12345
    });

    const result = await buildJupiterSwap({
      quote: mockQuote(),
      userPublicKey: TAKER_PUBKEY
    });

    expect(result).toEqual({
      swapTransaction: 'base64-mock-tx',
      lastValidBlockHeight: 12345
    });
  });

  it('respects wrapUnwrapSOL legacy parameter name', async () => {
    const fetchMock = mockFetchResponse(sampleV2Response());

    await buildJupiterSwap({
      quote: mockQuote(),
      userPublicKey: TAKER_PUBKEY,
      wrapUnwrapSOL: false
    });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('wrapAndUnwrapSol')).toBe('false');
  });

  it('returns null on HTTP error response', async () => {
    mockFetchResponse({ error: 'Route not found' }, 404);

    const result = await buildJupiterSwap({
      quote: mockQuote(),
      userPublicKey: TAKER_PUBKEY
    });

    expect(result).toBeNull();
  });

  it('returns null when payload contains an error field', async () => {
    mockFetchResponse({ error: 'Insufficient liquidity' }, 200);

    const result = await buildJupiterSwap({
      quote: mockQuote(),
      userPublicKey: TAKER_PUBKEY
    });

    expect(result).toBeNull();
  });

  it('returns null when blockhash is missing', async () => {
    mockFetchResponse({
      computeBudgetInstructions: [],
      swapInstruction: {
        programId: '11111111111111111111111111111111',
        accounts: [],
        data: ''
      }
    });

    const result = await buildJupiterSwap({
      quote: mockQuote(),
      userPublicKey: TAKER_PUBKEY
    });

    expect(result).toBeNull();
  });
});
