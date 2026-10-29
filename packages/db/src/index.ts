export * from './client.js';
export * from './transaction.js';
export * from './numeric.js';
export * from './wallets.js';
export * from './signals.js';
export * from './transactions.js';
export * from './trades.js';
export * from './relationships.js';
export * from './pnl-queries.js';
export * from './scoring-queries.js';
export * from './discovery-queries.js';
export * from './clustering-queries.js';
export * from './polymarket.js';
export * from './polymarket-redemptions.js';
export * from './ingestion-health.js';
export * from './execution-config.js';
export * from './chain-certifications.js';
export * from './attribution-queries.js';
export * from './copy-trade-lifecycle.js';
export * from './copy-eligibility.js';
export * from './circuit-breaker.js';
export * from './risk-policy.js';
export * from './stop-loss.js';
export * from './evm-nonce.js';
export * from './position-cap.js';
export * from './forward-only.js';
export * from './independence.js';
export * from './independence-queries.js';
export * from './master-capacity.js';
/**
 * Active-follower counts per (master, chain) -- the `activeFollowerCount` input
 * `master-capacity.js` needs. Separate from `master-membership.js`: that counts
 * ordinals, this counts the orders a fan-out implies (S4-M6).
 */
export * from './master-followers.js';
export * from './user-execution-settings.js';
export * from './user-balances.js';
export * from './execution-grants.js';
export * from './tracking-difference.js';
export * from './credentials.js';
export * from './tenancy.js';
export * from './users.js';
export * from './auth-wallets.js';
export * from './audit-log.js';
export * from './seed-admin.js';
export * from './subscriptions.js';
export * from './lot-allocation.js';
export * from './close-all.js';

/**
 * Quote-leg valuation (S4-M35).
 *
 * `copy_execution_evidence.quote_quantity` was a mixed-unit column -- USD on
 * Polymarket and paper, SOL on Solana live, ETH on robinhood live -- and
 * `cost_basis_usd` accumulated all four. One conversion rule lives here so the
 * executor and the lifecycle rebuild cannot disagree about what a number means.
 */
export * from './quote-valuation.js';

/**
 * Polymarket position-exit race (S4-M19).
 *
 * A master's sell and a market resolution are independent exit triggers that can
 * fire moments apart; these claim one winner per position rather than one per
 * trigger.
 */
export * from './polymarket-exit-queries.js';

/**
 * Fan-out eligibility (S4-13) — who copies a signal, and a stable code for
 * everyone who does not. Pure; the caller fetches, this decides.
 */
export * from './fanout-eligibility.js';

/**
 * Master membership cap (S4-M43/S4-M44). Separate from `master-capacity.js`: that
 * one bounds a single signal's cohort by price impact, this one bounds how many
 * members a master may have at all.
 */
export * from './master-membership.js';

/**
 * Fan-out candidate enumeration (S4-13's fetch half). Fetches only; every
 * decision lives in `fanout-eligibility.js`.
 */
export * from './fanout-candidates.js';

/**
 * Which Polymarket markets the book feed subscribes to (S4-M38). Read plus a
 * pure decider; the eviction rule lives in `selectPolymarketBookSubscriptions`.
 */
export * from './polymarket-book-subscriptions.js';
