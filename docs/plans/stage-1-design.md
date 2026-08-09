# Stage 1 Design — Identity & Tenancy

**Scope:** `AUDIT-FIX-CHECKLIST.md` §4 tasks `S1-1` … `S1-16`. Migrations `039`–`043`.
**Depends on:** `docs/adr/0001-tenancy-key.md` (DG-5, resolved).
**Delivers:** signup → login → wallet-link → `/v1/auth/me`, with tenant scoping enforced structurally rather than per-route.

This is the construction spec the checklist deliberately does not carry. Where it
and the checklist disagree, the checklist's *task list* wins and this doc's
*detail* wins.

---

## 1. Principles for this stage

1. **`user_id` comes from the session, never a request payload** (D12). Enforced by
   the `forUser()` layer in §5, not by discipline at each route.
2. **The browser holds no shared secret.** `NEXT_PUBLIC_API_KEY` is deleted in
   Stage 6; the legacy `API_KEY` becomes internal-service-and-admin only, and is
   rotated when S1-14 lands.
3. **Fail closed.** An unparseable session, an expired session, and an unknown user
   are all 401. A valid session for a user whose `status` is not `active` is 403.
4. **No execution code is touched.** Stage 1 is orthogonal — this is why BUILDER-GUIDE
   allows it to run in parallel with Stage 0 infra.

---

## 2. Schema — migrations `039`–`043`

Conventions matched from `035_copy_eligibility_policy.sql`: `gen_random_uuid()`
defaults (pgcrypto is already installed by `001`), `TIMESTAMPTZ` throughout,
`VARCHAR(n)` over `TEXT` for bounded values, `CREATE … IF NOT EXISTS` only, and
`CREATE INDEX IF NOT EXISTS` after the table. Every file must replay twice cleanly.

### `039_users.sql`

```sql
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS users (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  email           CITEXT       NOT NULL UNIQUE,
  password_hash   TEXT         NOT NULL,
  display_name    VARCHAR(64),
  role            VARCHAR(16)  NOT NULL DEFAULT 'user',
  tier            VARCHAR(16)  NOT NULL DEFAULT 'free',
  tier_expires_at TIMESTAMPTZ,
  status          VARCHAR(16)  NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_users_role   CHECK (role IN ('user','admin')),
  CONSTRAINT chk_users_tier   CHECK (tier IN ('free','operator','ultra')),
  CONSTRAINT chk_users_status CHECK (status IN ('active','suspended','deleted'))
);

CREATE INDEX IF NOT EXISTS idx_users_tier_expiry
  ON users(tier_expires_at) WHERE tier_expires_at IS NOT NULL;
```

- `CITEXT` gives case-insensitive uniqueness without a functional index, so
  `Alice@x.com` and `alice@x.com` cannot both register. The extension must be
  created in the same file that first uses it.
- `password_hash` is `TEXT`, not `VARCHAR(n)`: argon2id encoded hashes carry their
  own parameters and length changes when those are tuned.
- `tier_expires_at IS NULL` means **lifetime** (the USDC 99 tier), not expired.
  The partial index exists for Stage 5's nightly downgrade sweep.
- `status = 'deleted'` is a soft delete. Hard deletion is deferred — a user with
  `trades` rows cannot be removed without breaking the financial trail (D13).

### `040_user_sessions.sql`

```sql
CREATE TABLE IF NOT EXISTS user_sessions (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    BYTEA        NOT NULL UNIQUE,
  issued_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ  NOT NULL,
  revoked_at    TIMESTAMPTZ,
  last_seen_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  ip            INET,
  user_agent    VARCHAR(256)
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user   ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry ON user_sessions(expires_at);
```

- **Only the hash is stored.** The raw token exists in the cookie and nowhere else,
  so a database dump cannot be replayed as a login.
- `token_hash` is `BYTEA` holding a raw SHA-256 digest, compared with
  `timingSafeEqual` — the same primitive `apps/api/src/index.ts:87` already uses for
  the legacy key. SHA-256 (not argon2) is correct here: the token is 256 bits of
  CSPRNG output, so there is no low-entropy secret to slow an attacker down.
