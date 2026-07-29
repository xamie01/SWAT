import { describe, expect, it } from 'vitest';
import {
  getChainPrefix,
  prefixChainValue,
  resolveChainAddress,
  resolveChainValue,
  stripChainPrefix
} from './address.js';

const EVM_MIXED = '0xAbCdEf0123456789aBCdef0123456789AbCdEf01';
const EVM_LOWER = EVM_MIXED.toLowerCase();
const SOLANA_ADDRESS = '11111111111111111111111111111111';

describe('chain value normalization', () => {
  it('prefixes Solana values without changing case', () => {
    expect(prefixChainValue('AbC123', 'solana')).toBe('solana:AbC123');
  });

  it('normalizes EVM values to lowercase', () => {
    expect(prefixChainValue(EVM_MIXED, 'polygon')).toBe(`polygon:${EVM_LOWER}`);
    expect(stripChainPrefix(`robinhood-chain:${EVM_MIXED}`)).toBe(EVM_LOWER);
  });

  it('preserves and reports a matching existing prefix', () => {
    expect(resolveChainValue(`polygon:${EVM_MIXED}`, 'polygon')).toEqual({
      chain: 'polygon',
      raw: EVM_LOWER,
      prefixed: `polygon:${EVM_LOWER}`
    });
    expect(getChainPrefix(`polygon:${EVM_LOWER}`)).toBe('polygon');
  });

  it('rejects mismatched, nested, and unsupported prefixes', () => {
    expect(() => resolveChainValue(`solana:AbC123`, 'polygon')).toThrow(/does not match/);
    expect(() => resolveChainValue('polygon:solana:AbC123')).toThrow(/Nested/);
    expect(() => resolveChainValue('ethereum:0xabc')).toThrow(/Unsupported/);
  });

  it('requires an explicit chain for raw EVM values', () => {
    expect(() => resolveChainValue(EVM_MIXED)).toThrow(/explicit chain/);
    expect(() => resolveChainValue(EVM_MIXED, 'solana')).toThrow(/cannot be classified as Solana/);
  });

  it('validates wallet addresses against their resolved chain', () => {
    expect(resolveChainAddress(SOLANA_ADDRESS).chain).toBe('solana');
    expect(resolveChainAddress(EVM_MIXED, 'polygon')).toEqual({
      chain: 'polygon',
      raw: EVM_LOWER,
      prefixed: `polygon:${EVM_LOWER}`
    });
    expect(() => resolveChainAddress('not-a-wallet', 'solana')).toThrow(/Invalid solana address/);
    expect(() => resolveChainAddress(SOLANA_ADDRESS, 'polygon')).toThrow(/Invalid polygon address/);
  });
});
