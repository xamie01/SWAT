-- 056_master_membership.sql
--
-- Master **membership** cap: 50 members per master, enforced structurally
-- (checklist S4-M43), plus the rule that a copier who leaves does not get their
-- slot back (S4-M44).
--
-- ── What this encodes, and what it deliberately does not ──────────────────
--
-- 053 caps ONE SIGNAL's fan-out, denominated in price impact. This file caps
-- STANDING MEMBERSHIP: how many users may hold a live subscription to one
-- master at all. Both are needed. A master with 5000 members whose fan-out is
-- impact-capped serves 50 people per signal and misleads the other 4950 about
-- what they actually bought.
--
-- Both caps are 50, and the equality is the point rather than a coincidence.
-- One concurrency-1 worker per chain at ~6s/order drains roughly 50 orders per
-- 5-minute window, so 50 members is the largest cohort that can actually be
-- served inside one window. 500 would take ~50 minutes to clear and everyone
-- past roughly #50 would fill materially worse than the master they are paying
-- to copy. The matching TS constant is MASTER_MEMBERSHIP_CAP in
-- packages/db/src/master-membership.ts, and a test asserts the two agree.
--
-- ── Decision 1: an ordinal with a partial unique index, not a COUNT ───────
--
-- The obvious enforcement is "SELECT COUNT(*) ... IF count < 50 THEN INSERT".
-- That is not a cap. migrate.ts and every service run at READ COMMITTED, so N
-- concurrent subscribes all read the state before any of them commits: every
-- one sees 49 < 50 and every one inserts, and the cap is exceeded by exactly
-- the number of racers. subscriptions.ts already carries the same finding for
-- the tracked-wallet quota ("A test firing five concurrent subscribes against a
-- 3-wallet tier granted all five"), and its fix — FOR UPDATE on the USER row —
-- does not help here: it serialises one user's writes, and this cap is about 50
-- DIFFERENT users joining one master at the same moment.
--
-- So membership is a finite set of numbered slots:
--
--   membership_slot SMALLINT      the ordinal a live member holds
--   CHECK 1 <= membership_slot <= 50
--   UNIQUE (wallet_address, membership_slot) WHERE membership_slot IS NOT NULL
--
-- Range plus uniqueness is a pigeonhole argument. There are 50 ordinals a
-- master can hand out and no two members may hold the same one, so a 51st
-- slot-holder is UNREPRESENTABLE. That holds against concurrent writers,
-- against a future service that never read this file, and against a hand-typed
-- INSERT in psql. No application code has to be trusted for the cap to be true.
--
-- claimMasterMembershipSlot additionally takes pg_advisory_xact_lock on the
-- master while it picks an ordinal. That is for LIVENESS, not correctness:
-- without it two racers pick the same lowest free ordinal and the index rejects
-- one of them with a unique violation instead of giving it a different slot or a
-- clean refusal. The constraint is the cap; the lock is the manners.
--
-- ── Decision 2: winding_down and ended hold NO slot ──────────────────────
--
-- A winding-down user is leaving, so they must not occupy a slot. But they
-- still hold open positions and still need the master's sells mirrored, so they
-- must still be ENUMERATED for exits. Conflating the two breaks one or the
-- other: count them and the cap under-serves; drop them from enumeration and
-- their positions strand with no exit path.
--
-- The two facts are kept apart by construction. Mirror eligibility is derived
-- from `state` alone (mirrorEligibilityForState, consumed by
-- fanout-eligibility.ts) and nothing on the fan-out path reads membership_slot.
-- Occupancy is derived from membership_slot alone. Neither can drift into the
-- other.
--
-- chk_uws_membership_slot_state is what makes "a leaver holds no slot" an
-- invariant rather than a convention: a non-active row with a non-null
-- membership_slot is rejected by the database, so an UPDATE that forgets to
-- release the ordinal fails loudly instead of quietly holding a slot hostage.
--
-- ── Decision 3: S4-M44 expressed as a constraint, not a code path ─────────
--
-- A dropped copier does not get their slot back. Any reservation mechanism is a
-- queue, and a queue holding a slot for an absent user makes the cap dishonest
-- — the master shows 50 members of whom some cannot trade — while creating an
-- incentive to churn a subscription to hold position.
--
-- The ELSE branch of chk_uws_membership_slot_state clears BOTH columns for a
-- non-active row, so leaving `active` provably releases the ordinal and cannot
-- carry a grandfathering exemption out of the state either. Re-subscribing is
-- therefore an ordinary allocation: a free ordinal, or a refusal.
--
-- ── Decision 4: an over-subscribed master GRANDFATHERS, it never evicts ───
--
-- Existing masters may already have more than 50 active members. Nothing here
-- deletes a row or forces a state transition. Evicting the excess would be far
-- worse than the problem: it does not close anyone's positions, so it strands
-- exactly the open positions whose exit path is the master's sell mirror, and it
-- does it silently to users who did nothing wrong.
--
-- So the backfill hands out ordinals 1..50 oldest-member-first, and flags every
-- remaining active member `membership_grandfathered`. A grandfathered member
-- holds NO ordinal: they keep mirroring (fan-out reads `state`), they neither
-- block a join nor free one, and the cap applies to new joins only. The set can
-- only shrink — the flag is cleared the moment they leave `active` and can
-- never be reacquired, because DEFAULT FALSE is the only way a new row gets a
-- value for it. An over-subscribed master therefore converges to 50 by
-- attrition rather than by eviction.
--
-- The flag also closes the hole that a one-directional CHECK would leave open.
-- Without it, "an active row may have a NULL slot" would have to be permitted
-- forever to accommodate the legacy rows, and then any future writer could
-- insert unlimited active members with NULL slots and the cap would silently
-- stop being a cap. With it, an active row may skip the slot only when it
-- carries an explicit flag that no INSERT can set.
--
-- ── Idempotency ───────────────────────────────────────────────────────────
--
-- migrate.ts has NO applied-migrations table: it replays EVERY file in
-- packages/db/sql/ on EVERY invocation, in filename order, one transaction per
-- file. Every statement below is replay-safe.
--
-- The backfill deserves the specific argument, because a naive one is NOT
-- replay-safe. Re-deriving ordinals from a ROW_NUMBER() over current members
-- would, after any churn, try to give an already-taken ordinal to a
-- grandfathered row and abort the migration with a unique violation. Instead
-- the backfill only ever writes ordinals that are demonstrably FREE for that
-- master, and — the stronger argument — once the constraints below exist its
-- WHERE clause selects rows the CHECK has made unrepresentable, so on every
-- replay it matches nothing at all. It is a first-run-only statement enforced
-- by a constraint rather than by a flag.
--
-- Constraint adds are guarded on pg_constraint.conkey SHAPE rather than on
-- conname, following 054. A name guard is only safe when the name is explicit,
-- short and never reused; shape is safe unconditionally, and neither shape here
-- collides with 044's chk_subscription_source ({source}) or 051's
-- chk_subscription_state ({state}) / chk_subscription_state_stamps
-- ({state, wound_down_at, ended_at, close_all_requested_at}).


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Columns
-- ═══════════════════════════════════════════════════════════════════════════

-- SMALLINT, not INTEGER: the domain is 1..50 and the cap exists precisely
-- because a larger cohort cannot be served.
--
-- NULLable, and NULL is meaningful in two distinct ways that the coherence
-- CHECK below tells apart: a non-active row holds no slot because it is not a
-- member, and a grandfathered active row holds no slot because migration time
-- found the master already over the cap.
ALTER TABLE user_wallet_subscriptions
  ADD COLUMN IF NOT EXISTS membership_slot SMALLINT;

-- The only way an active row may hold no ordinal. DEFAULT FALSE with no writer
-- that ever sets it TRUE except the backfill below, so the grandfathered set is
-- fixed at migration time and monotonically shrinking.
ALTER TABLE user_wallet_subscriptions
  ADD COLUMN IF NOT EXISTS membership_grandfathered BOOLEAN NOT NULL DEFAULT FALSE;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. The uniqueness half of the cap
-- ═══════════════════════════════════════════════════════════════════════════

-- Created BEFORE the backfill on purpose: the backfill's writes are then
-- checked as they happen, so a bug in it aborts this migration instead of
-- committing two members onto one ordinal.
--
-- Partial on `membership_slot IS NOT NULL` because NULLs are the common case
-- (every ended row, forever, is retained for attribution) and because a
-- multi-column unique index would treat them as distinct anyway — the partial
-- predicate makes the intent explicit and keeps the index small.
CREATE UNIQUE INDEX IF NOT EXISTS unq_uws_membership_slot
  ON user_wallet_subscriptions (wallet_address, membership_slot)
  WHERE membership_slot IS NOT NULL;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Backfill
-- ═══════════════════════════════════════════════════════════════════════════

-- Assigns ordinals to existing active members, oldest first.
--
-- Ordered by active_since then created_at then user_id: active_since is the
-- forward-only boundary 051 introduced and is the honest answer to "who has
-- been copying this master longest"; created_at breaks ties from a common
-- backfill clock; user_id makes the result deterministic so a replay cannot
-- reorder anyone.
--
-- Only ordinals that are currently FREE for that master are written, and each
-- free ordinal is consumed once. That is what makes the statement safe to
-- replay against a table that has since churned.
WITH unslotted AS (
  SELECT user_id,
         wallet_address,
         ROW_NUMBER() OVER (
           PARTITION BY wallet_address
           ORDER BY active_since, created_at, user_id
         ) AS seq
    FROM user_wallet_subscriptions
   WHERE state = 'active'
     AND membership_slot IS NULL
     AND NOT membership_grandfathered
),
masters AS (
  SELECT DISTINCT wallet_address FROM unslotted
),
free_slots AS (
  SELECT masters.wallet_address,
         candidate.slot,
         ROW_NUMBER() OVER (
           PARTITION BY masters.wallet_address
           ORDER BY candidate.slot
         ) AS seq
    FROM masters
    CROSS JOIN generate_series(1, 50) AS candidate(slot)
   WHERE NOT EXISTS (
           SELECT 1
             FROM user_wallet_subscriptions taken
            WHERE taken.wallet_address = masters.wallet_address
              AND taken.membership_slot = candidate.slot
         )
)
UPDATE user_wallet_subscriptions AS target
   SET membership_slot = free_slots.slot
  FROM unslotted
  JOIN free_slots
    ON free_slots.wallet_address = unslotted.wallet_address
   AND free_slots.seq = unslotted.seq
 WHERE target.user_id = unslotted.user_id
   AND target.wallet_address = unslotted.wallet_address;

-- Whatever is left is a master that was already over the cap. Grandfathered,
-- never deleted and never transitioned: see Decision 4. After the constraints
-- below exist, this statement's WHERE clause describes a row the CHECK forbids,
-- so every replay matches nothing.
UPDATE user_wallet_subscriptions
   SET membership_grandfathered = TRUE
 WHERE state = 'active'
   AND membership_slot IS NULL
   AND NOT membership_grandfathered;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. The range half of the cap
-- ═══════════════════════════════════════════════════════════════════════════

-- 50 is written as a literal rather than derived, because a CHECK cannot read a
-- configuration table. packages/db/src/master-membership.test.ts asserts this
-- literal equals MASTER_MEMBERSHIP_CAP, so drift between the two is a red suite
-- rather than a cap that binds at a different number than the code believes.
DO $$
DECLARE
  slot_shape smallint[];
BEGIN
  SELECT array_agg(attnum)
    INTO slot_shape
    FROM pg_attribute
   WHERE attrelid = 'user_wallet_subscriptions'::regclass
     AND attname = 'membership_slot';

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'user_wallet_subscriptions'::regclass
       AND contype = 'c'
       AND conkey @> slot_shape
       AND conkey <@ slot_shape
  ) THEN
    ALTER TABLE user_wallet_subscriptions
      ADD CONSTRAINT chk_uws_membership_slot_range
      CHECK (membership_slot IS NULL OR (membership_slot >= 1 AND membership_slot <= 50));
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. The coherence invariant
-- ═══════════════════════════════════════════════════════════════════════════