- `ON DELETE CASCADE` is safe on sessions specifically — a session has no financial
  meaning, unlike `trades`.
- `revoked_at` supports logout-everywhere and forced revocation on password change,
  without deleting the audit trail.

### `041_user_auth_wallets.sql`

```sql
CREATE TABLE IF NOT EXISTS user_auth_wallets (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain_kind  VARCHAR(16)  NOT NULL,
  address     VARCHAR(100) NOT NULL,
  verified_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_auth_wallet_kind CHECK (chain_kind IN ('evm','solana')),
  CONSTRAINT uq_auth_wallet UNIQUE (chain_kind, address)
);

CREATE INDEX IF NOT EXISTS idx_user_auth_wallets_user ON user_auth_wallets(user_id);
```

- `UNIQUE (chain_kind, address)` is **global, not per-user** — one wallet proves one
  identity. Without this, two accounts could both claim the same address and Stage 4's
  withdraw-to-linked-wallet-only control would be ambiguous about who owns it.
- `chain_kind`, not `chain`: these are identity wallets, not tracked wallets. An EVM
  signature proves control of that address on every EVM chain at once, so pinning it
  to `polygon` vs `robinhood-chain` would be wrong.
- Addresses stored here are **not** chain-prefixed — the repo-wide prefix invariant
  applies to tracked wallets/transactions, and `chain_kind` already carries the
  discriminator. EVM addresses are lowercased on write; Solana addresses are
  case-preserved, matching `resolveChainAddress` semantics.

### `042_user_api_keys.sql`

```sql
CREATE TABLE IF NOT EXISTS user_api_keys (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         VARCHAR(64)  NOT NULL,
  key_prefix   VARCHAR(16)  NOT NULL UNIQUE,
  key_hash     BYTEA        NOT NULL,
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_api_keys_user ON user_api_keys(user_id);
```

- Key format `swat_<prefix>_<secret>`. The **prefix is indexed and unique** so lookup
  is one indexed equality, not a scan-and-compare over every key — the naive design
  degrades linearly and invites a timing oracle.
- Only `key_hash` (SHA-256 of the full key) is stored; the secret is shown once at
  creation.

### `043_audit_log.sql`

```sql
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
  CONSTRAINT chk_audit_actor CHECK (actor_type IN ('user','admin','service','anonymous'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_occurred ON audit_log(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor    ON audit_log(actor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_event    ON audit_log(event, occurred_at DESC);
```

- Built now on purpose (D10/D13): cheap today, impossible to reconstruct later.
- **No FK on `actor_id`.** The log must outlive the user row it describes, and a
  failed login for a nonexistent email has no user to reference.
- `actor_type = 'anonymous'` covers pre-authentication events — failed logins are
  exactly what you want when investigating credential stuffing.
- **Append-only by convention in Stage 1**, enforced by a revoked-UPDATE/DELETE grant
  when the app role is split out in Stage 0's D10 hardening.

Events to emit from day one: `auth.signup`, `auth.login`, `auth.login_failed`,
`auth.logout`, `auth.session_revoked`, `auth.password_changed`, `auth.wallet_linked`,
`auth.wallet_unlinked`, `apikey.created`, `apikey.revoked`, `admin.role_changed`,
`admin.tier_changed`.

---

## 3. Session and credential mechanics

The checklist says "argon2id + opaque tokens in httpOnly cookies", which does not
determine the parameters that matter. Pinned here:

| Parameter | Value | Why |
|---|---|---|
| Password hash | argon2id, m=47104 (46 MiB), t=1, p=1 | See measurement below |
| Password policy | min 12 chars, no composition rules | Length beats character classes; composition rules push users to predictable patterns |
| Session token | 32 bytes from `randomBytes`, base64url | 256 bits — brute force is not a threat model |
| Token storage | SHA-256 digest in `token_hash` | Raw token never persisted |
| Session TTL | 30 days absolute, 7-day idle | `last_seen_at` drives idle expiry |
| Rotation | New token on login; **all sessions revoked on password change** | Password change is the account-recovery primitive |
| Cookie | `httpOnly`, `Secure`, `SameSite=Lax`, `Path=/` | See below |
| CSRF | Double-submit token, required on all non-GET | Cookie auth without this is CSRF-open |
| Login rate limit | 5 per 15 min per (IP, email) | Plus Cloudflare edge limits (D10) |

