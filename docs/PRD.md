# WAKE — Product Requirements

- **Status:** Living document. Current as of 2026-08-19.
- **Repo:** `SWAT` (the codebase name predates the product name; `WAKE` is the product).
- **Authoritative decisions:** `docs/adr/` — this PRD states *what* we build; the ADRs state *why* and record rejected alternatives. Where they disagree, the ADR wins and this document is stale.
- **Audience:** everyone building WAKE. Assumes no prior context.

**Status legend used throughout:** ✅ built and tested · 🟡 partially built (detail given) · ⬜ not started · ❓ needs confirmation by whoever owns that area

---

## 0. Where the build actually is

Read this before anything else; it is the part that goes stale fastest.

**Branch** `feat/multi-tenant-foundation`, pushed. **CI is not running at all:** every Actions run fails in ~4 seconds with *"your account is locked due to a billing issue"*, and the same failure appears on the 2026-08-09 run — so nothing has been CI-validated since at least then. No integration suite has ever executed, including the cross-tenant leakage tests. Local `tsc --noEmit` and the unit suites are currently the only verification. Unblocking this is operator-side.

**Green locally:** 865+ tests — `@swat/db` 305, `@swat/shared` 207, `@swat/trade-executor` 343, `@swat/signal-engine` 10 — with `tsc --noEmit` clean on every package.

**The backend is multi-tenant; the frontend is not.** That asymmetry is the single most important thing to understand about the current state. Sessions, CSRF, `requireUser`, `requireRole`, nine `/v1/me/*` routes and a cross-tenant leakage suite all exist and are tested. `apps/web` is a single-operator **mockup** with no auth and no concept of a user.

| Area | State |
| --- | --- |
| Auth, sessions, tenancy discipline | ✅ built and tested |
| Ingestion across 3 chains | ✅ |
| Per-master signal (`source_trade`) | ✅ on the pub/sub fast path |
| Proportional exits | ✅ all three chains, refuses rather than guessing |
| Multi-tenant schema `047`–`050` | ✅ written and reviewed; `050`'s acceptance test **written but never run** |
| Jito tip accounting | ✅ `S4-P18` complete |
| Transactional email | 🟡 module + 56 tests; **no caller, no credentials, never sent a real email** |
| Cluster→mirroring pivot | ✅ decided (ADR-0005) and enforced in code; the rest of the semantics ⬜ |
| Fan-out to multiple users | ⬜ blocked on the per-chain queue split |
| Frontend for users | ⬜ 47 items, `AUDIT-FIX-CHECKLIST.md` §9 |
| Withdrawal | ⬜ endpoint does not exist |

**Two facts that will trip up anyone running things.** Both `dist/` directories are **stale** — `packages/shared/dist` predates six source changes, so `import { sendEmail } from '@swat/shared'` does not currently resolve; a build is needed on a machine that can run one. And Solana execution still defaults to the **third-party Trojan bot**, because the better Jupiter+Jito path is built but uncertified.

**Direction, in one line:** a user copies one master wallet per chain — when it buys they buy, when it sells they sell, sized to their own balance. This replaced a cluster-consensus model; see `docs/adr/0005-single-master-mirroring.md` for why.

---

## 1. What WAKE is

WAKE lets a person copy a specific crypto trader's trades automatically, across
multiple venues, without handing over custody of their funds.

A user picks a wallet — one they already follow, or one WAKE suggests — and from
that point on, when that wallet buys, the user buys; when it sells, the user
sells. Position sizes are scaled to the user's own balance and risk settings, not
copied one-for-one.

We call the followed wallet a **master**. We call the user's replicated trade a
**mirror**.

## 2. Who it's for

| Segment | What they want | Why WAKE |
| --- | --- | --- |
| Retail copy-trader | Exposure to a trader they believe in, without watching charts | Automation across chains, with real risk controls |
| Self-directed trader | Signal from wallets they already track manually | Removes the manual step; keeps their own wallet |
| Operator (us) | A single-tenant tool that became a product | The original system; still the internal user |

**Explicit non-audience:** high-frequency traders and snipers. We do not compete
on milliseconds against dedicated sniper bots (see §9.1). Anyone whose edge is
latency is better served elsewhere, and we should not market to them.

