export * from './types.js';
export * from './scoring.js';
export * from './validation.js';
export * from './constants.js';
export * from './prices.js';
export * from './jupiter.js';
export * from './logger.js';
export * from './address.js';
export * from './queues.js';
export * from './starter-pack.js';
export * from './ingestion-health.js';
export * from './execution.js';
export * from './copy-trade-lifecycle.js';
export * from './tiers.js';
export * from './jito.js';
export * from './jupiter-swap.js';
export * from './polymarket-clob-auth.js';
export * from './polymarket-clob-credentials.js';
export * from './slippage.js';
export * from './email.js';

/**
 * Argument-scoped execution permission policy (S4-P10).
 *
 * Lives under `src/authority/` and moves to `packages/authority` when that
 * package is created (checklist §7.1) -- it is here rather than in a new
 * workspace package only because a new package needs `pnpm install` to link
 * before its tests can run.
 */
export * from './authority/index.js';

/**
 * pUSD withdrawal-liquidity monitoring (S4-M42). Not a peg monitor: pUSD is
 * unlisted, so there is no price to poll -- what strands funds is depth in one
 * named Uniswap pool.
 */
export * from './pusd-liquidity.js';
