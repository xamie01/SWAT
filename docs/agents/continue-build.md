# Continue the WAKE build — handoff prompt

**How to use this:** in a fresh conversation, say *"Read `docs/agents/continue-build.md` and continue the build from there."* Reading the file beats pasting a wall of text — it stays in git, stays current, and the agent gets it at full fidelity.

Written 2026-08-19, current as of commit `0245b33` on branch `feat/multi-tenant-foundation`.

**CI IS NOT RUNNING — do not rely on it.** The branch is pushed, but every GitHub Actions run fails in ~4 seconds with *"The job was not started because your account is locked due to a billing issue."* The same failure appears on the 2026-08-09 run, so **nothing has been CI-validated since at least then** — no `db:migrate`, no `test:integration`, no cross-tenant suite, no `NEXT_PUBLIC_` secret lint.

Two consequences you must carry:

1. **`tests/integration/copy-position-tenancy.integration.test.ts` has still never executed anywhere.** `S4-10` stays open. The same is true of every other integration suite, including the cross-tenant leakage tests that Stage 1 relies on.
2. **Local verification is the only verification.** Per-package `tsc --noEmit` plus the unit suites are it. Say so when you report — never write "CI will catch it".

Resolving the billing lock is operator-side and outside engineering. Until it is fixed, treat the §10 build loop's local checks as the whole safety net rather than a first pass.

---

## 1. Hard constraints — violating any of these is a failed session

1. **NEVER run `pnpm build`, `pnpm dev`, or `docker-compose up`.** The operator's machine crashes under the build and it requires pausing all running services. Builds are done later on a different machine. This has been stated repeatedly; do not "just check if it compiles" with a build.
2. **You may run,** and should: `pnpm --filter <pkg> exec vitest run <file>`, `pnpm --filter <pkg> test`, and `./node_modules/.bin/tsc --noEmit -p <pkg>/tsconfig.json`. Per-package `tsc --noEmit` is **not** a build — it emits nothing and is the main safety net. Use it after every package you touch.
3. **No database is available.** Do not run `pnpm db:migrate` or `pnpm test:integration`. Write integration tests under `tests/integration/` and leave them unrun, saying so explicitly.
4. **`TRADING_MODE=paper` and `AUTO_EXECUTE=false` stay set.** Never work around the live-execution gate (`LIVE_ENABLED_CHAINS` + an active `chain_certifications` row) to test something.
5. **Commit on the feature branch. Never push** without asking. Conventional Commits; end messages with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
6. **Report honestly.** If a test fails, say so with output. If something is written but unrun, say that. Never claim a thing works because it typechecks.

## 2. Repo orientation — the invariants that bite

- **Product is WAKE; repo is SWAT.** Read `CLAUDE.md` first, then `docs/PRD.md`.
- **NodeNext:** every relative TS import carries `.js`, even from a `.ts` source.
- **Chain-prefixed addresses:** every wallet/transaction address is `${chain}:${rawAddress}`; `Chain = 'solana' | 'polygon' | 'robinhood-chain'`. Never write a bare address into a prefixed column. `packages/shared/src/address.ts` is pure/sync and **throws** on a bare `0x...` rather than defaulting; `resolvePrefixedAddress()` in `packages/db/src/wallets.ts` is the async probe for untrusted API input.
- **Migrations replay.** `packages/db/src/migrate.ts` has no applied-migrations table — every `.sql` file re-runs on every invocation under an advisory lock. Every statement must be idempotent. Guard constraint drops on `pg_constraint.conkey` **shape**, not name (names truncate at 63 bytes, and replacement keys often reuse the old name — see `050_copy_tenancy.sql` for the established idiom).
- **Fastify route order:** static paths register before parameterized ones.
- **Two messaging mechanisms, don't conflate:** Redis pub/sub for fire-and-forget control signals (`REDIS_CHANNELS` in `packages/shared/src/constants.ts`), BullMQ for durable work. Queue names are all centralized as of `S3-25` (2026-08-20) — `QUEUES` and `TRADE_QUEUES_BY_CHAIN`; trades are per-chain, resolved with `tradeQueueForChain()` / `tradeQueueForTokenMint()`. Never inline a queue name.
- **`packages/shared/dist` is what services import.** Both `dist/` dirs are currently **stale** (see §8).