## 3. The core product loop

1. User signs up, verifies email, and connects a wallet they control.
2. User grants WAKE **scoped, revocable, expiring** authority to trade on their
   behalf — never a root private key (ADR-0003).
3. User funds their trading balance and sets risk preferences.
4. User subscribes to one or more masters, per chain.
5. A master trades. WAKE detects it, sizes a mirror, and executes.
6. User sees the mirror, its fill, and how it compared to the master's fill.
7. User can unsubscribe, withdraw, or revoke authority at any time.

## 4. Non-goals

Stating these because each has been proposed and rejected, and re-litigating them
costs more than writing them down.

- **We do not trade on cluster consensus.** Superseded by ADR-0005. The four
  cluster pattern detectors still run, but for discovery and alerting only.
- **We do not hold users' root private keys.** ADR-0003.
- **We do not compete on execution latency with sniper bots.** §9.1.
- **We do not queue a trade to execute later.** A late fill is not a copy of the
  signal it was meant to mirror. We skip and say why.
- **We do not auto-liquidate a user's positions.** Not on unsubscribe, not on
  revoke. Those are their assets.
- **We do not show follower counts or master popularity.** It creates reflexive
  crowding and tells a master exactly when farming their own followers pays.

---

## 5. Requirements

### 5.1 Master selection and subscription

| # | Requirement | Status |
| --- | --- | --- |
| MS-1 | A user may subscribe to a wallet by address, on any supported chain | ✅ `044_user_wallet_subscriptions` |
| MS-2 | Subscriptions record provenance: user-supplied vs platform-suggested vs discovered | ✅ `source IN ('manual','platform-signal','discovered')` |
| MS-3 | A user may hold multiple masters per chain | 🟡 schema allows; per-token exposure cap across masters not built |
| MS-4 | Masters are **per-chain**. A wallet address is chain-scoped; there is no cross-chain master identity. UI must not imply otherwise | ⬜ |
| MS-5 | Subscribing to a never-indexed wallet works immediately. Copying does not wait for history | ⬜ |
| MS-6 | Subscription has three states: `active` / `winding_down` / `ended` | ⬜ **schema change — needed before fan-out ships** |
| MS-7 | A wallet inside a funding or behavioural cluster shows a warning that it may not be an independent actor | ⬜ |

**MS-6 is load-bearing and easy to miss.** Unsubscribe must mean *exits-only
wind-down*: stop copying entries immediately, keep honouring the master's sells
against already-open positions until each closes, and offer an explicit "close
all now". Both simpler options are wrong — auto-selling is a market action the
user didn't request, and stopping outright orphans positions whose exit was going
to arrive as the master's sell mirror. Retrofitting this state later means
reconstructing which open position came from which subscription.

### 5.2 Mirroring semantics

| # | Requirement | Status |
| --- | --- | --- |
| MR-1 | On a master buy, size the mirror as `min(max_position_pct, master_fraction × scale)` — hybrid | 🟡 today it is flat `riskPct` of user balance (`trade-executor/src/index.ts:508`) |
| MR-2 | `master_fraction` is computed over assets we index. Below a coverage threshold, fall back to flat `max_position_pct` and mark the trade **sized-without-conviction** | ⬜ |
| MR-3 | On a master sell, sell the same **fraction of the master's position**, applied to the user's own holding | ✅ `computeCopySellProportion` (`packages/shared/src/copy-trade-lifecycle.ts:242`), enforced on all three chains |
| MR-4 | When proportional position evidence is missing, **refuse** rather than defaulting to "sell everything" | ✅ throws `UnrecoverableError` |
| MR-5 | Joining is **forward-only** — no catch-up buying into a master's existing positions | ⬜ |
| MR-6 | If a master sells more than the user holds, cap at the user's holding and record the remainder | 🟡 `copy_positions.unmatched_reduction_quantity` exists; wiring ❓ |
| MR-7 | Only buys and sells above a minimum notional are mirrorable. Transfers, LP, staking, dust excluded | ⬜ |
| MR-8 | Tokens failing safety checks are skipped | ✅ `signal-engine/src/safety.ts` |
| MR-9 | Max concurrent copied positions is a **per-user setting**, API → UI, with a platform hard ceiling | ⬜ |
| MR-10 | At the position-cap slider, warn when the user's balance would put copies below venue minimum order size | ⬜ |
| MR-11 | An underfunded trade skips with a stated reason. Never a silent partial | 🟡 skip logic exists; reason taxonomy needs extending |

