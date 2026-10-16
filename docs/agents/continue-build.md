# Continue the WAKE build — handoff prompt

**How to use this:** in a fresh conversation, say *"Read `docs/agents/continue-build.md` and continue the build from there."* Reading the file beats pasting a wall of text — it stays in git, stays current, and the agent gets it at full fidelity.

Written 2026-08-19; updated 2026-10-03 on branch `feat/multi-tenant-foundation`.

**CI IS NOT RUNNING — do not rely on it.** GitHub Actions fails at startup with the account billing lock. Local package typechecks and unit tests are the available verification. Integration tests require Postgres and must not be run in this environment.

## Hard constraints

1. Never run `pnpm build`, `pnpm dev`, or `docker-compose up`. The machine crashes under full workspace build. A single `pnpm --filter @swat/db build` or `@swat/shared build` is allowed only after changing that package's `src/` when a consumer needs fresh `dist/`; this is required because package consumers resolve `dist/`.
2. Use per-package `tsc --noEmit` and focused Vitest suites. Do not run `pnpm db:migrate` or `pnpm test:integration`; no database is available. Write integration tests and leave them unrun.
3. Keep `TRADING_MODE=paper` and `AUTO_EXECUTE=false`. Never bypass live certification.
4. Commit to the feature branch; never push without asking. Conventional Commits. Do not commit until review and verification are complete.
5. Report exactly what ran and what did not. A typecheck is not runtime proof.
6. Read `CLAUDE.md`, `docs/PRD.md`, this file, and `docs/stale-dist-hazards.md` before substantial work.
7. Every migration replays. Make every statement idempotent and guard constraint changes on shape, not a potentially truncated name.

## Current checkpoint (2026-10-04)

Recent relevant commits include S4-M2 forward-only (`c85c33c`), Polymarket book feed (`d8192ca`), and per-user breaker/risk-key corrections (`77f279b`). S4-M3 is active uncommitted work in the current tree; inspect `git status` before continuing and preserve all local changes.

### S4-M16 and S4-M17

Both are implemented and caller-tested. `execution-lifecycle.test.ts` reaches the Polygon branch of `handleJob` and covers master fill price, null/missing source price, sell copies, and manual orders. Focused verification passed 36 tests. S4-M17's exit escalation is called from the existing guarded `reconcilePending` pass; caller tests cover rung progression, terminal alerts, redemption, and no extra timer. Do not duplicate or rewire these.

### S4-M3: master-attributed inventory is active, uncommitted work

ADR-0007 records the selected semantics: `copy_positions` remains the aggregate
venue balance, while `copy_position_lots` records confirmed inventory by user,
chain-prefixed source master, chain, and token. A source sell reduces only its
master's lot and is bounded by the user's aggregate unreserved balance. Manual
and redemption exits still operate on the aggregate venue position and must
allocate confirmed evidence across lots before this item can close.

Migration `058_master_attributed_inventory.sql` is written and recorded in
the migration ledger, but it is not applied or committed. It creates the lot
table, adds `master_wallet_address` and `lot_id` to
`copy_position_applications`, repairs tenant attribution from
`copy_executions`, and backfills source-master identity from immutable
`source_trades`.

`packages/db/src/copy-trade-lifecycle.ts` now:

- ensures and locks the aggregate row followed by the master lot;
- rebuilds aggregate and master ledgers from active evidence;
- writes both application identities in one transaction;
- caps direct and signal-claimed source sells by both the aggregate balance and
  the selling master's unreserved lot; and
- uses execution-before-inventory lock ordering for duplicate requests and fill
  evidence to avoid a request/evidence deadlock.

`unsubscribeFromWallet` now retains the subscription, choosing `winding_down`
when that master has an open or reserved lot and `ended` when it has none.
`endSubscription` refuses to end while attributed inventory remains open.

Still open for S4-M3:

- aggregate manual-exit and Polymarket-redemption allocation across lots;
- stop-loss, P&L, capacity, and cleanup consumers that need lot scope;
- close-all execution for one subscription's lots;
- database-backed race/replay cases, including two masters sharing one token;
- runtime proof against a migrated Postgres database.

Integration coverage is written in
`tests/integration/master-attributed-inventory.integration.test.ts` and the
schema guard requires migration `058`, but integration tests remain unrun here.
`docs/PRD.md` and `.zcodeignore` were pre-existing local modifications; preserve
them.

## Critical build order

1. Run Stage B Redis and Postgres acceptance gates when infrastructure is available. The current environment explicitly prohibits those commands.
2. Close the fan-out chain with evidence: candidate enumeration, forward-only eligibility, capacity assessment, per-user planning, per-chain queue, risk keys, and idempotent ledger writes.
3. Finish the selected S4-M3 inventory-attribution design: complete position/sell accounting, unsubscribe transitions, aggregate exits, and DB integration verification as one coherent item.
4. S4-M4 execution-settings API/UI and remaining S4-15/16/17 fan-out wiring follow their backend dependencies.
5. Do not start frontend user workflows before their backend endpoints exist.

## Build loop

For one item at a time: implement, add a meaningful test, run the focused unit suite and per-package typecheck, update the checklist only when the done-when is met, record what was found, and commit. Never tick an item whose required integration test has not run. Never push unless explicitly authorized.
