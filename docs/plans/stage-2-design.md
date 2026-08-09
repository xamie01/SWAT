# Stage 2 Design — Per-User Tracking, Backfill, Feeds

**Scope:** `AUDIT-FIX-CHECKLIST.md` §5 tasks `S2-1` … `S2-18`. Migrations `044`–`045`.
**Depends on:** Stage 1 (`forUser()`, auth plugin, cross-tenant suite).
**Delivers:** two users tracking different wallets and seeing disjoint feeds, with tier quotas enforced.

---

## 1. The model: global dedup, per-user subscription

`wallets`, `transactions`, clusters, and scoring stay **global**. One wallet is
indexed once regardless of how many users track it (D9). Subscription is a join
table, not a copy.

This is the decision that keeps indexing cost sublinear in user count, and it is
why `user_wallet_subscriptions` has `PRIMARY KEY (user_id, wallet_address)`
rather than a surrogate id — the pair *is* the fact.

`wallets.address` is `VARCHAR(100)` and the table's PK, so the FK is a plain
reference. Addresses remain chain-prefixed (`${chain}:${raw}`) per the repo-wide
invariant; the subscription table stores the prefixed form and never a bare one.

---

## 2. The pause conflict — resolve before writing `044`

`pauseUnderperformingWallets` (`packages/db/src/scoring-queries.ts:163`) sets
`status = 'paused'` nightly when a wallet has ≥50 trades and a composite score
below 40, or has been inactive 30 days. It was written for a single operator, and
it is **wrong under tenancy as it stands**:

> A user subscribes to a wallet. The nightly sweep decides that wallet
> underperforms and pauses it. The user — who explicitly chose it, and may be
> paying for the privilege — silently stops receiving its data, with no event
> and no way to tell why.

D9 also asks for the opposite direction: pause wallets that have *zero*
subscribers, so growth cannot multiply webhook volume.

Both rules touch `wallets.status`, and they disagree about who owns it.

**Decision: `wallets.status` means "is the platform indexing this?", and
subscriber count is the dominant input.**

| Subscribers | Platform interest | Status |
|---|---|---|
| ≥ 1 | any | `active` — a subscriber pins it, regardless of score |
| 0 | scored/clustered/high-priority | `active` |
| 0 | none, or dormant 30 days | `paused` |

Concretely:
- `pauseUnderperformingWallets` gains a `NOT EXISTS (SELECT 1 FROM
  user_wallet_subscriptions …)` guard. A subscribed wallet is never paused for
  performance. Underperformance is *surfaced* to the user (score/tier are already
  on the wallet), not acted on for them.
- A new `pauseUnsubscribedWallets` handles the D9 direction.
- `reactivateDormantWallets` needs no change; it only ever widens `active`.

The alternative — per-user status — was rejected: it multiplies rows by user
count for a fact that is genuinely global (either we index the wallet or we do
not), and it would make the indexer's "should I poll this?" query per-user.

---

## 3. Tier matrix (`packages/shared/src/tiers.ts`)

Single source of truth for API guards and frontend gating. The checklist gave
only wallet quotas; the rest is specified here.

| | free | operator | ultra |
|---|---|---|---|
| Tracked wallets | 3 | 25 | unlimited |
| Token backfills / day | 1 | 20 | 100 |
| Backfill depth | 30 days | 180 days | 730 days |
| Chains | solana | all built-in | all + custom (Stage 7) |
| Signal feed | delayed 15 min | real-time | real-time |
| Live execution | ✗ | ✓ (Stage 4) | ✓ (Stage 4) |
| API keys | 0 | 3 | 10 |
| Backfill queue priority | 10 (lowest) | 5 | 1 (highest) |

`unlimited` is `null`, not `Infinity` — it serialises to JSON, survives a
database round trip, and cannot silently become `0` through a falsy check.

**Delayed free-tier signals are a product decision, not a technical one.** They
are recorded here because the feed query must implement them, and doing so later
means retrofitting a `WHERE detected_at < NOW() - interval` into a hot path.

Prices are **not** set here — Stage 5 owns them. The matrix deliberately carries
capability, not billing, so a price change never touches quota logic.

---

## 4. Schema

### `044_user_wallet_subscriptions.sql`

```sql
CREATE TABLE IF NOT EXISTS user_wallet_subscriptions (
  user_id        UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_address VARCHAR(100) NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
  label          VARCHAR(64),
  source         VARCHAR(24)  NOT NULL DEFAULT 'manual',
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, wallet_address),
  CONSTRAINT chk_subscription_source
    CHECK (source IN ('manual','platform-signal','discovered'))
);

CREATE INDEX IF NOT EXISTS idx_uws_wallet ON user_wallet_subscriptions(wallet_address);
```

- `ON DELETE CASCADE` on both sides is safe: a subscription is a preference, not
  a financial record. Deleting the *user* removes it; deleting the *wallet*
  removes it. Neither is true of `trades`.