### 5.3 Capacity and fairness

The product has two hard capacity ceilings. Neither can be engineered away — only
allocated and communicated.

| # | Requirement | Status |
| --- | --- | --- |
| CP-1 | Per-master capacity cap denominated in **price impact**: aggregate copy notional per `(master, token, window)` as a fraction of usable liquidity | ⬜ **v1 requirement** |
| CP-2 | Follower soft-cap per master as a crude secondary guard | ⬜ |
| CP-3 | When any capacity limit binds, **everyone is skipped uniformly**. No tier-based priority | ⬜ |
| CP-4 | Per-master budget allocation *inside* the platform daily cap, so one hyperactive master cannot starve users copying other masters | ⬜ |
| CP-5 | User-facing message is generic ("at capacity, scaling infrastructure"). Internal reason code names the actual constraint for ops and telemetry | ⬜ |

**Why CP-1 is denominated that way:** if 1,000 users copy one master's buy of a
thin token, our own cohort becomes the adverse selection — user #900 eats the
impact users #1–899 created. Follower count is the wrong unit: 500 followers
buying a deep pair is harmless, 50 buying a fresh memecoin is not. A master who
notices can also farm it — buy small, wait for copy flow to lift the price, sell
into their own followers.

**Why CP-4 exists:** a master doing 400 trades a day copied by 25 users is 10,000
Polymarket orders — the entire daily relayer budget — blanking the venue for
everyone else.

### 5.4 Suggestion engine

| # | Requirement | Status |
| --- | --- | --- |
| SG-1 | Rank candidates on out-of-sample, risk-adjusted metrics over **24h / 7d / 30d**: PnL net of fees, max drawdown, hit rate, median hold time, capacity estimate | 🟡 `apps/scorer/` scores wallets; metric set and windows not as specified |
| SG-2 | Never rank on raw ROI — it surfaces the luckiest, not the best | ⬜ |
| SG-3 | Minimum trade count enforced **per window**. Show "insufficient history" rather than a number we don't trust | ⬜ |
| SG-4 | Surface divergence across windows as a finding — strong on 30d and weak on 24h means decaying | ⬜ |
| SG-5 | Never display follower counts or popularity rankings | ⬜ |
| SG-6 | Capacity estimate: does this master trade tokens deep enough to be copyable at scale | ⬜ |
| SG-7 | Token backfill continues to discover candidate masters from on-chain history | ✅ `discoverFromToken` in `apps/indexer/src/index.ts` |

### 5.5 Per-venue execution

Three venues, three genuinely different execution models. Treat them as separate
implementations behind one interface, not as one path with flags.

**Solana — token swaps**

| # | Requirement | Status |
| --- | --- | --- |
| SOL-1 | Execute via Jupiter quote → build → Jito bundle | 🟡 built (`jupiter-jito-runtime.ts`), **not certified**, and not the default |
| SOL-2 | Retire the Trojan bot path. Order is non-negotiable: certify (`S3-9`) → flip `SOLANA_EXECUTOR` → delete Trojan (`S3-6`) | ⬜ default is still `trojan` (`solana-executor-selection.ts:39`) |
| SOL-3 | Add pre-trade simulation | ⬜ absent repo-wide |
| SOL-4 | Slippage bounded by per-user `max_slippage_bps` as a ceiling | 🟡 column exists in `049`; call site still uses a flat 150 bps default |
| SOL-5 | Jito tip recorded as a real cost on landed bundles only; never fabricated for an unobserved outcome | ✅ (`S4-P18`, pending review) |
| SOL-6 | Priority fee stays unset while Jito-only; becomes mandatory if we ever fan out to multi-path senders | ✅ current behaviour is correct for Jito-only |

**Robinhood Chain — Uniswap V3 swaps**

