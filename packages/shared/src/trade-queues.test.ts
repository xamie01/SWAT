import { describe, it, expect } from 'vitest';
import { QUEUES, TRADE_QUEUES_BY_CHAIN, tradeQueueForChain } from './constants.js';

describe('trade queue naming (D6 / S3-25)', () => {
  it('routes every chain to the shared queue while the split is off', () => {
    // The switch is deliberately off: producers and consumers adopt the helper
    // first, so the cutover is one line rather than a four-service refactor.
    expect(tradeQueueForChain('solana')).toBe('swat-trades');
    expect(tradeQueueForChain('polygon')).toBe('swat-trades');
    expect(tradeQueueForChain('robinhood-chain')).toBe('swat-trades');
  });

  it('routes each chain to its own queue once enabled', () => {
    expect(tradeQueueForChain('solana', true)).toBe('swat-trades-solana');
    expect(tradeQueueForChain('polygon', true)).toBe('swat-trades-polygon');
    expect(tradeQueueForChain('robinhood-chain', true)).toBe('swat-trades-robinhood');
  });

  it('keeps the shared queue name matching the four inlined call sites', () => {
    // api, scorer, signal-engine, and trade-executor each still inline this
    // literal. If this constant drifts, producers and consumers silently stop
    // sharing a queue and trade jobs are never consumed.
    expect(QUEUES.trades).toBe('swat-trades');
  });

  it('gives every chain a distinct queue', () => {
    const names = Object.values(TRADE_QUEUES_BY_CHAIN);
    expect(new Set(names).size).toBe(names.length);
  });

  it('covers exactly the supported chains', () => {
    expect(Object.keys(TRADE_QUEUES_BY_CHAIN).sort()).toEqual([
      'polygon',
      'robinhood-chain',
      'solana'
    ]);
  });
});