## 3. Where the build stands

Recent commits, newest first:

```
0245b33 docs: close OQ-2/3/4, re-scope the detection tier, and refocus the README on WAKE
11eedd4 docs: build out the frontend section and fix a migration-number collision
34d840a test: extend the integration schema guard through migration 050
5e2a813 docs: add fresh-session handoff prompt for continuing the build
a51f83e docs: re-sequence the checklist against ADR-0005
bb0fbf5 test(signal-engine,db): cover the ADR-0005 trade gate and S4-10 tenancy key
30bdef7 fix(db,executor): land reviewed S4-10 tenancy and S4-P18 Jito tip accounting
84ed4ef docs: add PRD for the single-master mirroring direction
```

**The pivot.** WAKE no longer trades on cluster consensus. A user copies **one master wallet per chain**: when it buys they buy, when it sells they sell, sized to their own balance. Read `docs/adr/0005-single-master-mirroring.md` for the reasoning — the short version is that cluster grouping and the cluster trade signal were the same predicate at two time scales, so the signal restated its own grouping criterion, and co-movement among wallets grouped *for* co-moving is evidence of shared control rather than a shared fact.

**Landed and verified:** migrations `047`–`051` (execution grants, balances, settings, tenancy key, subscription states); `packages/shared/src/email.ts` (Resend, three-way fail-closed result, 56 tests); `S4-P18` Jito tip accounting; cluster detectors demoted with the invariant centralized in `apps/signal-engine/src/trade-eligibility.ts`.

### Session of 2026-08-20 — what changed, newest last

| Item | Commit | State |
| --- | --- | --- |
| `S3-25` per-chain trade queues | `1059531` | **Done and ticked.** Switch on, all seven inlined queue literals gone, `chainFromTokenMint` is the single definition of a job's chain |
| `docs/stale-dist-hazards.md` | `efe018b` | Three tracked items, all one root cause. **Read it before trusting a clean `tsc` or a green app suite** |
| `S4-M12` per-account EVM nonce lock | `5604950` | **Done.** Session advisory lock + per-account in-process chain + breaker exemption |
| `S4-M3` subscription states (`051`) | `f09da04` | **Unticked.** Schema and state machine done; the unsubscribe *call site* is blocked — see below |
| `S4-M16`/`S4-M17` Polymarket libs | `f47675f` | **Both unticked.** Mirror-bound planner (22 tests) and exit-escalation ladder (20 tests) |
| `S4-M16` mirror wiring | `f210bad` | **Still unticked.** Now reachable, but the call site has no test |
| `S4-M22` / `S4-M14` | `b7c1f77` | **Both ticked.** Latency target deleted; `docs/adr/0006-robinhood-sequencer-trust.md` written |

Test counts after that session: `@swat/db` **357**, `@swat/shared` **214**, `@swat/trade-executor` **429** (see `S4-M27` for the one environmental flake), `@swat/signal-engine` 10, `@swat/alert-service` 13, `@swat/api` 17.

**Three things that will bite the next session, in order:**

