# ADR-0007 — Master-attributed lots over aggregate venue positions

- **Status:** Accepted
- **Date:** 2026-10-03
- **Decision gate:** `S4-M3` (`AUDIT-FIX-CHECKLIST.md` §7.5)
- **Related:** [ADR-0005](./0005-single-master-mirroring.md), [ADR-0001](./0001-tenancy-key.md)

## Context

ADR-0005 allows a user to follow multiple masters on one chain, while the current
copy ledger has one `copy_positions` row per `(target_account, chain, token_mint,
user_id)`. That aggregate is the right shape for the fungible balance held by one
venue account, but it is not enough to answer which subscription opened that
balance.

The current sell contract stores the source master's position-before quantity and
sell fraction, then applies that fraction to the user's aggregate confirmed
quantity. With one master this is correct. With two masters holding the same token,
a sell by master A can consume master B's inventory. The same missing attribution
means unsubscribe cannot safely choose between `winding_down` and `ended`.

## Decision

Keep two deliberately different ledgers:

1. **Aggregate venue position.** Keep `copy_positions` as the user's physical
   position per `(target_account, user_id, chain, token_mint)`. It is the quantity
   the venue account can actually sell, reserve, redeem, or close. Legacy operator
   rows keep `user_id NULL` as specified by ADR-0001.
2. **Master-attributed lots.** Add a source-master subledger keyed by the user,
   chain-prefixed master wallet, chain, and token. It records the confirmed quantity,
   cost basis, reservations, reductions, and unmatched reductions attributable to
   that master. It is an accounting claim over the aggregate balance, not a second
   on-chain wallet position.

Every confirmed copy fill must update both ledgers in one transaction. The
evidence/application row must identify the same user and master lot as the
execution's source trade. Rebuilding either ledger must use immutable evidence and
must never infer the master from the current subscription table.

### Buys and deduplication

- A copied buy belongs to the master named by its canonical `source_trade`.
- If a duplicate source signal is suppressed before execution, it creates no fill
  and no lot. If it executes, its confirmed fill belongs only to its own master lot;
  evidence from two masters must never be merged merely because the token matches.
- The aggregate position is the sum of its attributed lots plus any explicitly
  retained legacy/operator opening balance. A shared paper `target_account` does
  not justify sharing a user's lots or cost basis with another user.

### Master sells

For a master sell, retain the existing source evidence contract:

```text
fraction = min(1, source_reduction / source_position_before)
```

Apply that fraction only to the selling master's open lot quantity. Do not apply it
to every lot for the user's token. The requested external sell quantity is the
master-lot reduction, bounded by the user's aggregate unreserved confirmed
quantity. The aggregate row and the master lot are reserved and reduced together;
partial fills update both by the actual confirmed quantity.

If the master has no attributable open lot, the sell produces no copy order and a
stable skip/reason record. If the aggregate balance is lower than the attributed
lot ledger says, sell only what the aggregate ledger can prove and record the
remainder as a master-scoped unmatched reduction. The aggregate unmatched counter
must not be used as a substitute for that source-specific fact.

This preserves the product promise in both directions: a master sell reduces that
master's copied exposure, and it cannot liquidate another master's exposure just
because both trades use the same token.

### Subscription wind-down

- `beginWindDown` stops new lots for that master but continues to admit that
  master's sells against its existing lots.
- `endSubscription` is legal only when that master has no open attributed lots and
  no pending or reserved exit for them. Another master holding the same token does
  not keep this subscription alive.
- The existing subscription row is retained for attribution. The DELETE API must
  switch to this lifecycle only after the lot attribution path exists.
- A subscription's **close all now** targets that subscription's lots. A separate
  user-level aggregate close, if added later, may close the whole venue position;
  the two commands must not share an ambiguous position key.

### Aggregate exits and race claims

Manual aggregate exits and Polymarket redemption act on the actual venue position,
not on one master's accounting lot. A resolved Polymarket outcome redeems the
whole account balance for that outcome and therefore closes all corresponding
master lots after confirmed evidence is allocated to them.

The position-exit race must express this distinction:

- a mirrored master sell claims the relevant master lot and locks the aggregate
  venue position while reserving its quantity;
- a manual aggregate exit or redemption claims the aggregate outcome/token
  position and prevents new master-lot exits from racing it;
- a losing or failed claim is retryable, but a confirmed claim remains exactly once.

The current `(user_id, position_key)` Polymarket claim is therefore not sufficient
for the master-sell side once multiple masters can hold one outcome. The follow-up
schema and lock design must add an explicit exit scope/master identity rather than
silently letting one master-sell claim suppress another master's lot or an
aggregate redemption.

### Other consumers

- Stop-loss claims must carry the master/source lot or an explicitly aggregate
  scope; a user-level signal claim must not hide another user's or master's
  position.
- Capacity remains master-scoped at the cohort level, while a user's concurrent
  position cap remains aggregate by user/chain/token.
- P&L may roll lots up for a user's aggregate report, but it must calculate each
  lot's cost basis before adding results. Blending bases first recreates the
  cross-master accounting error.
- Position locks, advisory-lock keys, reservation queries, application foreign
  keys, manual exits, redemption, rebuilds, fixtures, and cleanup must all carry
  the same attribution dimensions. A master column on one table is not sufficient.

## Rejected alternatives

### Apply every master sell to the aggregate position

Rejected because it lets master A consume master B's position, makes wind-down
dependent on unrelated activity, and contradicts the per-master mirroring promise
when multiple masters share a token.

### Make `copy_positions` itself the venue position per master

Rejected because the venue owns one fungible account balance per user/chain/token.
Manual exits and Polymarket redemption operate on that aggregate balance, and
pretending that the venue has independent on-chain lots would make reservations,
redemption, and external quantities diverge from reality. The aggregate row and
attributed lot ledger must coexist.

## Implementation contract for S4-M3

Do not allocate the next migration number until the design is reconciled with the
migration ledger. The implementation must land as one coherent change covering:

1. the master-lot schema and replay-safe migration;
2. dual-write and rebuild behavior for aggregate positions and lots;
3. master-aware position and reservation locks;
4. source-sell sizing and unmatched-reduction accounting;
5. subscription wind-down/end transitions and close-all behavior;
6. manual and Polymarket aggregate-exit race keys;
7. stop-loss, capacity, P&L, evidence, and cleanup consumers;
8. unit tests plus database-backed integration tests.

Required integration cases include two masters buying the same token for one user,
one master selling without reducing the other's lot, wind-down ending after only
its own lots close, replayed evidence remaining idempotent, and an aggregate
redemption/close racing a master sell without double execution.

S4-M3 remains open until those runtime and database checks pass.
