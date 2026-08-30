-- 055_polymarket_position_exits.sql
--
-- Single-shot exit claim per Polymarket outcome position (checklist S4-M19).
--
-- Why this table exists. Our copy has two independent ways to exit a Polymarket
-- position and they race: (1) the master closes their position, which mirrors as
-- a sell, and (2) the market resolves, which redeems. Neither alone is
-- sufficient — waiting only for the master's sell strands every hold-to-
-- resolution position, and waiting only for resolution exits late on every
-- position the master actually traded out of. So both are tracked and the
-- earlier one acts.
--
-- Why the existing claim cannot be reused. `polymarket_redemptions` (046) is
-- keyed `(user_id, condition_id)`, which is correct for the on-chain call —
-- `redeemPositions({conditionId})` takes no amount and redeems the wallet's
-- balances for BOTH outcomes of the condition. But a condition holds two outcome
-- positions, and the race needs one winner PER POSITION, not one per condition
-- and not one per trigger. A condition-keyed guard would let a mirrored sell of
-- YES suppress the redemption of NO on the same condition, which is exactly the
-- outcome-collapsing mistake S4-M20 forbids.
--
-- Why the two triggers can genuinely collide. A master selling moments before
-- resolution is the ordinary case, not the edge. Without a position-scoped
-- exactly-once guard both triggers fire and the position is exited twice.

CREATE TABLE IF NOT EXISTS polymarket_position_exits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenancy key per ADR 0001, and NULLable for the same reason as 046: the
  -- executor still runs as the single pre-multi-tenant operator account.
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,

  -- The canonical position key from `polymarketPositionKey`: the chain-prefixed
  -- ERC-1155 OUTCOME token, `polygon:<tokenId>`. Deliberately not the condition
  -- id -- a condition holds two outcomes, so a condition-keyed row would merge
  -- YES and NO into one position.
  position_key TEXT NOT NULL,

  -- Carried for reporting and for the redemption fan-out. Not part of any
  -- uniqueness key, so it can never become the identity by accident.
  condition_id TEXT NOT NULL,
  outcome_token_id TEXT NOT NULL,

  -- Which side of the race won. Recorded because "the position exited" and "the
  -- position exited because the master left" are different facts, and P&L
  -- attribution needs the second one.
  exit_trigger TEXT NOT NULL
    CHECK (exit_trigger IN ('mirrored-sell', 'redemption')),

  -- Claim/confirm lifecycle, mirroring 046. A crash between claim and confirm
  -- must not look like a completed exit.
  status TEXT NOT NULL DEFAULT 'claimed'
    CHECK (status IN ('claimed', 'confirmed', 'failed')),

  -- Evidence of the exit: a settlement transaction hash for a redemption, or the
  -- copy execution id for a mirrored sell. One of the two, never neither, once
  -- confirmed.
  transaction_hash TEXT,
  copy_execution_id UUID,

  failure_reason TEXT,

  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,

  -- A confirmed exit must carry its evidence and a claimed one must not pretend
  -- to, for the same reason as 046: a row that reads as settled with nothing to
  -- verify against is worse than no row.
  CONSTRAINT chk_polymarket_position_exit_confirmed_evidence CHECK (
    status <> 'confirmed'
    OR (
      confirmed_at IS NOT NULL
      AND (transaction_hash IS NOT NULL OR copy_execution_id IS NOT NULL)
    )
  )
);

-- The exactly-once guard, and the whole point of the table. One live exit per
-- (user, position): whichever trigger inserts first wins, and the loser's insert
-- returns no row rather than raising, so the losing trigger is a no-op instead of
-- an error.
--
-- NULLS NOT DISTINCT is load-bearing, exactly as in 046 and 050. `user_id` is
-- NULL for every operator row, and by default NULL never conflicts with NULL --
-- so without this clause the index is silently INERT and both triggers claim the
-- same position. Partial, so a 'failed' attempt does not poison the position
-- forever: redemption has no deadline and must stay retryable.
--
-- Requires PostgreSQL 15+. CI and production both run 16.
DROP INDEX IF EXISTS uq_polymarket_position_exit_live_claim;
CREATE UNIQUE INDEX IF NOT EXISTS uq_polymarket_position_exit_live_claim
  ON polymarket_position_exits (user_id, position_key) NULLS NOT DISTINCT
  WHERE status IN ('claimed', 'confirmed');

-- The redemption fan-out reads every position of one condition at once.
CREATE INDEX IF NOT EXISTS idx_polymarket_position_exits_condition
  ON polymarket_position_exits (condition_id, status);

-- Stuck-claim recovery scan: claimed rows older than the confirm timeout.
CREATE INDEX IF NOT EXISTS idx_polymarket_position_exits_claimed_at
  ON polymarket_position_exits (claimed_at)
  WHERE status = 'claimed';

COMMENT ON TABLE polymarket_position_exits IS
  'Single-shot exit claim per Polymarket outcome position. Two exit triggers '
  'race -- the master closing their position (mirrored sell) and the market '
  'resolving (redemption) -- and this table guarantees one winner per position '
  'rather than one per trigger (S4-M19).';

COMMENT ON COLUMN polymarket_position_exits.position_key IS
  'polygon:<outcomeTokenId>. The outcome token, never the condition id: a '
  'condition holds two outcomes and keying on it would merge them (S4-M20).';