| # | Requirement | Status |
| --- | --- | --- |
| RHC-1 | **No MEV protection is needed.** Robinhood Chain runs a single sequencer, so there is no public mempool to front-run from | ✅ by decision — do not build it |
| RHC-2 | Document the replacement trust assumption: the sequencer can reorder or censor. Chain-level, not something we defend against | ⬜ |
| RHC-3 | Approvals via Permit2 if the router supports it; otherwise a rolling bounded allowance to a pinned router | ⬜ today it approves the exact amount on essentially every trade (`robinhood.ts:683`) — two blocks of latency and 2× gas per mirror |
| RHC-4 | **Per-user nonce allocation** — advisory lock on `(chain, account)` plus per-user queue concurrency | ⬜ **correctness bug under fan-out, not an optimisation.** Today: `getPendingNonce` then local `nonce++` on one shared operator key. Two concurrent jobs for one user read the same nonce, both submit, one is silently replaced, and a fill vanishes with no error |
| RHC-5 | Per-user native gas minimum, USD-denominated and priced live; skip-with-reason when unpriceable | ⬜ |
| RHC-6 | Three-way confirmation — landed / definitively not / unobserved — with replacement detection and no fabricated fills | ⬜ |

**Polymarket — prediction market order book**

The mirroring promise is weakest here, because an order can partially fill or not
fill at all. A master's fill at 0.62 does not mean 0.62 is available to us.

| # | Requirement | Status |
| --- | --- | --- |
| PM-1 | Orders are **FAK with a maximum price bound derived from the master's fill.** A resting order is not mirroring | ⬜ |
| PM-2 | Exit-order failure escalates the limit, then alerts. Never leave a user silently holding a position their master has left | ⬜ |
| PM-3 | Sub-minimum or off-tick orders skip with a reason. Never round — rounding changes the user's price | ⬜ |
| PM-4 | negRisk representation is preserved, not normalised. Buying NO on one outcome is not the same position as buying YES across the complement | 🟡 `polymarket-negrisk.ts` exists; copy-path preservation ❓ |
| PM-5 | Staleness bound is a **fraction of remaining time-to-resolution**, not a constant | ⬜ |
| PM-6 | Redemption is a first-class exit path — if the master holds to resolution, the sell mirror never fires | 🟡 `polymarket-redemption.ts` + `046` exist; wiring to mirroring ❓ |
| PM-7 | Geo-eligibility re-verified per user; execution stops after 7 days without a verified login | ⬜ provisional pending legal review |

### 5.6 Custody, authority, and withdrawal

| # | Requirement | Status |
| --- | --- | --- |
| CU-1 | WAKE never holds a user's root private key. Authority is scoped, revocable, expiring, enforced at the protocol or contract layer | ✅ ADR-0003 direction; per-chain implementations vary |
| CU-2 | Solana: a keyless PDA vault. No private key exists to steal | ⬜ ADR-0004 pending; `docs/dg-8/wake-vault-skeleton.rs` is a scaffold with three known flaws |
| CU-3 | EVM: scoped session key / delegation with argument-level policy | ⬜ |
| CU-4 | Polymarket: venue-scoped signer key, held by WAKE, explicitly disclosed at setup. Blast radius is one venue's trading float | ✅ decided (ADR-0003 §4, fork b); disclosure copy ⬜ |
| CU-5 | Withdrawal only to a signature-verified linked wallet, with email confirmation and a per-day cap | ⬜ endpoint does not exist |
| CU-6 | A linked wallet is not spendable until it has been verified for a cooling-off window | ⬜ today an attacker with a session can link their own address and use it immediately |
| CU-7 | Email address must be **verified** before withdrawal ships | ⬜ no `email_verified_at` column, no verification flow. The withdrawal control rests on this |
| CU-8 | Transactional email fails closed: a send resolves to sent / not-sent / **unknown**, and only `sent` permits the withdrawal to proceed | ✅ `packages/shared/src/email.ts` (Resend), 56 tests. No caller yet, no credentials configured |

### 5.7 What the user must be able to see

These are product requirements, not nice-to-haves. The system makes decisions on
the user's behalf; each one has to be legible or the product is not trustworthy.

