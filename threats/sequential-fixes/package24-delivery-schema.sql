-- PACKAGE24 PROPOSAL ONLY. NOT A MIGRATION; DO NOT APPLY without schema/role review.
-- Durable transport containment, not external exactly-once or repair of old sends.
CREATE TABLE signal_notification_deliveries (
  signal_id UUID PRIMARY KEY REFERENCES signals(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','preparing','sending','delivered','uncertain')),
  owner_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (state NOT IN ('preparing','sending','uncertain') OR (owner_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
-- sending after expiry remains uncertain, never automatically pending.
-- A reviewed reconciliation mechanism must use real provider/operator evidence;
-- no certificate/environment flag can authorize blind retransmission.

CREATE TABLE discovery_backfill_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address TEXT NOT NULL UNIQUE REFERENCES wallets(address) ON DELETE CASCADE,
  chain TEXT NOT NULL CHECK (chain IN ('solana','polygon','robinhood-chain')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','enqueued')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enqueued_at TIMESTAMPTZ,
  CHECK ((state = 'pending' AND enqueued_at IS NULL) OR (state = 'enqueued' AND enqueued_at IS NOT NULL))
);
CREATE INDEX discovery_backfill_pending ON discovery_backfill_intents(created_at, id) WHERE state = 'pending';
-- Wallet INSERT and intent INSERT must share a caller PoolClient transaction.
-- Queue ack is not indexing completion. Lost queue ack retries the existing
-- address/chain job ID; BullMQ removal/retention bounds deduplication.
-- Historical missing obligations are NOT automatically repaired here.
-- Integrator must review least-privilege service grants/RLS and deployment.
-- No runtime roles, grants, existing rows or live migration are changed here.