1. **A `pnpm --filter @swat/shared build` and a `pnpm --filter @swat/db build` are now hard prerequisites, not hygiene.** `chainFromTokenMint`, `tradeQueueForTokenMint`, `withEvmNonceLock` and `getCanonicalSourceTradeById` are all new exports, and services resolve both packages to stale `dist/`. Until those builds run, `api`'s manual-execute route throws and `signal-engine` drops every signal. Full detail and a verification command in `docs/stale-dist-hazards.md`.
2. **`S4-M3` cannot finish until a position can be attributed to a subscription.** `copy_positions` is keyed `(target_account, chain, token_mint)` + `user_id` and carries **no master-wallet column**, so choosing between `winding_down` and `ended` on unsubscribe is not answerable from the schema. Defaulting to `winding_down` would strand rows in a state nothing clears — no reaper exists. Fan-out (`S4-13`/`S4-15`) must carry the master wallet onto the position row; only then does the route switch to `beginWindDown`/`endSubscription`. Also: `pauseUnsubscribedWallets` (`packages/db/src/scoring-queries.ts`) counts an `ended` row as a subscriber, so a retained row pins a wallet to `active` forever — it needs `AND state <> 'ended'` in both `NOT EXISTS` sub-selects.
3. **`S4-M2` must filter on `active_since`, not `created_at`.** Re-subscribe is an `ended → active` transition on the same row (the PK forbids a second one), so `created_at` still reads January for a subscription revived in August. Getting this wrong silently reintroduces catch-up buying, which is the one thing forward-only joins exist to prevent.

**Already built and correct, do not rewrite:** `computeCopySellProportion` (`packages/shared/src/copy-trade-lifecycle.ts:242`) — proportional exits across all three chains, throwing rather than defaulting to sell-everything when position evidence is missing. `processSourceTradeSignals` — the per-master signal, already on the pub/sub fast path. `044_user_wallet_subscriptions` — user↔wallet with `manual | platform-signal | discovered` provenance.

## 4. Decisions already made — do NOT re-litigate