| # | Requirement | Status |
| --- | --- | --- |
| UX-1 | Every skipped trade shows an actionable reason, never a generic error | 🟡 taxonomy partially exists |
| UX-2 | A trade sized without conviction data is labelled as such | ⬜ |
| UX-3 | Tracking difference is shown — the user's fill versus the master's fill. Entering after the master is structurally worse and we should say so, not hide it | ⬜ |
| UX-4 | Jito tips and gas appear as real costs in P&L | ✅ (`S4-P18`, pending review) |
| UX-5 | While history loads: *"copying now; performance history still loading."* Never promise "a few seconds" — see §9.2 | ⬜ |
| UX-6 | Capacity refusals read as capacity, not as failure | ⬜ |

### 5.8 Frontend

**The existing `apps/web` is a mockup, not a product** — 9 pages, 16 `.tsx` files, no auth, no session, no concept of a user, and a user-facing `/clusters` page that now contradicts ADR-0005. Its value is the visual language, not its data flow. **47 items live in `AUDIT-FIX-CHECKLIST.md` §9**; the shape is summarised here.

| # | Requirement | Status |
| --- | --- | --- |
| FE-1 | Two route groups: `(app)` for users, `(admin)` for the operator console. The admin surface is a **separate product** — not reachable, linkable or discoverable from the user app | ⬜ |
| FE-2 | The operator console is **kept**, relocated behind `role=admin` + an IP allowlist. `/clusters` does not exist in the user app at all | ⬜ |
| FE-3 | **Delete `NEXT_PUBLIC_API_KEY`.** 11 of its 13 readers are `'use client'`, so Next.js currently inlines the operator control-plane key into the browser bundle. Move to cookie sessions against the existing `/v1/auth/*` | ⬜ **launch blocker** |
| FE-4 | Tailwind moves from a CDN `<script>` to a build-time pipeline; fonts via `next/font`; `darkMode: "class"` made reachable | ⬜ |
| FE-5 | Reuse the existing design tokens **verbatim** — Geist / Geist Mono / Material Symbols, the Material 3 surface families, and the semantic chain accents `solana-teal #14F195`, `polymarket-violet #8B5CF6`, `robinhood-amber #FFB800`. Chain colour is semantic, not decorative | ⬜ |
| FE-6 | The new-user journey: verify email → link wallet → grant authority per chain → fund → set risk → pick a master → live mirror feed | ⬜ |
| FE-7 | Every screen has error, empty, loading **and offline** states as shared primitives | ⬜ |
| FE-8 | SEO per route; everything behind a session is `noindex` | ⬜ |
| FE-9 | Accessibility: keyboard reachable, focus visible, contrast verified against the token palette, and status never conveyed by colour alone | ⬜ |


---

## 6. Architecture at a glance

Nine services in a pnpm + Turborepo monorepo, communicating over Redis and
Postgres. Each runs independently.

```
indexer     ingests wallet activity (Helius for Solana, viem logs for EVM,
            Data API for Polymarket) → publishes swap events to Redis
                    ↓
signal-engine   turns a master's trade into a per-user copy signal
                (`source_trade`), enqueues to BullMQ
                    ↓
trade-executor  sizes, risk-checks, and executes per venue (paper or live)
                    ↓
alert-service   Telegram notifications
scorer          nightly wallet metrics/tiers/clusters + mark-to-market
discovery       nightly candidate-master discovery
api             Fastify control plane
web             Next.js dashboard
mcp-server      tooling surface
```

Two messaging mechanisms, deliberately distinct: **Redis pub/sub** for
fire-and-forget control signals, **BullMQ** for durable work. Don't conflate them.

**Invariant every contributor must know:** all wallet and transaction addresses
are stored **chain-prefixed** as `${chain}:${rawAddress}` — e.g.
`solana:ABC...`, `polygon:0x...`. Never write a bare address into a prefixed
column. See `packages/shared/src/address.ts`.

**Migrations replay.** `packages/db/src/migrate.ts` has no applied-migrations
table; it re-runs every `.sql` file on every invocation under an advisory lock.
Every migration must be idempotent (`IF NOT EXISTS`, guarded constraint adds) or
it breaks `pnpm db:migrate` for everyone on the second run.

---

## 7. Constraints that shape the product

These are not bugs to fix. They are facts to design around.

### 7.1 We are not in the latency race, but latency is now the product

