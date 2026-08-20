# ADR-0001 — `user_id` is the tenancy key; `target_account` stays a settlement address

- **Status:** Accepted
- **Date:** 2026-08-04
- **Decision gate:** `DG-5` (`AUDIT-FIX-CHECKLIST.md` §13)
- **Blocks:** Stage 1 schema, Stage 4 fan-out

## Context

`docs/plans/saas-conversion-plan.md` §Phase 3 states:

> "Extend `trades` and `copy_executions` with `user_id` FK (nullable = legacy operator trades; `target_account` already exists in 028 and maps to user id)."

The parenthetical is false. `copy_executions.target_account` is populated at
`apps/trade-executor/src/index.ts:904` from `resolveLiveCopyTargetAccount(chain)` or
`resolvePaperCopyTargetAccount(chain)` — a **chain-prefixed wallet address**
(`solana:ABC…`), not an account identifier. Task C1 already hit this: wiring
`account` as a filter on `target_account` and passing `'operator'` would have
claimed zero rows forever, which is why the reconciliation coordinator scopes by
chain and treats `account` as a logical escalation label only.

The two constraints that fan-out idempotency depends on are therefore keyed on a
wallet, not a tenant:

```
UNIQUE (source_trade_id, target_account, execution_mode)
UNIQUE (chain, target_account, client_order_id)
```

Stage 4 fan-out needs exactly one execution per `(signal, user)`. We must decide
what carries tenant identity before writing any Stage 1 table that will later be
joined to it.

## Options considered

**A. Reuse `target_account` as the tenancy key.** Each user gets one custodial
wallet per chain, so their address is already unique per user per chain — the
existing constraints would give the right uniqueness with no schema change.

**B. Add an explicit `user_id UUID` FK; `target_account` keeps its real meaning
(the settlement wallet).** Re-key uniqueness to `(source_trade_id, user_id, execution_mode)`.

## Decision

**Option B.**

Option A is tempting because it is free, but it conflates *who owns this
execution* with *where the money settled*, and those diverge in two ordinary
cases:

1. **Paper mode has no real address.** `resolvePaperCopyTargetAccount` returns a
   synthetic per-chain value. Under Option A every paper user on a chain would
   collide on the same key, so the `(source_trade_id, target_account, execution_mode)`
   unique constraint would let exactly **one** user's paper execution exist per
   source trade and silently reject the rest. Paper is the default mode for every
   free-tier user, so this breaks the common path, not an edge case.
2. **Custodial key rotation changes the address.** `user_trading_wallets` carries
   `key_version` precisely because rotation is expected. Under Option A a rotation
   forks the user's execution history into two identities that no query rejoins,
   and per-user P&L, exposure caps, and the circuit breaker all silently reset.

Option B costs one column and one migration and keeps both facts addressable.

## Consequences

- `copy_executions` and `trades` gain `user_id UUID NULL REFERENCES users(id)`.
  **NULL means the legacy operator row** — existing data is never rewritten.
- New uniqueness is `(source_trade_id, user_id, execution_mode)`. The existing
  `target_account` constraints are **retained**, not dropped: expand-and-contract
  (Standing Rule 4 / D16). Dropping them in the same release as the code that stops
  depending on them is exactly the pattern D16 forbids.
- `target_account` is documented as the settlement wallet address. It stays
  `NOT NULL` and stays populated as it is today.
- The `account: string` parameter already threaded through `resolveRiskPolicy`,
  `circuit-breaker`, `stop-loss`, and `copy-eligibility` (Standing Rule 2) becomes
  the user id at Stage 4. Today it is the literal `'operator'`. **No signature
  changes are required** — this is the point of Standing Rule 2 and the reason
  Option B is cheap.
- `saas-conversion-plan.md` §Phase 3 must be corrected; it is wrong as written.

## Migration sequencing (Stage 4, migration `050`)

Per D16 expand-and-contract, in this order and **not** in one release:

1. Add `user_id` nullable, backfill nothing (legacy rows stay NULL).
2. Dual-write `user_id` alongside `target_account`.
3. Add the new unique constraint alongside the old ones.
4. Switch reads to `user_id`.
5. Drop the superseded `target_account` uniqueness **in a later release**.

## Open follow-on

Fan-out market impact is a separate unresolved question — N users executing one
signal against the same book degrade each other's fills and may exceed the
liquidity the signal-engine validated. Tracked as `DG-7`; it does not affect this
decision.
