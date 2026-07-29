import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getJupiterSimulatedFill,
  type JupiterQuote
} from './jupiter.js';

const INPUT_MINT = 'So11111111111111111111111111111111111111112';
const OUTPUT_MINT = 'Tokenyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';

function quote(overrides: Partial<JupiterQuote> = {}): JupiterQuote {
  return {
    inputMint: INPUT_MINT,
    outputMint: OUTPUT_MINT,
    inAmount: '1000000000',
    outAmount: '25000000',
    otherAmountThreshold: '24625000',
    swapMode: 'ExactIn',
    slippageBps: 150,
    priceImpactPct: '0.12',
    routePlan: [],
    contextSlot: 351_000_000,
    ...overrides
  };
}

function mockQuoteResponse(value: JupiterQuote) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Jupiter quote simulation', () => {
  it('labels ExactIn otherAmountThreshold as minimum output', async () => {
    const fetchMock = mockQuoteResponse(quote());

    const result = await getJupiterSimulatedFill({
      inputMint: INPUT_MINT,
      outputMint: OUTPUT_MINT,
      amountLamports: 1_000_000_000,
      swapMode: 'ExactIn'
    }, {
      inputDecimals: 9,
      outputDecimals: 6
    });

    expect(result).toMatchObject({
      status: 'quoted',
      swapMode: 'ExactIn',
      inAmountRaw: '1000000000',
      outAmountRaw: '25000000',
      tokenAmount: 25,
      minTokenAmount: 24.625,
      maxInputAmount: null,
      threshold: {
        kind: 'minimum-output',
        rawAmount: '24625000',
        amount: 24.625,
        decimals: 6
      }
    });

    const requestedUrl = new URL(fetchMock.mock.calls[0][0]);
    expect(requestedUrl.searchParams.get('swapMode')).toBe('ExactIn');
  });

  it('labels ExactOut otherAmountThreshold as maximum input', async () => {
    mockQuoteResponse(quote({
      inAmount: '1000000000',
      outAmount: '25000000',
      otherAmountThreshold: '1015000000',
      swapMode: 'ExactOut'
    }));

    const result = await getJupiterSimulatedFill({
      inputMint: INPUT_MINT,
      outputMint: OUTPUT_MINT,
      amountLamports: 25_000_000,
      swapMode: 'ExactOut'
    }, {
      inputDecimals: 9,
      outputDecimals: 6
    });

    expect(result).toMatchObject({
      status: 'quoted',
      swapMode: 'ExactOut',
      tokenAmount: 25,
      minTokenAmount: null,
      maxInputAmount: 1.015,
      threshold: {
        kind: 'maximum-input',
        rawAmount: '1015000000',
        amount: 1.015,
        decimals: 9
      }
    });
  });

  it('requires input decimals for ExactOut instead of guessing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(getJupiterSimulatedFill({
      inputMint: INPUT_MINT,
      outputMint: OUTPUT_MINT,
      amountLamports: 25_000_000,
      swapMode: 'ExactOut'
    }, 6)).rejects.toThrow('require resolved input token decimals');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed or direction-mismatched quote evidence', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockQuoteResponse(quote({ swapMode: 'ExactOut' }));

    await expect(getJupiterSimulatedFill({
      inputMint: INPUT_MINT,
      outputMint: OUTPUT_MINT,
      amountLamports: 1_000_000_000,
      swapMode: 'ExactIn'
    }, 6)).resolves.toBeNull();
  });

  it('rejects unresolved or invalid decimal metadata', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(getJupiterSimulatedFill({
      inputMint: INPUT_MINT,
      outputMint: OUTPUT_MINT,
      amountLamports: 1_000_000_000
    }, Number.NaN)).rejects.toThrow('Invalid output token decimals');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
