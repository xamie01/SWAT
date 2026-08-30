import { describe, expect, it } from 'vitest';
import {
  deriveFillPriceUsd,
  divideDecimalText,
  multiplyDecimalText,
  nativeQuoteCurrencyForChain,
  summarizeConfirmedQuoteTotal,
  valuateChainNativeQuoteLeg,
  valuateQuoteLeg
} from './quote-valuation.js';

describe('nativeQuoteCurrencyForChain', () => {
  it('maps each chain to the unit its native size is denominated in', () => {
    expect(nativeQuoteCurrencyForChain('solana')).toBe('SOL');
    expect(nativeQuoteCurrencyForChain('robinhood-chain')).toBe('ETH');
    expect(nativeQuoteCurrencyForChain('polygon')).toBe('USD');
  });
});

describe('multiplyDecimalText', () => {
  it('multiplies exactly where binary floating point does not', () => {
    // 0.1 * 3 is 0.30000000000000004 in IEEE-754 doubles.
    expect(multiplyDecimalText('0.1', '3')).toBe('0.3');
    expect(multiplyDecimalText('1.1', '1.1')).toBe('1.21');
  });

  it('keeps full precision on lamport-scale amounts at realistic prices', () => {
    expect(multiplyDecimalText('0.123456789', '187.42')).toBe('23.13827139438');
  });

  it('handles zero and integers without dangling separators', () => {
    expect(multiplyDecimalText('0', '187.42')).toBe('0');
    expect(multiplyDecimalText('2', '3')).toBe('6');
    expect(multiplyDecimalText('2.50', '4')).toBe('10');
  });
});

describe('valuateQuoteLeg', () => {
  it('passes a USD leg straight through at a rate of 1', () => {
    expect(valuateQuoteLeg({ amount: '4.5', currency: 'USD' })).toMatchObject({
      code: 'valued',
      currency: 'USD',
      nativeAmount: '4.5',
      nativeUsdPrice: '1',
      usdAmount: '4.5'
    });
  });

  it('converts a SOL leg and keeps the native amount and the rate used', () => {
    const valuation = valuateQuoteLeg({
      amount: '1.25',
      currency: 'SOL',
      nativeUsdPrice: 150
    });
    expect(valuation).toMatchObject({
      code: 'valued',
      currency: 'SOL',
      nativeAmount: '1.25',
      nativeUsdPrice: '150',
      usdAmount: '187.5'
    });
  });

  it('converts an ETH leg', () => {
    expect(valuateQuoteLeg({ amount: '0.02', currency: 'ETH', nativeUsdPrice: '3200' }))
      .toMatchObject({ code: 'valued', currency: 'ETH', usdAmount: '64' });
  });

  it('never puts a native token amount in the USD field', () => {
    // The whole bug in one assertion: 1.25 SOL must not become 1.25 USD.
    const valuation = valuateQuoteLeg({ amount: '1.25', currency: 'SOL', nativeUsdPrice: 150 });
    expect(valuation.usdAmount).not.toBe('1.25');
    expect(valuation.usdAmount).toBe('187.5');
  });

  it('reports an unknown USD value rather than zero when no rate is available', () => {
    for (const rate of [null, undefined, 0, Number.NaN, -5, '']) {
      const valuation = valuateQuoteLeg({
        amount: '1.25',
        currency: 'SOL',
        nativeUsdPrice: rate as number | string | null | undefined
      });
      expect(valuation.code, `rate ${String(rate)}`).toBe('native-price-unknown');
      expect(valuation.usdAmount, `rate ${String(rate)}`).toBeNull();
      // The observed half survives even when the derived half cannot.
      expect(valuation.nativeAmount).toBe('1.25');
      expect(valuation.currency).toBe('SOL');
      expect(valuation.nativeUsdPrice).toBeNull();
    }
  });

  it('distinguishes an absent quote leg from a zero one', () => {
    expect(valuateQuoteLeg(null)).toMatchObject({
      code: 'no-quote-leg',
      currency: null,
      nativeAmount: null,
      usdAmount: null
    });
    expect(valuateQuoteLeg(undefined).code).toBe('no-quote-leg');
    expect(valuateQuoteLeg({ amount: 0, currency: 'USD' })).toMatchObject({
      code: 'valued',
      nativeAmount: '0',
      usdAmount: '0'
    });
  });

  it('expands exponent notation instead of refusing it', () => {
    // Number(1e-9).toString() is '1e-9'; a lamport-scale amount must survive.
    expect(valuateQuoteLeg({ amount: 1e-9, currency: 'SOL', nativeUsdPrice: 200 }))
      .toMatchObject({ nativeAmount: '0.000000001', usdAmount: '0.0000002' });
  });

  it('throws on an amount that is not a non-negative decimal', () => {
    expect(() => valuateQuoteLeg({ amount: -1, currency: 'SOL', nativeUsdPrice: 1 }))
      .toThrow(/non-negative decimal/);
    expect(() => valuateQuoteLeg({ amount: 'abc', currency: 'USD' }))
      .toThrow(/non-negative decimal/);
    expect(() => valuateQuoteLeg({ amount: Number.NaN, currency: 'USD' }))
      .toThrow(/non-negative decimal/);
  });

  it('throws on an unknown currency rather than guessing USD', () => {
    expect(() => valuateQuoteLeg({ amount: '1', currency: 'USDC' as never }))
      .toThrow(/currency must be one of/);
  });
});

