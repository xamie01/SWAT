-- Migration 008: Add Token Name and Symbol columns to signals table
ALTER TABLE signals ADD COLUMN IF NOT EXISTS token_name varchar(100);
ALTER TABLE signals ADD COLUMN IF NOT EXISTS token_symbol varchar(50);
