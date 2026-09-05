# Build progress — Stage 4 fan-out and the 2026-09-01 decision set

**Purpose.** One page that answers "what is being built, by whom, and is it verified".
The checklist (`AUDIT-FIX-CHECKLIST.md`) is the specification; this is the *work-in-flight*
view. When an item lands, its evidence goes in the checklist entry and its row here is
deleted — this file tracks nothing that is finished.

## Rules that make parallel work safe

**File ownership is exclusive.** Two agents editing one file produces a merge the master
agent has to referee, and the losing edit is usually the one with the better reasoning
attached. So every row below names the files that row owns; nothing else may touch them.

**Nobody edits these — master agent only.** Both are re-emitted to `dist/`, so an agent
that edits one cannot see the consequence of its own change (see `stale-dist-hazards.md`):
- `packages/db/src/index.ts`
- `packages/shared/src/index.ts`

**Migration numbers are allocated up front**, because two agents that both pick "the next
free number" collide, and the collision surfaces as a migration that silently never runs.

**Done means mutation-verified.** A test that still passes with the feature removed is not
evidence. This project has four recorded cases of complete-but-inert features whose suites
stayed green, so the bar is: break it, watch a *named* test fail, restore it, report which.

## In flight

*Nothing dispatched. Fan-out `S4-13`..`S4-17` has landed as code; it is **inert** until
`S4-M6` (master capacity) is wired, which is the next item and the one thing standing between
this and a working per-user fan-out.*

| Item | Owns | Migration | Status |
|---|---|---|---|

**Neither may edit `apps/trade-executor/src/index.ts`** — both need wiring there, so each
reports a diff and the master agent applies them together. Two agents editing the executor's
entry point is the merge this ownership rule exists to prevent.

**Neither allocates a migration.** If either concludes one is needed it stops and reports,
rather than guessing a number — the collision surfaces as a migration that silently never runs.

*Nothing dispatched. Fan-out `S4-13`..`S4-17` has landed as code; it is **inert** until
`S4-M6` (master capacity) is wired, which is the next item and the one thing standing between
this and a working per-user fan-out.*

| Item | Owns | Migration | Status |
|---|---|---|---|

## Verification baselines — do not regress these

Captured 2026-09-01. Every agent reports its package's numbers against these.

| Package | Tests | Files |
|---|---:|---:|
| `@swat/db` | 706 | 37 |
| `@swat/shared` | 349 | 20 |
| `@swat/trade-executor` | 765 | 49 |
| `@swat/api` | 58 | 4 |
| `@swat/web` | 46 | 4 |
| `@swat/signal-engine` | 75 | 4 |
| `@swat/indexer` | 101 | — |
| `@swat/scorer` | 62 | — |
| `@swat/alert-service` | 13 | — |

All nine packages typecheck clean. `pnpm check:secrets` and `pnpm check:env` both exit 0.

## Sequencing, and why this order

1. **Master cap** first — it gates who can subscribe at all, so every later test needs it.
2. **Exit triggers** second — they extend `S4-M19`'s existing claim rather than adding a
   path, and getting that wrong is a double-sell of a user's position.
3. **pUSD monitors** third — independent of both, so it parallelises cleanly.

Fan-out `S4-14`/`S4-15` follows once the cap exists, because sizing a job for a user who
should not have a slot is work thrown away.
