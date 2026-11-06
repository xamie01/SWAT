# 05 — Indexer and parser defensive source review

Local source review, 2026-11-06. No network requests, real environment/credential reads, source changes, or test execution. Deployment, provider contracts, chain state, and installed schedules are **NOT VERIFIED**. Citations are absolute paths; ranges identify the implementation examined, not evidence of production execution. Confidence means **Verified** = code plus actual callers traced end-to-end; **Likely** = concrete defect with an unverified triggering venue/input condition; **Needs check** = missing external evidence. No Critical finding is established.

## A. Trust boundaries and ingestion map

The documented boundary is indexer → signals → executor, with durable BullMQ work distinct from fire-and-forget Redis messages and chain-prefixed storage (/home/xahmie/Documents/SWAT/README.md:54-67; /home/xahmie/Documents/SWAT/docs/PRD.md:270-287). The README's functional/test claims are documentation, not independently verified results (/home/xahmie/Documents/SWAT/README.md:26-33).

1. **Helius HTTP → trusted source trade.** Exact configured Authorization is hashed and constant-time compared, and missing configuration rejects requests; it is a static bearer, not a signed event/freshness proof (/home/xahmie/Documents/SWAT/apps/indexer/src/webhook-helpers.ts:35-43; /home/xahmie/Documents/SWAT/apps/indexer/src/webhook.ts:17-24,39-45). Candidate accounts are restricted to locally tracked Solana wallets before processing; each event and wallet has an exception boundary and failures return 503 after health recording (/home/xahmie/Documents/SWAT/apps/indexer/src/webhook.ts:28-36,51-118). HTTP transport/TLS, secret strength, provider retries, and rate limiting are NOT VERIFIED.
2. **RPC/account deltas → classification.** Solana backfill requests confirmed parsed transactions, then invokes the same parser as webhooks; token metadata/prices are separate mutable enrichments (/home/xahmie/Documents/SWAT/apps/indexer/src/index.ts:251-305,530-585). Robinhood logs lead to receipts and reviewed-router/pool classification; the indexer intentionally leaves RPC chain identity to another startup gate (/home/xahmie/Documents/SWAT/apps/indexer/src/evm.ts:75-85,252-282). This review does not independently establish that gate's execution.
3. **Venue API → market context/source event.** Polymarket Data API rows supply wallet, side, asset, quantity, price and transaction identity; market/outcome mapping is checked before persistence (/home/xahmie/Documents/SWAT/apps/indexer/src/polymarket-helpers.ts:110-133; /home/xahmie/Documents/SWAT/apps/indexer/src/polymarket.ts:230-279,321-376). No receipt verification occurs on this path; “confirmed” is the local interpretation of this API (/home/xahmie/Documents/SWAT/apps/indexer/src/source-trade-lifecycle.ts:148-163).
4. **Independent DB writes → signals.** Legacy transaction insertion precedes atomic canonical source persistence; source identity collisions with differing payloads throw, and source position rebuilding is inside the canonical transaction (/home/xahmie/Documents/SWAT/apps/indexer/src/index.ts:285-305; /home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:633-716). Actual signal polling selects confirmed/finalized active scored sources, within an age window; pub/sub is an acceleration, not the sole delivery mechanism (/home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:858-884; /home/xahmie/Documents/SWAT/apps/signal-engine/src/index.ts:591-646,693-724).

