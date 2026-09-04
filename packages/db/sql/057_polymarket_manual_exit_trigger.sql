-- 057 — allow 'manual' as a Polymarket exit trigger (S4-M45).
--
-- `055` created `polymarket_position_exits` with a CHECK admitting only
-- 'mirrored-sell' and 'redemption', the two entrants `S4-M19` raced. `S4-M45`
-- adds a third: the user exiting their own position.
--
-- The third entrant joins the SAME race rather than getting its own path,
-- because a user tapping "exit" moments before the master sells is the ordinary
-- case, not the edge — and two paths would sell one position twice. That is why
-- this is a one-value widening of an existing CHECK rather than a new table.
--
-- Idempotent: the guard matches on the constraint's `conkey` SHAPE and its
-- current definition, not on its name. Postgres truncates identifiers at 63
-- bytes, so a name comparison is unreliable on generated names — the trap
-- `028` fell into and `054` documents.
DO $$
DECLARE
  trigger_shape smallint[];
  existing_name text;
  admits_manual boolean;
BEGIN
  IF to_regclass('polymarket_position_exits') IS NULL THEN
    RAISE NOTICE '057: polymarket_position_exits absent; 055 has not run yet';
    RETURN;
  END IF;

  SELECT ARRAY[attnum] INTO trigger_shape
    FROM pg_attribute
   WHERE attrelid = 'polymarket_position_exits'::regclass
     AND attname = 'exit_trigger'
     AND NOT attisdropped;
  IF trigger_shape IS NULL THEN
    RAISE NOTICE '057: exit_trigger column absent; nothing to widen';
    RETURN;
  END IF;

  -- Find the single-column CHECK on exit_trigger, whatever it is called, and ask
  -- whether it already admits 'manual'. Checking the definition rather than
  -- assuming makes the replay a no-op instead of a needless constraint churn.
  SELECT conname, pg_get_constraintdef(oid) LIKE '%manual%'
    INTO existing_name, admits_manual
    FROM pg_constraint
   WHERE conrelid = 'polymarket_position_exits'::regclass
     AND contype = 'c'
     AND conkey @> trigger_shape
     AND conkey <@ trigger_shape
   LIMIT 1;

  IF existing_name IS NOT NULL AND admits_manual THEN
    RETURN;
  END IF;

  IF existing_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE polymarket_position_exits DROP CONSTRAINT %I', existing_name
    );
  END IF;

  ALTER TABLE polymarket_position_exits
    ADD CONSTRAINT chk_polymarket_exit_trigger
    CHECK (exit_trigger IN ('mirrored-sell', 'redemption', 'manual'));
END $$;
