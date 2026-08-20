-- 051_subscription_states.sql
--
-- Subscription lifecycle states `active` / `winding_down` / `ended`
-- (checklist S4-M3, ADR-0005 §3.7).
--
-- ── What this encodes ─────────────────────────────────────────────────────
--
-- Unsubscribe is an **exits-only wind-down**, not a liquidation and not an
-- abandonment. Auto-selling on unsubscribe is a market action the user never
-- asked for — taxable, fee-bearing, slippage-bearing, and at scale 500 users
-- leaving one master at once is a coordinated sell *we* caused. Simply
-- stopping is equally wrong: the exit for an already-open position was going
-- to arrive as the master's sell mirror, so dropping the link orphans it.
--
-- So the three states mean, precisely:
--
--   active        mirror the master's buys AND sells.
--   winding_down  mirror the master's sells ONLY. No new entries, ever.
--                 Positions opened while active keep their exit path.
--   ended         mirror nothing. Reached when the last position opened under
--                 this subscription has closed, or immediately on unsubscribe
--                 when there was nothing open to wind down.
--
-- `packages/db/src/subscriptions.ts` holds the matching state machine and is
-- the only place that decides which transitions are legal. This file's job is
-- to make an incoherent row unrepresentable, not to duplicate that logic.
--
-- ── Why now and not after fan-out ─────────────────────────────────────────
--
-- Retrofitting means reconstructing which open position came from which
-- subscription, and that information is not recoverable once positions exist.
-- Today no fan-out has run, so every existing row is unambiguously `active`
-- and the default is exact rather than a guess. That is why the column is
-- landing while the table is still, in effect, empty of history.
--
-- ── Decision 1: a column here, not a separate lifecycle table ─────────────
--
-- The state is an attribute of the subscription, and 044 already settled that
-- there is exactly one subscription per (user, wallet): "the pair IS the fact;
-- there is no such thing as two distinct subscriptions by one user to one
-- wallet." Nothing in `packages/db/sql/` carries a foreign key onto this table
-- (grepped), so there is no dependency forcing a surrogate key either.
--
-- A separate `user_wallet_subscription_states` table would buy transition
-- *history*, which nothing in the checklist asks to read, at the cost of every
-- reader needing a lateral join to answer "is this subscription live?" — the
-- single question the fan-out path asks per master wallet per signal. Where
-- transition history is genuinely wanted it belongs in `audit_log` (043),
-- which already exists and already records per-actor events.
--
-- ── Decision 2: re-subscribe after `ended`, and why `active_since` exists ─
--
-- The primary key is still `(user_id, wallet_address)`, so a second row for
-- the same pair is impossible. A re-subscribe therefore CANNOT be a new row:
-- it is an `ended → active` transition on the row that is already there. That
-- is representable, which is what the state model needed to guarantee.
--
-- But it makes `created_at` unusable as the forward-only mirror boundary
-- (S4-M2: "mirrors only trades from subscription onward"). A row created in
-- January, ended in March and revived in August still reads
-- `created_at = January`, so a forward-only filter written against
-- `created_at` would let the revived subscriber catch up on eight months of
-- the master's trades — entering existing positions at an unknown cost basis,
-- which is precisely how followers become exit liquidity.
--
-- `active_since` is therefore set on EVERY entry into `active`, and it is the
-- column S4-M2 must filter on. Backfilled from `created_at` because for rows
-- that exist today the two are the same fact.
--
-- ── Decision 3: per-transition timestamps ────────────────────────────────
--
-- `wound_down_at` and `ended_at` are not decoration. A subscription that has
-- been winding down for sixty days is an operational alert — either the master
-- has gone quiet and never sold, or an exit is failing (S4-M17) — and that is
-- undetectable without knowing when the wind-down started. `ended_at` is what
-- makes "closed cleanly" distinguishable from "still waiting" in support
-- traffic and in the wind-down UI (S6-32).
--
-- They describe the CURRENT lifecycle instance, not history: entering `active`
-- clears them, which is what lets the coherence CHECK below be a real
-- invariant instead of advice. History is `audit_log`'s job, per Decision 1.
--
-- `close_all_requested_at` is the durable record of the explicit "close all
-- now" the item requires us to offer. It is a timestamp rather than a fourth
-- state because the subscription's mirroring posture does not change when the
-- user asks — it is already sells-only; only the *urgency* changes, from
-- "wait for the master's exit" to "exit now". Making it a state would force
-- every eligibility reader to learn a value that means the same thing as
-- `winding_down` for its purposes. It must be durable rather than an in-flight
-- command so that a request survives an executor restart and so that a second
-- click is a no-op instead of a second round of sells.
--
-- ── Idempotency ───────────────────────────────────────────────────────────
--
-- `migrate.ts` has NO applied-migrations table: it replays EVERY file in
-- `packages/db/sql/` on EVERY invocation, in filename order, one transaction
-- per file. Every statement below is replay-safe.
--
-- The two CHECK constraints are guarded by NAME rather than by
-- `pg_constraint.conkey` shape, which is the opposite of what 050 does. That
-- is deliberate and the reasoning does not carry over: 050 had to drop keys
-- whose generated names exceed the 63-byte identifier limit and whose
-- replacements reuse the old name. Here both names are explicit, 24 and 25
-- bytes, newly introduced by this file, and never reused by a replacement —
-- so the name IS the identity and a name guard cannot mis-fire. It is also
-- the idiom 050 itself uses for the constraint it ADDS
-- (`fk_copy_position_applications_position`).


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Columns
-- ═══════════════════════════════════════════════════════════════════════════