**Entrypoint/schedule/subscriber map (source wiring, not deployment verification).** `/webhook/helius` and `/webhook/health` are registered and the listener binds 0.0.0.0 outside test mode (/home/xahmie/Documents/SWAT/apps/indexer/src/webhook.ts:39,121-129). Importing the indexer starts wallet-backfill and token-discovery workers, optional seed ingestion, 15-minute resolution polling plus immediate poll, the book runtime, immediate subscription refresh and a five-minute refresh timer (/home/xahmie/Documents/SWAT/apps/indexer/src/index.ts:621-670,704-745). Backfill dispatch maps Solana→backfillWallet, Polygon→Polymarket, Robinhood→EVM; it also immediately scores after a completed batch (/home/xahmie/Documents/SWAT/apps/indexer/src/backfill-worker.ts:21-24,39-67). Wallet swaps publish to Redis from all three ingestors; the signal engine subscribes and polls every 15 seconds (/home/xahmie/Documents/SWAT/apps/indexer/src/index.ts:313-325; /home/xahmie/Documents/SWAT/apps/indexer/src/evm.ts:499-512; /home/xahmie/Documents/SWAT/apps/indexer/src/polymarket.ts:393-409; /home/xahmie/Documents/SWAT/apps/signal-engine/src/index.ts:693-724). Book transport internals are not reviewed.

## B. Findings

| ID | Severity | Confidence | file:line | Abuse scenario (≤3 steps) | Code-level fix |
|---|---|---|---|---|---|
| IDX-01 | High | Verified | /home/xahmie/Documents/SWAT/apps/indexer/src/parse.ts:183-209,234-260; /home/xahmie/Documents/SWAT/apps/indexer/src/index.ts:157-164,251-305; /home/xahmie/Documents/SWAT/apps/signal-engine/src/index.ts:597-631 | 1. Observe opposite-sign non-swap balances. 2. Parser assigns a trade without success/instruction proof; allowlist only labels it. 3. False source inventory reaches copying. | Require successful, wallet-linked supported swap evidence before canonical construction. |
| IDX-02 | High | Verified | /home/xahmie/Documents/SWAT/apps/indexer/src/parse.ts:138-155,179-209; /home/xahmie/Documents/SWAT/apps/indexer/src/index.ts:285-324; /home/xahmie/Documents/SWAT/apps/indexer/src/source-trade-lifecycle.ts:81-106 | 1. Supply mixed-decimal multi-leg balances. 2. Largest raw +/- integer substitutes target/quote. 3. Wrong direction/quantity reaches canonical sizing. | Attribute decoded route legs; reject ambiguity instead of ranking raw units. |
| IDX-03 | Medium | Verified | /home/xahmie/Documents/SWAT/apps/indexer/src/webhook.ts:64-75; /home/xahmie/Documents/SWAT/apps/indexer/src/webhook-helpers.ts:102-133; /home/xahmie/Documents/SWAT/apps/indexer/src/parse.ts:76-78,162-176 | 1. Tracked non-payer is placed at index zero with full fee. 2. Parser refunds another account's fee or includes rent. 3. Enhanced/raw quantities diverge. | Preserve payer identity; distinguish native swap flows from rent/wrapping. |
| IDX-04 | Medium | Verified | /home/xahmie/Documents/SWAT/apps/indexer/src/source-trade-lifecycle.ts:92-105,148-163,188-203; /home/xahmie/Documents/SWAT/apps/indexer/src/evm.ts:166-195; /home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:719-746,872-880 (external reversal incidence: Needs check) | 1. Observe provisional event asserted confirmed by builders. 2. No production confirmation-advancement caller was found. 3. Reversal can leave stale source inventory; actual occurrence NOT VERIFIED. | Define source evidence levels and wire finality/reversal reconciliation. |
| IDX-05 | Medium | Likely | /home/xahmie/Documents/SWAT/apps/indexer/src/source-trade-lifecycle.ts:116-163; /home/xahmie/Documents/SWAT/packages/db/src/transactions.ts:110-132; /home/xahmie/Documents/SWAT/apps/indexer/src/polymarket.ts:355-390; /home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:644-645,700-710 | 1. If the API exposes identical split fills or corrected economic fields, canonical identity hashes quantity/price/time while legacy identity does not. 2. Fills may collapse or corrections add an event. 3. Ledgers diverge. Provider fill contract NOT VERIFIED; no demonstrated High exploitation. | Use documented stable fill/log identity with explicit aggregation/correction semantics; validate actual-contract fixtures before raising severity. |
| IDX-06 | Medium | Verified | /home/xahmie/Documents/SWAT/apps/indexer/src/robinhood-ingestion.ts:190-262; /home/xahmie/Documents/SWAT/apps/indexer/src/evm.ts:313-329,455-488 | 1. Reviewed pool route contains opposing/multi-beneficiary transfers. 2. Legacy pool amounts and canonical gross wallet quantity are not net-attributed. 3. Source inventory is overstated. | Reconcile wallet net inventory with attributed route flow; reject mismatches. |
| IDX-07 | Medium | Verified | /home/xahmie/Documents/SWAT/apps/indexer/src/polymarket.ts:152-157,180-185,199-209,245-272; /home/xahmie/Documents/SWAT/packages/db/src/polymarket.ts:146-174 | 1. Risk/tick/end metadata is missing. 2. Fallback synthesizes complete safe-looking context. 3. Unknown risk appears measured. | Preserve unknown fields; withhold complete status without authoritative evidence. |
| IDX-08 | Medium | Verified | /home/xahmie/Documents/SWAT/apps/indexer/src/polymarket.ts:67-128,314-317; /home/xahmie/Documents/SWAT/apps/indexer/src/index.ts:91-109,130-153,261-283 | 1. Cursor cycles/nonterminating pages or hanging metadata are encountered. 2. No total budget bounds work. 3. Worker memory/latency grows. | Bound pages/items/bytes and operation deadlines; quarantine bad rows independently. |

