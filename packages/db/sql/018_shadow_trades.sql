-- 018_shadow_trades.sql
-- Phase 4: Add shadow_of column to trades table to link shadow trades to live trades

ALTER TABLE trades ADD COLUMN IF NOT EXISTS shadow_of UUID REFERENCES trades(id) ON DELETE SET NULL;
