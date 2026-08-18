-- 047_user_execution_grants.sql
-- Scoped delegated authority to trade on a user's behalf (checklist S4-7,
-- ADR-0003). Renamed from the earlier `user_trading_wallets` shape, which
-- assumed one custodial keypair per user per chain.
--
-- Why the rename matters: the three venues store three DIFFERENT kinds of thing.
--
--   Solana     -> the user's vault PDA address.  No secret exists to store.
--   EVM        -> a session key plus its argument-level scope policy. Secret,
--                 but bounded-loss by the on-chain policy.
--   Polymarket -> the user's signer key. Secret, and funds-loss if it leaks.
--
-- So `sealed_secret` cannot be NOT NULL: a Solana vault has nothing to seal, and
-- a NOT NULL here would force a placeholder — which is exactly how a keyless
-- design quietly acquires a key. `chk_ueg_secret_matches_kind` below makes the
-- absence structural instead.
--
-- `chain`, not `chain_kind` — unlike 041_user_auth_wallets.sql. An EVM *auth*
-- wallet is one signature valid across every EVM chain, so `chain_kind` is right
-- there. An execution *grant* is per-venue: a Polymarket signer key is useless on
-- Robinhood Chain, and polygon/robinhood-chain are both EVM, so keying on
-- `chain_kind` would let one user's two EVM grants collide on a single row.
--
-- ON DELETE RESTRICT, not CASCADE. Stage 1 and 2 used CASCADE because sessions
-- and subscriptions are preferences. A Polymarket row is the only pointer to
-- funds and a Solana row is the only pointer to a vault the user can still
-- withdraw from; a cascade destroys both from one `DELETE FROM users`.
--
-- Idempotent: CREATE ... IF NOT EXISTS only.

CREATE TABLE IF NOT EXISTS user_execution_grants (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  chain           VARCHAR(32)  NOT NULL,
  grant_kind      VARCHAR(24)  NOT NULL,
  -- The account the trade settles from. The user's OWN address on Solana/EVM;
  -- their Polymarket Deposit Wallet on Polymarket. We no longer mint addresses.
  --
  -- NOT chain-prefixed, for the same reason as user_auth_wallets.address: the
  -- repo-wide `${chain}:${raw}` invariant governs *tracked* wallets and
  -- transactions, and `chain` already carries the discriminator here. Write EVM
  -- lowercased and Solana case-preserved, matching resolveChainAddress. Any join
  -- to copy_positions.target_account must prefix on the way.
  account_address VARCHAR(100) NOT NULL,
  -- The versioned envelope from S4-3: `v1.<wrapperId>.<b64 fields...>`. TEXT, not
  -- VARCHAR(n), because the length depends on the wrapper — an env-wrapped data
  -- key is 32 bytes and a Vault/KMS ciphertext blob is a few hundred, so a width
  -- sized for the env wrapper would reject rows during the very migration that
  -- touches every user's key.
  --
  -- NULL for keyless kinds. See chk_ueg_secret_matches_kind.
  sealed_secret   TEXT,
  key_version     INTEGER,
  -- Argument-level allowlist (S4-P10). Required in practice for EVM session keys;
  -- the Solana equivalent lives on-chain in the vault program, not here.
  --
  -- Deliberately JSONB and not typed columns: the policy is a list of
  -- (target, selector, argument constraint) triples whose shape differs per venue,
  -- so a normalised table would need a migration per policy feature. It is
  -- validated in application code on write and never read as authority — the
  -- on-chain policy is the enforcement point. This column records what we asked
  -- for, not what protects the funds.
  scope_policy    JSONB,
  expires_at      TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  status          VARCHAR(16)  NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_ueg_chain CHECK (chain IN ('solana','polygon','robinhood-chain')),
  CONSTRAINT chk_ueg_kind CHECK (grant_kind IN
    ('solana_vault','eip7702','session_key_4337','polymarket_signer')),
  CONSTRAINT chk_ueg_status CHECK (status IN ('active','retired','revoked','compromised')),

  -- A keyless grant must carry no secret; a keyed grant must carry one, versioned.
  --
  -- Enforced in SQL rather than in application code because this is the invariant
  -- that "the API can never decrypt" ultimately rests on. The API holds no wrapper
  -- key, so a keyed row is openable only inside trade-executor and a keyless row
  -- has nothing to open at all. If a code path could write a bare key into
  -- `sealed_secret`, or write a secret onto a row the API is allowed to read as
  -- keyless, that guarantee would be a convention rather than a fact.
  --
  -- Written against a SET of keyless kinds rather than by naming `solana_vault`
  -- twice. The invariant is "keyless kinds carry no secret", not "Solana is
  -- special": adding a second PDA-style venue later is then a one-line edit to the
  -- array instead of a DROP + ADD on a load-bearing constraint, which is the kind
  -- of change that gets deferred and then forgotten.
  --
  -- The `LIKE 'v%'` half is a cheap tripwire for the envelope format: it rejects
  -- any write that is not a versioned envelope, so a path that ever stores a raw
  -- or base64-only key fails at the database rather than at the next signing
  -- attempt. It cannot detect a plaintext key that happens to start with `v` — it
  -- is a guardrail, not a proof, and the envelope round-trip tests carry the real
  -- assertion.
  CONSTRAINT chk_ueg_secret_matches_kind CHECK (
    CASE WHEN grant_kind = ANY (ARRAY['solana_vault']) THEN
      sealed_secret IS NULL AND key_version IS NULL
    ELSE
      sealed_secret IS NOT NULL
      AND key_version IS NOT NULL
      AND sealed_secret LIKE 'v%'
    END
  ),

  -- A session key with no expiry is not a scoped grant.
  CONSTRAINT chk_ueg_session_expires CHECK (
    grant_kind NOT IN ('eip7702','session_key_4337') OR expires_at IS NOT NULL
  ),

  -- Global, mirroring uq_auth_wallet. Two users cannot share an execution
  -- account; if a restore bug produced one, two users' funds would settle to a
  -- single address with two ledger balances and no way to say whose is whose.
  CONSTRAINT uq_ueg_account UNIQUE (chain, account_address)
);

-- Exactly one active grant per (user, chain, kind).
--
-- Keyed on `chain`, NOT `chain_kind`: polygon and robinhood-chain are both EVM,
-- so keying on chain_kind would let one user's Polymarket grant collide with
-- their Robinhood Chain grant.
--
-- Partial rather than a plain UNIQUE so that rotation stays possible without
-- deleting the old row — deleting the row that holds the sealed secret for an
-- account that may still hold dust. Retired rows stay forever and stay openable.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ueg_active_per_user_chain_kind
  ON user_execution_grants(user_id, chain, grant_kind)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_ueg_user ON user_execution_grants(user_id);

-- S4-P9 sweeps for lapsing grants. Partial, because only session keys expire, so
-- the index stays proportional to the EVM grant count rather than the table.
CREATE INDEX IF NOT EXISTS idx_ueg_expiring
  ON user_execution_grants(expires_at)
  WHERE status = 'active' AND expires_at IS NOT NULL;