Under the old cluster-consensus model, a 15-second detection cycle was
defensible — consensus takes seconds to form anyway. Under "when he buys, you
buy" it is not. The existing `SOLANA_SIGNAL_TO_ALERT_TARGET_MS = 60_000` target
is no longer a target; it is a defect.

We currently detect via Helius **webhooks**, which Helius's own documentation
places at its highest-latency tier and recommends for "low-volume
server-to-server work" — while listing copy trading under preconfirmations → raw
shreds → preprocessed transactions.

**The plan we are on gates most of that ladder, so the realistic upgrade is
narrower than it first appears.** On the **Free** tier: LaserStream **gRPC** is
Business+, **preconfirmations** are Professional+, **preprocessed transactions**
are Professional+, and **raw shreds** cost $1,000/month per IP seat. What is
available is **LaserStream WebSocket** — documented as up to **200 ms** faster
than standard Agave RPC websockets, serving `transactionSubscribe` among others,
with **no replay**.

So the v1 move is webhooks → **LaserStream WebSocket**. That is a real
improvement at no cost, and it is the launch dependency. Two things follow: do
not design against gRPC, preconfirmations or shreds until someone decides to pay
for a tier; and because the Free tier has **no replay**, a dropped connection
loses events, so the 15-second poll stays as the authoritative backstop rather
than becoming redundant.

At every tier, shreds and preprocessed transactions carry transaction data only,
not account state — so anything reading a bonding curve or token balance needs a
subscription path regardless. This is a two-source design, not a swap.

We still will not beat dedicated snipers, and should not pretend to. The goal is
to be fast enough that mirroring is honest, not to win a race.

### 7.2 Solana history backfill is slow, and that is fine

Measured, not estimated:

| Chain | Mechanism | Duration |
| --- | --- | --- |
| Solana | one `getSignaturesForAddress` (≤1000), then `getTransaction` in batches of 5 with a 150 ms sleep, then sequential processing | ~5 s quiet wallet; **90 s – 2.5 min** at the 1000-signature cap |
| Robinhood Chain | `getLogs` in 2000-block chunks | seconds |
| Polymarket | Data API, 500/page, windowed offset paging | seconds |

Solana is slowest because it has no plural `getTransaction` RPC — 200 sequential
round trips minimum. **Backfill is not on the critical path for copying**: live
mirroring needs the wallet subscribed to the data stream, not its history. Hence
UX-5.

**A previously-noted "cheap win" here is withdrawn.** Raising
`BACKFILL_BATCH_SIZE` above 5 and dropping the 150 ms pacing would cut this 4–5×
*if* the plan allowed the concurrency — on the **Free** tier it does not, and the
conservative pacing is correct rather than timid. Revisit only if the plan
changes.

### 7.3 The Polymarket relayer quota caps user count

10,000 orders/day, platform-wide. One active master copied by enough users
exhausts it. This limits how many users we can serve on that venue, not just how
many trades — hence CP-4 and CP-5.

### 7.4 Live execution is gated, deliberately

A chain executes live only when **both** hold: it is listed in
`LIVE_ENABLED_CHAINS` (operator intent) **and** it has an active reviewed row in
`chain_certifications` pointing at evidence under `docs/certification/` with a
valid checksum. Failing either silently downgrades to paper. `TRADING_MODE=paper`
and `AUTO_EXECUTE=false` stay set unless live execution has been explicitly
reviewed. Do not work around this to test something.

---

## 8. Suggested workstreams

Roughly parallelisable. Ordered by what blocks what.

| Stream | Scope | Blocks |
| --- | --- | --- |
| **A — Multi-tenancy foundation** | Review and land migrations `047`–`050`, per-chain queue cutover, per-user nonce allocation | Everything below |
| **B — Mirroring semantics** | Hybrid sizing, forward-only joins, subscription states, position cap | Product launch |
| **C — Capacity** | Price-impact caps, per-master budget, uniform skip, reason codes | Scale beyond pilot |
| **D — Venue execution** | Solana certification + Trojan retirement; RHC approvals + confirmation; Polymarket FAK + exits | Live trading |
| **E — Suggestions** | Metric set over three windows, independence warnings | Onboarding quality |
| **F — Trust surface** | Withdrawal endpoint, email verification, cooling-off, skip-reason UX, tracking difference | Public launch |
| **G — Detection tier** | Webhooks → LaserStream **WebSocket** (the Free-tier ceiling) | Mirroring honesty |
| **H — Frontend** | 47 items in checklist §9. Foundation (§9.1) is unblocked **today**; everything from §9.2 onward needs the backend it renders | Public launch |