-- VARCHAR + CHECK rather than a PostgreSQL ENUM, matching every other status
-- column in this schema (`wallets.status`, `user_token_watches.status`,
-- `user_wallet_subscriptions.source` in 044). An ENUM would need
-- `ALTER TYPE ... ADD VALUE`, which cannot run inside the transaction
-- `migrate.ts` wraps each file in.
--
-- DEFAULT 'active' is exact for the rows that exist today, not a fallback:
-- every one of them was written by `subscribeToWallet`, no fan-out has ever
-- run, so no row can be mid-wind-down. It also keeps any writer still running
-- the previous release correct — an insert without `state` means active, which
-- is what that writer intends.
ALTER TABLE user_wallet_subscriptions
  ADD COLUMN IF NOT EXISTS state VARCHAR(16) NOT NULL DEFAULT 'active';

-- Added NULLable, backfilled, then made NOT NULL with a default. Adding it
-- NOT NULL DEFAULT NOW() in one step would stamp every existing row with the
-- migration's own clock instead of its real subscription time. `SET NOT NULL`
-- and `SET DEFAULT` are both no-ops on replay.
ALTER TABLE user_wallet_subscriptions
  ADD COLUMN IF NOT EXISTS active_since TIMESTAMPTZ;

UPDATE user_wallet_subscriptions
   SET active_since = created_at
 WHERE active_since IS NULL;

ALTER TABLE user_wallet_subscriptions
  ALTER COLUMN active_since SET DEFAULT NOW();

ALTER TABLE user_wallet_subscriptions
  ALTER COLUMN active_since SET NOT NULL;

ALTER TABLE user_wallet_subscriptions
  ADD COLUMN IF NOT EXISTS wound_down_at TIMESTAMPTZ;

ALTER TABLE user_wallet_subscriptions
  ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;

ALTER TABLE user_wallet_subscriptions
  ADD COLUMN IF NOT EXISTS close_all_requested_at TIMESTAMPTZ;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Constraints
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'user_wallet_subscriptions'::regclass
       AND conname = 'chk_subscription_state'
  ) THEN
    ALTER TABLE user_wallet_subscriptions
      ADD CONSTRAINT chk_subscription_state
      CHECK (state IN ('active', 'winding_down', 'ended'));
  END IF;
END $$;

