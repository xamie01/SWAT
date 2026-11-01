-- 060_lp_auto_rebalance.sql
-- Track I: per-position auto-rebalance opt-in + manual rebalance transitions.
--
-- Two changes, both forward-only:
--
-- 1. `lp_positions.auto_rebalance` — the user's explicit opt-in. The scheduled
--    monitor (Track F6) no longer fires rebalances by default: it re-labels
--    range states and records the recommendation; only a position whose owner
--    opted in gets queued for automatic rebalancing. Manual triggers (Track I)
--    do not need this flag — the user IS the consent.
--
-- 2. The state machine gains `active → rebalancing`: the manual trigger may
--    re-center an in-range position on purpose. The scheduled monitor never
--    uses that edge — it only re-labels from price observations — so the
--    trigger's SQL function is replaced here (CREATE OR REPLACE, idempotent)
--    and `@swat/shared`'s LP_POSITION_TRANSITIONS carries the same table.

ALTER TABLE lp_positions
  ADD COLUMN IF NOT EXISTS auto_rebalance BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN lp_positions.auto_rebalance IS
  'Track I: owner opted into automatic rebalancing. The monitor only queues rebalances for opted-in positions; manual triggers bypass this flag.';

CREATE OR REPLACE FUNCTION enforce_lp_position_state_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.state = 'building' AND NEW.state IN ('active', 'closed'))
    OR (OLD.state = 'active' AND NEW.state IN ('near_edge', 'out_of_range', 'rebalancing', 'closed'))
    OR (OLD.state = 'near_edge' AND NEW.state IN ('active', 'out_of_range', 'rebalancing', 'closed'))
    OR (OLD.state = 'out_of_range' AND NEW.state IN ('active', 'rebalancing', 'closed'))
    OR (OLD.state = 'rebalancing' AND NEW.state IN ('active', 'near_edge', 'out_of_range', 'closed'))
  ) THEN
    RAISE EXCEPTION 'invalid lp position transition: % -> %', OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END;
$$;
