import { describe, it, expect } from 'vitest';
import {
  QUEUES,
  TRADE_QUEUES_BY_CHAIN,
  chainFromTokenMint,
  tradeQueueForChain,
  tradeQueueForTokenMint
} from './constants.js';

describe('trade queue naming (D6 / S3-25)', () => {
  it('routes each chain to its own queue', () => {
    expect(tradeQueueForChain('solana')).toBe('swat-trades-solana');
    expect(tradeQueueForChain('polygon')).toBe('swat-trades-polygon');
    expect(tradeQueueForChain('robinhood-chain')).toBe('swat-trades-robinhood');
  });

  it('gives every chain a distinct queue', () => {
    const names = Object.values(TRADE_QUEUES_BY_CHAIN);
    expect(new Set(names).size).toBe(names.length);
  });

  it('covers exactly the supported chains', () => {
    expect(Object.keys(TRADE_QUEUES_BY_CHAIN).sort()).toEqual([
      'base',
      'bsc',
      'ethereum',
      'polygon',
      'robinhood-chain',
      'solana'
    ]);
  });

  it('no longer routes any chain to the pre-split queue', () => {
    // The drain worker in `tradeWorkerSpecs` is the only remaining reader of
    // `swat-trades`. If a producer started resolving to it again, jobs would
    // land in a queue scheduled for deletion.
    for (const chain of Object.keys(TRADE_QUEUES_BY_CHAIN) as Array<
      keyof typeof TRADE_QUEUES_BY_CHAIN
    >) {
      expect(tradeQueueForChain(chain)).not.toBe(QUEUES.trades);
    }
  });

  it('keeps the pre-split queue name pinned for the drain worker', () => {
    // Not a producer target any more, but the executor still reads it to drain
    // jobs enqueued before the cutover. If this drifts, those jobs are orphaned.
    expect(QUEUES.trades).toBe('swat-trades');
  });
});

describe('chainFromTokenMint (S3-25 routing agreement)', () => {
  it('reads the chain from a prefixed mint', () => {
    expect(chainFromTokenMint('solana:So11111111111111111111111111111111111111112')).toBe('solana');
    expect(chainFromTokenMint('polygon:0xabc')).toBe('polygon');
    expect(chainFromTokenMint('robinhood-chain:0xabc')).toBe('robinhood-chain');
  });

  it('reads an unprefixed mint as Solana', () => {
    // Every historical Solana mint in this codebase is stored unprefixed in
    // older rows, and the executor has always read them this way.
    expect(chainFromTokenMint('So11111111111111111111111111111111111111112')).toBe('solana');
  });

  it('throws on an unsupported prefix rather than defaulting to Solana', () => {
    // Defaulting would route a job to the Solana queue, whose worker would then
    // refuse it — a trade lost at the far end of the pipeline instead of a loud
    // failure at the near end.
    expect(() => chainFromTokenMint('avalanche:0xabc')).toThrow(/Unsupported trade chain: avalanche/);
    expect(() => chainFromTokenMint('arbitrum:0xabc')).toThrow(/Unsupported trade chain: arbitrum/);
  });

  it('throws on an empty prefix', () => {
    expect(() => chainFromTokenMint(':0xabc')).toThrow(/Unsupported trade chain/);
  });

  it('does not mistake a mint containing a later colon for a prefix', () => {
    // Only the first segment is a prefix; anything after is part of the mint.
    expect(chainFromTokenMint('polygon:0xabc:1')).toBe('polygon');
  });
});

describe('tradeQueueForTokenMint (S3-25 producer routing)', () => {
  it('routes a job to the queue its own chain owns', () => {
    expect(tradeQueueForTokenMint('solana:So111')).toBe('swat-trades-solana');
    expect(tradeQueueForTokenMint('polygon:0xabc')).toBe('swat-trades-polygon');
    expect(tradeQueueForTokenMint('robinhood-chain:0xabc')).toBe('swat-trades-robinhood');
    expect(tradeQueueForTokenMint('base:0xabc')).toBe('swat-trades-base');
    expect(tradeQueueForTokenMint('ethereum:0xabc')).toBe('swat-trades-ethereum');
    expect(tradeQueueForTokenMint('bsc:0xabc')).toBe('swat-trades-bsc');
  });

  it('refuses to pick a queue for an unsupported chain', () => {
    expect(() => tradeQueueForTokenMint('avalanche:0xabc')).toThrow(/Unsupported trade chain/);
  });
});