| Decision | Answer |
| --- | --- |
| Alpha model | Single-master mirroring, not cluster consensus |
| Buy sizing | **Hybrid**: `min(max_position_pct, master_fraction × scale)`, scale 1.0. Below portfolio-coverage threshold, fall back to flat pct and mark **sized-without-conviction** |
| Joining a master | **Forward-only.** No catch-up buying into existing positions |
| Unsubscribe | **Exits-only wind-down.** Not liquidation (a market action they didn't request), not abandonment (orphans positions whose exit was the sell mirror). Needs subscription states `active`/`winding_down`/`ended` |
| Per-master capacity cap | **In v1**, denominated in **price impact**: copy notional per `(master, token, window)` as a fraction of usable liquidity. Follower count is the wrong unit |
| When capacity binds | **Everyone skipped uniformly.** No tier priority |
| Capacity messaging | Generic "at capacity, scaling infrastructure" to users; specific internal reason code for ops. Do **not** itemise the relayer quota to users |
| Solana execution | **Jupiter + Jito bundles.** Retire Trojan — but ordering is certify (`S3-9`) → flip `SOLANA_EXECUTOR` → delete (`S3-6`). Never compress it |
| Jito vs multi-path | Jito-only to start. Priority fee stays unset while Jito-only (correct — the tip buys inclusion); becomes mandatory if we ever fan out |
| EVM MEV protection | **Do not build it.** Robinhood Chain runs a single sequencer, so no public mempool exists to front-run. Document the sequencer trust assumption instead |
| Polymarket order type | **FAK with a max price bound from the master's fill.** A resting order is not mirroring |
| Master metrics | Out-of-sample over **24h / 7d / 30d**; never raw ROI; min trade count per window; divergence across windows is itself the finding |
| Follower counts | **Never displayed.** Creates reflexive crowding and tells masters when to farm followers |
| Position cap | **Per-user setting**, API → UI, with a platform hard ceiling |
| Backfill UX copy | *"copying now; performance history still loading"* — never "a few seconds" (Solana takes 90 s–2.5 min for an active wallet) |
| Email provider | Resend |
| Polymarket custody | ADR-0003 fork (b): venue-scoped signer key, disclosed |
| Legal / `DG-2` | Out of engineering scope. Leave it alone |
| Existing `apps/web` | A **mockup**, not production code — 9 pages, 16 `.tsx`, no auth, no user concept. Harvest its visual language; do not preserve its data flow |
| Operator console | **Kept, but relocated** into an `(admin)` route group behind `role=admin` + IP allowlist. A separate product from the user app — not reachable, linkable, or discoverable from it. `/clusters` must not exist in the user app at all |
| `NEXT_PUBLIC_API_KEY` | **Delete it.** 11 of 13 readers are `'use client'`, so the operator control-plane key is currently inlined into the browser bundle. Move to cookie sessions against the existing `/v1/auth/*`. Remove the variable from `.env.example` rather than leave a footgun |
| Frontend design system | **Reuse the existing tokens verbatim** — Geist / Geist Mono / Material Symbols, the Material 3 surface families, and the semantic chain accents `solana-teal #14F195`, `polymarket-violet #8B5CF6`, `robinhood-amber #FFB800`. Full table in checklist §9 |

## 5. Open questions — these need the human, don't invent answers

- **OQ-3 — CLOSED 2026-08-19: Robinhood Chain supports Permit2.** `S4-M13` is now "use Permit2", fallback dropped. Two consequences: a mirror becomes one transaction instead of approve-then-swap, and `S4-P10`'s argument-level check moves off `approve`'s spender onto the permit's token/spender/amount/deadline fields.
- **OQ-4 — CLOSED 2026-08-19: Helius FREE tier.** This materially re-scoped `S4-M21`. gRPC is Business+, preconfirmations and preprocessed transactions are Professional+, raw shreds are $1,000/mo per IP seat. **The available upgrade is LaserStream *WebSocket*** (Free+, up to 200 ms faster than standard Agave websockets, **no replay**). Do not design against gRPC or shreds. Also **withdraws** the backfill "cheap win" — the conservative `BACKFILL_BATCH_SIZE=5` + 150 ms pacing is correct on this plan, not timid.
- **OQ-5 — CLOSED 2026-08-19: essentially no user UI exists.** `apps/web` is a single-operator mockup. Console kept but relocated behind `(admin)`; user app built new against the existing design tokens. 47 items in checklist §9.
- **OQ-2 / DG-9 fork (c) — CLOSED BY DECISION 2026-08-19.** Fork (b) ships; fork (c) is not pursued in v1 and **blocks nothing**, because `047`'s `grant_kind` CHECK was written as a generic keyless/keyed split, so moving to (c) later is a change inside one adapter function rather than a schema migration. The ~10-minute test is specified in full as `S4-P21` for whoever later wants to reduce custody exposure. Do not treat it as a prerequisite.

## 6. Next work, sequenced

Full item text is in `AUDIT-FIX-CHECKLIST.md` **§7.5** (26 items, `S4-M*`). Order below reflects what blocks what.

1. ~~**`S3-25`**~~ — **DONE 2026-08-20.** Per-chain queues are live, one concurrency-1 worker each, and the seven inlined queue literals are gone. `chainFromTokenMint()` in `packages/shared/src/constants.ts` is now the single definition of a job's chain, shared by the producers and the executor — do not add a second one. **Requires `pnpm --filter @swat/shared build` before it runs** (new export, stale `dist`). Left open: delete the `swat-trades` drain worker and `QUEUES.trades` once a deploy confirms that queue is empty. Full entry in `AUDIT-FIX-CHECKLIST.md` §6.4.
2. ~~**`S4-M12`**~~ — **DONE 2026-08-20 (`5604950`).** Session-level `pg_try_advisory_lock` on `(chain, account)` via `withEvmNonceLock`, injected as a port so `robinhood.ts` stays free of `@swat/db`; plus the in-process submission chain re-keyed from global to per-account, so users no longer serialise behind each other. Contention throws `NonceContentionError`, which the circuit breaker exempts — counting it would turn a millisecond overlap into a five-minute chain outage. **The same port is what Polymarket's polygon signer should use; do not write a second one.**
3. ~~**`S4-M3`**~~ — **schema DONE 2026-08-20 (`f09da04`), item still open.** See §3 point 2 for the exact blocker; the remaining work is fan-out carrying the master wallet onto the position row, not more schema.
4. **`S4-M2`** forward-only joins, then **`S4-15`/`S4-M1`** hybrid sizing, then **`S4-M4`** position cap + the derived below-minimum warning.
5. **`S4-M6`** price-impact capacity cap and per-master budget allocation.
6. **`S4-M15`** pre-trade simulation; **`S4-M16`–`S4-M20`** Polymarket. **`S4-M16` and `S4-M17` are built and tested but not finished** (`f47675f`, `f210bad`): the mirror-bound planner is now reachable from the copy path, but its call site has no test because `execution-lifecycle.test.ts` has **no test that reaches the Polymarket branch of `handleJob` at all** — building that fixture is the next real piece of work there, and it unblocks ticking `S4-M16`. The exit-escalation ladder has **no caller**; wiring it must go through the existing guarded `reconcilePending` loop, never a second timer (audit `C1`).
7. **`S4-M21`** detection tier: webhooks → LaserStream gRPC at `processed`. Note it's a **two-source design** — shreds and preprocessed transactions carry transaction data only, *not* account state, so anything reading a bonding curve or token balance still needs gRPC.
8. ~~**`S4-M22`**~~ — **DONE 2026-08-20 (`b7c1f77`).** Constant and its reporting helper deleted; no replacement number invented, because `S4-M21` hasn't landed and no observed distribution exists. A tripwire test fails if anyone re-adds one. `calculateSolanaLifecycleLatencies` is retained as the input `S4-M21` will feed.

Parallel, non-blocking: `S3-9` Solana certification canary (evidence under `docs/certification/`), then `S3-6` Trojan deletion.

**The frontend is a genuinely parallel workstream — checklist §9, 47 items.** `§9.1 Foundation` is unblocked **today** and is real work: move Tailwind off the CDN `<script>`, fonts to `next/font`, adopt cookie sessions against the existing `/v1/auth/*`, **delete `NEXT_PUBLIC_API_KEY`** (currently inlined into the browser bundle by 11 `'use client'` readers — a launch blocker), add `middleware.ts` route protection, and split `(app)` from `(admin)`. Everything from `§9.2` onward renders backend that does not exist yet, so do **not** start there and discover the API is missing. Reuse the existing design tokens verbatim; the palette table is in checklist §9.

## 7. Known debt — inherited, state it rather than discover it

- **`tests/integration/copy-position-tenancy.integration.test.ts` has never run.** `S4-10` is **not closeable** until it does. Its first assertion should raise `23505` against the old three-column key.
- **`S4-M25`:** `tests/integration/` is not typechecked by CI at all (`tsconfig.tools.json` includes only `discover-starter-pack.ts`). Not a one-line fix — `cross-tenant.integration.test.ts` needs the `@fastify/cookie` type augmentation in the right module-resolution context.
- **`S4-M26`:** the four cluster detectors have no query coverage. Reaching them from a test needs extracting them from `index.ts`, which runs `setInterval` at import.
- **Email has no caller and no credentials.** `sendEmail` is tested only against a mocked `fetch`; nothing has ever sent a real email. Withdrawal (`S4-12`) doesn't exist yet.
- **`users` has no `email_verified_at`.** The withdrawal control rests on the email being genuinely the user's, and nothing establishes that. Mitigating fact, verified: the only `UPDATE users` in `packages/db` touches `password_hash`, and no `/v1/me` route changes the email — so the circular attack is closed.
- **A linked wallet is spendable immediately.** Needs a cooling-off window before it can be a withdrawal destination.

**All three stale-`dist` hazards are now measured and tracked in
`docs/stale-dist-hazards.md`** — read it before trusting a clean `tsc --noEmit` or a
green app suite. Item 1 there (`pnpm --filter @swat/shared build`) is a **deploy
blocker** for `S3-25`, not a tidy-up.

## 8. Cleanup mandate — delete dead code, but verify before deleting

Two rules: **look at the target before deleting**, and **never delete something merely because nothing references it in one grep** — check tests, barrels, SQL, and env references too.

**Verified findings to act on:**

- **Both `dist/` directories are stale and this is a live hazard.** `packages/shared/dist/index.d.ts` is from 2026-08-08 with **6** newer sources; `packages/db/dist` has **7**. Services import `dist`, so `import { sendEmail } from '@swat/shared'` does not currently resolve — the barrel export exists in `src` only. **Do not run the build yourself.** Tell the operator a `pnpm --filter @swat/shared build` is required on their build machine, and never conclude from a stale `dist` that source is broken.
- **Trojan is 1,401 lines across `trojan.ts`, `trojan-runtime.ts` and their tests**, scheduled for deletion under `S3-6` — **but only after `S3-9` certification.** Do not delete it early; both paths run side by side until the canary is recorded, and `clampExecutionModeForStartup` accepts either being ready.
- **`SOLANA_SIGNAL_TO_ALERT_TARGET_MS`** (`solana-latency.ts:1`) — obsolete under ADR-0005 (`S4-M22`). Removing it means removing the summary helper that reports against it, so check `solana-latency.test.ts` first.

**Sweep to run, reporting findings rather than deleting silently:**

- Cluster-consensus leftovers now that detectors are discovery-only: is `getClusterTier` still reachable on a trade path? Are the snipe/accumulation ROI-bonus score terms dead? These now feed alerts only.
- Unreferenced exports in `packages/shared/src/index.ts` and `packages/db/src/index.ts`.
- Stray `*.tmp*` / `*.bak` / `*.orig` files. One was found this session containing a 24-line comment that had never landed — **it was salvaged, not deleted.** Read stray files before removing them.
- `docs/plans/` overlap: `saas-conversion-plan.md` and parts of `stage-4-design.md` predate ADR-0003/0005. `stage-4-design.md` mentions clusters only once, so it is **not** broadly superseded — do not mass-delete docs. Flag contradictions for the operator instead.

## 9. Subagent playbook

The operator has authorized subagents for build work. Use them for genuinely parallel, file-disjoint tasks. Every brief must contain:

- **The §1 hard constraints, verbatim.** Agents will otherwise run `pnpm build`.
- **The §10 build loop, verbatim.** One item, then a test where meaningful, then `tsc --noEmit` and the suite, then tick the box. A subagent that returns five finished items and no tests has done the wrong job even if the code is right.
- **An explicit allowlist of files it may create or edit, and an explicit list of files it must NOT touch** (naming the other agents' files). File-level ownership is what makes parallelism safe.
- **"Do not edit barrel files** (`packages/db/src/index.ts`, `packages/shared/src/index.ts`) — report needed exports and the orchestrator wires them." Barrels are the one guaranteed collision point.
- **"Do not `git commit` or `git add`."** The orchestrator reviews first.
- **"Do not invent an endpoint, parameter, or figure. If you cannot verify it, say so and leave the existing behaviour in place."**

### Infrastructure findings from 2026-08-20 — read before spawning anything

1. **An over-long MCP tool name kills subagents with a 400.** `mcp__polymarket-docs__query_docs_filesystem_polymarket_documentation` is **68 characters** and the API caps tool names at **64**, so every agent handed the full tool list died with `400 tools.N.name`. It then hit the main session too. Fixed by renaming the server in `.mcp.json` from `polymarket-docs` to `pmdocs` — **11 characters is the maximum server name that fits** that tool, and `pmdocs` leaves 5 to spare. If you add an MCP server, check `len('mcp__' + server + '__' + longest_tool) <= 64` before relying on it.
2. **Agents die to stream-idle timeouts on long thinking passes.** Four of seven agent runs this session terminated early with `StreamIdleTimeoutError` or an empty HTTP 200. Two lost everything because they had written nothing yet. **Put "write each file to disk as soon as you draft it" in every brief** — the survivors' work was recoverable precisely because it was on disk.
3. **Inventory disk before respawning.** Of the four deaths, two had written real files and two had written nothing. Re-running an agent over completed output wastes a cycle and risks conflicting edits. `git status --porcelain` first, every time.
4. **Do not let agents edit `AUDIT-FIX-CHECKLIST.md`.** Three concurrent agents editing one file is the only guaranteed collision point. Have them **report proposed entry text** and let the orchestrator paste it — this also forces the orchestrator to actually read what it is ticking, which caught an overclaimed `S4-M16` tick.

### Lessons from this session — each cost real debugging

1. **An agent can report "done" when nothing is wired.** The Jito draft added every import for tip accounting and called **none** of them; `submit()` still used the stale array and `reconcile()` never populated `feeUsd`. It typechecked because unused imports are not errors. **So: verify the new code path actually executes — grep the call sites, don't trust the report.**
2. **Agents leave syntax errors that a whole package fails on.** `trades.ts` had backticks inside a SQL comment inside a TS template literal, which terminates the string — four `TS1005` errors. **Run `tsc --noEmit` per package after every agent returns.**
3. **Agents skip the acceptance test.** `050` shipped without the "fails against the old key" test its own done-when demanded. **Check the done-when explicitly, as a separate step from reading the code.**
4. **Agents leave `.tmp` files containing work that never landed.** Diff them against the real file before deleting.
5. **Agents die and lose their reasoning, not their files.** A terminal death mid-session lost three agents; every file they had written survived on disk. On restart, **inventory what's on disk first** and respawn only the missing work — don't blindly re-run agents over completed output.
6. **Don't commit files an agent is still reading via `git diff`.** One brief told an agent to read its predecessor's uncommitted draft that way; committing those paths would have emptied the diff mid-task.
7. **Ask agents to state what they could not verify.** The best output in this session came from an agent that checked Jito's own client source because the docs host was unreachable, and said so.

### A good fan-out for the next phase

`S3-25` (queues) landed 2026-08-20, so `S4-M12` (nonce) is the head of the sequential chain now. Genuinely disjoint candidates, ~3 agents:

- **Agent 1:** `S4-M3` subscription states — migration `051` + `packages/db/src/subscriptions.ts` + tests.
- **Agent 2:** `S4-M16`–`S4-M20` Polymarket — `apps/trade-executor/src/polymarket*.ts` only the session has the polymarket mcp server connected untilize it when necessary.
- **Agent 3:** `S4-M8` master metrics over three windows — `apps/scorer/src/` only.

## 10. The build loop — mandatory, and it binds orchestrators too

**One item at a time. Never batch.** This is the project's working method, not a suggestion, and it applies identically to a lead agent and to every subagent it spawns. An orchestrator that fans out five agents and ticks five boxes at the end has violated it just as much as an agent that skips a test.

For each checklist item, in this order:

1. **Implement that one item.** Not the item plus two neighbours that looked related.
2. **Write a test where a test is meaningful.** Meaningful means: behaviour that can regress silently — an auth guard, a state transition, a formatter, a fail-closed branch, a constraint the database is supposed to reject. Not meaningful: pixel snapshots, or a test that restates the implementation. If an item genuinely needs no test, say why in the commit rather than staying quiet about it.
3. **Check for errors.** `./node_modules/.bin/tsc --noEmit -p <pkg>/tsconfig.json` for every package touched, plus the relevant vitest file or suite. Fix what breaks before moving on.
4. **Only then tick the box** in `AUDIT-FIX-CHECKLIST.md`, and record the commit hash next to it.
5. **Record what you found, not only what you fixed.** A defect discovered and worked around is worth more to the next person than a clean diff. The checklist is this project's memory; an unrecorded fix gets re-litigated in three weeks.

**Never tick an item whose test has not run.** If no database is available and the test is an integration test, the item stays unticked and the entry says "written, not run" — see `S4-10`, which is deliberately open for exactly this reason.

**Do not tick an item because it typechecks.** A whole workstream in this session reported done while its new code path was never called; it typechecked because unused imports are not errors.

## 11. Before claiming anything is done

- Per-package `tsc --noEmit` clean for every package touched.
- The relevant test suites run and passing, with counts stated.
- The checklist item's **done-when** re-read and each clause addressed, or explicitly noted as not met.
- Anything written-but-unrun said plainly.
- `AUDIT-FIX-CHECKLIST.md` updated per §10 step 4 and 5.
