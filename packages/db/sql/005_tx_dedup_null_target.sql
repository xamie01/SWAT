-- Fix: the UNIQUE(signature, wallet_address, target_token) constraint does NOT
-- dedupe rows where target_token IS NULL, because Postgres treats NULLs as
-- distinct. Any transaction ingested without a target_token could be inserted
-- repeatedly on re-backfill, double-counting trades and P&L.
--
-- This migration: (1) removes any existing NULL-target duplicates, then
-- (2) replaces the constraint with a unique index over
-- COALESCE(target_token, '') so NULLs dedupe like any other value.

-- 1. Remove duplicate rows the NULL-distinct constraint allowed through,
--    keeping the lowest id of each logical group.
DELETE FROM transactions a
USING transactions b
WHERE a.id > b.id
  AND a.signature = b.signature
  AND a.wallet_address = b.wallet_address
  AND COALESCE(a.target_token, '') = COALESCE(b.target_token, '');

-- 2. Drop the old NULL-distinct unique constraint (default Postgres name) and
--    add a NULL-safe unique index. ON CONFLICT in insertParsedTransaction is
--    updated to target this expression.
ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_signature_wallet_address_target_token_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_dedup
  ON transactions (signature, wallet_address, COALESCE(target_token, ''));
