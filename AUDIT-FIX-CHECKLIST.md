# SWAT Build Checklist — Current State → Multi-Tenant SaaS

**The execution tracker.** Every task needed to take this codebase from where it is today to the destination in `docs/plans/saas-conversion-plan.md`, in the stage order set by `docs/plans/BUILDER-GUIDE.md`.

| Doc | Role |
|---|---|
| `docs/plans/BUILDER-GUIDE.md` | **Why this order.** Stage definitions, standing rules, decision gates. Wins on any sequencing conflict. |
| **`AUDIT-FIX-CHECKLIST.md`** (this) | **What to build, in order.** Numbered tasks, files, done-when. Check items off here. |
| `docs/plans/saas-conversion-plan.md` | SaaS design detail — schemas, routes, packages. See §2 for four corrections that override it. |
| `docs/plans/production-decisions.md` | D1–D18 infrastructure/security decisions. |
| `docs/plans/audit-history.md` | Archived evidence log for every audit ID (`F-CORE7`, `G5-R3`, …). Read-only. |

Audit IDs are kept inline for traceability. `S<n>-<k>` is this document's own task numbering.

## Status legend

- `[x]` — implemented, focused tests pass, evidence in the repo.
- `[ ]` — not started or partial; the **Done when** line is the acceptance test.
- `[!]` — **blocker or correction.** Do these before the stage they sit in.
- `(ext)` — needs credentials, funded wallets, a canary, or a human reviewer. Cannot be closed by code.

---

## 1. Verified baseline — updated 2026-08-05

Measurements from an actual run, not claims carried forward.

| Gate | Result |
|---|---|
| `pnpm db:migrate` | **46/46** apply (highest file `046_polymarket_redemptions.sql`) |
| `pnpm check:secrets` | ✅ 226 files, 1 grandfathered (`NEXT_PUBLIC_API_KEY`, tracked by S6-3) |
| `pnpm typecheck` | ✅ all packages + `typecheck:tools` |
| `pnpm test` | ✅ **774 passed** across 11 packages |
| `pnpm build` | ✅ 11/11 |
| `pnpm test:integration` | ✅ **50/50 across 8 files** |

**Engine is complete and green.** Audit batches A–F all landed: build fix, CI, artifact cleanup, account-keyed circuit breaker, DB-resolved risk policy, stop-loss enforcement, reconciliation coordinator, copy-eligibility policy, read/write pool split, BRIN index, `pg_stat_statements`, chaos fixtures, per-chain pipeline fixtures, and the four Polymarket partials. Ingestion, scoring, clustering, signal detection, alerting, and paper execution work end to end on all three chains.

**Stage 0 blockers cleared; Stages 1 and 2 complete; Stage 3 codeable half in progress** (2026-08-05). Identity, sessions, SIWE/SIWS wallet linking, tiers/roles, the `forUser()` tenancy layer, the audit log, per-user subscriptions with transactional quotas, admin-gated global routes, and two mutation-tested isolation/safety suites are all in place. Stage 3 has the Jito bundle client, Jupiter swap build, CLOB V2 auth, and the Jupiter+Jito runtime — see §6.0.

**Still absent (Stages 4–7):** `user_execution_grants`, `user_balances`, `user_execution_settings`, `subscriptions`, `payments`, `chains`; no `packages/authority`; no `wake-vault` Anchor program; no `user_id` on `trades`/`copy_executions` yet; no Stripe, wagmi, or email provider dependency; the frontend is unrebuilt (`/workspace` still unauthenticated, `NEXT_PUBLIC_API_KEY` still shipped — both S6).

**The groundwork that keeps Stage 4 cheap:** Standing Rule 2 is honoured across the risk surface. `account: string` is threaded through `resolveRiskPolicy`, `circuit-breaker` (`breaker:${account}:${chain}`), `stop-loss`, and `copy-eligibility`. Every caller passes the literal `'operator'`, so per-user risk is *mostly* a value-substitution exercise rather than a signature rewrite.

**Three exceptions, verified in source 2026-08-07 — do not assume the substitution is uniform:**
- **`runStopLossSweep` needs a signature change, not a substituted value.** It resolves **one** account before the loop (`apps/scorer/src/stop-loss.ts:85`) and then claims every position under it. With `signal_stop_losses` keyed `PRIMARY KEY (account, signal_id)` (`034_stop_loss_triggers.sql:18`), under fan-out the **first user to breach claims the signal and every other holder is never sold** — the position stays open past its stop. The account must become per-position, sequenced *after* migration `050`.
- **`RECONCILIATION_ACCOUNT` must stay `'operator'`.** It is an escalation label, not a tenancy key — the C1 code carries a comment saying exactly that, because `copy_executions.target_account` holds a wallet address and filtering it by an account value claims zero rows. Mechanically substituting a user id here fragments one alert stream into N while scoping nothing. `S4-P2` therefore introduced a **separate** `RISK_POLICY_ACCOUNT` constant in the executor: that one *does* become the user id, and keeping the two literals apart is what stops a later find-and-replace from breaking reconciliation.
- **The risk policy was not reaching live sizing at all** — see `S4-P2`. Substituting a user id into `resolveRiskPolicy` would have had no effect on a live trade before that fix, because the call sat inside a paper-only branch.

---

## 2. Blockers and corrections — do these first

Four of these are defects **in the planning documents**, found by reading them against the code. Building on them as written would put a wrong tenancy key into a table that later holds real money.

- [x] **S0-B1 — `LIVE_ENABLED_CHAINS` is not empty.** *(Closed 2026-08-04.)* `.env:66` read `LIVE_ENABLED_CHAINS=solana,robinhood-chain`, contradicting both `audit-history.md` and `G2-R13`. Nothing was live — `TRADING_MODE=paper`, `AUTO_EXECUTE=false`, and `chain_certifications` had **0 rows** (verified) — but one of two independent controls was off, and `G2-R13` forbids `robinhood-chain` appearing here before its certification doc is reviewed.
  **Fixed:** set to empty with a comment stating both gates required to re-add a chain.

- [x] **S0-B2 — build artifacts tracked again.** *(Closed 2026-08-04.)* 30 `.turbo/cache/*` files, reintroduced by commit `71624e1` after task A3 removed them.
  **Fixed:** `git rm -r --cached .turbo/cache`. `git ls-files | grep -E '(^|/)(dist/|\.turbo/)'` is now empty; `.gitignore:5-6` already covered both.

- [x] **S0-B3 — `bullmq` / `ioredis` declared but not installed.** *(Closed 2026-08-04.)* Root `devDependencies` listed both; neither was in `node_modules`, so `chaos.integration.test.ts` failed to load.
  **Verified:** the lockfile carries both; `pnpm install --frozen-lockfile` is clean and the suite loads. The working tree had simply never been re-installed after they were added.

- [x] **S0-B4 — stale integration schema produced a misleading failure cascade.** *(Closed 2026-08-04. Root cause differs from the original diagnosis — recorded because the wrong one is easy to re-reach.)*
  **What was seen:** `pnpm test:integration` failed 20/20, loudest error a *cleanup* failure, and an orphaned `trades` row (`copy_execution_id` set, `signal_id`/`source_trade_id` NULL) was blocking migration `030`.
  **What it looked like:** a third instance of the E2 fixture-teardown selector gap.
  **What it actually was:** `swat_integration` was stranded at migration `029`. On a migrated database that orphan shape **cannot exist** — `030` adds both `chk_trades_copy_execution_identity_complete` (rejects the shape on insert) and `fk_trades_copy_execution_identity ... ON DELETE RESTRICT` (a `copy_executions` delete fails loudly rather than orphaning). The teardown logic was never at fault; an extra delete statement for that shape would have been unreachable dead code.
  **Fixed:** `tests/integration/helpers/schema-guard.ts` + `tests/integration/global-setup.ts` assert the schema is current **once, before any test file**, failing with a single actionable message naming the missing objects, the newest migration on disk, and the command to run. It checks for late-migration tables/columns rather than counting applied files, because `migrate.ts` deliberately keeps no applied-migrations table (D16) — the schema is the only record. `trades` was also added to the teardown's leftover-verification count, so a stray trade can never again let cleanup report success.
  **Verified:** suite green 28/28 against a current schema; a deliberately stale scratch database produces exactly one error naming `signal_stop_losses`, `copy_eligibility_rejections`, and `trades.venue_settlement_status`.

- [x] **S1-B5 — `target_account` does not hold a user id.** *(Resolved 2026-08-04 — `docs/adr/0001-tenancy-key.md`.)* `saas-conversion-plan.md` §Phase 3 claimed "`target_account` already exists in 028 and maps to user id." It does not: `apps/trade-executor/src/index.ts:904` fills it from `resolveLiveCopyTargetAccount(chain)` / `resolvePaperCopyTargetAccount(chain)` — a **chain-prefixed wallet address**. Both fan-out uniqueness constraints were therefore keyed on a wallet, not a tenant.
  **Decided:** explicit `user_id UUID` FK is the tenancy key; `target_account` keeps its real meaning (settlement wallet). Reusing the address was rejected for two reasons found while writing the ADR: paper mode has a synthetic per-chain address, so **every paper user on a chain would collide onto one key** and the unique constraint would admit exactly one user's paper execution per source trade — breaking the default path for every free-tier user; and a custodial key rotation (`user_trading_wallets.key_version` exists precisely because rotation is expected) would fork a user's execution history, silently resetting their P&L, exposure cap, and breaker.
  **Consequence:** no signature changes needed — the `account: string` parameter already threaded through the risk surface (Standing Rule 2) becomes the user id at Stage 4. `saas-conversion-plan.md` corrected.

- [x] **S1-B6 — migration numbering in the SaaS plan was stale.** *(Closed 2026-08-05.)* The plan said "new migrations `029+`"; `029`–`038` were already consumed by audit work. Stage 1 took **`039`–`043`**, and §11 now reserves a range per stage so the next collision cannot happen silently.

- [!] **S6-B7 — `/workspace` is completely unauthenticated.** The plan describes "fake hardcoded login in `apps/web/app/page.tsx`". That file is now a 509-line marketing landing page whose `enterWorkspace()` is a bare `router.push('/workspace')` — there is no login at all, fake or otherwise, and no route protection. Anyone who can reach the web tier gets the full operator dashboard.
  **Do:** treat as live exposure wherever the web tier is network-reachable. Gate at the proxy now; `middleware.ts` (S6-2) is the real fix.
  **Done when:** unauthenticated `GET /workspace` does not return the dashboard.

- [!] **S7-B8 — chain-literal blast radius is larger than scoped.** The plan and BUILDER-GUIDE §Stage 7 both estimate "~15 places". Actual count is **20 files** across `packages/shared`, `packages/db`, and `apps/api` — before counting SQL `CHECK` constraints. Re-scope Stage 7 accordingly.

---

## 3. Stage 0 — Close out the engine

*Everything else stands on this. Most of it is done; what remains is listed in full.*

### 3.1 Corrections
- [x] **S0-1** Blockers **S0-B1 … S0-B4** cleared 2026-08-04. Full gate re-verified after: typecheck 13/13, test 13/13, build 11/11, integration 28/28.

### 3.2 Remaining audit items (BUILDER-GUIDE §6 disposition: Stage 0)
- [ ] **S0-2** `G5-R7` — multi-process risk acceptance. Cap boundaries, breaker transitions, restart persistence, chain isolation, kill-switch latency, and gas-floor behaviour exist as unit tests; what is missing is a **process-level** run proving isolation and restart across separate workers.
  **Done when:** two executor processes against one database demonstrate breaker isolation per `(account, chain)` and kill-switch effect within one cache TTL.
- [ ] **S0-3** `G7-A4` — strictness gate. Explicit `any` remains in source and tests.
  **Done when:** `any` is eliminated or individually justified with a comment, and `pnpm typecheck` passes under the stricter setting.
- [ ] **S0-4** `G7-T1` — regression tests for audit/goal data contracts not yet covered by a focused suite.
- [ ] **S0-5** `G7-A1` — numeric golden vectors for every expectancy formula, **including ROI** (currently SQL shape and persistence are tested, the arithmetic is not).
- [ ] **S0-6** Product decision, then implementation: Polymarket `/trades` defaults `takerOnly=true`, so **maker-side fills are invisible to ingestion**. For copy-trading a liquidity-providing wallet this is a real coverage gap, but flipping it changes what the pipeline counts as a source trade.
  **Done when:** the call is recorded in `docs/adr/` and, if flipped, source-trade classification tests cover maker fills.

### 3.3 Infrastructure baseline (D1, D2, D3, D7, D10, D15 — operational track, parallel to code)
- [ ] **S0-7** `D1` — provision the dedicated box (8–16 vCPU / 32–64 GB), Docker Compose deploy.
- [ ] **S0-8** `D2` — staging environment, permanently paper-clamped by three independent locks: empty `LIVE_ENABLED_CHAINS`, zero `chain_certifications` rows, no custody master key present.
- [ ] **S0-9** `D3` — GitHub Actions → SHA-tagged images → auto-deploy staging → **manual** prod promotion. The manual gate is deliberate: services that sign with user keys must not self-deploy on merge.
- [ ] **S0-10** `D7` + `D10` — Caddy (TLS, `api.`/`app.`/`webhook.` routing, size limits, **SSE: proxy buffering off, idle timeout > heartbeat**) behind Cloudflare (WAF, edge rate limits); Postgres/Redis bound to the Docker network only; SSH key-only + fail2ban; SOPS-encrypted env files; trade-executor accepts **no inbound connections**.
- [ ] **S0-11** `D15` — nightly `pg_dump` to encrypted offsite storage, 30-day retention, staging restoring from it nightly so the backup is continuously tested. Honest RPO: 24h.
- [ ] **S0-12** `D16` — migrations as a dedicated deploy step (not service startup); CI replays the full set twice on scratch Postgres **and** once against a staging-data copy.
- [x] **S0-13** `D17`-now — `pg_stat_statements`, BRIN on transaction timestamps, `readPool`/`writePool` split. *(Batch D, 2026-08-02.)*

**Stage 0 exit gate:** blockers cleared; CI green on every merge; staging auto-deploying; backups restoring nightly; risk policy DB-resolved and enforced pre-claim; one coordinator reconciling all ambiguous executions; no artifacts tracked.

---

## 4. Stage 1 — Auth & tenancy *(SaaS Phase 1)*

*May start in parallel with Stage 0 infra once CI is green — it touches no execution code.*

### 4.1 Decide first
- [x] **S1-1** `DG-5` resolved (`docs/adr/0001-tenancy-key.md`) and `DG-6` numbering corrected. Construction spec written: **`docs/plans/stage-1-design.md`** — DDL, session/credential parameters, SIWE/SIWS flow, route contracts, `forUser()` layer, test plan.

### 4.2 Schema — migrations `039`–`043` *(applied 2026-08-04; replayed twice clean on both databases; 43/43)*
- [x] **S1-2** `039_users.sql` — `CITEXT` email (case-insensitive uniqueness is a column property, so no call site can bypass it), argon2id `password_hash` as `TEXT` (encoded hashes change length when parameters are tuned), CHECKs on role/tier/status, partial index on `tier_expires_at`. `tier_expires_at IS NULL` means **lifetime**, not expired.
- [x] **S1-3** `040_user_sessions.sql` — SHA-256 `token_hash` only, never the raw token, so a database dump cannot be replayed as a login. Fast hash is correct here (256-bit CSPRNG token has no low-entropy secret to protect); argon2 is for passwords. `revoked_at` set rather than row deleted, so logout-everywhere leaves a trail.
- [x] **S1-4** `041_user_auth_wallets.sql` — `UNIQUE (chain_kind, address)` **globally, not per user**: one wallet proves one identity, otherwise Stage 4's withdraw-to-linked-wallet-only control has no single answer to whose address it is. `chain_kind` not `chain`, because an EVM signature proves control on every EVM chain at once.
- [x] **S1-5** `042_user_api_keys.sql` — indexed `UNIQUE key_prefix` so verification is one indexed equality plus one constant-time compare; the scan-all-and-compare alternative degrades linearly and is a timing oracle.
- [x] **S1-6** `043_audit_log.sql` — **no FK on `actor_id`, deliberately**: the log must outlive the user it describes, and a failed login for a nonexistent email has no user to reference — precisely the row worth keeping during credential stuffing. `actor_type = 'anonymous'` covers pre-auth events.

  **Verified by direct SQL probe, not assumed** — each design claim exercised in a rolled-back transaction: `Alice@Example.com` then `alice@example.com` rejected by `users_email_key`; `tier='platinum'` and `role='superuser'` rejected; a second user claiming a linked address rejected by `uq_auth_wallet` while the same address under a different `chain_kind` is allowed; `chain_kind='bitcoin'` rejected; deleting a user cascades its sessions to zero; `audit_log` accepts both an anonymous actor and an `actor_id` for a nonexistent user, and rejects `actor_type='robot'`.
- [x] **S1-7** Admin seed. **Split from `039` deliberately:** a migration that seeds a credential would put a password hash in a file that replays on every deploy (D16), and would make the schema undeployable without also choosing an admin password. `packages/db/src/seed-admin.ts` + `pnpm seed:admin` instead. **Never rewrites an existing admin's password**, so re-running after the operator rotates it cannot restore the bootstrap value; refuses a password under 12 chars (the one account that reaches every admin route is the worst place for an exception); tolerates losing a race with a concurrent seed. Existing operator `trades`/`copy_executions` keep `user_id NULL` per ADR-0001 and are never backfilled — attributing historical single-operator activity to an account would corrupt its P&L, expectancy, and exposure caps with trades it never made.
  **Verified:** no-env → no-action · weak password → refused · proper → created · re-run with a *different* password → no-action.

