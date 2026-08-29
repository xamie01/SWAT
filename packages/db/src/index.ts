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
export * from './master-capacity.js';
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
