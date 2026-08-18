-- 049_user_execution_settings.sql
-- Per-user risk and execution preferences (checklist S4-9), plus the per-chain
-- mode and slippage tolerance that S4-P4 depends on.
--
-- Two tables, not one. Per-chain mode and slippage live in a second table rather
-- than a JSONB column on the first because a JSONB `{"solana":"live"}` cannot
-- carry a CHECK on its values, cannot be joined to the certification gate, and
-- needs application-side parsing inside the fan-out enumeration query — which is
-- the hot path. The (user, chain) pair IS the fact, same argument as 044.
--
-- Defaults duplicate DEFAULT_RISK_CONFIG (packages/shared/src/constants.ts) as
-- literals because a migration cannot import TypeScript. The values must match,
-- and user-execution-settings.test.ts asserts this file's defaults against the
-- constant so drift fails CI instead of silently giving new users different risk
-- than the docs claim.
--
-- No row is created at signup. Absence means "all defaults, nothing opted in",
-- and the resolver returns defaults for a missing row. Creating a row at signup
-- would require Stage 1's signup path to know about Stage 4's schema.
--
-- Idempotent: CREATE ... IF NOT EXISTS only.

CREATE TABLE IF NOT EXISTS user_execution_settings (
  user_id                  UUID         PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- FALSE, and per-chain `mode` defaults to 'off'. A user who creates an account
  -- and deposits does not begin trading; opting in is an explicit act, and the
  -- disclosure obligations attach to that act.
  auto_execute             BOOLEAN      NOT NULL DEFAULT FALSE,
  -- 80 matches the seeded signals.auto_execute_min_score in 001_init.sql.
  min_signal_score         SMALLINT     NOT NULL DEFAULT 80
                             CHECK (min_signal_score BETWEEN 0 AND 100),
  -- DEFAULT_RISK_CONFIG.maxPositionPct
  max_position_pct         NUMERIC(5,2) NOT NULL DEFAULT 5
                             CHECK (max_position_pct > 0 AND max_position_pct <= 100),
  -- DEFAULT_RISK_CONFIG.maxDailyExposurePct
  max_daily_exposure_pct   NUMERIC(5,2) NOT NULL DEFAULT 25
                             CHECK (max_daily_exposure_pct > 0 AND max_daily_exposure_pct <= 100),
  -- DEFAULT_RISK_CONFIG.stopLossPct
  stop_loss_pct            NUMERIC(5,2) NOT NULL DEFAULT 20
                             CHECK (stop_loss_pct > 0 AND stop_loss_pct <= 100),
  -- 3600s == the 60-minute REBUY_COOLDOWN_MINUTES default the operator path uses.
  rebuy_cooldown_seconds   INTEGER      NOT NULL DEFAULT 3600
                             CHECK (rebuy_cooldown_seconds >= 0),
  -- Lives here rather than in a constant because D11 requires a daily cap and a
  -- per-user cap must be adjustable by an admin without a deploy. 1000 is
  -- deliberately low; raising it is an audited admin action.
  max_daily_withdrawal_usd NUMERIC      NOT NULL DEFAULT 1000
                             CHECK (max_daily_withdrawal_usd >= 0),
  -- The per-user kill switch. On the settings row rather than derived from setting
  -- every chain to 'off', because those are different intents: "stop everything
  -- now" must be one atomic write that survives the user later re-enabling one
  -- chain, and it must be greppable in the audit log as one event.
  killed                   BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Rejects a single-position cap larger than the daily cap. Without it one trade
  -- can exhaust and exceed the daily limit, which makes the daily limit
  -- decorative. The checklist lists both fields and does not say they must be
  -- ordered; they must.
  CONSTRAINT chk_ues_position_within_daily
    CHECK (max_position_pct <= max_daily_exposure_pct)
);

CREATE TABLE IF NOT EXISTS user_chain_execution_settings (
  user_id          UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain            VARCHAR(32) NOT NULL,
  -- 'off' by default. The platform gates (chain_certifications and
  -- LIVE_ENABLED_CHAINS) still clamp on top of whatever this says — resolveChainMode
  -- downgrades to paper when either is missing, so 'live' here is a request, not
  -- a grant.
  mode             VARCHAR(16) NOT NULL DEFAULT 'off',
  -- Per-chain because tolerable slippage is a property of the venue, not the
  -- person: 3% is loose on a Polymarket CLOB book and tight on a thin Solana
  -- memecoin. One global value would force a user to accept the loosest chain's
  -- risk everywhere.
  --
  -- NULL means "use the chain default" and is deliberately distinct from a
  -- user-chosen value. That distinction is what lets DEFAULT_SLIPPAGE_BPS be
  -- retuned later for users who never expressed a preference, without silently
  -- overwriting anyone who did — resolveSlippageBps(chain, null) in
  -- packages/shared/src/slippage.ts accepts NULL for exactly this.
  --
  -- Bounds mirror that module: MIN_SLIPPAGE_BPS = 1 (zero makes every order
  -- unfillable, which is a footgun rather than a policy) and MAX_SLIPPAGE_BPS =
  -- 5000 (without a ceiling a user could set 90% and the executor would fill at a
  -- tenth of the quoted price — technically their stated limit, but not a risk
  -- anyone chooses knowingly). Hard prerequisite of S4-P4.
  max_slippage_bps INTEGER     NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (user_id, chain),
  CONSTRAINT chk_uces_chain CHECK (chain IN ('solana','polygon','robinhood-chain')),
  CONSTRAINT chk_uces_mode CHECK (mode IN ('off','paper','live')),
  CONSTRAINT chk_uces_max_slippage_bps CHECK (
    max_slippage_bps IS NULL
    OR (max_slippage_bps >= 1 AND max_slippage_bps <= 5000)
  )
);