### Argon2id parameter choice (measured, not assumed)

`@node-rs/argon2`, median of 5 runs on the development box (**2 cores**):

| Config | Median |
|---|---|
| m=65536, t=3, p=1 | 450 ms |
| m=65536, t=2, p=4 | 304 ms |
| **m=47104, t=1, p=1** | **110 ms** |
| m=19456, t=2, p=1 | 75 ms |

**Chosen: m=47104, t=1, p=1.** OWASP publishes several argon2id configurations it
treats as *equivalent* in strength — m=47104/t=1, m=19456/t=2, m=12288/t=3,
m=9216/t=4, m=7168/t=5 — trading memory against time. The first draft of this doc
specified m=65536/t=3, which exceeds all of them but costs 450 ms per verify on
2 cores. That is not free: every login and every *failed* login pays it, so it
becomes a self-inflicted DoS lever under credential stuffing, which is the exact
attack the login rate limit exists to blunt. m=47104/t=1 is an OWASP-recommended
configuration at roughly a quarter of the cost.

Raising parallelism is not the fix here — the box has 2 cores, so p=4 cannot
deliver its intended speedup.

**Re-measure on the D1 production box and record the result.** These numbers are
hardware-specific and the box is 8–16 vCPU.

Changing these parameters later is safe and needs no migration: an argon2 encoded
hash embeds its own parameters, so `verify` keeps working against hashes written
under any previous configuration. New hashes simply use the new settings.

**`SameSite=Lax`, not `Strict`.** The SIWE/SIWS wallet-linking flow can return the
user via a top-level cross-site navigation from a wallet app; `Strict` withholds the
cookie on that navigation and the callback lands unauthenticated. `Lax` still blocks
the cross-site POST that CSRF needs, and the double-submit token covers the rest.

**Login must not leak which emails exist.** Unknown email and wrong password both
return the same 401 body and both perform an argon2 verify against a dummy hash, so
response timing does not distinguish them either.

### SIWE / SIWS verification

1. `POST /v1/auth/wallet/nonce` → server generates a nonce, stores it in Redis under
   `swat:siwe:<nonce>` with a **5-minute TTL**, returns it.
2. Client signs the EIP-4361 (EVM) or structured (Solana) message including that nonce.
3. `POST /v1/auth/wallet/verify` → server **atomically consumes** the nonce with
   `DEL` and checks the return value is 1, exactly as the existing SSE ticket flow does
   (`apps/api/src/index.ts:104`). A nonce that verifies twice is a replay.
4. Verify signature: `viem`'s `verifyMessage` for EVM; `tweetnacl.sign.detached.verify`
   over the ed25519 public key for Solana.
5. Also validate the message's `domain` and `uri` fields against the configured origin
   — signature validity alone does not prove the user meant to sign in *here*.

---

## 4. API contracts

All routes under `/v1/auth/`. Error bodies match the existing convention exactly —
`{ error: string }`, optionally `{ error, message }` — established at
`apps/api/src/index.ts:108-125`. Never include database detail (audit `M5`).

| Route | Body | 200 | Errors |
|---|---|---|---|
| `POST /v1/auth/signup` | `{email, password, displayName?}` | `{user:{id,email,displayName,role,tier}}` + `Set-Cookie` | 400 invalid, 409 email taken, 429 |
| `POST /v1/auth/login` | `{email, password}` | same as signup | 401 `Invalid credentials`, 403 suspended, 429 |
| `POST /v1/auth/logout` | — | `{ok:true}` | 401 |
| `GET /v1/auth/me` | — | `{user:{id,email,displayName,role,tier,tierExpiresAt}, wallets:[{chainKind,address,verifiedAt}]}` | 401 |
| `POST /v1/auth/wallet/nonce` | `{chainKind, address}` | `{nonce, message, expiresAt}` | 400, 401, 429 |
| `POST /v1/auth/wallet/verify` | `{chainKind, address, signature, nonce}` | `{wallet:{chainKind,address,verifiedAt}}` | 400, 401 bad signature, 409 linked elsewhere, 410 nonce expired |

