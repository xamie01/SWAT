import { describe, expect, it } from 'vitest';
import { parseSeedWalletAddresses } from './seed-wallets.js';

const SOLANA_ADDRESS = '11111111111111111111111111111111';
const EVM_ADDRESS = '0xabcdef0123456789abcdef0123456789abcdef01';

describe('indexer wallet seeds', () => {
  it('accepts bare Solana and chain-prefixed EVM wallets', () => {
    expect(
      parseSeedWalletAddresses(
        `${SOLANA_ADDRESS}, polygon:${EVM_ADDRESS}, robinhood-chain:${EVM_ADDRESS}`
      )
    ).toEqual([
      {
        address: SOLANA_ADDRESS,
        chain: 'solana',
        source: 'manual'
      },
      {
        address: EVM_ADDRESS,
        chain: 'polygon',
        source: 'manual'
      },
      {
        address: EVM_ADDRESS,
        chain: 'robinhood-chain',
        source: 'manual'
      }
    ]);
  });

  it('deduplicates normalized seeds and rejects ambiguous raw EVM addresses', () => {
    expect(
      parseSeedWalletAddresses(
        `polygon:${EVM_ADDRESS.toUpperCase().replace('0X', '0x')},polygon:${EVM_ADDRESS}`
      )
    ).toHaveLength(1);
    expect(() => parseSeedWalletAddresses(EVM_ADDRESS)).toThrow(/explicit chain/);
  });

  it('rejects invalid prefixed addresses before startup ingestion', () => {
    expect(() => parseSeedWalletAddresses('polygon:not-an-address')).toThrow(
      /invalid polygon address/
    );
  });
});