-- The coherence invariant. Without it `state = 'winding_down'` with a NULL
-- `wound_down_at` is representable, and then "how long has this been winding
-- down?" — the one operational question the timestamp exists to answer — has
-- no answer for exactly the rows that need it.
--
-- Note the asymmetry, which is intentional: an `ended` row may have a NULL
-- `wound_down_at`, because `active → ended` is a legal direct transition for a
-- subscription that never opened a position. Requiring `wound_down_at` there
-- would force a fictitious wind-down through a state the subscription never
-- occupied.
--
-- `ELSE FALSE` fails closed. If a fourth state is ever added to
-- `chk_subscription_state` without being given a branch here, every write of
-- it is rejected loudly rather than silently escaping the invariant.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'user_wallet_subscriptions'::regclass
       AND conname = 'chk_subscription_state_stamps'
  ) THEN
    ALTER TABLE user_wallet_subscriptions
      ADD CONSTRAINT chk_subscription_state_stamps
      CHECK (
        CASE state
          WHEN 'active' THEN
            wound_down_at IS NULL
            AND ended_at IS NULL
            AND close_all_requested_at IS NULL
          WHEN 'winding_down' THEN
            wound_down_at IS NOT NULL
            AND ended_at IS NULL
          WHEN 'ended' THEN
            ended_at IS NOT NULL
          ELSE FALSE
        END
      );
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Indexes
-- ═══════════════════════════════════════════════════════════════════════════

-- The fan-out hot path (S4-13): given a master wallet on a `source_trade`
-- signal, find its live subscribers and split them into buy-eligible
-- (`active`) and sell-only (`winding_down`). 044's `idx_uws_wallet` covers the
-- lookup but not the split, and `ended` rows are retained forever for
-- attribution, so without the partial predicate every mirror would scan the
-- accumulated history of everyone who ever left this master.
CREATE INDEX IF NOT EXISTS idx_uws_wallet_live
  ON user_wallet_subscriptions (wallet_address, state)
  WHERE state <> 'ended';

-- Wind-downs that are not finishing: the operational sweep behind S4-M17
-- (an unfilled sell leaves a user holding a position their master has left).
-- Partial, because this is a small set by construction and a full-table index
-- on a nullable timestamp would be mostly dead entries.
CREATE INDEX IF NOT EXISTS idx_uws_winding_down
  ON user_wallet_subscriptions (wound_down_at)
  WHERE state = 'winding_down';


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Documentation
-- ═══════════════════════════════════════════════════════════════════════════

COMMENT ON COLUMN user_wallet_subscriptions.state IS
  'Mirroring lifecycle (S4-M3, ADR-0005 §3.7). active = mirror buys and '
  'sells; winding_down = mirror SELLS ONLY, no new entries; ended = mirror '
  'nothing. Legal transitions live in packages/db/src/subscriptions.ts '
  '(evaluateSubscriptionTransition) — do not UPDATE this column directly.';

COMMENT ON COLUMN user_wallet_subscriptions.active_since IS
  'When the CURRENT active period began; reset on every entry into active. '
  'This — not created_at — is the forward-only mirror boundary (S4-M2), '
  'because a revived subscription keeps its original created_at and filtering '
  'on that would let it catch up on trades from before it was revived.';

COMMENT ON COLUMN user_wallet_subscriptions.wound_down_at IS
  'When the current wind-down began. NULL for active rows, and also for rows '
  'that went active -> ended directly with nothing open to wind down.';

COMMENT ON COLUMN user_wallet_subscriptions.ended_at IS
  'When mirroring stopped entirely: the last position opened under this '
  'subscription closed, or unsubscribe found nothing open.';

COMMENT ON COLUMN user_wallet_subscriptions.close_all_requested_at IS
  'When the user asked to exit every open position now rather than waiting '
  'for the master to sell (S4-M3 "close all now"). Durable so the request '
  'survives an executor restart and so a second click is a no-op. Not a '
  'fourth state: the mirroring posture is already sells-only, only the '
  'urgency changes.';