`POST /v1/auth/wallet/verify` serves two flows: linking (authenticated session
present) and wallet-only login (no session — succeeds only if the address is already
linked, then issues a session). Both paths write `audit_log`.

**Route ordering.** Static paths register before parameterized ones — Fastify matches
in registration order and `/v1/signals/stats` before `/v1/signals/:id` is the existing
precedent (`apps/api/src/index.ts`).

---

## 5. The `forUser()` tenancy layer (D12)

The single most important structural piece in Stage 1. Every per-user query goes
through it so no route can forget the scope.

```ts
// packages/db/src/tenancy.ts
export interface UserScope { readonly userId: string; }

/** The only way to obtain a UserScope. Takes the id from the session, never a payload. */
export function forUser(userId: string): UserScope;
```

Rules, enforced by the cross-tenant CI suite rather than by review:

- Any `packages/db` function returning user-owned rows takes `UserScope` as its
  **first** parameter.
- The scope is never constructed from `request.body` or `request.params` — only from
  `request.user.id` set by the auth plugin.
- Admin routes that legitimately cross tenants use a separately named function
  (`…ForAdmin`), so cross-tenant access is greppable rather than implicit.

### Auth plugin shape

```
onRequest:
  OPTIONS                          → pass
  /v1/health                       → pass
  session cookie present           → validate → request.user = {id, tier, role}
  Authorization: Bearer swat_…     → validate API key → request.user
  X-Api-Key matches legacy API_KEY → request.user = {role:'service'}   (internal + admin only)
  otherwise                        → 401
```

The legacy key **must not** satisfy `/v1/me/*` once Stage 2 lands — it is a
service credential with no tenant, and treating it as one would be a cross-tenant
hole by construction.

---

## 6. Seeding existing operator data (S1-7)

Migration `039` seeds nothing. A separate idempotent step creates the admin user from
`ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD` if absent, and Stage 2's `044` subscribes all
existing `wallets` rows to it. Splitting these matters: Stage 1 must be deployable
without Stage 2's tables existing.

Existing operator `trades` and `copy_executions` keep `user_id NULL` per ADR-0001 —
they are never backfilled to the admin user. Attributing historical operator activity
to a user account would corrupt that user's P&L and expectancy.

---

## 7. Test plan

Gate for the stage: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:integration`.

**Unit (`packages/db`, `apps/api`)**
- argon2 verify accepts correct / rejects wrong password.
- Session token: hash stored not raw; expired rejected; revoked rejected; idle-expiry.
- API key: prefix lookup; revoked and expired rejected.
- SIWE and SIWS: valid accepted; wrong signer rejected; replayed nonce rejected;
  expired nonce rejected; wrong domain rejected.
- Login enumeration: unknown-email and wrong-password bodies are byte-identical.

**Integration (`tests/integration/`)**
- Full signup → login → `/v1/auth/me` → logout → `/v1/auth/me` 401.
- Password change revokes all other sessions.
- Wallet link, then wallet-only login with the linked address.
- Linking a wallet already bound to another user → 409.
- **Cross-tenant suite (S1-16):** user A's session cannot read or mutate user B's
  resources on any route. Written now against `/v1/auth/*`, extended to every
  `/v1/me/*` route in Stage 2, and run on every merge.
- Migrations `039`–`043` replay twice cleanly.

**Lint gate:** CI fails on any new `NEXT_PUBLIC_` name containing `KEY`, `SECRET`, or
`TOKEN`.

---

## 8. Deliberately deferred

| Item | Why |
|---|---|
| Email delivery (verification, password reset) | Needs a provider decision; signup works without it. `status` already supports a `pending` value if added. |
| TOTP / 2FA | `users` has room; not required before custody (Stage 4), where it should be reconsidered as mandatory. |
| OAuth / social login | Email + wallet covers the stated product. |
| Hard user deletion | Blocked by the D13 financial trail; soft delete only. |
| Per-tier rate limits | Needs the Stage 2 tier matrix; a flat limit applies in Stage 1. |
