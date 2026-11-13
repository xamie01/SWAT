# Package 11 — fill identity aspect

Coordinator record of the identity owner's returned final report, 2026-11-13. Baseline: `8905505595802c21053118b5fab3fd53a8a1654c`. This records delegated source work and actual checks; it is not an independent review or current aggregate acceptance. Package 11 remains **in-progress**. The aspect owner returned this report directly rather than writing Markdown.

## Implemented containment

**High severity; verified source behavior and mocked regressions.** The previous economic/time content hash distinguished corrected reports as purported independent fills while collapsing identical independent fills. A reliable native provider fill/log ID was not substantiated.

`apps/indexer/src/source-trade-lifecycle.ts:121–155` now uses:

- `sourceEventType: venue_trade`;
- `sourceEventId: normalized transactionHash`;
- `sourceEventIndex: ambiguous-data-api-wallet-v1:<normalized raw wallet>`.

This is an explicitly ambiguous transaction/wallet observation group, **not a fill ID**. Economic/time/token/side changes keep the same group identity, so the existing persisted immutable payload contract can reject a collision. Identical reports remain ambiguous. Current builders remain observed; input observation eligibility stays false regardless of the returned historical stored state.

`apps/indexer/src/polymarket-helpers.ts:146–179` rejects contradictory transaction/wallet aliases and malformed explicit aliases. Unknown `id`, `trade_id`, `logIndex`, status or certificate claims confer no identity or confirmation authority. Exact decimal text remains authoritative.

Read-time line citations can move during later integration.

## Changed files

- `apps/indexer/src/source-trade-lifecycle.ts`
- `apps/indexer/src/source-trade-lifecycle.test.ts`
- `apps/indexer/src/source-trade-lifecycle.sequential.test.ts`
- `apps/indexer/src/polymarket-helpers.ts`
- `apps/indexer/src/polymarket-helpers.test.ts`
- `apps/indexer/src/polymarket-identity.sequential.test.ts` (new)

## Actual checks

All test/compiler workloads used CPU 0, the shared flock and offline guarded runner. Evidence is in this directory; test labels identify corresponding JSON/log files.

| Label | Result |
|---|---|
| package11-identity-group-red | 1 failed, 4 passed / 1 file |
| package11-identity-group-green | 22 passed / 2 files |
| package11-identity-alias-red | 2 failed, 42 passed / 1 file |
| package11-identity-alias-green | 66 passed / 3 files |
| package11-identity-caller-contract | Fixture transform failure; 71 tests passed / 3 files, 1 suite failed |
| package11-identity-caller-contract-fixed | 77 passed / 4 files |
| package11-identity-neighbors | 5 failed, 163 passed / 9 files |
| package11-identity-typecheck-640 | Focused source noEmit exit 0 |
| package11-identity-reviewed-focused | 78 passed / 4 files, no skips |

The five neighbor failures were in concurrently edited `polymarket.test.ts` metadata fixtures, not edited by the identity owner. They were relayed and retained. The metadata owner subsequently reported corrected final neighbors; only a later combined gate can establish the integrated result. Do not add checkpoint totals.

The actual public backfill/parser/adapter tests with mocked persistence cover all four returned stored states, same-group correction conflict propagation, zero accepted legacy writes/publication, original numeric wire tokens and exact BigInt economics. DB collision enforcement was a mocked contract here, not actual PostgreSQL verification. Scoped tracked-file whitespace check passed.

## Review and unresolved contracts

The owner performed bounded self-review: no supported new hard standards violations or blocking smells, and no supported defect in the implemented ambiguity containment. **No independent reviewer approval was claimed.**

The finality owner's global unavailable-verifier fence must cover both this new namespace and old content-hash identities. Observations must not reapply historical positions. Nullable observation positions are compatible with adapter result spreading.

Dormant accepted publication remains blocked. At the owner's read-time checkpoint, `apps/indexer/src/polymarket.ts:572–587` still inserted a legacy transaction with transaction-hash-only signature. `packages/db/src/transactions.ts:131` deduplicates by `(chain, signature, wallet, target_token)`, which cannot reliably preserve independent same-token fills. Before restoring acceptance, require reviewed native fill/log identity, legitimate authority bound to exact canonical payload/state, durable canonical-source linkage with the real transaction hash preserved, and explicit replay/correction/reversal/republication semantics.

`packages/db/src/polymarket.ts:262–286` retains economic/time deduplication, and `packages/db/sql/026_polymarket_context.sql:30–31` retains scale-18 legacy decimals. These are blocked acceptance boundaries, not fixed by identity quarantine.

Canonical immutable comparison does not preserve condition ID, outcome or title. A conflicting report is rejected, not durably retained as a revision or automatically applied. No historical namespace migration, repair, demotion or downstream reconciliation occurred.

No live provider/DB/Redis calls, credentials, services, applied migrations, signing, orders, deployment, commits or pushes occurred. Native-fill uniqueness, functioning finality and financial availability remain unavailable or unverified.