describe('divideDecimalText', () => {
  it('divides exactly when the quotient terminates', () => {
    expect(divideDecimalText('187.5', '1000')).toBe('0.1875');
    expect(divideDecimalText('64', '2')).toBe('32');
  });

  it('truncates a repeating quotient at the configured scale', () => {
    expect(divideDecimalText('1', '3')).toBe('0.333333333333333333');
    expect(divideDecimalText('1', '3', 4)).toBe('0.3333');
  });

  it('returns null rather than Infinity on a zero denominator', () => {
    expect(divideDecimalText('1', '0')).toBeNull();
  });
});

describe('deriveFillPriceUsd', () => {
  it('derives the realised price from USD paid over units received', () => {
    // 1.25 SOL at 150 USD/SOL buys 1000 tokens => 0.1875 USD per token.
    expect(deriveFillPriceUsd('187.5', '1000')).toBe('0.1875');
  });

  it('stays unknown when the USD amount is unknown', () => {
    // The Solana-live and robinhood-live paths reach this when the native price
    // feed is down. A NULL price_usd is correct there; a 0 would be a free fill.
    expect(deriveFillPriceUsd(null, '1000')).toBeNull();
    expect(deriveFillPriceUsd(undefined, '1000')).toBeNull();
  });

  it('stays unknown when the base quantity cannot support a ratio', () => {
    expect(deriveFillPriceUsd('187.5', '0')).toBeNull();
    expect(deriveFillPriceUsd('187.5', null)).toBeNull();
    expect(deriveFillPriceUsd('187.5', 'abc')).toBeNull();
    expect(deriveFillPriceUsd('187.5', -1)).toBeNull();
  });

  it('never returns zero for a positive fill', () => {
    const price = deriveFillPriceUsd('4.5', '10');
    expect(price).not.toBeNull();
    expect(Number(price)).toBeGreaterThan(0);
  });
});

describe('valuateChainNativeQuoteLeg', () => {
  it('applies the same per-chain rule persistTrade used to inline', () => {
    expect(valuateChainNativeQuoteLeg({ chain: 'solana', amount: 2, nativeUsdPrice: 150 }))
      .toMatchObject({ currency: 'SOL', usdAmount: '300' });
    expect(valuateChainNativeQuoteLeg({ chain: 'robinhood-chain', amount: 0.5, nativeUsdPrice: 3000 }))
      .toMatchObject({ currency: 'ETH', usdAmount: '1500' });
    // polygon sizes are already USD, so no rate is needed and none is invented.
    expect(valuateChainNativeQuoteLeg({ chain: 'polygon', amount: 25 }))
      .toMatchObject({ currency: 'USD', usdAmount: '25' });
  });

  it('leaves the USD value unknown when the native price is missing', () => {
    expect(valuateChainNativeQuoteLeg({ chain: 'solana', amount: 2, nativeUsdPrice: null }))
      .toMatchObject({ code: 'native-price-unknown', usdAmount: null, nativeAmount: '2' });
  });
});

describe('summarizeConfirmedQuoteTotal', () => {
  it('calls a zero-fill total a known zero', () => {
    expect(summarizeConfirmedQuoteTotal({
      valuedFillCount: 0,
      unvaluedFillCount: 0,
      valuedUsdSum: null
    })).toMatchObject({ code: 'no-fills', usdAmount: '0', complete: true, unvaluedFillCount: 0 });
  });

  it('reports a fully valued total as complete', () => {
    expect(summarizeConfirmedQuoteTotal({
      valuedFillCount: 2,
      unvaluedFillCount: 0,
      valuedUsdSum: '30.5'
    })).toMatchObject({ code: 'complete', usdAmount: '30.5', complete: true });
  });

  it('marks a partial total as a lower bound instead of a settled figure', () => {
    const total = summarizeConfirmedQuoteTotal({
      valuedFillCount: 2,
      unvaluedFillCount: 1,
      valuedUsdSum: '30.5'
    });
    expect(total.code).toBe('partially-valued');
    expect(total.usdAmount).toBe('30.5');
    expect(total.complete).toBe(false);
    expect(total.unvaluedFillCount).toBe(1);
  });

  it('returns null, not zero, when no confirmed fill has a USD value', () => {
    const total = summarizeConfirmedQuoteTotal({
      valuedFillCount: 0,
      unvaluedFillCount: 3,
      valuedUsdSum: null
    });
    expect(total.code).toBe('unvalued');
    expect(total.usdAmount).toBeNull();
    expect(total.complete).toBe(false);
    expect(total.unvaluedFillCount).toBe(3);
  });

  it('refuses a missing sum that contradicts a positive valued count', () => {
    expect(() => summarizeConfirmedQuoteTotal({
      valuedFillCount: 1,
      unvaluedFillCount: 0,
      valuedUsdSum: null
    })).toThrow(/valuedUsdSum/);
  });

  it('refuses non-integer or negative counts', () => {
    expect(() => summarizeConfirmedQuoteTotal({
      valuedFillCount: 1.5,
      unvaluedFillCount: 0,
      valuedUsdSum: '1'
    })).toThrow(/valuedFillCount/);
    expect(() => summarizeConfirmedQuoteTotal({
      valuedFillCount: 0,
      unvaluedFillCount: -1,
      valuedUsdSum: null
    })).toThrow(/unvaluedFillCount/);
  });
});
