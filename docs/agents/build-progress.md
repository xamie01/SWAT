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

| Item | Owns | Migration | Status |
|---|---|---|---|
| `S4-M43`+`S4-M44` master copier cap | `packages/db/src/master-membership.ts` (new), `subscriptions.ts` | **056** | dispatched |
| `S4-M45` three exit triggers | `apps/trade-executor/src/manual-exit.ts` (new), `polymarket-exit-race.ts` | none | dispatched |
| `S4-M42` pUSD withdrawal monitors | `packages/shared/src/pusd-liquidity.ts` (new) | none | dispatched |

## Verification baselines — do not regress these

Captured 2026-09-01. Every agent reports its package's numbers against these.

| Package | Tests | Files |
|---|---:|---:|
| `@swat/db` | 622 | 35 |
| `@swat/shared` | 325 | 19 |
| `@swat/trade-executor` | 664 | 47 |
| `@swat/api` | 58 | 4 |
| `@swat/web` | 46 | 4 |
| `@swat/signal-engine` | 32 | — |
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
