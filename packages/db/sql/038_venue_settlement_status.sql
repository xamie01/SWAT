-- Distinct settlement state for a venue order whose trades have not reached
-- finality. `venue_status` carries the ORDER status (live/matched/delayed);
-- this carries the SETTLEMENT status of the associated trades, which the venue
-- advances independently: MATCHED -> MINED -> CONFIRMED, with RETRYING when a
-- submitted transaction failed and is being resubmitted.
--
-- Collapsing those into one "pending" bucket loses the operational distinction
-- an operator needs during an incident: "matched, not yet onchain" and
-- "mined, awaiting finality" and "onchain attempt failed, retrying" are three
-- very different positions to be holding.
--
-- Only CONFIRMED ever creates a fill quantity; this column is diagnostic and
-- never a substitute for confirmed evidence.
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS venue_settlement_status VARCHAR(32);
