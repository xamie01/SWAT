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
export * from './lp-lifecycle.js';
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

/**
 * Polymarket order-book depth cache (S4-M38). An outcome share trades on a CLOB,
 * so its liquidity is resting depth within a price bound -- not a pool TVL, and
 * not something `priceImpactBps`'s constant-product algebra can consume. This
 * module walks the ladder and publishes a calibrated equivalent reserve.
 */
export * from './polymarket-book-depth.js';

/**
 * Cross-service transport for the Polymarket book cache (S4-M38). The subscriber
 * fills an in-process cache in the indexer; the pre-fan-out read happens in
 * signal-engine. This is the bridge, over an injected key-value port.
 */
export * from './polymarket-book-transport.js';
export * from './sol-reserve.js';
export * from './billing.js';
export * from './rpc-failover.js';