### Numbered remediation and neighboring compatibility

1. **IDX-01/02: introduce typed provenance, not another downstream side filter.** Require successful transaction evidence and decoded supported swap instructions tied to wallet inputs/outputs. Reject ambiguous multi-action routes into an explicit non-mirrorable classification. Keep quantity atomic and metadata separate; the existing source payload intentionally excludes target decimals/prices for Solana replay stability (/home/xahmie/Documents/SWAT/apps/indexer/src/source-trade-lifecycle.ts:64-78). Preserve canonical event identity across HTTP/RPC, and update discovery deliberately: its buyer extraction currently counts net receivers, not proven purchases (/home/xahmie/Documents/SWAT/apps/indexer/src/parse.ts:278-305; /home/xahmie/Documents/SWAT/apps/indexer/src/index.ts:449-459). The current mirrorability gate only knows the already assigned side, so it cannot repair a fabricated buy (/home/xahmie/Documents/SWAT/apps/signal-engine/src/mirrorable-activity.ts:220-245).
2. **IDX-03: repair normalization before quantities are persisted.** Keep real payer separately, apply fees only to that payer, and account for ATA creation, close-account refunds and wrapped/native SOL without arbitrary magnitude heuristics. Plan historical reconciliation rather than silently changing immutable source quantities: differing replay payloads are rejected (/home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:665-710). Existing parity fixtures always make the tracked wallet the payer and therefore do not establish non-payer correctness (/home/xahmie/Documents/SWAT/apps/indexer/src/solana-parity.test.ts:35-78).
3. **IDX-04: make confirmation evidence operational.** Separate successful observation from finality and retain block identity for reorg checks. Wire confirmation history/position rebuild through the existing advancement interface, while ensuring previously emitted copies get an explicit reconciliation policy rather than another trade (/home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:550-601,719-746). Do not confuse Robinhood sequencer trust documentation with a finality implementation (/home/xahmie/Documents/SWAT/docs/adr/0006-robinhood-sequencer-trust.md:92-105).
4. **IDX-05/06: unify accounting identity and quantity semantics.** Obtain stable fill identifiers or documented deterministic aggregation; aggregate legacy rows consistently and make corrections explicit. For Robinhood use wallet net quantity, not gross sends/receipts or all reviewed-pool activity. Preserve source-event foreign-key compatibility and migrate already persisted collisions with an audited reconciliation, not deletion. Legacy persistence and canonical persistence are separate, but canonical polling repairs a missed publish after canonical success; do not incorrectly report every duplicate/no-publish as a lost mirror (/home/xahmie/Documents/SWAT/apps/indexer/src/polymarket.ts:372-390; /home/xahmie/Documents/SWAT/apps/signal-engine/src/index.ts:591-596,693-724).
5. **IDX-07/08: make unknowns and incomplete work visible.** Require explicit risk metadata; distinguish unavailable context from false neg-risk and keep stale/missing state non-complete. Add cursor visited-set, maximum page/item/byte budgets and total deadlines without breaking legitimate historical paging. Maintain existing per-row/wallet exception isolation and record partial failures: webhook isolation is already present, while backfill health records failed counters even when the batch returns normally (/home/xahmie/Documents/SWAT/apps/indexer/src/webhook.ts:51-108; /home/xahmie/Documents/SWAT/apps/indexer/src/ingestion-health.ts:36-78).