- The reverse index on `wallet_address` is what makes "does this wallet have any
  subscribers?" cheap — the pause sweep runs it over every wallet nightly.

### `045_user_token_watches.sql`

```sql
CREATE TABLE IF NOT EXISTS user_token_watches (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain      VARCHAR(32)  NOT NULL,
  token_mint VARCHAR(100) NOT NULL,
  status     VARCHAR(16)  NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_token_watch_status
    CHECK (status IN ('pending','running','complete','failed')),
  CONSTRAINT uq_token_watch UNIQUE (user_id, chain, token_mint)
);

CREATE INDEX IF NOT EXISTS idx_utw_user_created
  ON user_token_watches(user_id, created_at DESC);
```

- Surrogate PK here, unlike `044`: a watch has lifecycle state that outlives the
  identity, and the daily-quota query counts rows by `created_at`.
- `UNIQUE (user_id, chain, token_mint)` makes re-requesting the same backfill
  idempotent instead of burning quota.
- The `(user_id, created_at DESC)` index serves the daily quota count directly.

---

## 5. Quota enforcement

Enforced in `packages/db`, **not** in route handlers. A quota checked in a
handler is a quota that the next handler forgets.

```ts
assertWithinQuota(scope, 'trackedWallets')  // throws QuotaExceededError → 402
```

Two rules:

1. **Lock the user row, then count, then insert — all in one transaction.**
   A transaction alone is *not* enough, and an earlier draft of this doc was wrong
   to claim it was. `withTransaction` runs at **READ COMMITTED**, so N concurrent
   `COUNT(*)` reads all observe the state before any of them commits: every one
   sees `0 < 3` and every one inserts. A test firing five concurrent subscribes
   against the 3-wallet free tier granted **all five** before this was fixed.
   `SELECT id FROM users WHERE id = $1 FOR UPDATE` first serialises that user's
   quota writes. Chosen over `SERIALIZABLE` (needs a retry loop) and over an
   advisory lock (the row already exists, and the transaction releases it).
   Different users take different locks and never contend.
2. **Quota is read from the user's *effective* tier** — an expired paid tier
   degrades to `free`, matching `requireTier`. `tier_expires_at IS NULL` is
   lifetime and must never read as expired.

Over-quota returns **402 Payment Required**, not 403. 403 means "you may never do
this"; 402 means "upgrade and you may", which is what the frontend needs to
distinguish to show an upgrade prompt rather than an error.

---

## 6. Route contracts

All under `/v1/me/`, all through `forUser()`, all inheriting the Stage 1 auth
plugin and CSRF.

| Route | Notes |
|---|---|
| `GET /v1/me/wallets` | Own subscriptions joined to global wallet stats |
| `POST /v1/me/wallets` | Quota-checked. Upserts the global wallet, enqueues backfill **only if new**, then links. Always builds the job via `createWalletBackfillJob` — never a hand-rolled `jobId`. |
| `DELETE /v1/me/wallets/:address` | Removes the subscription only. **Never deletes the global wallet** — another tenant may be subscribed. |
| `GET /v1/me/wallets/:address/history\|holdings` | Existing queries, gated on subscription. Not-subscribed → 404, not 403: whether *another* user tracks a wallet is not this user's business. |
| `POST /v1/me/tokens/backfill` | Daily-quota-checked; feeds `swat-token-discovery`. |
| `GET /v1/me/signals` | `signals → cluster_memberships → user_wallet_subscriptions`, plus platform-curated for `operator+`. Free tier gets the 15-minute delay. |
| `GET /v1/me/feed` | Subscribed-wallet activity from `source_trades`/`transactions`. |

**Existing global routes become admin-only** (`S2-11`): `/v1/wallets`,
`/v1/config`, trading mode, reindex, logs. They are operator surfaces that read
and mutate platform-wide state; leaving them reachable by any authenticated user
would make every tenancy control above decorative.

---

## 7. Test plan

Extend `tests/integration/cross-tenant.integration.test.ts` — the existing
stand-in `/v1/me/wallets` route is replaced by the real one, so its isolation
assertions carry over unchanged. Add:

- Two users subscribing to the **same** wallet: one `wallets` row, two
  subscriptions, one backfill job enqueued.
- Unsubscribing one user leaves the other's subscription and the global wallet
  intact.
- Quota: the 4th wallet on `free` returns 402; concurrent inserts cannot exceed
  the cap (the transaction test).
- History/holdings for a wallet the user does not subscribe to → 404.
- A subscribed wallet is **not** paused by `pauseUnderperformingWallets` even
  when it meets the underperformance criteria.
- A zero-subscriber wallet with no platform interest **is** paused.
- Every new `/v1/me/*` route rejects the tenant-less legacy service key.