- [x] **S1-16** Cross-tenant CI suite + browser-secret lint. *(Both land before Stage 2's `/v1/me/*` routes exist, not after — that ordering is the point.)*
  `tests/integration/cross-tenant.integration.test.ts` — 8 cases against the **real** auth plugin and routes, mounted on a minimal Fastify app rather than importing `apps/api/src/index.ts` (which opens Redis and BullMQ at module scope; importing it would start a second API against the test database — the same constraint the pipeline suite documents for `signal-engine`). It includes a stand-in `/v1/me/wallets` route so the scoping path is exercised now and inherited by real routes later. Covers: wallet isolation between tenants, no-credential 401, **tenant-less legacy service key refused on a per-user route**, normal user → admin route 403, one tenant's CSRF token paired with another's session 403, logout revoking only the logging-out tenant, cross-tenant wallet link 409, and own-wallet re-link idempotent.
  **Mutation-tested, so the suite is known to have teeth:** deleting the `WHERE user_id = $1` filter from `listAuthWallets` — the classic tenancy bug — turned it red immediately (2 failures). A green isolation suite that cannot fail is worse than none, because it licenses the assumption it never checked.
  `scripts/check-public-secrets.mjs` + `pnpm check:secrets`, wired into CI **before** typecheck so it fails fast. `NEXT_PUBLIC_*` is inlined into the client bundle and shipped to every visitor, so a secret there is *published*, not configured. The existing `NEXT_PUBLIC_API_KEY` is grandfathered with a pointer to S6-3; the script's job is that no **new** one can appear while that work is pending. **Verified both directions:** passes on the tree as-is (197 files, 1 grandfathered), and rejects a planted `NEXT_PUBLIC_STRIPE_SECRET_KEY` with exit 1.

**Exit gate:** ✅ **met 2026-08-05.** signup → login → wallet-link → `/v1/auth/me` end to end; cross-tenant suite green in CI; browser holds no *new* shared secret (the pre-existing one is tracked by S6-3 and blocked from growing).
Full gate: typecheck 13/13 · test 13/13 · build 11/11 · **integration 36/36 across 6 files** · migrations 43/43.

### 4.3 API — `apps/api/src/auth/` *(built 2026-08-05)*
- [x] **S1-8** `POST /v1/auth/signup`, `/login`, `/logout`; `GET /v1/auth/me`. Login returns a byte-identical 401 for unknown-email and wrong-password, backed by the matching argon2 burn in `authenticateUser` so timing agrees with the body.
- [x] **S1-9** `POST /v1/auth/wallet/nonce` and `/verify` — SIWE (EIP-4361 via `viem`) and SIWS (ed25519 via `tweetnacl`/`bs58`). Serves both linking (session present) and wallet-only login (no session). A proven signature for an *unlinked* wallet is **not** an account — creating one there would let anyone with a keypair mint accounts without an email.
  Nonces are consumed with Redis **`GETDEL`**: a `GET`-then-`DEL` pair lets two concurrent requests both observe the same nonce, which is precisely the replay the nonce exists to stop. The nonce is also bound to the address it was issued for, so one minted for wallet A cannot be spent proving control of wallet B.
- [x] **S1-10** Layered auth plugin replacing the global `onRequest` key hook: session cookie → per-user API key (reserved) → legacy `X-Api-Key` as a **tenant-less service principal**. `requireUser` rejects the service principal outright rather than trusting each route to remember.
- [x] **S1-11** `requireTier` / `requireRole`. An expired paid tier degrades to `free`; `tier_expires_at IS NULL` means lifetime and is never read as expired.
- [x] **S1-12** `@fastify/rate-limit` — 300/min globally, plus a scoped 10/15-min bucket on credential routes keyed on **IP + email**, so one attacker cannot lock out a whole NAT and one account cannot be sprayed from a single address. Double-submit CSRF on every state-changing cookie request; `SameSite=Lax` is deliberate (see design doc) and CSRF covers what it does not.
- [x] **S1-13** SSE tickets preserved and hardened — see the regression below.
- [x] **S1-14** Legacy `API_KEY` is now service/admin-only and carries no tenant.

  **Verified against a live server, not just types.** Three defects surfaced that unit tests would not have caught:
  1. **SSE was briefly left unauthenticated.** Moving the hook dropped the ticket check, and `GET /v1/logs/stream` performs *no validation of its own* — the old hook was the only gate. Ticket consumption is now injected into the plugin (`consumeSseTicket`) with a comment recording that the route cannot be trusted to check.
  2. **Auth routes were registered before the hook.** Fastify applies a parent's hooks only to children registered *after* `addHook`, so `request.principal` was never populated for them — an authenticated wallet-link request was silently treated as an anonymous wallet-only login and returned 401. Registration order is now explicit and commented.
  3. **Public paths returned before resolving the session.** `POST /v1/auth/wallet/verify` is public (wallet-only login needs it) but must still see a session when one exists, or linking can never work. The hook now resolves opportunistically on public paths, still enforces CSRF when a session is present, and lets a *stale* cookie through so an expired user can log in again without manually clearing cookies.

  **Live probe results:** health 200 · no-creds 401 · wrong-key 401 · legacy-key 200 · bearer 401 · SSE-no-ticket 401 · signup 201 · me-with-session 200 · me-without 401 · duplicate-signup 409 · wrong-password and unknown-email both `401 {"error":"Invalid credentials"}` · short-password 400 · POST-without-CSRF 403 · POST-with-CSRF 200 · forged-CSRF rejected · logout revokes session · wallet link 200 · **nonce replay 410** · wallet-only login 200 · unlinked-wallet login 401.
- [x] **S1-20** `packages/db/src/auth-wallets.ts` — re-linking a wallet the same user already owns is an idempotent success; claiming one owned by **another** user is a 409, never a silent re-link, because quietly moving a verified wallet between accounts would hand over its role as a Stage 4 withdrawal destination.
- [x] **S1-21** `packages/db/src/audit-log.ts` — `recordAuditEvent` is best-effort and never throws (an audit failure must not turn a successful login into a 500); `recordAuditEventStrict` throws, for custody/withdrawal/tier events where an unlogged action is worse than a failed one.
- [x] **S1-22** `apps/api/src/auth/wallet-signature.test.ts` — 12 cases with real keypairs, including the **cross-domain replay**: a signature harvested by `evil.test` is rejected here even though it is cryptographically valid. Domain/URI binding is the check most often omitted, and signature validity alone never proves the signer meant to authenticate *here*.

### 4.4 Tenancy discipline (D12) — establish before any per-user route exists
- [x] **S1-15** `packages/db/src/tenancy.ts` — `forUser(userId)` is the only constructor for a `UserScope`. Made a **branded nominal type**, not `{userId: string}`: a signature of `(userId: string, …)` accepts `request.body.userId` exactly as happily as the session's id and the mistake is invisible in review, whereas `(scope: UserScope, …)` will not compile against a raw string. The type is the control, not the convention. `crossTenantScope(reason)` is the deliberately verbose, greppable escape hatch for admin and background-job paths.

### 4.5 Credential layer *(built 2026-08-05)*
- [x] **S1-17** `packages/db/src/credentials.ts` — argon2id for passwords, SHA-256 + `timingSafeEqual` for session tokens and API keys. **Two strategies on purpose:** passwords are low-entropy so they need a slow memory-hard hash; tokens are 256-bit CSPRNG output where a slow hash buys nothing and would put ~110 ms on *every authenticated request*.
  **Parameters measured, not assumed:** the first draft specified m=65536/t=3, which costs **450 ms** on this 2-core box. Every login *and every failed login* pays that, making it a self-inflicted DoS lever under exactly the credential stuffing the rate limit exists to blunt. Switched to **m=47104/t=1/p=1 (110 ms)** — a configuration OWASP treats as equivalent in strength. Raising parallelism was not an option: 2 cores.
- [x] **S1-18** `packages/db/src/users.ts` — user and session queries. `authenticateUser` burns an equivalent argon2 verify against a module-scoped dummy hash when the email is unknown, so response *timing* cannot enumerate users; the identical 401 body is otherwise cosmetic. `changePassword` revokes all sessions **in the same transaction** — separable, it fails to evict whoever the user is changing the password because of. `resolveSession` applies both expiry rules inside the `UPDATE … RETURNING` CTE so touching and validating are one atomic step; select-then-update would leave a window where a concurrently revoked session still resolves.
- [x] **S1-19** `packages/db/src/credentials.test.ts` — 14 cases. **Found and fixed a real bug:** `parseApiKeyPrefix` split on `_` and required exactly 3 parts, but the base64url secret alphabet *includes* `_`, so roughly half of all generated keys were rejected as malformed. Now parsed by position with a hex prefix that cannot contain the delimiter; the regression is pinned by a 40-iteration round-trip test.

---

## 5. Stage 2 — Per-user tracking, backfill, feeds *(SaaS Phase 2)*

**Model:** global dedup, per-user subscription. `wallets`, `transactions`, clusters, and scoring stay **global** — one wallet indexed once serves every subscriber (D9).

### 5.1 Schema — migrations `044`–`045` *(applied 2026-08-05; replayed twice clean on both databases; 45/45)*
- [x] **S2-1** `044_user_wallet_subscriptions.sql` — `PRIMARY KEY (user_id, wallet_address)` rather than a surrogate id, because the pair **is** the fact. Reverse index on `wallet_address` so the nightly "does this wallet have subscribers?" sweep is not a sequential scan. `ON DELETE CASCADE` on both sides is safe *here* — a subscription is a preference, not a financial record — and is deliberately not used on `trades`/`copy_executions`.
- [x] **S2-2** `045_user_token_watches.sql` — surrogate PK (lifecycle state outlives identity), `UNIQUE (user_id, chain, token_mint)` so re-requesting a backfill is idempotent rather than burning quota, and a `(user_id, created_at DESC)` index serving the rolling-24h count directly.

### 5.2 Tiers and quotas
- [x] **S2-3** `packages/shared/src/tiers.ts` — capability matrix, **capability only, never price**, so a Stage 5 price change never touches quota logic. `unlimited` is `null`, not `Infinity`: `Infinity` does not survive `JSON.stringify` or a numeric column, and invites `if (!limit)` checks that treat it as `0`. 17 unit tests including the matrix invariants (a higher tier can never have a smaller quota; higher tiers get a *lower* BullMQ priority number, an inversion that would otherwise silently starve paying users behind free ones).
- [x] **S2-4** Quotas enforced in `packages/db`, not in route handlers — a quota checked in a handler is one the next handler forgets. Over-quota returns **402, not 403**: 403 means "never", 402 means "upgrade and you may", and the frontend needs that distinction to show an upgrade prompt rather than an error.
- [x] **S2-5** `pauseUnsubscribedWallets` (D9) — pauses zero-subscriber wallets with no platform interest, so growth cannot multiply webhook volume indefinitely. Never pauses a wallet holding an open position (its P&L is still being marked to market) or one in a cluster (dropping it would corrupt cluster membership).
- [x] **S2-6** Tier-based BullMQ backfill priority wired into `POST /v1/me/wallets`.

  **The pause conflict, found by reading the sweep against tenancy.** `pauseUnderperformingWallets` was written for a single operator: it paused any wallet scoring below 40. Under tenancy that silently stops data for a wallet a user *explicitly chose and may be paying to track*, with no event and no way to diagnose it. Resolved by making `wallets.status` answer exactly one question — "is the platform indexing this?" — with subscriber count as the dominant input: a subscriber pins a wallet `active` regardless of score. Underperformance is *surfaced* (score and tier are already on the row), never acted on for the user. Per-user status was rejected: it multiplies rows by user count for a genuinely global fact and would make the indexer's poll query per-user.

### 5.3 Routes — `/v1/me/*` *(built 2026-08-05)*
- [x] **S2-7** … **S2-10** `apps/api/src/routes/me.ts` — wallets CRUD, history/holdings, token backfill, signals, feed. Backfill is enqueued **only when the call created the global wallet**; enqueuing on every subscribe would re-backfill each time another user tracks it, which is the exact cost the dedup model exists to avoid. Not-subscribed on history/holdings returns **404, not 403** — whether another user tracks a wallet is not this user's business, and 403 would confirm the wallet exists.
- [x] **S2-11** Global routes are admin-only via `registerAdminOnlyGlobals`. Implemented as an **allowlist** (`/v1/auth/*`, `/v1/me/*`, `/v1/health`), not a blocklist, so a global route added later is admin-gated *by default* — a blocklist would leave every new operator route open until someone remembered it.
- [x] **S2-12** *(deferred to Stage 6)* SSE `/v1/me/stream` — the polling it replaces lives in the frontend, which Stage 6 rebuilds. Noted so it is not lost.

  **Verified against a live server:** free-tier quota blocks at exactly 3/3 with `402 QUOTA 3/3` · second subscriber to the same wallet returns `backfillQueued=false` (dedup proven) · isolation holds (alice 3, bob 1) · unsubscribe leaves the other subscriber *and* the global wallet intact · free tier `delayedSeconds=900` · token backfill 402s at 1/day and a re-request of the same token returns 200 without burning quota · free-tier polygon → 402 `chain-not-in-tier` · legacy service key → 401 on `/v1/me/*` · normal user → **403 on all six global routes** while the service key still gets 200 (internal calls unbroken).

  **A real TOCTOU bug the tests caught.** The first implementation counted inside `withTransaction` and my own comment claimed that made the quota safe. It did not: `withTransaction` runs at **READ COMMITTED**, so N concurrent `COUNT(*)` reads all observe the pre-commit state — five concurrent subscribes against the 3-wallet free tier granted **all five**. Fixed with `SELECT id FROM users WHERE id = $1 FOR UPDATE` before the count, serialising one user's quota writes without contending with any other user. Chosen over `SERIALIZABLE` (needs a retry loop) and an advisory lock (the row exists; the transaction releases it). Both quota paths now hold the lock. The design doc's incorrect claim was corrected rather than left to mislead.

  **A pre-existing bug found while probing:** the API error handler discarded `err.statusCode`, so Fastify's own 4xx client errors (malformed JSON, empty body, payload too large) were reported as **500**. That hides real 500s in the logs and tells clients to retry something that cannot work. Now mapped through.

**Exit gate:** ✅ **met 2026-08-05.** Two users track different wallets and see disjoint feeds; quotas enforced under concurrency; cross-tenant tests green; global routes admin-only.
Gate numbers for this stage live in §1 only. They were duplicated here and drifted; §1 is the single current baseline and a stage section is not a place to read one from.

### 5.4 Attribution — parallel, non-blocking
- [ ] **S2-13** `G6-A6` — Polymarket redemption detection and reconciliation. *(Resolution and winning-token backfill already exist; redemption does not.)*
- [ ] **S2-14** `G6-A7` — golden test asserting the Polygon-specific resolution-aware scoring weight end to end.
- [ ] **S2-15** `G6-A9` — make an immutable `expectancy_reports` record a database-enforced prerequisite for a threshold change, replacing today's free-text script.
- [ ] **S2-16** `G6-A10` — expose per-chain evidence for each score in API and dashboard.
- [ ] **S2-17** `G7-A5` — one cross-chain fixture suite proving every signal carries its chain-native context.
- [ ] **S2-18** `G7-A6` — assert active-dimension coverage (all chains, patterns, tiers, modes) in the nightly reports.

**Exit gate:** two users track different wallets and see disjoint feeds; quotas enforced; cross-tenant attack tests green; SSE feed live.

---

## 6. Stage 3 — Venue executors & certification *(audit Phases 2–3)*

> **⚠ PARTIAL — codeable half in progress. Full gate GREEN as of 2026-08-05.**
> Venue certification items (`(ext)`) are tracked in `docs/testing-aspects.md` and
> cannot be closed by code. See §6.0 for what is built and what remains.

### 6.0 State — verified 2026-08-05

**Full gate:** see §1. It is the single current baseline. This section deliberately
carries no gate table of its own — the duplicate that used to sit here drifted out
of step with §1 (it still read 44/44 across 7 files while §1 read 50/50 across 8),
and a stage section is not a place to read a gate number from.

**Built and verified:**
- `packages/shared/src/jito.ts` — Jito block-engine client: `submitJitoBundle`,
  `getJitoBundleStatus`, `getJitoTipFloor`, `selectJitoTip`, `selectTipAccount`
  (`S3-2`, `S3-3`). 9 tests.
- `packages/shared/src/jupiter-swap.ts` — `buildJupiterSwap`, the `/swap`
  transaction-build step (`S3-1`).
- `packages/shared/src/polymarket-clob-auth.ts` — CLOB **V2** L1 typed-data +
  L2 HMAC signing (`S3-20`). 14 tests.
- `apps/trade-executor/src/jupiter-jito-runtime.ts` (`S3-2`–`S3-5`) — the full
  submit/reconcile/sweep state machine, deliberately mirroring
  `trojan-runtime.ts` so the executor's existing sweeper semantics carry over and
  only the transport differs. Dependency-injected throughout; the signer is a
  **parameter** (Standing Rule 2), so Stage 4 swaps the operator wallet for a
  per-user custodial key with no call-site change. 19 tests.
- `packages/shared/src/constants.ts` — `QUEUES.trades` / `QUEUES.alerts` **added**,
  plus `TRADE_QUEUES_BY_CHAIN` and `tradeQueueForChain()` (`S3-25`). 5 tests.
  **Correction:** an earlier draft called these "centralised". They are not — the
  constants exist but **no call site references them yet**. All seven original
  inline literals remain (4 for `swat-trades`, 3 for `swat-alerts`; the draft also
  said four for alerts, which was wrong). Adopting the constants at each producer
  and consumer is part of the `S3-25` cutover, and `CLAUDE.md` requires it so the
  names cannot drift between the two ends of a queue.

**`S3-25` switch is intentionally OFF.** `tradeQueueForChain()` returns the shared
`swat-trades` for every chain. The cutover touches the money path in four services
at once (`api`, `scorer`, `signal-engine`, `trade-executor`), and a half-migrated
producer/consumer pair would send trade jobs into a queue nobody reads. Producers
and consumers adopt the helper first; flipping the flag then becomes a one-line
change. Expand-and-contract, Standing Rule 4.

**Mutation-tested, so the runtime's tests are known to have teeth.** Two
money-safety properties were deliberately broken and both turned the suite red:
removing the resolved-order guard — which would let a redelivered queue job
double-spend a position — failed 1 test; treating an unobservable bundle as
`failed` — which would let the executor re-enter a position that is actually live
— failed 2. A green suite that cannot fail is worse than none.

**Verified against live Polymarket docs via MCP, not written from memory:**
- L2 signing is `timestamp + METHOD + path + body`, HMAC-SHA256 keyed by the
  **base64-decoded** secret, output as URL-safe base64 **with padding retained**.
  Node's built-in `'base64url'` strips padding and would be rejected; the
  transform is explicit and pinned by a test asserting the trailing `=`.
- **`G3-P6`'s "venue-limited" closure re-confirmed.** The `coid` (client order ID)
  endpoints live at `/v1/trade/*`, the **Perps** gateway. The predictions CLOB
  (`clob.polymarket.com/orders`) still has no client-order-ID field, so idempotency
  stays on our persisted signal/execution identity. The earlier closure was correct
  and is not stale.
- CLOB V2 went live 2026-04-28; V1 SDKs and V1-signed orders are rejected on
  production. Anything written from pre-cutover memory would fail.

**Not yet built:** `S3-6` (Trojan retirement) and `S3-10` — both gated on
certification, not on code. Everything else in the codeable half has landed:
the `S3-18` neg-risk matrix is in, `S3-12`'s matrix turned out to have already
existed, and the Solana dispatch cutover is wired behind
`SOLANA_EXECUTION_PATH`.

**Next steps, each its own tested change:**
1. `S3-25` queue cutover — migrate producers and consumers together, then flip
   the flag. The mechanism and its tests exist; the switch is off, and the
   `QUEUES.trades` / `QUEUES.alerts` constants still have **zero** call sites
   (see the correction under `S3-25`).
2. Stage 4 (custody + per-user execution). Its design doc is the gate.
3. The two certification items above, which need a human reviewer and funded
   wallets — no code will close them.


*Pull-based. Certify a venue only when live money is wanted there. **Paper mode ships everywhere without any of this.*** Sequencing is `DG-4`, open.

### 6.1 Solana — retarget to Jupiter + Jito (`DG-1` resolved 2026-07-27)
- [x] **S3-1** Jupiter `/swap` transaction-build step — `packages/shared/src/jupiter-swap.ts`. The signer is a **parameter** (`signTransaction`), not a module-level key, so Stage 4 substitutes a per-user custodial signer with no call-site change. `apps/trade-executor/src/solana-signer.ts` is the operator implementation; the private key is loaded once into a closure and never returned, logged, or placed on a reachable object.
- [x] **S3-2** Jito `sendBundle` with an appended tip — `packages/shared/src/jito.ts`. Never broadcasts over public RPC.
- [x] **S3-3** Dynamic tip sizing from the block engine's tip-floor percentiles, capped by `JITO_MAX_TIP_LAMPORTS`. The cap is enforced, not advisory: without it a congestion spike or a malformed floor response spends unbounded SOL per trade. A zero/absent floor reads as *no data* and falls back, never as "free" — a zero tip never lands, which would look identical to a dead executor.
- [x] **S3-4** Confirmation and reconciliation — `jupiter-jito-runtime.ts` `reconcile`/`sweep`, wired into the **existing** guarded `reconcilePending` loop (no second timer, per C1). A miss is declared **only** once the block height passes `lastValidBlockHeight`, which is the only point the transaction provably cannot land — and is why a retry needs a fresh quote and build rather than a blind resubmit. An unobservable bundle resolves to `null`, deliberately distinct from `failed`.
- [x] **S3-5** Fallback policy — a Jito failure is reported honestly (`submission_unknown` when retryable, `rejected` when definitive) and never downgraded to a public RPC broadcast.
- [ ] **S3-6** Retire Trojan: delete `TROJAN_WEBHOOK_URL` / `TROJAN_API_KEY` and the client path once the new path is certified; `TROJAN_WALLET_ADDRESS` balance reads become the parameterized operator signing wallet. `H4` is superseded with the path. **Blocked on `S3-9` certification** — both paths run side by side until then, and `clampExecutionModeForStartup` accepts either being ready.
  **Pulled forward by ADR-0005 §7.1 (2026-08-19), ordering unchanged.** The operator has decided Solana executes via Jupiter+Jito. Under single-master mirroring the user is waiting on a specific trade, and that trade is currently placed by a third-party Telegram bot on a 60-second timeout (`MAX_TROJAN_TIMEOUT_MS`, `trojan.ts:2`) with no control over route, slippage, tip, or priority fee — so this stops being cleanup and becomes product work. **The sequence is still certify → flip → delete, and must not be compressed:** flipping `SOLANA_EXECUTOR` before `S3-9` would put an uncertified path on the money path, which inverts the audit's own ordering. Raising the priority of this item does not license skipping its gate.
- [ ] **S3-7** `F-SOL2` / `F-SOL3` (retargeted) — **dispatch adapter built and now WIRED, behind a flag.** `apps/trade-executor/src/solana-dispatch.ts` (15 tests) owns the two things the runtime does not: turning a trade intent into a Jupiter quote, and flattening the submission union into the shape `persistTrade` expects.
  **A BUY is `ExactIn` on SOL; a SELL is `ExactIn` on the token** — the proportional exit gives an exact base-unit quantity to dispose of, not a target SOL amount, and `ExactOut` would name a SOL figure we do not have while letting the venue take more tokens than the position holds. A sell quantity beyond `Number.MAX_SAFE_INTEGER` is rejected rather than rounded.
  **A bundle id is not a transaction signature.** It exists only once the bundle lands, so `trades.signature` stays null at submit and the reconciliation sweep fills it in; persisting the bundle id there would put a value in the column that no explorer can resolve.
  **Cutover is flag-gated, not unconditional** — `apps/trade-executor/src/solana-executor-selection.ts` (9 tests). Jupiter+Jito is unit-tested but **uncertified**, and `S3-9` requires the canary to run *before* the path carries real trades. So `handleJob` routes to it only when `SOLANA_EXECUTOR=jupiter-jito` **and** a signer plus block engine are configured; neither control implies the other. Default stays Trojan. A typo in `SOLANA_EXECUTOR` throws at startup rather than falling back, because a misrouted execution variable must not fail silently. `trades.executor` is `varchar(20)` with no CHECK constraint, so the new `'jupiter-jito'` value needed no migration — verified against the live schema.
  **Mutation-verified:** flipping the default to the uncertified path fails 2 tests; dropping the readiness requirement fails 1.
  **Remaining:** the fixture matrix (entry, partial exit, full exit, failure, duplicate webhook, timeout-after-submit), then `S3-9`'s canary — after which the flag becomes the default and `S3-6` retires Trojan.
- [ ] **S3-8** `G1-S1` — measure webhook→signal→alert→execution over a real review window; hold Solana median signal-to-alert under 60s.
- [ ] **S3-9 (ext)** Capped live canary recorded under `docs/certification/solana.md`.

  **Wired 2026-08-05:** `jupiter-jito-config.ts` provides `createJupiterJitoRuntimeFromEnvironment` + `getJupiterJitoLiveReadiness`, mirroring the Trojan pattern. Startup configures it alongside Trojan; a configuration error is caught and recorded as a readiness reason rather than thrown, because taking down execution for *every* chain when one chain's optional live path is misconfigured is the wrong failure mode. `JITO_BLOCK_ENGINE_URL` has no default on purpose. All new env vars documented in `.env.example`.

  **A live-money coverage hole found by mutation testing and closed.** Making the Solana readiness gate fail **open** — which would let a live trade proceed with no configured signer — passed **all 252 tests**. The clamp had no direct coverage. `solana-live-clamp.test.ts` (7 cases) now pins it; re-running the identical mutation fails 4 of them. Tests: `jupiter-jito-runtime.test.ts` (19), `jupiter-jito-config.test.ts` (14), `solana-live-clamp.test.ts` (7).


### 6.2 Robinhood Chain
- [ ] **S3-10** `F-RH3` — pin the deployed router ABI/version verified on-chain, with reviewed evidence.
- [x] **S3-11** `F-RH5` — explicit fee-on-transfer coverage on proportional exits. **The implementation was already correct** — `createRobinhoodSafetyAssessment` probes `context.order.token`, and the safety gate sits in the shared submission path so it applies to sells as well as buys. The gap was purely test coverage: every existing case built its context with `direction: 'buy'`, where `tokenOut === order.token`, so no test could distinguish probing the traded token from probing `tokenOut`. Two exit cases added in `robinhood-runtime.test.ts` (11 → 13).
  **Why this matters on an exit specifically:** V3's `exactInputSingle` credits the pool less than it was sent, so a taxed token cannot be sold through the router at all — a position entered in a taxed token is stranded. On a sell the route reverses, so a probe following `tokenIn`/`tokenOut` rather than `order.token` would check the *untaxed base asset*, pass, and strand the position at submission.
  **Mutation-verified:** rewriting the probe to `context.tokenOut` leaves all buy-path tests green and fails exactly the new exit case.
- [x] **S3-12** `F-RH6` — native/token **and** token/token entry-exit matrix. Already complete in `robinhood.test.ts`: the entry/exit block crosses both base-asset modes with both directions (`native-weth` / `erc20` x buy/sell) via `it.each`, and asserts the router is approved **only when an ERC-20 is being spent** — a native-weth buy sends native value and has nothing to approve; every other leg does.
  *Previously left unchecked here because an earlier search looked for a `baseAssetMode` object property; the matrix passes it as an `it.each` tuple, so the search missed it. The coverage predates this session.*
- [ ] **S3-13 (ext)** `G2-R3` — direction-classification accuracy >95% on an operator-reviewed production sample.
- [ ] **S3-14 (ext)** `G2-R4` — ingestion completeness >90% on the certification sample.
- [ ] **S3-15** `G2-R5` — verified-source and reliable holder-concentration evidence for Robinhood assets.
- [ ] **S3-16 (ext)** `G2-R12` — tiny successful buy with receipt-derived amounts, a forced failure with released claim, an orphaned receipt resolved after restart.
- [ ] **S3-17 (ext)** `G2-R13` — write and have reviewed `docs/certification/robinhood-chain.md`; only then add `robinhood-chain` to `LIVE_ENABLED_CHAINS`. **See S0-B1 — it is currently listed there without this.**

### 6.3 Polymarket / Polygon
- [x] **S3-18** `F-PM8` — binary + neg-risk entry-exit matrix and resolution/redemption cases.
  **Matrix built (2026-08-05):** `apps/trade-executor/src/polymarket-negrisk.test.ts`, 16 cases. The suite is shaped around an asymmetry found while writing it: **neg-risk is a no-op axis for us**, while entry-vs-exit is the real one.
  `PrepareMarketOrderRequest` has no field through which a caller could select the exchange — verified against the installed SDK type, whose buy/sell union is `tokenId | side | amount|shares | maxSpend | maxPrice|minPrice | orderType | builderCode` and nothing more. The SDK derives the verifying contract (standard vs neg-risk Exchange) from the token itself; both addresses are pinned and attested once at startup, not per order. So four cases assert the plan output and the signed request are **key-for-key identical** across the flag, with explicit `not.toHaveProperty` on `negRisk`/`neg_risk`/`exchange`/`adapter`/`verifyingContract`. That is a guard against a future edit, not a present defect — and it mirrors the one the redemption suite already carries for the collateral adapter.
  The remaining twelve cover what genuinely differs by direction across both market kinds: balance source (`COLLATERAL` vs `CONDITIONAL` + tokenId), request shape (`amount`/`maxSpend`/`maxPrice` vs `shares`/`minPrice`), requested-amount units (USD off ask depth vs shares off bid depth — same book, same `10`, different results), and the directional price bounds (0.98 refused as an entry but fine as an exit; 0.005 the reverse).
  **Mutation-verified independently, not taken on report:** leaking `negRisk` into the signed BUY request fails 1 case; branching the depth walk on it fails 5.
  **Redemption ledger built (2026-08-05).** A genuine gap, not a test gap: `assertPolymarketMarketTradable` correctly *refuses to trade* a resolving market, but nothing ever claimed the proceeds — so a winning position stayed open in the ledger forever and its collateral was stranded. Confirmed against the live docs: `redeemPositions({conditionId})` converts each winning outcome token to 1 pUSD and each losing token to 0, with no deadline and no amount parameter.
  `packages/db/sql/046_polymarket_redemptions.sql` + `packages/db/src/polymarket-redemptions.ts` provide the claim/confirm ledger. The split matters because `redeemPositions()` redeems the wallet's *whole* balance for both outcomes, so a second call after a successful first is an on-chain no-op that still burns gas and still returns a transaction hash a reconciler would read as a fresh fill.
  **The first version of the exactly-once guard was INERT, and a direct SQL probe caught it.** The partial unique index was on `(user_id, condition_id)`, but `user_id` is NULL for all of Stage 3 and **NULL never conflicts with NULL** — two concurrent sweeps both claimed the same market (`INSERT 0 1` twice). Fixed with `NULLS NOT DISTINCT` (Postgres 15+; CI and prod both run 16) plus an explicit `ON CONFLICT` target, since a bare `DO NOTHING` does not engage a partial index. Now `INSERT 0 1` then `INSERT 0 0`, exactly one live row.
  `tests/integration/polymarket-redemption.integration.test.ts` (6 cases) pins it. **Mutation-verified:** reverting the index to its original `NULLS DISTINCT` form fails 3 of the 6.
  **Sweep built and wired (2026-08-05).** `apps/trade-executor/src/polymarket-redemption.ts` + 9 unit tests, running inside the **existing** guarded `reconcilePending` loop — no second timer — and gated on the live client existing, since redemption is a real on-chain claim with nothing to do in paper mode. Stale claims are released *before* the scan so a market wedged by a crashed sweep becomes eligible in the same pass rather than the next one. A venue error (a missing collateral-adapter approval surfaces here) releases the claim rather than wedging the market, and one bad market never abandons the sweep.
  **Docs-verified, not written from memory** (`trading/positions/manage`): `redeemPositions({conditionId})` takes **no amount** and redeems both outcomes; `wait()` yields `{transactionHash, transactionId}`; there is **no redemption deadline**, which is what makes a retry after failure safe. The client selects the collateral adapter (`CtfCollateralAdapter` vs `NegRiskCtfCollateralAdapter`) from the condition id, so this code deliberately does **not** branch on `negRisk` — duplicating that choice would silently diverge if Polymarket changed the mapping. A test asserts no `negRisk`/`adapter` key is ever sent.
  **`redeemedCollateral` is recorded as `0`, not a guess.** The venue returns no per-redemption payout figure; deriving one from the pre-redemption balance would be invention, and attribution reads the on-chain transfer instead.
  **Mutation-verified:** redeeming despite a lost claim (double-redeem) and confirming without a transaction hash (unverifiable money) each fail exactly one test.
  **Remaining:** the binary/neg-risk entry-exit matrix.
- [x] **S3-19** `G3-P10` — rounding parity with venue precision constraints. `apps/trade-executor/src/polymarket-precision.test.ts` (16 cases) pins our behaviour against the published table in `trading/place-orders`, tick by tick.
  **Size decimals are 2 at every tick size**, which is why the single `POLYMARKET_SHARE_DECIMALS` constant is correct rather than a lookup table. Shares round **down**: rounding up would sell shares the position does not hold, or buy more than the sized notional pays for. An order pushed under `min_order_size` *by that rounding* is refused rather than submitted to a guaranteed rejection.
  **The price-decimals column is deliberately not implemented.** The book walk instead rejects any price off the current tick grid, which is strictly stronger — an off-grid price with a legal-looking decimal count (`0.0026` under a `0.0025` tick) is still refused, where a decimals-only check would wave it through and the CLOB would reject at submission. That equivalence is not assumed: a test enumerates **every** on-grid price for all six tick sizes and asserts none exceeds the documented decimals, so if a future tick size broke the implication the superset argument fails loudly.
  **Mutation-verified:** disabling the tick-grid check fails all six off-grid cases.
- [ ] **S3-20** Derive CLOB L2 credentials **as a function of an EVM signer**, so the same code serves per-user keys at Stage 4.
- [ ] **S3-21 (ext)** `G3-P3` — authenticated production round trip, no secrets logged.
- [ ] **S3-22 (ext)** `G3-P5` — operator account, jurisdiction, venue terms, and wallet funding eligibility confirmed.
- [ ] **S3-23 (ext)** `G3-P11` — a tiny filled BUY, an unfillable order cancelling cleanly, a duplicate rejection.
- [ ] **S3-24 (ext)** `G3-P12` — `docs/certification/polygon-polymarket.md` reviewed and signed off. *(The file exists and is correctly marked **NOT CERTIFIED** with every box unchecked.)*

### 6.4 Isolation
- [ ] **S3-25** `D6` — split `swat-trades` into `swat-trades-{solana,polygon,robinhood}`, one worker each, concurrency 1. Risk logic is already chain-keyed, so this is parallelism at zero logic cost and it satisfies `F-ACC2` isolation.
- [ ] **S3-26 (ext)** `F-ACC1` / `F-ACC2` — simultaneous three-chain production-worker replay; prove one venue's RPC outage neither stalls nor corrupts the others.
- [ ] **S3-27 (ext)** `F-ACC3` — verify production prerequisites: Postgres, Redis, Helius / Robinhood / Polymarket credentials, funded wallets.

**Exit gate, per venue:** `docs/certification/<chain>.md` reviewed, canary evidence recorded, reconciliation-after-restart demonstrated — *then and only then* the chain enters `LIVE_ENABLED_CHAINS`.

---

## 7. Stage 4 — Custody & per-user execution *(SaaS Phase 3)*

**Highest-risk stage. User funds live here.** Hard prerequisites: Stage 0 complete, Stage 2 complete, `DG-1` resolved (done), and the legal gate below.

### 7.0 Stage 4 prerequisites — land these before any fan-out code

*Fan-out multiplies each of these by the user count, and two of them corrupt data rather than failing loudly. `S4-P1`…`S4-P3` are defects that exist **today** with one operator; the rest are gaps fan-out opens.*

- [x] **S4-P1** **Per-chain slippage resolver.** *(Built 2026-08-07.)* `packages/shared/src/slippage.ts` + 10 tests. `resolveSlippageBps(chain, userValue)` with `DEFAULT_SLIPPAGE_BPS` preserving the constants it replaces (Solana 1500, Robinhood/Polygon 300), a `MAX_SLIPPAGE_BPS` platform ceiling of 5000, and a floor of 1 because zero makes every order unfillable.
  **The chain default is a default, never a floor** — a user asking for 50 bps on Solana gets 50, not 1500. Treating the constant as a minimum would quietly widen every cautious user's risk to the platform's own appetite. **Mutation-verified:** rewriting the clamp to use the chain default as the lower bound fails 3 tests. A fractional bps throws rather than rounding, since that is a caller bug and the venues take integers.
  **Threaded through the executor 2026-08-07.** All 13 live venue call sites now take a `slippageBps` resolved **once per job**, replacing the literals (9 × `1500` on Solana, 4 × `300` on Robinhood). It resolves with `null` — no user preference — which returns the chain default and is byte-identical to the constants it replaces, so this is a refactor with zero behaviour change. The 150-bps Jupiter *paper quote* is deliberately untouched: it prices a simulation, not an order.
  **A coverage hole found and closed while verifying this.** Changing the Solana default from 1500 to 777 left **all 332 executor tests green** — nothing in the suite asserted a slippage value anywhere, so the threading could have been wired to the wrong place undetected. `execution-lifecycle.test.ts` now pins `slippageBps: 1500` on the Trojan call; the same mutation fails it. This matters for migration `049`: without the pin, wiring the user's value incorrectly would be invisible.
  Four test files mock `@swat/shared`; three spread `...actual` and were already correct. `shadow.test.ts` was converted from a sync factory to `importActual` so it uses the **real** resolver — a hand-written stub of the chain defaults would silently drift from them.
  *Remaining for `S4-P4`: migration `049`'s `max_slippage_bps` column and the `/v1/me/*` surface to set it. The single `resolveSlippageBps(chain, null)` call site becomes `resolveSlippageBps(chain, userValue)`.*

- [x] **S4-P2** **Sizing resolves the DB risk policy in every mode, and fails closed.** *(Fixed 2026-08-07.)* Two live defects in `getBalanceAwarePositionSize`:
  (a) the policy override sat inside `if (sizingMode === 'paper')`, so **live sizing ignored the DB policy entirely** and used the env constant. Invisible with one operator whose env and DB agree; under fan-out the per-user percentage exists *only* in the database, so live sizing would size every user off one env value.
  (b) resolution failure was a `console.warn` and a fall back to env defaults — silently substituting a risk percentage the account never agreed to, on a real trade. Now fatal: throwing costs one skipped signal, defaulting costs a wrong-sized position.
  Also replaced the `(config as any).riskPct = …` mutation with a `{...envConfig, riskPct}` spread, removing the `any` cast (`S0-3`).
  **The suite did not notice any of this.** All 326 tests stayed green through the behaviour change, because `getBalanceAwarePositionSize` had **no direct coverage** — `policy.test.ts` exercises the pure math helper beneath it, not the policy resolution above it. `sizing-risk-policy.test.ts` (6 cases) now pins it; **mutation-verified** by restoring the original defect, which fails 3 of the 6.
  Introduced `RISK_POLICY_ACCOUNT` as a **separate constant from `RECONCILIATION_ACCOUNT`** even though both are `'operator'` today: this one *becomes the user id* at Stage 4, while `RECONCILIATION_ACCOUNT` must **stay** `'operator'` because `copy_executions.target_account` holds a wallet address. Collapsing them into one shared constant is exactly how that distinction gets lost.

- [x] **S4-P3** **Bounded `resolveRiskPolicy` cache.** *(Fixed 2026-08-07.)* It was a module-level `Map` keyed `${account}:${chain}`, TTL-checked on read but **never swept** — so an entry for a user who never returned lived for the life of the process. With one operator that is three entries and invisible; under fan-out the key carries a user id, so it grew one entry per active user per chain and retained every user who had ever traded. Unbounded growth keyed by user id, inside the process that also holds the custody master key.
  Now sweeps expired entries on write and enforces `RISK_POLICY_CACHE_MAX_ENTRIES` (5000) with oldest-first eviction. **Swept on write, not on a timer** — a timer keeps the process alive and fires when nothing is being cached, whereas growth only ever happens on write. The cap is a backstop rather than the primary mechanism: a fan-out burst can outrun TTL expiry entirely, so expiry alone is not a bound.
  `risk-policy-cache.test.ts` (6 cases). **Mutation-verified:** removing the sweep fails 2 — the expired-entry case and the cap case. The 7 pre-existing `risk-policy.test.ts` cases still pass unchanged.

- [ ] **S4-1 (ext)** **`DG-2` / `D13` — legal gate, non-negotiable.** Counsel opinion on custodial funds and autonomous trading in the operating jurisdiction; ToS and risk disclosures; Cloudflare geo-blocks live; stricter per-user Polymarket geo-gate inheriting venue restrictions. **Custody does not launch without this. No code workaround exists.**
  **Scope grew with the `DG-7` decision (2026-08-07).** The risk disclosures are now a *load-bearing control*, not boilerplate: `DG-7` resolves to "serve every eligible user and disclose the consequence" instead of capping, so the text stating that later fills land at worse prices, that this is inherent to copy trading, and that the strategy is high-risk is the thing standing in for a platform limit. It must also frame the routing claim as *fastest available route* (the Jito bundle path), never as a price or latency guarantee. Counsel should review that wording specifically.

- [ ] **S4-P4** **Per-user `max_slippage_bps` — hard prerequisite of the `DG-7` decision.** *(Found 2026-08-07 verifying §7.5 of the design doc; verified in source.)* Mechanism 3 of the `DG-7` resolution relies on each user's own slippage tolerance rejecting a bad fill, so that the platform never has to choose who misses a trade. **That mechanism does not exist.** Slippage is a **hard-coded per-chain constant** — `1500` bps (15%) on the Solana paths, `300` bps (3%) on the Robinhood paths, `150` on the Jupiter route (`apps/trade-executor/src/index.ts`) — absent from `packages/db/src/risk-policy.ts` and, at the time of the finding, absent from every Stage 4 settings table in `docs/plans/stage-4-design.md` §5.
  Two consequences: **nothing bounds the fan-out tail today** (15% on Solana is wide enough that a badly degraded late fill still executes), and **a per-chain constant cannot express user intent** — two users with different appetites get the same ceiling, so "their own stated limit" is not something the system can honour.
  **Per-chain, not global** *(operator decision, 2026-08-07)*. Users set their tolerance **per chain**, so it belongs on `user_chain_execution_settings` — already keyed `(user_id, chain)` in `docs/plans/stage-4-design.md` §5 — and **not** on the user-global `user_execution_settings`. Tolerable slippage is a property of the venue rather than the person: 3% is loose on a Polymarket CLOB book and tight on a thin Solana memecoin, so one global value would force a user to accept the loosest chain's risk everywhere. `NULL` means "use the chain default" and is deliberately distinct from a user-chosen value, so a default can be raised later for users who never set one without silently overwriting anyone who did.
  **Done when:** `max_slippage_bps INTEGER NULL` exists on `user_chain_execution_settings`, is threaded to every venue call site listed above, and the per-chain constant acts as the **default for a user who has not set one — never as a floor overriding a tighter user value**; the `/v1/me/*` surface lets a user read and set it per chain; and a test asserts a user with a tight tolerance is *not executed* on a fill that a user with a loose tolerance accepts. **Until this lands, fan-out has no per-user downside bound and `DG-7` is not safe to ship.**

- [x] ~~**S4-P5** Enforce the ADR-0002 custody migration trigger in code.~~ **RETIRED 2026-08-09** by `docs/adr/0003-delegated-execution-authority.md`. The trigger existed to time-limit the exposure of custodied user keys. There are none, so it has nothing to measure. **Returns only under ADR-0003 §6 fork (b)**, scoped to Polymarket balances.

- [x] ~~**S4-P6** Bounded, swept cache of unwrapped data keys.~~ **RETIRED 2026-08-09** by ADR-0003 — no per-user data keys to unwrap. The underlying fan-out concern does not vanish, it **changes venue**: it reappears as bundler/paymaster throughput and per-user 4337 nonce management (`S4-P8`). The `S4-P3` lesson still binds any cache that replaces it.

- [ ] **S4-P7** **`UserExecutionAuthority` port with per-chain adapters.** *(Created 2026-08-09 with ADR-0003.)* Three delegation mechanisms with nothing in common at the key level — a 4337/7702 session key, a Solana program delegate, and whatever Polymarket resolves to — must not leak into `handleJob`. `solana-signer.ts` already proves the seam works: it is injected as `signTransaction`/`buildTipTransaction`, so the runtime never learns where authority comes from.
  **Done when:** one interface covers "authorize this venue action for this user", each chain has an adapter behind it, `handleJob` names no chain-specific authority type, and the existing **operator** path is one adapter among them rather than a special case. A test substitutes a stub authority and asserts the executor is unchanged.

- [ ] **S4-P8** **Paymaster spend cap and per-user rate limit.** *(Created 2026-08-09 with ADR-0003 §8.)* Sponsoring gas turns every copied trade into an operating cost we pay and an attacker can spend. A user who subscribes to a hyperactive wallet drains the Gas Manager policy; nothing today bounds it. Unbounded third-party spend triggered by untrusted activity is the same defect class as unbounded memory keyed by user id (`S4-P3`).
  **Done when:** a per-user daily sponsored-operation cap and a global policy ceiling are enforced **before** submitting a UserOperation, exhaustion degrades to skip-with-reason rather than failing the job silently, and a test asserts the cap blocks the N+1st operation.

- [ ] **S4-P9** **Session-key expiry monitoring and re-consent.** *(Created 2026-08-09 with ADR-0003 §8.)* Scoped grants expire — that is the point. But an expired grant makes a user *silently stop copying*: no error at grant time, and the failure surfaces at trade time as a rejected UserOperation, by which time the trade is missed. Expiry is now a liveness dependency, which custody never was.
  **Done when:** grant expiry is stored and indexed, a job warns users ahead of lapse, the dashboard shows remaining validity, and a lapsed grant produces an explicit skip reason distinguishable from "no signal". A test asserts an expired grant is reported as lapsed rather than as a generic execution failure.

### 7.1 `packages/custody` → `packages/authority`

> **Rewritten 2026-08-09 by `docs/adr/0003-delegated-execution-authority.md`.** WAKE no
> longer generates or holds user root keys. It holds **scoped grants**. Secret storage
> survives (a session key still lets an attacker trade as the user); what changes is the
> blast radius — scoped trades until expiry, revocable by the user on-chain, versus all
> funds forever with no remedy. **Build order is Robinhood Chain → Solana → Polymarket**,
> which is the inverse of the old plan; see ADR-0003 §1.

- [ ] **S4-2** ~~Per-user Solana + EVM keypair generation.~~ **Replaced:** per-user *grant*
  issuance. Robinhood Chain: an EIP-7702 delegation or 4337 session key over the user's
  **existing** EOA — no new address, so no deposit step and no onboarding drop-off
  (ADR-0003 §2). Solana: a PDA delegate registration. The user's root key never reaches us.
- [ ] **S4-3** Envelope encryption — **retained, retargeted** (ADR-0003 §5). Now seals
  session keys, delegate keypairs, and CLOB credentials rather than root private keys. Same
  AES-256-GCM per-secret data key; a DB dump alone stays worthless.
- [ ] **S4-4** `KeyWrapper` interface — **retained**. Still the seam that makes env → Vault a
  config change. Lower urgency (ADR-0003 §5 retires the "lose it and funds are gone" row),
  and it is also what fork (b) would need if Polymarket stays custodial.
- [ ] **S4-5** The API may request **grant issuance only, never signing**. Session keys
  decrypt inside trade-executor at signing time, never leave the process, never appear in
  logs or API responses. *(Unchanged in force, narrower in scope.)*
- [ ] **S4-6** `DG-3` — price Turnkey / Privy-class vendors. **Re-scoped:** the question is
  no longer "who custodies keys" but "who issues and stores scoped grants". Robinhood Chain
  docs name Privy and Dynamic for embedded wallets plus AA; Alchemy and ZeroDev for
  bundler/paymaster. Verify **before** design freeze whether the vendor supports the
  argument-level permission policy `S4-P10` requires — not merely "session keys".
- [ ] **S4-P10** **Argument-scoped permission policy, not `(target, selector)`.** *(ADR-0003
  §2.1.)* A session key restricted to "the router, swap selectors only" is still drainable:
  any ERC-20 swap needs `approve(spender, amount)`, so the policy must permit `approve` — and
  an unconstrained `spender` lets the key approve an attacker who then drains the token
  directly, never calling the router. "No transfer, no withdraw" is an **incomplete**
  specification of the scope.
  **Done when:** the policy constrains decoded arguments — `approve` only to allowlisted
  routers with a bounded amount (never `type(uint256).max`), swap recipients pinned to the
  user's own account — with default-deny for anything unlisted. A test asserts a UserOperation
  approving a non-allowlisted spender is **rejected by the account**, not merely unbuilt by us.
- [ ] **S4-P11** **Pin the EntryPoint version.** Robinhood Chain has **three** deployed
  simultaneously — v0.6.0 `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789`, v0.7.0
  `0x0000000071727De22E5E9d8BAf0edAc6f37da032`, v0.8.0 `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108`
  (chain ID **4663**). Paymaster interfaces and gas accounting differ across them, so an
  implicit default is a silent-mismatch bug. Config-pinned and asserted at startup.
- [ ] **S4-P12** **Solana delegation program.** *(ADR-0003 §3 — the long pole.)* No off-the-shelf
  primitive does this: native SPL `approve` bounds *how much*, never *to whom*, so a delegate
  can transfer anywhere; Gum Protocol is unmaintained and unacceptable in the funds path.
  **Evaluate Squads V4 first** — its spending limits carry a destination list — but verify
  whether a member can be constrained to *swap via a program* rather than *transfer to an
  address*; that is a different shape from what multisig spending limits are built for.
  Absent that, this is our own audited Anchor program.
  **Consequence:** Solana becomes the **last** chain to get per-user execution. `S3-1`…`S3-6`
  are complete for the **operator** account only — do not read them as nearly-done for fan-out.
- [ ] **S4-P13** **Polymarket — non-custodial is not achievable here; pick `DG-9`.** *(ADR-0003 §4.)*
  CLOB API credentials **cannot place orders**: placement needs L2 HMAC to authenticate the
  request **and** a per-order EIP-712 `Order` signature, fresh `salt`, from the account signer.
  The **Builder Program** does not close this — builder credentials provision Deposit Wallets and
  grant relayer access, but "**each wallet remains controlled by its signer**", and provisioning
  passes a `signer` private key alongside the builder key. Builder creds are an integration
  identity, not a delegation grant. There is no Polymarket equivalent of a 4337 session key or a
  PDA program delegate. Also: `@polymarket/clob-client-v2` is **deprecated** (current is
  `@polymarket/client` + `viem`, already this repo's dependency), and every account wallet
  deployed on or after **2026-05-04** is a **Deposit Wallet** (`signatureType` 3, ERC-7739),
  making ERC-1967 Proxy (`1`) and Safe (`2`) legacy targets.
- [ ] **S4-P15** **Builder relayer capacity — resolved by agreement, still needs enforcement.** *(ADR-0003 §4.2.4; updated 2026-08-10.)*
  **Polymarket has granted 10,000 executions/day** (the Verified-tier figure) rather than the
  Unverified default of 100, scaling as users grow — confirmed by the operator in direct
  conversation. The lead-time trap in the original item is therefore **closed**: no application
  backlog, no launch-blocking circularity.
  **What remains is enforcement, not negotiation.** 10,000/day is a real ceiling, and relayer
  transactions cover wallet deployment, approvals, order execution and CTF operations — every
  write. At 3 writes per copied trade that is ~3,300 trades/day across all users; a single
  hyperactive tracked wallet fanning out can still exhaust it.
  **ADR-0005 §4.2–4.4 settles the two questions this item left open (2026-08-19).** *Who gets
  skipped when the budget is spent:* **everyone, uniformly.** No tier priority — it is the fairest
  rule and it removes the need to choose winners, which was never an engineering decision to make.
  *What the user is told:* a generic "at capacity, scaling infrastructure", backed by a specific
  internal reason code so ops and telemetry still name the real constraint. Nothing stated is false;
  the venue's quota simply is not itemised to users.
  **One structural consequence that needs its own guard:** a per-master budget allocation *inside*
  the daily cap. Without it a single master doing 400 trades a day copied by 25 users consumes the
  entire platform budget and blanks the venue for users copying **other** masters — so the uniform
  skip, applied naively, lets one master's followers deny service to everyone else's. Tracked as
  `S4-M6` in §7.5.
  **This is a ceiling on user count, not just on trade count** (PRD §7.3), which makes it a growth
  constraint to plan around rather than a bug to fix.
  **Done when:** remaining daily relayer budget is tracked and checked **before** submitting,
  exhaustion degrades to skip-with-reason rather than a burst of failures at the cap, the limit
  is a config value (it scales with growth, so it must not be a literal), and a test asserts the
  N+1st operation is refused. Same defect class as `S4-P8`'s paymaster cap.
- [ ] **S4-P16** **Geo-eligibility for a user who is not present.** *(ADR-0003 §4.2.5 — binds under
  every `DG-9` fork, and is a `DG-2` input.)* Polymarket restricts order placement by geography and
  assigns the duty to us: *"Builders are responsible for verifying user location before submitting
  orders."* The check (`GET https://polymarket.com/api/geoblock`) evaluates the **requesting IP**.
  Under unattended execution there is no user IP — the request comes from our server, so a naive
  integration geo-checks **our datacentre**, always passes, satisfies the endpoint and fails the
  obligation. Nothing in the API asserts a user's location while they are absent.
  **Done when:** eligibility is captured at consent time and stored with a timestamp, re-verified
  on each interactive session, and automated execution **halts** for an account past a staleness
  window; the policy is reviewed under `DG-2` rather than settled in engineering; and a test
  asserts a stale-eligibility account is skipped with a distinct reason, never silently traded.
- [ ] **S4-P17** **Prefer `GTD` over `GTC` for copied orders.** *(ADR-0003 §4.2.6.)* A `GTC` order rests
  until filled or cancelled, so an unattended copy can fill long after the signal that motivated it
  has decayed — the Polymarket analogue of the stale-fill risk `S4-P4`'s slippage bound addresses
  elsewhere. `GTD` bounds the window, but **expires one minute before its stated time** as a
  deliberate security buffer, so expiry arithmetic must subtract it or orders die a minute early.
  **Correction 2026-08-18 (verified against `/trading/wallets-auth.mdx`): expiry is *not* a signed
  field.** The v2 `Order` struct carries exactly eleven members — `salt, maker, signer, tokenId,
  makerAmount, takerAmount, side, signatureType, timestamp, metadata, builder` — with **no
  `expiration`**. So `GTD` is a *request-body* concern enforced by the CLOB, not something bound
  into the signature and not something a signer-side policy (`DG-9` fork (c)) can constrain. The
  consequence is that a compromised order-submission path can convert our `GTD` into a `GTC`
  without invalidating the signature. Our own code is therefore the only place the bound exists,
  which raises rather than lowers this item's importance: assert the order type at construction,
  and treat a resting order older than its intended window as a reconciliation finding.
- [ ] **S4-P18** **Jito tip: live allowlist and P&L accounting.** *(Created 2026-08-11 from the `docs/dg-8/` review; `docs/plans/stage-4-design.md` §7.7.)* Two independent defects on **today's operator path**, both fixable now and neither waiting on the Solana vault.
  **(a) `JITO_TIP_ACCOUNTS` is a hard-coded constant** (`packages/shared/src/jito.ts:34`). Jito rotates these, and a stale entry fails in the worst available way — the block engine ignores the bundle, nothing lands, and the executor still reports submission success. Read the live set from the block engine, cache it, and fall back to the constant so an unreadable endpoint never blocks an otherwise-valid trade.
  **(b) Tips are missing from P&L.** `tipLamports` is computed at `jupiter-jito-runtime.ts:178` and discarded; `persistTrade` already carries a validated, unused `feeUsd` (`packages/db/src/trades.ts:25`). Thread it through `JupiterJitoResolution`, convert at the SOL price already fetched via `fetchTokenPriceUsd(SOL_MINT)`, and record it **only on a landed bundle** — Jito bundles are atomic, so a bundle that never lands costs nothing and must not be charged. Until this lands, reported returns are overstated, worst on small trades where a 0.005 SOL ceiling is a large fraction of the trade.
  **Done when:** the allowlist is resolved dynamically with a tested fallback; `feeUsd` is populated on landed Solana bundles and asserted non-null in a test; and a test asserts an unlanded bundle records **no** fee.
  **DONE 2026-08-19** (commit `30bdef7`). Tip accounts resolve from the block engine's `getTipAccounts` — verified against Jito's own client source (`jito-labs/jito-js-rpc`) rather than assumed, since `docs.jito.wtf` was unfetchable — with a TTL-bounded cache, in-flight dedupe, and the hard-coded array as fallback. `selectTipAccount(seed, accounts)` now **requires** the account set: a default would have silently preserved the exact stale-allowlist failure this item exists to remove for any call site that forgot. Tips reach `feeUsd` only on landed bundles; not-landed records `null` rather than `0`, because `fee_usd = COALESCE(EXCLUDED.fee_usd, trades.fee_usd)` means a `0` would **clobber** a previously recorded real fee where `null` preserves it. Ambiguous outcomes (`confirmation-timeout`, `landed-without-signature`, submit-time `submission_unknown`) record no fee and skip the price fetch entirely — asserted, so a future change cannot quietly fabricate a cost for an unobserved outcome. 44 + 30 tests.
  **Found while doing it:** the prior draft had added the imports for tip accounting and called **none** of them — `submit()` still used the stale array and `reconcile()` never populated `feeUsd`. It typechecked because unused imports are not errors here, so the item looked done and was not.
- [ ] **S4-P19** **Fold the three `wake-vault` review findings into the spec before writing Rust.** *(Created 2026-08-11; `docs/plans/stage-4-design.md` §3.4.)* `docs/dg-8/wake-vault-skeleton.rs` is a scaffold, and a review found three flaws that each independently defeat the program's purpose. Findings 1 and 2 must be settled in **ADR-0004**, not during implementation, because finding 1 changes the instruction signature.
  **1. The account checks don't constrain what Jupiter receives.** `execute_swap` validates the named source/destination accounts, then forwards a *separate* `remaining_accounts` list under the vault's signature. Nothing links them, so a legitimate pair in the named slots passes while an attacker-owned destination in `remaining_accounts` takes the funds. Fix: balance-delta post-conditions (`spent <= max_in`, `received >= min_out`, with `reload()` after the CPI) plus a scan rejecting any *other* vault-owned token account. This also puts slippage on-chain, so a compromised backend can only make a **bounded** bad trade — feed `min_out` from the quote's `otherAmountThreshold`, which is where `S4-P4`'s per-user slippage lands.
  **2. `WakeConfig` is unpinned.** `Account<'info, WakeConfig>` without `seeds` accepts any program-owned account with a matching discriminator, so a forged config can carry `max_tip_lamports: u64::MAX` and an attacker address in `tip_accounts`. Fix: `seeds = [b"config"], bump` everywhere it is taken, plus a fixed-size `[Pubkey; 8]`. **Until this lands, the decisions report's "vandalism, not theft" claim is false** — it is a full drain.
  **3. Executor rotation does not work.** `initialize_vault` copies `config.executor` into `vault.executor_authority` and `execute_swap` checks the copy, so rotating the config leaves every existing vault on the old key. Exactly the defect correctly diagnosed for the tip allowlist and missed for the executor. Fix: delete the field, check `config.executor` live. `revoked` stays per-vault.
  Smaller: `restore_executor` needs its own context requiring the owner's signature (**revoke failing open is safe; restore failing open is not**); `Pubkey::from_str(..).unwrap()` per swap should be a const `pubkey!`; build `AccountMeta` explicitly rather than copying caller-supplied `is_signer` flags.
  **Done when:** ADR-0004 exists carrying all three fixes and the immutable-owner disclosure requirement, **and** the Squads V4 evaluation is recorded — it may make the whole program unnecessary.
  **Squads V4 evaluated 2026-08-18 — rejected; the custom program stands.** A spending limit is exactly four parameters (the account it draws from, a token + maximum amount, a time frame, and a set of **destination wallet addresses**). It is a *withdrawal allowance*, not CPI authority: it authorizes moving a bounded amount of a named token to a pre-named recipient, which is structurally unable to express "swap through Jupiter and settle back into the same vault". The strongest corroboration is Squads' own product — its **Trade feature is powered by Jupiter and routes through normal threshold-approval transactions**, not through spending limits. Had spending limits been able to authorize a swap, Squads would have used them for exactly this. A second, independent reason to decline even if the mechanism had fit: the proposed adapter is *strictly worse* than our own PDA vault, because it requires a Squads multisig per user **plus** a custom audited adapter program — two moving parts carrying the same audit burden as the one part it was meant to avoid, with an added upstream dependency on a program we do not control. This closes the "quick sanity check" listed as open step 1 in `docs/dg-8/wake-execution-decisions-report.md` §3.
- [ ] **S4-P20** **Per-user SOL minimum for tips and fees — USD 10 equivalent.** *(Created 2026-08-11; §7.7 consequence 3. **Threshold decided 2026-08-11 by the operator: USD 10 of SOL, priced live.**)* A user funding only USDC has zero SOL and cannot execute; `SOLANA_GAS_RESERVE_SOL` is operator-global.
  **The threshold is denominated in USD, not SOL** — deliberately. A fixed `0.05 SOL` floor silently changes meaning as SOL moves: it is generous at USD 100/SOL and inadequate at USD 400. Convert at request time with `fetchTokenPriceUsd(SOL_MINT)` (`packages/shared/src/prices.ts:317`), which the executor already calls, and **display the SOL figure** so the user sees the amount they must actually hold.
  **Two things the price dependency forces.** `fetchTokenPriceUsd` returns `null` on failure, and the executor's existing sites fall back to a hard-coded `150` (`apps/trade-executor/src/index.ts:453,1212`). That fallback is acceptable for sizing but **not** for a gate: an unreadable price must not silently admit an underfunded user, nor block a funded one. Resolve it as *skip with a stated reason* per Principle 3 (fail toward not moving funds), and surface the staleness rather than presenting a stale number as current. Second, the displayed minimum must be recomputed on render, not cached at signup — a figure fixed at onboarding is wrong within days.
  **Done when:** the gate is `USD 10` converted live, checked at onboarding **and** before each trade; a SOL-less user is skipped with an actionable "add ~X SOL" reason carrying the figure, never a generic execution error; an unavailable price resolves to skip-with-reason rather than the `150` fallback; and tests cover funded, underfunded, and price-unavailable.
- [ ] **S4-P21** **Privy policy-boundary test — the `DG-9` fork (c) question, resolved as a decision so it stops blocking.** *(Created 2026-08-19. Closes PRD `OQ-2`.)*
  **Decision first: fork (b) ships. Fork (c) is not pursued in v1, and this test is not a prerequisite for anything.** The question — can a vendor policy be scoped so that our *own* signing credential cannot widen it? — was recorded as an open blocker. It is being closed by decision rather than by experiment, for four reasons that hold regardless of the answer: fork (b) is already designed and has schema support (`047` accepts `polymarket_signer` with a `sealed_secret`); `DG-8` escrow already covers this key class; the blast radius is already bounded to one venue's trading float, and a user can withdraw to exit custody without leaving the product; and — the decisive one — **`047`'s `grant_kind` CHECK was written as a generic keyless/keyed split rather than singling out one kind, so moving from (b) to (c) later is a change inside one adapter function (`resolvePolymarketSigner`), not a schema migration.** Deferring therefore costs almost nothing, while blocking on a vendor experiment costs the critical path.
  **Why fork (c) is still worth testing eventually, and exactly how.** Polymarket ships a first-class Privy adapter (`signerFrom({ privy, walletId })` from `@polymarket/client/privy`), and Privy's policy engine is default-deny twice over with `eth_signTypedData_v4` constrainable on `ethereum_typed_data_domain`. That is decisive because the dangerous payload and the benign one are structurally distinguishable: a Deposit Wallet **`Batch`** (an arbitrary `(target, value, data)` call list — full control of the wallet) is signed against the user's **own** Deposit Wallet with `primaryType: "Batch"`, while an **order** is signed against the **Exchange** contract with `primaryType: "TypedDataSign"` (ERC-7739 nested, so order fields sit under `contents.*` — a policy written against a flat `maker` path matches nothing and, being default-deny, silently denies every order). Privy also documents that **signers cannot alter a wallet's owner, signers, or policies, and cannot export the key**.
  **The test, ~10 minutes, needs a Privy dev app and no funds:** create a policy with an `owner` set to a P-256 key you hold, then `PATCH /v1/policies/{id}` authenticated with the **app secret alone** and **no** `privy-authorization-signature` header. A **4xx** means the policy boundary is enforced independently of the signing credential, and fork (c) is genuinely non-custodial. A **200** means `PRIVY_APP_SECRET` is the entire boundary and fork (c) collapses to fork (b) plus vendor risk. This must be **tested, not assumed**: the header is `required: false` in Privy's OpenAPI spec and no page states it becomes mandatory once an owner is attached.
  **Two operational findings that constrain any fork (c) policy, recorded so the test is not run against a design that cannot work:** `setupTradingApprovals()` is itself a `Batch`, and order placement can auto-recover missing allowances via a `Batch` — so a blanket deny-all-`Batch` rule breaks onboarding and intermittently breaks trading. And `calls[]` is an array of structs with no documented array-index condition path, so a *narrow* `Batch` allow-rule is not documented-feasible today.
  **Done when:** either the test has been run and the result recorded here, **or** this item is explicitly deferred with fork (b) shipped — both are acceptable outcomes and neither blocks other work.
- [ ] **S4-P14** **Enrol in the Builder Program — required under `DG-9` fork (b).** *(ADR-0003 §4.1.)*
  Three concrete wins independent of the custody question: (1) **gasless** — the builder relayer
  covers wallet deployment, approvals, order execution and CTF operations, so unlike Robinhood
  Chain this venue needs **no paymaster budget and no `S4-P8` gas cap**; (2) `GET /builder/trades`
  / `listBuilderTrades` is a **builder-wide** fills feed covering every account we serve in one
  call — directly useful to `reconciliation-coordinator.ts`, which otherwise polls per user;
  (3) order attribution and leaderboard visibility. Builder API key/secret/passphrase are
  server-side secrets — they belong in the same sealed store as everything else in `S4-3`.
  **Done when:** a builder profile exists, the code is attached to every order **before signing**
  (it is part of the signed struct, so attaching it afterwards silently loses attribution), and
  reconciliation reads the builder feed rather than per-user polling where it can.

### 7.2 Schema — migrations `047`–`050`
- [ ] **S4-7** `047` `user_execution_grants` *(renamed from `user_trading_wallets` by ADR-0003)* — user_id, chain, **grant_kind** (`solana_vault` | `eip7702` | `session_key_4337` | `polymarket_signer`), **account_address** (the user's own address — we no longer mint one), sealed_secret, key_version, **scope_policy** (the argument-level allowlist of `S4-P10`), **expires_at**, revoked_at, created_at. `expires_at` is indexed: `S4-P9` needs to find lapsing grants cheaply, and a scoped grant with no expiry is not a scoped grant.
  *`grant_kind` values and the `sealed_secret` column name corrected 2026-08-18 — this line had drifted from the authoritative DDL in `docs/plans/stage-4-design.md` §3.3, which is what `047` is written against.* Two constraints there are load-bearing and must not be relaxed into application code: a **keyless** kind (`solana_vault`) must carry no secret and no key version, while a **keyed** kind must carry both with a `v`-prefixed version tag — this is the invariant "the API can never decrypt" ultimately rests on; and a session-shaped kind (`eip7702`, `session_key_4337`) must carry a non-null `expires_at`. The keyless/keyed split is expressed as a **set of keyless kinds**, not as `grant_kind = 'solana_vault'`, so that adding a future keyless kind fails the CHECK loudly rather than silently permitting a secret against it.
- [ ] **S4-8** `048` `user_balances` — chain, asset, amount, usd, fetched_at; refreshed by a poller reusing parameterized `balances.ts`.
- [ ] **S4-9** `049` `user_execution_settings` — auto_execute, per-chain mode, min_signal_score, max_position_pct, max_daily_exposure_pct, stop_loss_pct, rebuy_cooldown. Defaults from `DEFAULT_RISK_CONFIG`; live execution tier-gated to `operator+`.
- [ ] **S4-10** `050` tenancy key on **three** tables — `trades`, `copy_executions`, and `copy_positions` — **per the S1-B5 decision**. Legacy operator rows keep `user_id NULL`. Expand-and-contract: add → dual-write → backfill → switch reads → drop later. Never a destructive statement in the same release as the code depending on it.
  **`copy_positions` was missing from this item and is not optional** *(found 2026-08-07 while writing `docs/plans/stage-4-design.md`; verified in source, not inferred)*. Its primary key is `(target_account, chain, token_mint)` (`packages/db/sql/028_copy_execution_lifecycle.sql:280`). In **live** mode each user has a distinct custodial address, so the key happens to separate users by accident. In **paper** mode `resolvePaperCopyTargetAccount(chain)` (`apps/trade-executor/src/canonical-copy.ts:16`) returns **one synthetic value per chain** — an env var or a hard-coded default, with no user dimension — so **every paper user on a chain would share a single position row**: A's buy inflates B's `confirmed_quantity`, and B's exit computes P&L against A's cost basis. This is precisely the collision ADR-0001 identified for `copy_executions`, applied to a second table and missed. Paper is the default mode for every free-tier user, so this is the common path, not an edge case.
  **Done when:** two paper users copying the same token on the same chain hold two independent `copy_positions` rows with independent quantities and cost bases, asserted by a test that fails against the current three-column key.
  **The re-key must be idempotent, which the "expand-and-contract" framing above does not by itself guarantee** *(noted 2026-08-18)*. `packages/db/src/migrate.ts` has no applied-migrations table — it replays **every** `.sql` file on **every** invocation under an advisory lock. A bare `ALTER TABLE ... DROP CONSTRAINT copy_positions_pkey` / `ADD PRIMARY KEY` pair therefore succeeds once and then breaks `pnpm db:migrate` for every developer and for CI on the next run. The shape that survives replay: a surrogate `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, the old three-column primary key dropped with `IF EXISTS`, and the tenancy-aware uniqueness expressed as `CREATE UNIQUE INDEX IF NOT EXISTS ... (target_account, chain, token_mint, user_id) NULLS NOT DISTINCT`. `NULLS NOT DISTINCT` (PG15+; CI runs PG16) is what keeps legacy operator rows — which carry `user_id NULL` by design — colliding exactly as they did under the old key, so the migration adds a dimension without quietly removing the protection that was already there.
  **Migration written and reviewed 2026-08-19** (`050_copy_tenancy.sql`, commits `3eff476`, `30bdef7`). It goes beyond the brief in two ways that turned out to be necessary: constraint drops are guarded on `pg_constraint.conkey` **shape** rather than name, because the replacement primary key reuses the name `copy_positions_pkey` and a name-based `DROP CONSTRAINT IF EXISTS` would remove the *new* key on replay; and it found that **`copy_position_applications` needs the tenancy column too** — `rebuildCopyPosition` filters on `(target_account, chain, token_mint)`, so splitting `copy_positions` alone would have produced two rows holding identical doubled quantities.
  **One defect found in review and fixed:** the `position_id` backfill joined on `(target_account, chain, token_mint)` only, which is unambiguous while every position has `user_id NULL` but stops being so once tenants exist — several positions then match and `UPDATE ... FROM` picks one nondeterministically, attaching one tenant's evidence to another tenant's position. Reachable, not theoretical, because the expand phase deliberately tolerates an old executor writing rows without `position_id`. Now joined with `position.user_id IS NOT DISTINCT FROM application.user_id` so the join key mirrors the unique index exactly.
  **Acceptance test now exists but has NOT been run** — `tests/integration/copy-position-tenancy.integration.test.ts`, written 2026-08-19 (the migration originally shipped without it). Its first assertion raises `23505` against the old three-column key. It also pins the parts most likely to be undone later: that legacy operator rows still collide (so a future migration dropping `NULLS NOT DISTINCT` fails loudly), that a user owning financial history cannot be deleted, and that the primary key is single-column. **This item is not closeable until that suite has run against a live database.** Still owed beyond it: an end-to-end assertion driving two paper users through `requestCopyExecution`, which needs tenancy threaded through `tests/integration/helpers/lifecycle-fixture.ts`.

### 7.3 Deposit and withdraw (D11 anti-theft core)
- [ ] **S4-11** Deposit: show the user's address with a QR code.
- [ ] **S4-12** `POST /v1/me/trading/withdraw` — signed transfer **only to a SIWE/SIWS-verified linked auth wallet**, plus email confirmation and a per-day cap. This is what makes a full account takeover unable to exfiltrate to an attacker-controlled address.
  **Unlisted hard prerequisite: there is no email capability at all** *(verified 2026-08-07 — no `nodemailer`/`sendgrid`/`postmark`/`resend`/SES dependency anywhere in the workspace, and no SMTP or `EMAIL_*` key in `.env.example`)*. Stage 1 §8 deferred email on the reasoning that "signup works without it". **Withdrawal does not.** Choosing a provider, wiring it, and deciding the fail-closed behaviour when a send fails (a withdrawal must not proceed on an unsent confirmation) all belong to this item and are currently invisible in it.
  **Provider decided 2026-08-18 by the operator: Resend.** The capability lands as `packages/shared/src/email.ts` — a module in the existing `@swat/shared` package, not a new workspace package, since it is one HTTP call and a template and every consumer already depends on `shared`. It follows the `jito.ts` idiom (direct `fetch` behind a timeout, no vendor SDK, no throwing on transport failure) for the same reason: an email provider outage must be a *legible refusal*, never an exception that unwinds a half-applied withdrawal.
  **The result type is three-way, not boolean, and that is the whole point.** A send resolves to *definitely delivered to the provider* (2xx with a message id), *definitely not sent* (4xx — bad address, rejected payload; safe to surface to the user and safe to retry never), or **unknown** (timeout, 5xx, aborted socket — the provider may or may not have accepted it). Collapsing the third case into either of the first two is the defect: folding it into "sent" lets a withdrawal proceed on a confirmation nobody received, and folding it into "not sent" invites a retry that double-sends a confirmation code. Unknown must block the withdrawal *and* be distinguishable in logs from a rejection.
  **A second gap that makes the linked-wallet control bypassable on its own:** an attacker holding a session can link *their own* wallet — `S1-20` only returns 409 when the address is already linked to a *different* user, so a fresh attacker address links cleanly and becomes a valid withdrawal destination. Mitigation needs no schema change: require `user_auth_wallets.verified_at` to be older than a cooling-off window (24h suggested) before an address is spendable, and send an immediate notification on every link.
  **A third gap — the email control rests on an address nobody ever proved** *(found 2026-08-18 while wiring the Resend capability)*. `users.email` is `CITEXT NOT NULL UNIQUE` (`packages/db/sql/039_users.sql:23`) but there is **no `email_verified_at` column and no verification flow anywhere in the workspace** (grepped for `email_verified` / `verify_email` / `email_verification`: zero hits). So "only the holder of the user's mailbox can approve a withdrawal" currently means "only the holder of whatever string was typed at signup". A typo'd address makes that user permanently unable to withdraw — which fails closed, so it is a support burden rather than a hole, but it is an invisible one until the first withdrawal is attempted.
  **What keeps this from being exploitable today, verified rather than assumed:** the only `UPDATE users` statement in `packages/db` touches `password_hash` (`packages/db/src/users.ts:128`), and no route under `/v1/me` changes the email. The address is therefore effectively immutable after signup, which closes the circular attack — a session-holding attacker cannot repoint the address at their own inbox and then confirm from it.
  **Two consequences for this item, both prerequisites rather than nice-to-haves.** (1) Verify the address at signup — an `email_verified_at` column plus a token flow — **before** withdrawal ships, since the whole control is the assumption that the mailbox is the account holder's. (2) If an email-change endpoint is ever added, it must re-verify **and** carry the same cooling-off window as a linked wallet. Without that, changing the email becomes strictly the easiest route to an attacker-controlled withdrawal approval, and it would bypass the linked-wallet cooling-off entirely rather than stacking with it.

### 7.4 Fan-out
- [ ] **S4-13** On a trade-eligible signal, enumerate eligible users: **subscribed to the signal's master wallet** ∩ auto-execute on ∩ chain enabled ∩ tier allows ∩ balance ≥ minimum ∩ position cap not reached ∩ capacity not exhausted.
  **Rewritten by ADR-0005 (2026-08-19).** This said "subscribed to the signal's *cluster*". Under single-master mirroring the join is `user_wallet_subscriptions` on the **source wallet** of a `source_trade` signal, not cluster membership — and only `source_trade` reaches this path at all now, because `mayPatternTrade` (`apps/signal-engine/src/trade-eligibility.ts`) refuses every cluster pattern. Two enumeration terms are new and neither is optional: a subscription in `winding_down` state is eligible for **sells only** (§7.5 `S4-M3`), and a user already at their concurrent-position cap is eligible for sells only too. Getting either wrong opens positions a user cannot exit or has explicitly stopped opening.
- [ ] **S4-14** One BullMQ job per `(signal, user)` on the per-chain queue, idempotent under the Stage-0 identity keys as re-keyed by S1-B5.
  **Depends on `S3-25`, which is not yet done — the per-chain queue switch is currently OFF** (`tradeQueueForChain` returns `swat-trades` for all three chains). Fanning out through one concurrency-1 queue serialises every chain's users behind the slowest venue, so a Polymarket settlement delay stalls Solana copies. `S3-25` must land before this item, not alongside it.
- [ ] **S4-15** Sizing: reuse `calculateBalanceAwareSize` parameterized by **that user's** balance and risk percentages, so exposure is always proportional to what they deposited and agreed to.
  **Extended by ADR-0005 §3.1 — flat-percentage sizing is no longer sufficient.** Buy sizing is now `min(max_position_pct, master_fraction × scale)`. The existing behaviour (`apps/trade-executor/src/index.ts:508`, `riskPct` of the user's balance) is the `max_position_pct` half only, which flattens the master's conviction: a 2% speculative punt and a 40% core position produce the same allocation for the follower. `master_fraction` is computed over the assets we index, and below a coverage threshold it falls back to flat `max_position_pct` **and marks the trade sized-without-conviction** — presenting a fraction derived from a portfolio we cannot see would be a fabricated input to a real position size. Sells stay as they are: `computeCopySellProportion` is already correct.
- [ ] **S4-16** Per-user breaker, exposure cap, and paper bankroll ride the existing account-parameterized machinery unchanged — substitute the user key for `'operator'`. **Except stop-loss and `RECONCILIATION_ACCOUNT`** — see the two verified exceptions in §1.
  **`resolveRiskPolicy`'s cache needs bounding first.** `packages/db/src/risk-policy.ts:23` is a module-level `Map` keyed `${account}:${chain}`, TTL-checked on read but never swept — so today it holds one entry, and under fan-out it grows one entry per active user per chain and retains entries for users who have churned. That growth sits in the same process that holds the custody master key, which is the last process that should have an unbounded map keyed by user id.
- [ ] **S4-17** Platform gates (`chain_certifications` + `LIVE_ENABLED_CHAINS`) still clamp **on top of** every user setting.
- [ ] **S4-18** `D5` step 2 — consider the dedicated hardened custody host split at this point.

**Exit gate:** paper-mode fan-out proven for multiple users on one signal with disjoint sizing; withdrawal controls tested adversarially; custody keys never observed outside trade-executor (log and API scan); **Vault Transit migration path demonstrated on staging** (seal under `env:v1`, flip the active wrapper, sweep, verify only `vault:v1` remains, and prove a paper trade still executes end to end — per `docs/runbooks/custody-vault-migration.md` §6).

### 7.5 ADR-0005 — single-master mirroring *(created 2026-08-19)*

The pivot from cluster-consensus trading to single-master mirroring. `docs/adr/0005-single-master-mirroring.md` carries the reasoning and the rejected alternatives; `docs/PRD.md` carries the product framing for collaborators. Items here are the work that had no checklist entry before the pivot.

**Already landed:**
- [x] **S4-M0** Demote the four cluster detectors to discovery-only. *(Done 2026-08-19, commits `2c30e60`, `bb0fbf5`.)* `suppressTrade: true` on snipe, accumulation and rotation; exit was already suppressed and its comment corrected. The invariant then moved into `apps/signal-engine/src/trade-eligibility.ts` as a single frozen list consulted by `enqueueSignal`, because four independent literals at four call sites is a decision nothing can test — the detectors query the database directly and `index.ts` starts timers at import, so a test cannot reach them. A frozen array rather than an exported `Set`: `ReadonlySet` is a compile-time claim only, and one stray `.add()` would have re-enabled cluster trading process-wide with no diff to review. Fails closed on unrecognised patterns, which is reachable because `patternType` is typed `string`. 8 tests.

**Mirroring semantics:**
- [ ] **S4-M1** Hybrid buy sizing — see `S4-15`, which this rewrites rather than duplicating.
- [ ] **S4-M2** **Forward-only joins.** A user subscribing to a master already holding twelve tokens mirrors only trades from subscription onward. No catch-up buying: entering an existing position at an unknown cost basis is how followers become exit liquidity. **Done when:** a test asserts a new subscriber receives no position for a token the master held before subscription.
- [ ] **S4-M3** **`051` — subscription states `active` / `winding_down` / `ended`.** Unsubscribe means **exits-only wind-down**, not liquidation and not abandonment. Both simpler options are wrong: auto-selling is a market action the user never requested — taxable, fee-bearing, slippage-bearing, and at scale 500 users unsubscribing from one master is a coordinated sell *we* caused — while stopping outright orphans positions whose exit was going to arrive as the master's sell mirror. So: stop entries immediately, keep honouring the master's sells until each open position closes, and offer an explicit "close all now".
  **Schema change required before fan-out ships, not after.** Retrofitting this means reconstructing which open position came from which subscription, and that information is not recoverable once positions exist. `044_user_wallet_subscriptions` has no state column today.
- [ ] **S4-M4** **Per-user concurrent-position cap**, in `049`, API → UI, with a platform hard ceiling. Plus a *derived* warning at the point of configuration: beyond N positions at the user's balance, each copy falls below venue minimum order size and every trade is skipped. Better said at the slider than discovered in a skip reason.
- [ ] **S4-M5** **Mirrorable-activity filter** — buys and sells above a minimum notional only. Transfers, LP, staking and dust excluded. Without this, a master moving funds between their own wallets triggers copies.

**Capacity:**
- [ ] **S4-M6** **`053` — per-master capacity cap, denominated in price impact:** aggregate copy notional per `(master, token, window)` as a fraction of usable liquidity. Follower count is the wrong unit — 500 followers buying a deep pair is harmless, 50 buying a fresh memecoin is not. A follower soft-cap remains as a crude secondary so no single master becomes an operational concentration risk regardless of what they trade.
  **The harm being capped:** our own cohort is the adverse selection. User #900 eats the impact users #1–899 created, and a master who notices can farm it — buy small, wait for copy flow to lift the price, sell into their own followers. Also carries the per-master budget allocation that `S4-P15` depends on.
- [ ] **S4-M7** **Uniform skip and generic capacity messaging** — see `S4-P15`, where the decision is recorded.

**Suggestion engine:**
- [ ] **S4-M8** **Out-of-sample master metrics over 24h / 7d / 30d:** PnL net of fees, max drawdown, hit rate, median hold time, capacity estimate. **Never raw ROI** — it ranks the luckiest. Minimum trade count enforced **per window**, showing "insufficient history" rather than a number we do not trust. Divergence across windows is itself a finding: strong on 30d and weak on 24h means decaying, which is more actionable than either figure alone.
- [ ] **S4-M9** **Never display follower counts or popularity.** They create reflexive crowding and tell a master precisely when farming their own followers pays.
- [ ] **S4-M10** **Independence warning** when a chosen wallet sits in a funding or behavioural cluster. This is the highest-value surviving use of the clustering work — the same detection that was wrong as a trade trigger is right as a caution.
- [ ] **S4-M11** **Cap funder degree and exclude exchange hubs.** `HAVING COUNT(DISTINCT wr.wallet_b) >= 2` (`clustering-queries.ts:44`) sets a minimum and no maximum, so a CEX hot wallet funding millions of addresses becomes one enormous "Funding Group" whose members trivially satisfy any co-movement test for anything trending. A bug under either model.

**Execution — see `docs/adr/0005-single-master-mirroring.md` §7 for the reasoning:**
- [ ] **S4-M12** **Per-user nonce allocation on EVM** — advisory lock on `(chain, account)` plus per-user queue concurrency. **A correctness bug under fan-out, not an optimisation:** today one operator key with `getPendingNonce` then local `nonce++` (`robinhood.ts:670`, `:722`). Two concurrent jobs for one user read the same pending nonce, both submit it, one is silently replaced, and a fill vanishes with **no error anywhere**. Must land with the fan-out.
- [ ] **S4-M13** **EVM approvals: Permit2. Decided 2026-08-19 — the operator confirms Robinhood Chain supports it, so the fallback is dropped.** Today `allowance !== amountIn` approves the exact amount on essentially every trade (`robinhood.ts:683`), which means approve-then-swap on every mirror: two blocks of latency and 2× gas between the user and their fill. Permit2 removes the on-chain approve entirely — the user signs an off-chain permit and the swap is one transaction.
  **Two consequences worth stating.** It changes what `S4-P10`'s policy layer inspects: there is no longer an `approve` call to constrain by spender, so the argument-level check moves onto the Permit2 signature's token/spender/amount/deadline fields. And the permit is a **signature**, so it flows through the same `UserExecutionAuthority` port as everything else rather than being a special-cased transaction — which is the seam `S4-P7` exists to provide.
  **Done when:** a mirror executes in one transaction with no separate approve; a test asserts no `approve` calldata is emitted on the happy path; and the residual-allowance posture is documented (Permit2 leaves no standing ERC-20 allowance to the router, which is strictly better than the bounded-allowance fallback we no longer need).
- [ ] **S4-M14** **No EVM MEV protection — do not build it.** Robinhood Chain runs a single sequencer, so there is no public mempool to front-run from. What replaces it is a *documentation* task: the sequencer can reorder or censor, which is a chain-level trust assumption to disclose, not engineer around. Recording this as an item so nobody re-opens it as a gap.
- [ ] **S4-M15** **Pre-trade simulation on Solana.** `simulateTransaction` appears nowhere in the repo, so today we discover a failing route by paying for it.
- [ ] **S4-M16** **Polymarket FAK with a price bound from the master's fill.** A resting order is not mirroring, and a late fill on a resolving market is the stale-signal failure `S4-P15` already rejected queuing for. Sub-minimum or off-tick orders **skip with a reason** — rounding to tick changes the user's price, which is not ours to choose.
- [ ] **S4-M17** **Polymarket exit-failure escalation.** An unfilled sell leaves a user holding a position their master has left, which is worse than a missed entry. Escalating limit, then alert.
- [ ] **S4-M18** **Polymarket staleness as a fraction of remaining time-to-resolution**, not a constant. Six hours late on a market resolving in two days is a different risk from six hours late on a token buy.
- [ ] **S4-M19** **Redemption as a first-class exit.** If the master holds to resolution, the sell mirror never fires. `polymarket-redemption.ts` and `046` exist; the wiring to the mirroring path does not.
- [ ] **S4-M20** **Preserve negRisk representation, don't normalise.** Buying NO on one outcome is not the same position as buying YES across the complement, even where the economics look similar.

**Detection tier — now a launch dependency:**
- [ ] **S4-M21** **Move Solana detection off webhooks — to LaserStream *WebSocket*, not gRPC. Re-scoped 2026-08-19 once the operator confirmed a Helius FREE plan.**
  Helius's own documentation places webhooks at its highest-latency tier, recommended for "low-volume server-to-server work", and lists copy trading under preconfirmations → raw shreds → preprocessed transactions. Under cluster consensus a 15 s cycle was defensible because consensus takes seconds to form; under "when he buys, you buy" it is not.
  **But the plan gates almost all of that ladder, so the original target was unbuildable:** LaserStream **gRPC** is Business+ on mainnet; **preconfirmations** are Professional+; **preprocessed transactions** are Professional+; **raw shreds** are on all plans but cost **$1,000/month per IP seat**. What *is* available on Free is **LaserStream WebSocket** — documented as up to **200 ms** faster than standard Agave RPC websockets, serving `accountSubscribe` / `programSubscribe` / `logsSubscribe` plus Helius's `transactionSubscribe`, with **no replay**.
  **So the realistic v1 is: webhooks → LaserStream WebSocket.** That is a real improvement and it is free. Do not design against gRPC, preconfirmations or shreds until someone has decided to pay for a tier, and do not quietly assume replay exists — the Free tier has none, so a dropped connection loses events and the 15 s poll remains the authoritative backstop rather than becoming redundant.
  **The constraint that survives any tier:** shreds and preprocessed transactions carry transaction data only, **not account state**, so anything reading a bonding curve or token balance needs a subscription path regardless. This is a two-source design at every tier, not a swap.
  **Done when:** `transactionSubscribe` drives the same `source_trade` path the webhook does, the 15 s tick is retained as the backstop with a comment saying why (no replay on this tier), and a reconnect gap is measured rather than assumed harmless.
- [ ] **S4-M22** **Retire `SOLANA_SIGNAL_TO_ALERT_TARGET_MS = 60_000`** (`solana-latency.ts:1`). Under ADR-0005 that is not a target, it is a defect — and it is the kind of constant that justifies itself in review indefinitely if nobody changes it. Replace with a target derived from observed data once `S4-M21` lands.

**Observability the user sees (PRD §5.7):**
- [ ] **S4-M23** **Tracking difference** — the user's fill versus the master's fill, surfaced per trade. Entering after the master is structurally worse and the product should say so rather than hide it.
- [ ] **S4-M24** **Skip reasons are always actionable**, never a generic error; and a trade sized without conviction data is **labelled** as such.

**Testing debt found while landing the above:**
- [ ] **S4-M25** `tests/integration/` is **not typechecked by CI at all** — `tsconfig.tools.json` includes only `discover-starter-pack.ts`. Wiring it in needs real config work rather than a one-line include, because the Fastify cookie type augmentation in `cross-tenant.integration.test.ts` needs the right module-resolution context. Integration tests can therefore drift into type errors that only surface when run against a database.
- [ ] **S4-M26** `signal-engine` had **2 tests** before `S4-M0`, both for `polymarket-context`. The four detectors still have no coverage of their queries — only of the trade gate. Testing them needs the detectors extracted from `index.ts`, which runs `setInterval` at import.

---

## 8. Stage 5 — Billing *(SaaS Phase 4)* — may overlap Stage 4

- [ ] **S5-1** `054` `subscriptions` — user_id, tier, provider `stripe|usdc`, status, current_period_end, stripe_subscription_id.
- [ ] **S5-2** `055` `payments` — provider, amount, currency, tx_hash/invoice_id, status.
- [ ] **S5-3** Stripe Checkout + Billing portal; `POST /v1/billing/stripe/webhook`, **signature-verified**, driving tier grants and downgrades.
- [ ] **S5-4** USDC rail: per-user deposit reference; user pays USDC (Solana or Polygon) to the treasury with a memo/reference; a billing watcher in the indexer — reusing existing Helius/viem infrastructure — confirms the transfer and grants the tier. Lifetime tier = `tier_expires_at NULL`.
- [ ] **S5-5** Nightly job downgrading expired tiers, 3-day grace period.
- [ ] **S5-6** Every tier change writes the audit log; billing events alert via the existing Telegram service.

**Exit gate:** end-to-end tier grant from both rails on staging (Stripe test mode; USDC on testnet or a small mainnet canary); downgrade path proven.

---

## 9. Stage 6 — Frontend *(SaaS Phase 6)* — progressive from Stage 1 onward
## NOTE : IN THIS DESIGN MAINTAIN EXISTING DESIGN PATTERNS INCUDING FONTS COLOURS AND ARRANGEMENT AND ENSURE SEO OPTIMIZATION

**What exists today is a MOCKUP, not a product** *(verified 2026-08-19; this section rewritten against ADR-0005)*. `apps/web` is 9 pages and 16 `.tsx` files with **no auth, no session, and no concept of a user** — a single-operator console. Only `app/workspace/views/WalletIntelView.tsx` mentions copying at all, and there is a user-facing `/clusters` page, which now contradicts ADR-0005. Treat the existing tree as a **design reference to harvest, not production code to preserve** — its value is the visual language, not its data flow.

**Five mockup markers that must not reach production:** Tailwind loaded from a **CDN `<script>`** (`app/layout.tsx:20`); its config injected via `dangerouslySetInnerHTML` onto a `window.tailwindConfigInit` global; `app/globals.css` is a **single blank comment line**; Google Fonts via `<link>` rather than `next/font`; and `<html className="light">` hardcoded, so the configured `darkMode: "class"` is unreachable.

**The security finding that gates the whole section.** `.env.example:73` sets `NEXT_PUBLIC_API_KEY=swat-dev-key`, and **11 of the 13 files that read it are `'use client'`** — `/setup`, `/wallets`, `/logs`, `/clusters`, and every `workspace/views/*`. Next.js inlines `NEXT_PUBLIC_*` into the browser bundle, so **the operator control-plane key is shipped to every visitor**; the API compares it against `API_KEY` with `timingSafeEqual` and it grants full access. Survivable with one operator and no public deployment; a total authorisation bypass the moment a second user exists. Note `.env.example:107` already states the rule — "Never mirror it into a `NEXT_PUBLIC_*` name" — for the Resend key. **Operator decision 2026-08-19: adopt cookie sessions and delete `NEXT_PUBLIC_API_KEY` outright rather than leave a footgun in `.env.example`.**

**The good news, and the right framing:** the backend is already multi-tenant and the frontend is one rewrite behind it. `apps/api/src/auth/plugin.ts` has cookie sessions, CSRF, `requireUser`, `requireRole` and `USER_REACHABLE_PREFIXES = ['/v1/auth/', '/v1/me/']`; `apps/api/src/routes/me.ts` has nine `/v1/me/*` routes; `tests/integration/cross-tenant.integration.test.ts` already makes tenant leakage a test failure. This section is *adopt what exists*, not *invent auth*.

**Design system — reuse verbatim, do not reinvent.** Harvest these from `app/layout.tsx` into a real build-time config (`S6-1`) without changing a single value:

| Token group | Values |
| --- | --- |
| Chain accents | `solana-teal #14F195` · `polymarket-violet #8B5CF6` · `robinhood-amber #FFB800` |
| Status | `status-success #10B981` · `status-warning #F59E0B` · `status-error #EF4444` · `status-neutral #64748B` · `error #ba1a1a` |
| Surfaces | Material 3 families — `background #fdf8f8`, `on-background #1c1b1b`, `surface-container-{lowest,high,highest}`, `surface-dim`, `on-surface-variant`, `inverse-primary`, `surface-tint` |
| Type | **Geist** for all named scales (`headline-lg`, `headline-md`, `body-md`, `body-sm`, `label-caps`, `mono-data`); **Geist Mono**; **Material Symbols Outlined** for icons |
| Modes | `darkMode: "class"` already configured — make it reachable (`S6-15`) |

Chain accents are semantic, not decorative: the same colour means the same chain everywhere, including in the admin console.

**Build discipline — every item in this section, and every agent working on it, follows this loop.** One item at a time: implement it → write a test where a test is meaningful (component behaviour, auth guards, state transitions, formatters — not pixel snapshots) → run `tsc --noEmit` for the package and the relevant vitest file → fix what breaks → **then tick the box here and record the commit**. Do not batch several items and tick them together; do not tick an item whose test has not run. This binds subagents **and** the agent orchestrating them.

### 9.0 Route architecture — the user app and the admin console are separate products
- [ ] **S6-13** **Split into two route groups: `(app)` for users and `(admin)` for the operator console.** *(Operator decision 2026-08-19: keep the operator console's code, move it entirely out of what users see.)* Different navigation, different information density, different landing pages — an admin surface is a different product from a copy-trading dashboard and should not be reachable, linkable, or discoverable from the user app.
- [ ] **S6-14** **Relocate today's 9 pages into `(admin)` as the starting point for the admin dashboard.** They keep their value as operator tooling. **`/clusters` must not exist in the user app at all** — cluster detection is discovery-only under ADR-0005, and a user-facing cluster page would advertise a signal we deliberately stopped trading.

### 9.1 Foundation — blocks every item below it
- [ ] **S6-1** Drop the CDN Tailwind script (`apps/web/app/layout.tsx:20`) for a build-time Tailwind pipeline; add `tailwind.config` and `postcss.config` — **neither currently exists**. Port the token palette above verbatim; a CDN script has no purge step, causes FOUC, and makes every page load depend on a third party.
- [ ] **S6-15** Replace the `<link>` Google Fonts with `next/font` (self-hosted, no layout shift), move styling out of `dangerouslySetInnerHTML`, give `globals.css` real content, and make `darkMode: "class"` reachable instead of hardcoding `light`.
- [ ] **S6-3** Shared `lib/api.ts` — cookie auth, CSRF header, no API key. **Delete every `NEXT_PUBLIC_API_KEY` read (13 files) and the variable itself from `.env.example`.** CI already lints for `NEXT_PUBLIC_` secrets (§15) — make that lint fail on this.
- [ ] **S6-2** `middleware.ts` route protection: unauthenticated users never reach `(app)`, non-admins never reach `(admin)`. **This closes S6-B7.**
- [ ] **S6-4** react-query for polling and cache. Needed before the mirror feed, or every view invents its own refetch.
- [ ] **S6-16** Error, empty, loading and **offline** states as shared primitives. Every screen below has all four; specifying them once is the difference between a product and a demo.

### 9.2 Auth and onboarding
- [ ] **S6-5** Real signup / login / forgot-password and an onboarding flow.
- [ ] **S6-17** **`052` `users.email_verified_at` + email verification UI** — send, resend with cooldown, confirm, and a blocked state. `users` has no `email_verified_at` yet (`S4-12` prerequisite); withdrawal's entire security rests on the address being genuinely the user's, so this cannot be skipped to ship faster.
- [ ] **S6-18** Onboarding checklist component that survives reload and resumes mid-flow: verify email → link wallet → grant authority → fund → set risk → pick a master. A user who closes the tab at step 4 must not restart at step 1.

### 9.3 Granting execution authority — per chain, and not uniform
- [ ] **S6-6** Wallet connect: wagmi + RainbowKit (EVM) and `@solana/wallet-adapter` — auth-wallet linking, one-click "track my own wallet", USDC payment.
- [ ] **S6-19** **A grant flow per chain, because the mechanisms differ** (ADR-0003): Solana is a keyless PDA vault, EVM is a scoped session key with an expiry, Polymarket is a **venue-scoped key WAKE holds**. Show scope, expiry, and revocation for each.
- [ ] **S6-20** **Polymarket custody disclosure — an explicit, unskippable consent step**, stating plainly that WAKE holds this key, that the blast radius is that venue's trading float, and that withdrawal exits custody without leaving the product. ADR-0003 §4 requires this before the fork ships; copy is reviewed with `DG-2`.
- [ ] **S6-21** **Revocation is a first-class control, not buried in settings.** Solana revocation is on-chain and immediate; the UI must not imply the others are equally instant when they are not.

### 9.4 Funding and balances
- [ ] **S6-8** Stage-4 UI: trading wallet page (deposit QR, balances, withdraw), risk settings — `RiskExecutionView` rebuilt per-user with their exposure against their agreed risk %, plus a personal kill switch.
- [ ] **S6-22** **Per-chain gas minimum, displayed in the native unit but denominated in USD** — the `S4-P20` decision is USD 10 of SOL priced live, so the figure must be **recomputed on render, never cached at signup**, and shown as the SOL amount the user must actually hold. When the price is unavailable, say so; never present a stale number as current.
- [ ] **S6-23** Balance staleness is visible — `user_balances.fetched_at` surfaced, not silently presented as live.

### 9.5 Risk settings
- [ ] **S6-24** `max_position_pct`, `max_slippage_bps` (bounded per `packages/shared/src/slippage.ts`), auto-execute toggle, per-chain mode, and the **per-user concurrent-position cap** (`S4-M4`).
- [ ] **S6-25** **The derived below-minimum warning at the position-cap control** (`S4-M4`): at this balance, beyond N positions each copy falls below venue minimum order size and every trade will be skipped. Said at the slider, not discovered later in a skip reason.
- [ ] **S6-9** `G1-M8` — replace the workspace's hard-coded local-state mode toggles with the real API-backed matrix.

### 9.6 Master discovery and selection
- [ ] **S6-26** **Paste-an-address path.** Accepts a chain-prefixed or bare address, resolves the chain, and starts copying immediately — backfill is **not** on the critical path. Copy is *"copying now; performance history still loading"* (`S4-M8`/PRD UX-5). Never "a few seconds": Solana takes **90 s – 2.5 min** for an active wallet because it has no plural `getTransaction` RPC.
- [ ] **S6-27** **Suggestions list** showing out-of-sample metrics over **24h / 7d / 30d** — PnL net of fees, max drawdown, hit rate, median hold, capacity estimate. **"Insufficient history" instead of a computed number** where the per-window trade count is too low, and **window divergence surfaced as a finding** (strong 30d, weak 24h means decaying).
- [ ] **S6-28** **No follower counts, no popularity ranking, no leaderboard** (`S4-M9`). Reflexive crowding, and it tells a master exactly when farming their followers pays. This is a deliberate omission — a future contributor will read its absence as an oversight, so the component carries a comment saying it is not.
- [ ] **S6-29** **Independence warning** when a candidate sits in a funding or behavioural cluster (`S4-M10`) — the surviving high-value use of the clustering work.
- [ ] **S6-30** **Masters are per-chain and the UI must not imply otherwise** (PRD MS-4). A wallet address is chain-scoped; a user may run one master per chain. No cross-chain master identity exists.

### 9.7 Subscription lifecycle
- [ ] **S6-7** Stage-2 UI: My Wallets (subscribe, backfill status, activity feed), My Signals on the SSE stream; the existing `SignalsView` safety drawer carries over user-scoped.
- [ ] **S6-31** **Forward-only notice at subscribe time** (`S4-M2`): *"we will not buy into positions this wallet already holds."* Users will otherwise read a flat first day as a broken integration.
- [ ] **S6-32** **Wind-down UI for unsubscribe** (`S4-M3`) — three states `active` / `winding_down` / `ended`. Explain that entries stop immediately while exits keep mirroring until each open position closes, and offer an explicit **"close all now"**. Do not present unsubscribe as a single destructive button; auto-liquidation is exactly what the decision rejected.

### 9.8 The mirror feed — where trust is won or lost
- [ ] **S6-33** **Tracking difference per mirror** (PRD UX-3) — the user's fill against the master's fill. Entering after the master is structurally worse; showing it is what makes the product honest rather than making the number disappear.
- [ ] **S6-34** **Every skip carries an actionable reason** (PRD UX-1), never a generic error. Reasons already have distinct meanings and must not be collapsed: underfunded, below venue minimum, stale signal, safety flag, position cap reached, geo-ineligible, gas below minimum, **capacity**.
- [ ] **S6-35** **Capacity refusals read as capacity, not failure** (PRD UX-6) — "at capacity, scaling infrastructure". The specific constraint stays in the internal reason code, per the `S4-P15` decision.
- [ ] **S6-36** **`sized-without-conviction` is labelled** (PRD UX-2) — a mirror sized on the flat risk percentage because master portfolio coverage was too low to infer allocation (`S4-M1`).
- [ ] **S6-37** Fees are visible as real costs — Jito tips and gas in the per-trade view, not just netted into P&L (`S4-P18` populates `feeUsd`).

### 9.9 Positions and performance
- [ ] **S6-38** Open positions with cost basis, unrealised P&L, and which master and subscription each came from. `copy_positions` now carries the tenancy key (`050`) so this is per-user for the first time.
- [ ] **S6-39** Performance view: realised P&L net of fees, per master and per chain. **Consult the `dataviz` skill before writing chart code or choosing chart colours** — and note the chain accents above are already semantic, so series colour is constrained, not free.
- [ ] **S6-40** Paper vs live is unmistakable everywhere a number appears. Paper is the default for every free-tier user, so an ambiguous figure is the common case, not the edge case.

### 9.10 Withdrawal — the anti-theft surface
- [ ] **S6-41** Withdraw flow: destination limited to a **verified linked wallet**, email confirmation, per-day cap, and the linked-wallet **cooling-off window** made visible (`S4-12`). An address that is linked but not yet spendable must say when it becomes spendable.
- [ ] **S6-42** **Email-send failure blocks the withdrawal and says so.** `sendEmail` returns sent / not_sent / **unknown**, and only `sent` may proceed; the UI must distinguish "we could not send" from "we do not know whether we sent" without inviting a retry that double-sends a code.

### 9.11 Admin console — kept, relocated, hardened
- [ ] **S6-11** Admin area: today's global pages behind `role=admin` **and** an IP allowlist.
- [ ] **S6-43** Admin-only surfaces the user app must never expose: capacity and relayer-budget headroom with the real constraint named, per-master copy concentration (`S4-M6`), certification status per chain, ingestion health, and the skip-reason breakdown across all users.
- [ ] **S6-44** Admin actions are audited (`audit_log`) and the kill switches are reachable — global `'*' = 'off'`, per-chain mode, per-master pause.

### 9.12 Quality bars
- [ ] **S6-10** Stage-5 UI: billing page. Stage-7 UI: Ultra chain manager.
- [ ] **S6-12** `G7-A3` — component-wide regression suite proving no uncaught promise rejection on config-load failure.
- [ ] **S6-45** SEO per the section NOTE: metadata per route, Open Graph, sitemap, robots. Marketing and auth pages are indexable; **everything behind a session is `noindex`**.
- [ ] **S6-46** Accessibility: keyboard reachable, focus visible, form labels bound, and contrast checked against the token palette — Material 3 `on-*` pairs are designed for it, so verify rather than assume. Status must never be conveyed by colour alone; `status-success` and `status-error` need an icon or text partner.
- [ ] **S6-47** Responsive down to mobile. A user checking whether their copy filled will do it on a phone.

**Exit gate, per slice:** the corresponding backend stage is drivable end to end in the browser with no shared secrets and no hard-coded data — **and** no `NEXT_PUBLIC_*` secret appears in the built bundle, asserted by the §15 lint rather than by inspection.

---

## 10. Stage 7 — Ultra dynamic chains *(SaaS Phase 5)* — strictly last

*The chain-registry refactor touches audit-hardened code everywhere. The green suite from Stage 0 is the safety net. The audit's "no new chains" scope rule expires here.*

- [ ] **S7-1** `056` `chains` registry — id slug PK, kind `evm|solana|polymarket`, evm_chain_id, name, rpc_urls JSONB, native_symbol, coingecko_platform, dexscreener_id, status `builtin|custom`, added_by_user_id. Seed the three built-ins.
- [ ] **S7-2** Change `Chain` (`packages/shared/src/types.ts:2`) from a 3-value union to a registry-validated string. **20 files** carry hard-coded chain literals (see S7-B8) across `address.ts`, `validation.ts`, `execution.ts`, `prices.ts`, `scoring.ts`, `ingestion-health.ts`, `db/wallets.ts`, `execution-config.ts`, `circuit-breaker.ts`, `risk-policy.ts`, `trading-control.ts`, `api/index.ts` and their tests.
- [ ] **S7-3** `057` convert SQL `CHECK` constraints on chain columns to foreign keys against `chains`.
- [ ] **S7-4** `POST /v1/me/chains` (ultra only) — resolve metadata and public RPCs from Chainlist (`chainid.network/chains.json`), **verify RPC liveness**, resolve DeFi Llama for the 5 most liquid DEXes, map the CoinGecko platform id.
- [ ] **S7-5** Parameterize `evm.ts` base-token sets and RPC by registry row; per-user tracked wallets on custom chains flow through the same backfill queue.
- [ ] **S7-6** Custom chains are **paper-only by default**. Live requires a configured supported router plus platform certification — the same `chain_certifications` gate as everything else.

**Exit gate:** an Ultra user adds an uncatalogued EVM chain, backfills a wallet on it, and receives feed events — with every built-in-chain regression test green.

---

## 11. Migration number ledger

Highest applied: **`050`**. Next free: **`051`**. Reserved to prevent the collision that stalled the old plan (S1-B6):

| Range | Stage | Contents |
|---|---|---|
| `039`–`043` | 1 | users, user_sessions, user_auth_wallets, user_api_keys, audit_log |
| `044`–`045` | 2 | user_wallet_subscriptions, user_token_watches |
| `046` | 3 | polymarket_redemptions *(taken — see the correction below)* |
| `047`–`050` | 4 | user_execution_grants, user_balances, user_execution_settings + user_chain_execution_settings, tenancy key on trades/copy_executions/copy_positions *(all written 2026-08-18/19)* |
| `051`–`053` | 4 (ADR-0005) | subscription states (`active`/`winding_down`/`ended`, `S4-M3`), `users.email_verified_at` (`S6-17`), per-master capacity accounting (`S4-M6`) |
| `054`–`055` | 5 | subscriptions, payments |
| `056`–`059` | 7 | chains registry, chain FK conversion |

**Correction (2026-08-05).** Stage 3 needed a table the ledger had not anticipated — `polymarket_redemptions` — and took `046`, which was reserved for Stage 4's `user_trading_wallets`. This is the exact failure S1-B6 created the ledger to prevent, reappearing because the ledger was not updated at the moment the file was written. Stage 4 now starts at `047`. The lesson is procedural, not arithmetic: **update this table in the same commit as the migration**, never afterwards.

**Correction (2026-08-19).** ADR-0005 introduced schema work with no reserved range, and `S4-M3` was briefly written against `051` — already reserved for Stage 5 billing. Caught before either file existed. Since everything from `051` up was unwritten, the reservations were renumbered rather than the new work pushed to the end, so numeric order still matches build order: ADR-0005 takes `051`–`053`, billing moves to `054`–`055`, Stage 7 to `056`–`059`. `S5-1`, `S5-2`, `S7-1` and `S7-3` were updated in the same commit. **Second time this ledger has caught a collision — the range table is doing its job, but only because it was checked before writing the file, which is the habit to keep.**

Whoever lands first inside a range takes the next number and updates this table. Every file idempotent; `migrate.ts` re-runs all of them on every invocation and there is no applied-migrations table.

---

## 12. Standing rules — apply to every stage

From BUILDER-GUIDE §3. These never expire.

1. **Green gate.** `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:integration` pass at every stage exit. No stage is done with a red suite.
2. **Account parameterization.** All execution and risk code takes an account/scope parameter. Already satisfied across the risk surface; keep it true for new code. Idempotency keys are `(signalId, target_account)` — never `signalId` alone.
3. **Idempotency.** Source events and executions are idempotent; **never infer or fabricate a fill.** Deterministic BullMQ job IDs everywhere.
4. **Migrations.** Idempotent, expand-and-contract for breaking changes, destructive statements never ship in the same release as dependent code.
5. **Tenancy (from Stage 2).** `user_id` comes from the session, never the request payload; all per-user SQL goes through `forUser(userId)`.
6. **Money safety.** Live modes stay clamped by `LIVE_ENABLED_CHAINS` **and** `chain_certifications`. Staging never holds a custody master key or a certification row. Bounded token approvals only — never infinite allowances.
7. **Secrets.** SOPS-encrypted env files, never git. Nothing secret in `NEXT_PUBLIC_*`.
8. **Chain-prefixed addresses.** Every wallet/transaction address is stored `${chain}:${rawAddress}`. Bare EVM addresses throw rather than defaulting.

---

## 13. Decision gates

| ID | Decision | Blocks | Status |
|---|---|---|---|
| `DG-1` | Solana live path | Stage 3 Solana, Stage 4 Solana live | **Resolved** — direct Jupiter signing + Jito bundles; Trojan retires after the new path certifies |
| `DG-2` | Legal opinion on custody + autonomous trading; ToS; geo-gates | **Stage 4 launch** | **Open — non-negotiable** |
| `DG-3` | Custody build vs buy → **grant issuance build vs buy** (ADR-0003) | Stage 4 design freeze | **Re-scoped 2026-08-09.** No longer "who custodies keys". Robinhood Chain docs name Privy/Dynamic (embedded wallets + AA) and Alchemy/ZeroDev (bundler/paymaster). Verify vendor support for **argument-level** permission policies (`S4-P10`), not merely "session keys" — the `approve`-spender hole is the acceptance test. **Partially answered 2026-08-18 — the premise this gate inherited is refuted for Privy.** `docs/dg-8/wake-execution-decisions-report.md` §2 says to assume "none of them restrict `approve` calls by *spender address* — only by function name". Privy does: its `ethereum_calldata` field source exposes `function_name` **and decoded input paths** (`transfer.amount`, and by the same mechanism `approve.spender`) given an `abi` array, enforced inside the signing enclave before a signature exists. That is precisely this gate's stated acceptance test, so the "vendor cannot do it" assumption should not be carried into vendor selection unexamined. We still build our own check (`S4-P10`) as defense in depth, and two documented footguns are worth encoding in that layer's tests: overlapping `ALLOW` rules on the same field let the **looser** one win, and a mis-pathed condition fails **closed** — a wrong path denies every request rather than admitting too much, which is the right direction but presents as "the integration is broken", not "the policy is wrong". **Still open:** whether Privy supports Robinhood Chain (4663) at all — an unsupported chain makes the argument-level capability moot for the venue that most needs it. |
| `DG-4` | Which venues certify, in what order | Stage 3 scope | Open — pull-based on product need |
| `DG-5` | **Tenancy key** — `user_id` column vs reusing `target_account` (S1-B5) | Stage 1 schema | **Resolved 2026-08-04** — explicit `user_id`; `target_account` stays the settlement address. `docs/adr/0001-tenancy-key.md` |
| `DG-6` | Polymarket `takerOnly` (S0-6) | Source-trade coverage | Open |
| `DG-7` | **Fan-out market impact** — N users executing one signal against the same book degrade each other's fills, and the aggregate may exceed the liquidity the signal-engine screen validated. | **Stage 4 architecture** | **Resolved 2026-08-07 — no cap; disclosure + user-chosen targets + per-user slippage.** `docs/plans/stage-4-design.md` §7.5. Aggregation stays rejected (one order needs one signing key ⇒ pooled funds ⇒ commingled customer money, changing what `DG-2` asks). A truncating cap was *this doc's recommendation and was overridden*: it would make the platform choose who misses a trade, including paying users. Replaced by (1) disclosure of fastest-*routing* not price, (2) a per-chain discovery dashboard with bring-your-own-address so users pick targets — **load-bearing, it prevents concentration rather than mitigating it**, (3) per-user slippage limits, which bound the tail via the user's own setting rather than platform rationing. Open mechanics: order sequence (random-per-signal recommended), stagger interval. **Order sizes must not be scaled down** — that overrides agreed risk. Aggregate ratio still measured per §7.3. |
| `DG-9` | **Polymarket under the delegated model.** CLOB API credentials cannot place orders — placement needs L2 HMAC *and* a per-order EIP-712 `Order` signature from the account signer. The Builder Program does not close it: builder credentials provision Deposit Wallets and grant gasless relayer access, but "each wallet remains controlled by its signer." No Polymarket analogue of a 4337 session key or PDA delegate exists. | Before `S4-P13` | **RESOLVED 2026-08-11 — fork (b), venue-scoped custody.** `docs/dg-8/wake-execution-decisions-report.md` §1; design in `docs/plans/stage-4-design.md` §3.3. WAKE holds an encrypted signer key scoped to each user's **Polymarket wallet only** — Solana (keyless PDA) and EVM (scoped session key) stay non-custodial. Blast radius is one venue's trading float, and a user can withdraw to exit custody without leaving the product. **Carries four obligations:** explicit consent copy at setup (reviewed with `DG-2`), `DG-8` escrow for this key class, the ADR-0002 migration trigger measured on **Polymarket balances only**, and `S4-P16`'s 7-day geo-staleness window. Relayer capacity granted at **10,000/day** (up from 100), scaling with growth; on exhaustion **skip + alert, never queue** — a day-late fill is not copying the signal it was meant to mirror. Forks (c) and (d) withdrawn. **Fork (c) reopened and verified 2026-08-18 — documented-viable, one empirical test from replacing fork (b).** Polymarket ships a first-class Privy adapter (`signerFrom({ privy, walletId })` from `@polymarket/client/privy`, `/getting-started/typescript.mdx`), so the plumbing is vendor-supported rather than something we'd invent. What makes it interesting is that Privy's policy engine is **default-deny twice over** (an unlisted method is denied; a listed method with no matching rule is denied) and can constrain `eth_signTypedData_v4` on `ethereum_typed_data_domain` and dotted paths into the message. That is decisive because the dangerous payload and the benign one are *structurally* distinguishable: a Deposit Wallet **`Batch`** — an arbitrary `(target, value, data)` call list, i.e. full control of the wallet — is signed against `domain.verifyingContract = <the user's own Deposit Wallet>` with `primaryType: "Batch"`, whereas an **order** is signed against the **Exchange** contract with `primaryType: "TypedDataSign"` (ERC-7739 nested; the order fields sit under `contents.*`, so a policy written against a flat `maker` path matches nothing and — being default-deny — silently denies every order). One rule pinning the Exchange address therefore permits orders and refuses arbitrary batches. Privy further documents that **signers cannot alter a wallet's owner, signers, or policies, and cannot export the key**, and that policies are independently ownable by a P-256 key or key quorum. **Blocking test before this can be recorded as resolved** (needs a Privy dev app, no funds, ~10 min): create a policy with an `owner` we hold, then `PATCH /v1/policies/{id}` authenticated with the app secret alone and **no** `privy-authorization-signature`. A 4xx means the policy boundary is enforced independently of the signing credential and fork (c) is genuinely non-custodial; a 200 means `PRIVY_APP_SECRET` is the entire boundary and fork (c) collapses to fork (b) plus vendor risk. This must be *tested, not assumed*: the header is `required: false` in Privy's OpenAPI spec and no page states it becomes mandatory once an owner is attached. **Two operational findings that constrain any fork (c) policy:** `setupTradingApprovals()` is itself a `Batch`, and order placement can auto-recover missing allowances via a `Batch` — so a blanket deny-all-`Batch` rule breaks onboarding and intermittently breaks trading; and `calls[]` is an array of structs with no documented array-index condition path, so a *narrow* `Batch` allow-rule is not documented-feasible today. **Consequence for Phase 4:** `047`'s `grant_kind` CHECK is being written generically (`polymarket_signer`, keyless/keyed split expressed as a kind *set*), so a later move from fork (b) to fork (c) is a `sealed_secret`-shaped change inside one adapter, not a schema migration. DG-9 is therefore **off Phase 4's critical path**; it gates only `S4-P13` and part of `S4-P14`. Fork (d) remains withdrawn. |
| `DG-8` | **Key backup / rotation / disaster recovery.** | Stage 4 launch | **RESOLVED 2026-08-11 — Sev-2, not launch-blocking.** `docs/plans/stage-4-design.md` §4. The gate's original force — *lose the master key and every user's funds are unrecoverable on every chain* — is gone: Solana vaults are **keyless** (a PDA has no key to lose) and EVM session keys cost bounded bad trades, not funds. **Three secrets still need escrow:** Polymarket signer keys (`DG-9` fork b — real funds, one venue), the operator Solana key (`SOLANA_PRIVATE_KEY`, which also funds Jito tips), and the SOPS age key — **the last of which does not exist yet**; no `.sops.yaml` is present, it is planned as `S0-10`. *Escrow:* **Shamir 3-of-5** in **SLIP-39** (33 words/share at 256-bit; checksummed, so a mis-transcribed word surfaces at validation rather than on the day it is needed). **Still open, non-blocking:** which 5 locations hold the shares — five folders in one Google Drive is *one* location, since a single account compromise takes all five — and the annual rehearsal cadence against a throwaway key. |

---

## 14. Explicitly deprioritized

Recorded so they are not silently forgotten, and not re-litigated each planning pass. Per BUILDER-GUIDE §6.

| Item | Why |
|---|---|
| `G4-S2`, `G4-S7` (shadow execution) | Internal benchmarking tool, not on the SaaS critical path. Pick up opportunistically. *(`M14` closed 2026-08-02 regardless.)* |
| `G7-A7`, `G7-A8`, `G7-A9`, `F-ACC4` | Single-operator KPI certification goals. Retained as optional platform-health metrics, not release gates. |
| Final Repository Gate / Definition of Done | Re-scoped from one big-bang release to **per-stage exit gates**. Artifact and secret hygiene land in Stage 0 (S0-B2). |
| RLS for tenant isolation | Rejected for now (D12): single DB role + pooled connections make `SET LOCAL` fragile, and cross-tenant jobs would need bypasses. May return later as a backstop on custody and balance tables only. |

---

## 15. Verification cadence

- **Every merge:** CI — typecheck, unit tests, migration double-replay on scratch Postgres, cross-tenant attack suite (from Stage 2), lint for `NEXT_PUBLIC_` secrets.
- **Every stage exit:** integration suite against staging; the exit gate **demonstrated, not inferred**; diff reviewed for secrets, generated artifacts, unrelated changes, and unchecked failure paths.
- **Before any live-money change:** certification evidence under `docs/certification/` reviewed; capped canary; reconciliation-after-restart demonstrated.
- **Continuously:** nightly staging restore proves the backups (D15); ingestion-health alerts prove the pipeline (already shipped, `G0-H*`).