## C. Local invariants and proposed tests

**Tests were not run.** Descriptions below require synthetic fixtures/mocks only, never live services or real credentials.

- Assert transfer-only, LP deposit/withdrawal, failed transaction and unrelated-program opposite-delta events never create mirrorable sources; add mixed-decimal multi-leg routes that must reject rather than choose a largest integer. Targets are /home/xahmie/Documents/SWAT/apps/indexer/src/parse.ts:138-260 and actual ingestion /home/xahmie/Documents/SWAT/apps/indexer/src/index.ts:251-305.
- Compare raw/enhanced normalization for non-fee-payer masters, rent creation/refund and wrap/unwrap. Current source parity covers normal two-sided payer fixtures only (/home/xahmie/Documents/SWAT/apps/indexer/src/solana-parity.test.ts:81-188).
- Inject malformed BigInt, valid-invalid-valid event batches and persistence failures; assert valid neighbors persist, retry status is honest, and duplicates cannot apply position twice. Existing webhook lifecycle test checks one mocked failure, not mixed-batch parser behavior (/home/xahmie/Documents/SWAT/apps/indexer/src/webhook-source-lifecycle.test.ts:36-60).
- Exercise two identical legitimate fills, distinct prices within one transaction, correction replay and canonical/legacy write failure boundaries. Existing Polymarket tests cover duplicate legacy repair and lifecycle failure, not stable venue fill identity (/home/xahmie/Documents/SWAT/apps/indexer/src/polymarket.test.ts:202-263).
- Test Robinhood reviewed-router transactions containing opposing wallet transfers and multi-beneficiary pool swaps; verify canonical quantity equals attributed net inventory (/home/xahmie/Documents/SWAT/apps/indexer/src/robinhood-ingestion.ts:229-262; /home/xahmie/Documents/SWAT/apps/indexer/src/evm.ts:473-488).
- Test missing risk metadata, cursor A→B→A, oversized pages, hanging metadata mocks, and confirmed→reversed source rebuilding (/home/xahmie/Documents/SWAT/apps/indexer/src/polymarket.ts:73-128,131-217; /home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:719-746).

## D. Not reviewed and evidence limits

No live provider schema/guarantees, HTTP infrastructure, deployment configuration, chain certification evidence, actual cron installation, real secrets, compiled artifacts, dependency internals, full history, Rust programs, LP engine, executor transaction construction or book transport integrity was verified. No current Critical/High was inferred solely from a comment: High IDX-01/02 were reread with targeted parser→builder→persistence→signal queries; IDX-05 was also rechecked and is Medium/Likely because actual API fill semantics are unavailable. Shelf-life caller verification continues in report 06 rather than importing earlier assumptions.

### Appendix — depth manifest