-- Reads: an ACTIVE row is a member, so it holds an ordinal unless it was
-- grandfathered; ANY OTHER row holds neither an ordinal nor an exemption.
--
-- The ELSE branch is doing three separate jobs and each one matters:
--
--   * a winding_down or ended row cannot occupy a slot, so an UPDATE that
--     forgets to release the ordinal fails loudly instead of holding a slot for
--     a user who has left;
--   * a grandfathering exemption cannot survive a departure, which is S4-M44
--     expressed as an invariant: a returning member must take a real ordinal or
--     be refused;
--   * a state this build has never seen falls into ELSE and therefore holds no
--     slot, which is the fail-closed direction.
--
-- membership_grandfathered is NOT NULL, so `NOT membership_grandfathered` has no
-- three-valued-logic hazard and the CHECK cannot be satisfied by a NULL.
DO $$
DECLARE
  coherence_shape smallint[];
BEGIN
  SELECT array_agg(attnum ORDER BY attnum)
    INTO coherence_shape
    FROM pg_attribute
   WHERE attrelid = 'user_wallet_subscriptions'::regclass
     AND attname IN ('state', 'membership_slot', 'membership_grandfathered');

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'user_wallet_subscriptions'::regclass
       AND contype = 'c'
       AND conkey @> coherence_shape
       AND conkey <@ coherence_shape
  ) THEN
    ALTER TABLE user_wallet_subscriptions
      ADD CONSTRAINT chk_uws_membership_slot_state
      CHECK (
        CASE state
          WHEN 'active' THEN membership_slot IS NOT NULL OR membership_grandfathered
          ELSE membership_slot IS NULL AND NOT membership_grandfathered
        END
      );
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Documentation
-- ═══════════════════════════════════════════════════════════════════════════

COMMENT ON COLUMN user_wallet_subscriptions.membership_slot IS
  'Membership ordinal 1..50 held by an active member of this master (S4-M43). '
  'The cap is enforced by this range plus unq_uws_membership_slot, which '
  'together make a 51st slot-holder unrepresentable — a COUNT(*) check would '
  'be exceeded by exactly the number of concurrent racers. NULL for every '
  'non-active row, and for active rows grandfathered by migration 056. '
  'NEVER expose this to a user: an ordinal is a rank, and a rank discloses the '
  'follower count S4-M9 forbids showing.';

COMMENT ON COLUMN user_wallet_subscriptions.membership_grandfathered IS
  'TRUE only for active members that migration 056 found on a master already '
  'over the cap. They hold no ordinal, keep mirroring, and neither block nor '
  'free a join; the cap applies to new joins only. Set exclusively by 056 — '
  'DEFAULT FALSE and no writer sets it — and cleared on leaving active by '
  'chk_uws_membership_slot_state, so the set can only shrink and an '
  'over-subscribed master converges to the cap by attrition, never eviction.';