**Stream A is the critical path** and currently carries ~3,500 lines of
unreviewed schema and query code.

---

## 9. Success criteria

Proposed, needs sign-off — numbers marked **[proposed]** are starting points, not
decisions.

| Criterion | Measure |
| --- | --- |
| Mirrors actually mirror | Median tracking difference vs the master's fill, reported per venue. Target **[proposed]** and to be set from observed data, not guessed |
| Nothing silently diverges | Zero mirrors executed without a recorded reason; zero fabricated fills or fees |
| Exits are as reliable as entries | Sell-mirror fill rate within a stated band of buy-mirror fill rate |
| Capacity is honest | Every capacity refusal has an internal reason code and a generic user message |
| No cohort self-harm | Measured price impact attributable to our own copy flow, per `(master, token)` |
| Custody claim holds | An infrastructure compromise can cause bad trades, never balance theft |

---

## 10. Open questions

**Four of the five are now closed.** Only the legal question remains open, and it is outside engineering.

| # | Question | Status |
| --- | --- | --- |
| OQ-1 | Money-transmitter / VASP exposure, including venue-scoped custody, and sign-off on the 7-day geo-staleness window | **OPEN** — legal, outside engineering. Blocks launch, not build |
| OQ-2 | Can a vendor policy engine be scoped so that our own signing credential cannot widen it? | **Closed by decision 2026-08-19.** Fork (b) ships; fork (c) is not pursued in v1. It is deliberately *not* blocked on the experiment, because `047`'s `grant_kind` CHECK was written as a generic keyless/keyed split, so moving to (c) later is a change inside one adapter function, not a schema migration. The 10-minute test is specified in full as `S4-P21` for whoever wants to reduce custody exposure later |
| OQ-3 | Does the Robinhood Chain router support Permit2? | **Closed 2026-08-19 — yes**, confirmed by the operator. The rolling-bounded-allowance fallback is dropped. Permit2 removes the on-chain approve entirely, so a mirror is one transaction instead of two. Note it moves `S4-P10`'s argument-level check off `approve`'s spender and onto the permit's token/spender/amount/deadline fields |
| OQ-4 | Actual Helius plan concurrency limit | **Closed 2026-08-19 — Free tier.** This materially re-scoped §7.1: gRPC, preconfirmations and preprocessed transactions are all above Free, so the upgrade target is **LaserStream WebSocket**, not gRPC. It also withdrew the §7.2 backfill "cheap win" — the conservative pacing is correct on this plan, not timid |
| OQ-5 | Copy-trading UI surface in `apps/web` | **Closed 2026-08-19 — essentially none.** A single-operator mockup. Console kept but relocated behind `(admin)`; user app built new against the existing design tokens. 47 items in `AUDIT-FIX-CHECKLIST.md` §9 |

---

## 11. Glossary

- **Master** — the wallet a user has chosen to copy. Chain-scoped.
- **Mirror** — the user's replicated trade. Sized to their balance, never 1:1.
- **Chain-prefixed address** — `${chain}:${rawAddress}`. The storage form for
  every address in the system.
- **Paper mode** — simulated execution against real prices. The default.
- **Sizing modes** — `paper` and `live` size differently; the DB risk policy
  applies in both.
- **Tracking difference** — the gap between the user's fill and the master's fill.
  Structurally non-zero, since we necessarily trade after them.
- **Sized-without-conviction** — a mirror sized on the user's flat risk percentage
  because we could not observe enough of the master's portfolio to infer their
  allocation.
- **Wind-down** — a subscription that no longer opens positions but still mirrors
  exits for positions already open.
- **Capacity skip** — a trade not placed because a price-impact or venue quota
  limit bound. Uniform across users.
- **Certification** — the reviewed evidence file plus DB row that, together with
  operator intent, permits live execution on a chain.