**In depth:** /home/xahmie/Documents/SWAT/apps/indexer/src/{index.ts,parse.ts,webhook.ts,webhook-helpers.ts,source-trade-lifecycle.ts,evm.ts,robinhood-ingestion.ts,polymarket.ts,polymarket-helpers.ts,backfill-worker.ts,ingestion-health.ts,solana-parity.test.ts,webhook-source-lifecycle.test.ts}; /home/xahmie/Documents/SWAT/packages/db/src/transactions.ts. Brace lists denote individual absolute paths, not entire directories.

**Skim/targeted ranges:** /home/xahmie/Documents/SWAT/README.md; /home/xahmie/Documents/SWAT/docs/PRD.md; /home/xahmie/Documents/SWAT/docs/adr/0006-robinhood-sequencer-trust.md; /home/xahmie/Documents/SWAT/.env.example; /home/xahmie/Documents/SWAT/apps/indexer/src/{polymarket.test.ts,parse.test.ts}; /home/xahmie/Documents/SWAT/packages/db/src/{copy-trade-lifecycle.ts,polymarket.ts}; /home/xahmie/Documents/SWAT/apps/signal-engine/src/{index.ts,mirrorable-activity.ts}; /home/xahmie/Documents/SWAT/deploy/crontab.example. Full lifecycle/db/book coverage is not implied by these targeted reads.

**Not reviewed:** remaining files, particularly /home/xahmie/Documents/SWAT/apps/indexer/src/{polymarket-book-runtime.ts,polymarket-book-subscriber.ts,backfill-usd.ts,backfill-worker.test.ts,robinhood-ingestion.test.ts,source-trade-lifecycle.test.ts}; real environment/credential files, node_modules, dist, locks and history excluded by scope.

**Machine-readable coverage for main-owned persistence at /home/xahmie/Documents/SWAT/threats/evidence/05-indexer-parsers-coverage.json.** `excluded: []` lists no additional enumerated paths; it does not mean full repository coverage. The exclusions and unread categories above remain in force.

```json
{
  "deep": [
    "/home/xahmie/Documents/SWAT/apps/indexer/src/index.ts",
    "/home/xahmie/Documents/SWAT/apps/indexer/src/parse.ts",
    "/home/xahmie/Documents/SWAT/apps/indexer/src/webhook.ts",
    "/home/xahmie/Documents/SWAT/apps/indexer/src/webhook-helpers.ts",
    "/home/xahmie/Documents/SWAT/apps/indexer/src/source-trade-lifecycle.ts",
    "/home/xahmie/Documents/SWAT/apps/indexer/src/evm.ts",
    "/home/xahmie/Documents/SWAT/apps/indexer/src/robinhood-ingestion.ts",
    "/home/xahmie/Documents/SWAT/apps/indexer/src/polymarket.ts",
    "/home/xahmie/Documents/SWAT/apps/indexer/src/polymarket-helpers.ts",
    "/home/xahmie/Documents/SWAT/apps/indexer/src/backfill-worker.ts",
    "/home/xahmie/Documents/SWAT/apps/indexer/src/ingestion-health.ts",
    "/home/xahmie/Documents/SWAT/apps/indexer/src/solana-parity.test.ts",
    "/home/xahmie/Documents/SWAT/apps/indexer/src/webhook-source-lifecycle.test.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/transactions.ts"
  ],
  "skim": [
    "/home/xahmie/Documents/SWAT/README.md",
    "/home/xahmie/Documents/SWAT/docs/PRD.md",
    "/home/xahmie/Documents/SWAT/docs/adr/0006-robinhood-sequencer-trust.md",
    "/home/xahmie/Documents/SWAT/.env.example",
    "/home/xahmie/Documents/SWAT/apps/indexer/src/polymarket.test.ts",
    "/home/xahmie/Documents/SWAT/apps/indexer/src/parse.test.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/polymarket.ts",
    "/home/xahmie/Documents/SWAT/apps/signal-engine/src/index.ts",
    "/home/xahmie/Documents/SWAT/apps/signal-engine/src/mirrorable-activity.ts",
    "/home/xahmie/Documents/SWAT/deploy/crontab.example"
  ],
  "excluded": []
}
```
