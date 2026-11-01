-- 061_lp_multichain.sql
-- Expand LP dashboard multi-chain support to Solana (Meteora DLMM & Raydium CLMM)
-- and EVM chains (Uniswap v3 / PancakeSwap v3 on Robinhood Chain, Base, Ethereum, and BSC).

-- 1. lp_pools
ALTER TABLE lp_pools DROP CONSTRAINT IF EXISTS lp_pools_chain_check;
ALTER TABLE lp_pools DROP CONSTRAINT IF EXISTS chk_lp_pools_chain;
ALTER TABLE lp_pools ADD CONSTRAINT chk_lp_pools_chain
  CHECK (chain IN ('solana', 'robinhood-chain', 'base', 'ethereum', 'bsc'));

ALTER TABLE lp_pools DROP CONSTRAINT IF EXISTS lp_pools_protocol_check;
ALTER TABLE lp_pools DROP CONSTRAINT IF EXISTS chk_lp_pools_protocol;
ALTER TABLE lp_pools ADD CONSTRAINT chk_lp_pools_protocol
  CHECK (protocol IN ('meteora-dlmm', 'raydium-clmm', 'uniswap-v3', 'uniswap-v4', 'pancakeswap-v3'));

ALTER TABLE lp_pools DROP CONSTRAINT IF EXISTS chk_lp_pools_granularity;
ALTER TABLE lp_pools ADD CONSTRAINT chk_lp_pools_granularity CHECK (
  (protocol = 'meteora-dlmm' AND bin_step IS NOT NULL AND tick_spacing IS NULL)
  OR (protocol IN ('uniswap-v3', 'uniswap-v4', 'pancakeswap-v3', 'raydium-clmm') AND tick_spacing IS NOT NULL AND bin_step IS NULL)
);

-- 2. lp_guardrail_configs
ALTER TABLE lp_guardrail_configs DROP CONSTRAINT IF EXISTS lp_guardrail_configs_reserve_sub_vault_chain_check;
ALTER TABLE lp_guardrail_configs DROP CONSTRAINT IF EXISTS chk_lp_guardrail_reserve_chain;
ALTER TABLE lp_guardrail_configs ADD CONSTRAINT chk_lp_guardrail_reserve_chain
  CHECK (reserve_sub_vault_chain IN ('solana', 'robinhood-chain', 'base', 'ethereum', 'bsc'));

-- 3. lp_positions
ALTER TABLE lp_positions DROP CONSTRAINT IF EXISTS lp_positions_chain_check;
ALTER TABLE lp_positions DROP CONSTRAINT IF EXISTS chk_lp_positions_chain;
ALTER TABLE lp_positions ADD CONSTRAINT chk_lp_positions_chain
  CHECK (chain IN ('solana', 'robinhood-chain', 'base', 'ethereum', 'bsc'));

ALTER TABLE lp_positions DROP CONSTRAINT IF EXISTS lp_positions_protocol_check;
ALTER TABLE lp_positions DROP CONSTRAINT IF EXISTS chk_lp_positions_protocol;
ALTER TABLE lp_positions ADD CONSTRAINT chk_lp_positions_protocol
  CHECK (protocol IN ('meteora-dlmm', 'raydium-clmm', 'uniswap-v3', 'uniswap-v4', 'pancakeswap-v3'));

-- 4. lp_tracked_wallets
ALTER TABLE lp_tracked_wallets DROP CONSTRAINT IF EXISTS lp_tracked_wallets_chain_check;
ALTER TABLE lp_tracked_wallets DROP CONSTRAINT IF EXISTS chk_lp_tracked_wallets_chain;
ALTER TABLE lp_tracked_wallets ADD CONSTRAINT chk_lp_tracked_wallets_chain
  CHECK (chain IN ('solana', 'robinhood-chain', 'base', 'ethereum', 'bsc'));

-- 5. lp_wallet_position_results
ALTER TABLE lp_wallet_position_results DROP CONSTRAINT IF EXISTS lp_wallet_position_results_chain_check;
ALTER TABLE lp_wallet_position_results DROP CONSTRAINT IF EXISTS chk_lp_wallet_position_results_chain;
ALTER TABLE lp_wallet_position_results ADD CONSTRAINT chk_lp_wallet_position_results_chain
  CHECK (chain IN ('solana', 'robinhood-chain', 'base', 'ethereum', 'bsc'));
