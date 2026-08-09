-- 043_audit_log.sql
-- Append-only record of auth, custody, billing, and admin events.
--
-- Built now, before there is anything to log, on purpose (D10/D13): it is cheap
-- today and impossible to reconstruct retroactively. It is also the D13
-- compliance trail, so it must be the most durable table here.
--
-- NO foreign key on actor_id, deliberately:
--   * the log must outlive the user row it describes (soft delete, and later
--     hard deletion of a user with no financial rows), and
--   * a failed login for an email that does not exist has no user to reference
--     -- and that is precisely the event worth keeping when investigating
--     credential stuffing.
-- An FK here would either lose those rows or block the delete.
--
-- Append-only is convention in Stage 1 and becomes enforced when the app
-- database role is split out in Stage 0's D10 hardening (revoke UPDATE/DELETE).
--
-- Idempotent: CREATE ... IF NOT EXISTS only.

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL    PRIMARY KEY,
  occurred_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  actor_type  VARCHAR(16)  NOT NULL,
  actor_id    UUID,
  event       VARCHAR(64)  NOT NULL,
  target_type VARCHAR(32),
  target_id   VARCHAR(128),
  ip          INET,
  user_agent  VARCHAR(256),
  metadata    JSONB        NOT NULL DEFAULT '{}'::jsonb,
  -- 'anonymous' covers pre-authentication events (failed logins, nonce
  -- requests) where no actor is yet established.
  CONSTRAINT chk_audit_actor CHECK (actor_type IN ('user','admin','service','anonymous'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_occurred
  ON audit_log(occurred_at DESC);

-- "What did this actor do?" -- the account-investigation query.
CREATE INDEX IF NOT EXISTS idx_audit_log_actor
  ON audit_log(actor_id, occurred_at DESC);

-- "Who is failing logins right now?" -- the abuse-detection query.
CREATE INDEX IF NOT EXISTS idx_audit_log_event
  ON audit_log(event, occurred_at DESC);
