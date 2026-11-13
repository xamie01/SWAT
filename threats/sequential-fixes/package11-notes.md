# Package 11 — ingestion remediation checkpoint

Date: 2026-11-13. Authority baseline `8905505595802c21053118b5fab3fd53a8a1654c`; external shared-checkout commits advanced observed HEAD to `99c0e16469934b235372df342de8abc8a2c1a155` during final integration checks. **Status: in-progress.** Latest integrated offline gate: **444 passed / 42 files, zero failures/skips**, focused source-and-test noEmit640 exit 0. See [integrated report](package11-integration-report.md) and the latest checkpoint below. Prior sections are historical source/evidence checkpoints, not current aggregate verdicts. No production or venue acceptance is claimed.

## Corrected source behavior

- Trade paging now has bounded pages/items/streamed bytes and a body-inclusive operation deadline. Opaque cursors are preserved; all visited cursors are checked for cycles. Oversized provider pages, ambiguous v2 terminal envelopes, empty continuation pages and malformed/contradictory metadata are refused. Responses arriving after cancellation are disposed even when the injected transport ignores abort.
- Metadata backfills now share request/time/streamed-byte budgets across trades, Gamma/CLOB fallbacks and optional tick requests; individual body-inclusive deadlines/byte bounds and late-response disposal remain. Missing negative-risk, end-date or tick evidence still refuses context. This bounds metadata network work, not uncancellable DB waits or the entire resolution-poll scan; see the metadata slice below.
- Robinhood receipt classification reconciles signed wallet net transfers in both target and base assets against reviewed pool economics. Unexplained extra-asset flow and pool/wallet disagreement are refused. Canonical target quantities use the reconciled classifier amount, not gross incoming/outgoing transfer sums.
- Solana, Robinhood and Polymarket builders emit `observed` with observation provenance IDs. Receipt success, provider naming and a height/slot are not a separate confirmation certificate. See `apps/indexer/src/source-trade-lifecycle.ts:31–41,87–112,136–169,180–209`.
- Persistence returns `eligibleForCopy` only if both input and stored states are applied states. All current builders supply `observed`; a replay returning a historical `confirmed` or `finalized` row is still ineligible. Four state cases each exercise all three adapters in `source-trade-lifecycle.test.ts`.
- Actual callers honor containment before accepted legacy writes/publication: `apps/indexer/src/index.ts:242–250`, `apps/indexer/src/evm.ts:284–300`, and `apps/indexer/src/polymarket.ts:457–470` (lines may move in subsequent slices). Solana also avoids enrichment/token side effects after quarantine. Polymarket still validates/upserts market context and discovered wallet identity before quarantine.

**Availability consequence:** current observations do not generate accepted legacy trade rows or copy-triggering swap publications. There is no new verified promotion/republication worker. This is deliberate fail-closed containment, not a completed finality feature or a claim that copying remains available.

## Evidence (never combine separate checkpoints into a current pass total)

All commands used `taskset -c 0` and the sequential `run-check.py` offline/credential guard. Synthetic inputs and mocked dependencies only; no DB/Redis/provider operations or listener launch. Logs saying the indexer is running come from importing its entrypoint with workers/Redis/book runtime/timers mocked.

| Evidence label | Result | Scope |
|---|---|---|
| package11-canonical-net-red | 1 failed, 6 passed | Gross canonical target quantity reproduced: 5000 instead of net 500 |
| package11-canonical-net-green | 17 passed / 3 files | Net quantity correction before observation-state change |
| package11-late-response-red / green | 1 failed, 11 passed / 28 passed | Late trade response cancellation |
| package11-late-metadata-red / green | 1 failed, 16 passed / 29 passed | Three late metadata bodies originally uncancelled |
| package11-short-envelope-red / green | 1 failed, 12 passed / 30 passed | Missing short-envelope terminal marker |
| package11-page-limit-red / green | 1 failed, 13 passed / 31 passed | Requested page limit exceeded |
| package11-evidence-state-red / green | 4 failed / 4 passed | Builder observation states |
| package11-observation-publish-red / green | 1 failed / 1 passed, each 7 intentionally skipped | Robinhood public caller quarantine |
| package11-polymarket-observation-red / green | 1 failed / 1 passed, each 17 intentionally skipped | Polymarket public caller quarantine |
| package11-solana-observation-red / green | 2 failed / 2 passed, each 8 intentionally skipped | Both Solana ingestion source labels |
| package11-observation-neighbors | 85 passed / 10 files, 0 skipped | Full current selected ingestion/lifecycle neighbors before terminal consistency correction |
| package11-observation-full-guarded | 254 passed / 30 files, 0 skipped | Entire permitted sequential selection before terminal consistency correction; not repository-wide pnpm test |
| package11-observation-typecheck-640 | Exit 0 | Current source aliases, includes index.ts and ingestion modules, 640 MB heap, before terminal consistency correction |
| package11-null-terminal-red / green | 1 failed, 14 passed / 33 passed, 2 files | Full explicit-null terminal envelope now accepted consistently |
| package11-terminal-full-guarded | 255 passed / 30 files, 0 failed, 0 skipped | Historical permitted selection including terminal correction, before exact-decimal slice |
| package11-terminal-typecheck-640 | Exit 0 | Current source including terminal correction and index.ts, 640 MB heap |

Earlier pagination/unknown-context red and green evidence remains under its original labels. JSON result files accompany Vitest logs; command metadata is appended in `commands.jsonl`. Tests expecting hardcoded confirmation/accepted publication were intentionally updated to observation containment; exact net and immutable-payload assertions remain. The applied-input acceptance branch has no current public certificate-producing path and is **not verified** by these tests.

## Open scopes preventing package closure

1. A verified chain/provider confirmation evidence policy and durable promotion/reversal/republication. No production caller of `advanceSourceTradeConfirmation` was found in the prior targeted source trace. Old confirmed rows were not demoted, audited or reversed; stale input quarantine does not remove their existing downstream eligibility.
2. Stable Polymarket fill/log identity and correction semantics. The current content hash includes economic fields/time, so corrections can create a distinct observation. It does not prove independent fills. Align accepted identity/publication before restoring acceptance.
3. Generic Polygon EVM backfill is now explicitly unavailable at its public entrypoint, containing the inherited gross/first-transfer classifier. A functioning attributable canonical Polygon ingestion path and historical legacy-row repair remain unimplemented. The separate Polymarket fetch-to-observation exact-decimal slice is source-corrected below; historical rounded rows, stable native identity, accepted legacy precision and deployed runtime compatibility remain unresolved.
4. Metadata provenance/freshness, historical poisoned context, active DB wait cancellation and whole-resolution-scan resource bounds/continuation. Shared backfill network request/time/byte bounds are source-corrected below. Cached complete context is not proof of fresh measured safety. Full backfill provider/schema compatibility and short bare-array completeness remain unverified.
5. Health distinguishes counts/errors but not quarantined evidence, cursor coverage or confirmation readiness. Event lag alone is not a complete health policy. Existing-execution retry claim bypasses the fresh source-confirmation guard in the separately ordered execution work.
6. Full builds/dependencies, actual DB role availability, production data correction, venue/runtime compatibility and funded custody remain unapplied/unverified.

## Exact Polymarket decimal slice — 2026-11-13

The canonical trade model now has one authoritative decimal-text size and price, rather than parallel numeric/exact fields. Normalization bounds raw text to 128 characters, exponent magnitude to 36, integer digits to 78 and price/size fractional scale to 36. Strictly positive values and exact price ≤ 1 are required. Both parser and source builder share the price normalizer. Six-decimal outcome atomic conversion uses BigInt and refuses nonzero sub-atomic precision. Exact notional multiplication reuses the existing BigInt decimal multiplier; derived notional may have 42 fractional digits (six-decimal size × scale-36 price). Canonical source price/notional and normalized observation identity never use floating-point multiplication. Number conversion remains only in the quarantined downstream legacy/display projections.

Trade-page JSON parsing retains original numeric size/price tokens through reviver `context.source`; already-quoted decimals remain text. Local Node v22.23.3 supports this capability, verified in `package11-json-source-capability.log`. Missing source-token support refuses numeric economics instead of accepting already-rounded values. This does not recover decimals that a caller previously converted to Number; deployed runtime/provider compatibility remains unverified. No custom wire parser or dependency installation was introduced.

| Evidence label | Result | Scope |
|---|---|---|
| package11-exact-decimal-red / green | 1 failed / 1 passed, each 18 intentionally skipped | Quoted size 9007199254.740993 → atomic quantity 9007199254740993; exact notional 5764607523.03423552 |
| package11-decimal-identity-red / green | 1 failed / 1 passed, each 16 intentionally skipped | Equivalent price/amount spellings converge to identical observation |
| package11-wire-decimal-red / green | 1 failed / 1 passed, each 19 intentionally skipped | Numeric JSON price 0.640000000000000001 originally rounded to 0.64; exact lexeme and notional retained |
| package11-product-scale-red / green | 1 failed, 23 intentionally skipped / 4 passed, 20 intentionally skipped | Derived scale-42 notional retained; three sub-atomic outcome inputs refused |
| package11-decimal-neighbors | 102 passed / 5 files, 0 failed, 0 skipped | Full selected accounting/parser/paging/lifecycle neighbors |
| package11-decimal-full-guarded | 304 passed / 31 files, 0 failed, 0 skipped | Permitted offline selection before review cleanup |
| package11-decimal-typecheck-640 | Exit 0 | Focused current source before review cleanup |
| package11-decimal-reviewed-full | 304 passed / 31 files, 0 failed, 0 skipped | Current permitted offline selection after shared price-normalizer cleanup; not repository-wide test |
| package11-decimal-reviewed-typecheck-640 | Exit 0 | Current focused source after cleanup, CPU0/640 MB |

Standards review found **0 hard violations and 1 low-severity possible duplicated-code smell** in repeated price validation. Review-stage extraction into `normalizePolymarketPrice` addressed that smell without changing policy. Spec review found **0 supported findings**, including the extraction. Both reviews were bounded and read-only; tests were read, not run by reviewers. Main-process post-cleanup tests/compiler passed separately. Original broader review failures remain historical, not erased or converted into passes.

Observation quarantine and its availability consequence are unchanged. No finality certificate, promotion/reversal worker, native fill identity, historical data repair, runtime acceptance, deployment, DB/Redis/provider operation, signing, orders, commits or pushes occurred. Typed acceptance/integration fixtures were updated but infrastructure acceptance was not run. Package 11 remains **in-progress**.

## Aggregate Polymarket metadata backfill slice — 2026-11-13

One budget is created per backfill, before token/fetch side effects (`apps/indexer/src/polymarket.ts:35–70,486`). It is shared by all context lookups and Gamma open/closed, CLOB market and optional tick requests. Defaults are 100 requests, 30,000 ms and 16 MiB aggregate streamed bytes; allowed overrides are 1–1,000 requests, 1–120,000 ms and 1–32 MiB. Each individual response remains bounded to 2 MiB and at most 5,000 ms, clipped to remaining operation time. Stream chunks consume the shared byte budget even if parsing/fallback later fails. Typed exhaustion escapes fallback catches and rejects backfill with `IngestionBatchError` and current counters (`:252–306,341–342,371–372,396–410,607–613`). Fetched counts include unprocessed rows after an abort; they are not invented failures/skips.

The monotonic deadline begins at the first context lookup, after trade-page fetch, and cache completion is checked (`:66–70,418–420`). Post-fetch, each read and post-JSON checks prevent completed responses arriving after the deadline from slipping through before timer dispatch. Stalled bodies and ignored-abort late responses are cancelled. Cached observations spend no metadata network requests/bytes. DB awaits are not actively raced/cancelled; context writes/re-reads and other DB work do **not** have a hard end-to-end wall-time guarantee. Metadata freshness/provenance and historically poisoned context remain open.

The focused compiler caught a neighboring resolution caller missing the new argument (TS2554 at `:675`), and a public regression reproduced no fetch/update. Wiring an unintended scan-wide budget then caused a separate review-stage coverage regression: 101 active market lookups stopped at 100. The correction gives each polling market a fresh budget (`:672–676`), retaining successful resolution updates and existing per-market failure continuation without a shared exhausted prefix. **The whole resolution scan still lacks aggregate bounds and a continuation/rotation policy; this is explicitly not closed by this backfill slice.** Its winner/finality semantics were not independently certified.

| Evidence label | Result | Scope |
|---|---|---|
| package11-metadata-request-budget-red / green | 1 failed / 1 passed; 24 intentionally skipped each | Shared request exhaustion is batch-fatal rather than falling through |
| package11-metadata-deadline-red / green | 1 failed, 25 skipped / 2 passed, 24 skipped | Deadline shared across fallbacks, late response disposal |
| package11-metadata-bytes-red / red-complete / green | 1 failed, 26 skipped in each red / 3 passed, 24 skipped | First red timed out at 10 s; distinct 20 s-test-timeout red captured wrong resolved batch; aggregate byte refusal corrected |
| package11-metadata-late-success-red / green | 1 failed, 27 skipped / 4 passed, 24 skipped | Completed metadata arriving after monotonic deadline refused |
| package11-metadata-neighbors | 112 passed / 4 files, 0 failed, 0 skipped | Full selected parser/backfill/paging/lifecycle neighbors before resolution caller correction |
| package11-metadata-typecheck-red-640 / typecheck-green-640 | Exit 2 (TS2554) / Exit 0 | Missing resolution caller budget argument corrected |
| package11-metadata-resolution-red / green | 1 failed / 1 passed, 38 intentionally skipped each | Successful resolved-market update compatibility |
| package11-metadata-full-guarded | 319 passed / 31 files, 0 failed, 0 skipped | Permitted selection before review-stage polling coverage correction |
| package11-metadata-poll-coverage-red / green | 1 failed, 39 skipped / 2 passed, 38 skipped | Prefix starvation reproduced, per-market polling budget restores coverage |
| package11-metadata-reviewed-full | **320 passed / 31 files, 0 failed, 0 skipped** | Final permitted offline selection; includes 40 Polymarket cases and distinct 101-market fixtures; not repository-wide test |
| package11-metadata-reviewed-typecheck-640 | **Exit 0** | Final focused source noEmit, source aliases, CPU0/640 MB |

### Standards

Initial bounded review: 0 hard documented violations; 2 possible smells (low duplicated Gamma matching and medium scattered polling exhaustion policy). Recheck withdrew the medium concern after per-market polling correction. Final verdict: **0 hard violations, 0 remaining new smells, 1 inherited low nonblocking duplication heuristic**. The Gamma matching shape predates this slice and no root defect was supported; optional extraction was not performed. Reader cleanup had no supported defect.

### Spec

Initial bounded review: 2 findings in unintended scan-wide polling behavior—swallowed exhaustion and prefix starvation. Both were resolved at the scoped compatibility boundary by per-market polling budgets; final recheck found **0 remaining supported findings**. Scan-wide bounds/scheduling remain expressly open, not treated as a completed feature. Both axes were read-only; reviewers inspected tests but did not run them. Main-process final tests/typecheck passed separately.

All application checks remained guarded/offline and sequential on CPU0. Exact-decimal accounting and observed/ineligible quarantine are unchanged. No DB/Redis/provider operations, credentials, services, migrations, signing, orders, deployment, commits or pushes. Package 11 remains **in-progress**. Historical results and broader review limitations remain retained. The evidence inventory found an existing non-JSON line in `commands.jsonl` (line 11) and repeated historical deadline labels; neither was rewritten. The summary reader skipped that malformed line without altering source evidence. Current-session evidence labels were new.

## Generic Polygon attribution containment — 2026-11-13

`backfillEvmWallet` now refuses any non-Robinhood chain as its first function-body step (`apps/indexer/src/evm.ts:157–170`), before address resolution/client selection/backfill RPC, metadata, pricing, legacy writes or swap publication. The error explicitly states that generic Polygon backfill is unavailable without reviewed swap attribution and canonical evidence. The helper does not narrow the function's compile-time chain union, so the runtime public boundary remains testable and caller compatibility remains unchanged. This is unavailable containment, **not** a functioning Polygon classifier or native-value/finality implementation. Inherited module-level Redis initialization (`evm.ts:46`) is outside the function-invocation no-side-effect guarantee; tests mock it.

The first red fixture was incomplete (`getTransaction` absent) and reached RPC/metadata before resolving a failed batch; that red is retained but does not prove successful misclassification. A distinct complete-fixture red added a zero-native-value transaction and reproduced an inserted legacy trade for a transfer-only input. Production source was unchanged between red runs. The guard then passed the no-invocation-side-effect assertions (`evm-source-lifecycle.test.ts:164–179`) and all selected reviewed Robinhood neighbors.

Actual Polygon job wiring uses the separate Polymarket backfill, while the EVM function is called with Robinhood (`apps/indexer/src/index.ts:613–617`; `backfill-worker.ts:43–55`). Tracked ingestion errors are recorded/rethrown instead of claiming completion (`ingestion-health.ts:36–66`). Reviewers traced these callers; no new test independently exercises worker/UI error propagation.

| Evidence label | Result | Scope |
|---|---|---|
| package11-polygon-attribution-red | 1 failed, 8 intentionally skipped | Incomplete fixture still ran unsupported path and resolved failed batch |
| package11-polygon-attribution-red-complete | 1 failed, 8 intentionally skipped | Complete transfer-only fixture incorrectly resolved inserted=1 |
| package11-polygon-attribution-green | 19 passed / 3 files, 0 failed, 0 skipped | Public refusal and reviewed Robinhood classifier/lifecycle neighbors |
| package11-polygon-full-guarded | **321 passed / 31 files, 0 failed, 0 skipped** | Current entire permitted offline selection, not whole repository |
| package11-polygon-typecheck-640 | **Exit 0** | Current focused source noEmit, CPU0/640 MB |

### Standards

Bounded review found **0 hard documented violations and 0 new supported smells**. The guard supports the no-fabricated-fill constraint and is not speculative delegation. The retained unreachable generic classifier is inherited, not a new defect attributed to this guard.

### Spec

Bounded review found **0 supported missing/partial, incorrect-implementation or scope-creep findings**. Explicit refusal and reviewed Robinhood/separate Polymarket caller compatibility were traced. Reviewers read tests but did not run them; main-process current checks passed separately. No cleanup was required after review.

No historical rows were repaired, demoted or reversed. Native identity, finality/promotion, metadata provenance/DB waits/whole-poll bounds, health and runtime gates still prevent package closure. All local checks used CPU0 and offline/credential guards; no DB/Redis/provider operations, services, credentials, signing, orders, migrations, production changes, commits or pushes occurred. Package 11 remains **in-progress**.

## Review status

The original independent Standards/Spec agents did not deliver verdicts: Standards failed twice on provider token rate limits; Spec failed on a provider rejection. They are not counted as review passes.

A narrower read-only retry completed after those failures:

### Standards
Static containment review passed. Both incoming and stored state are required by `source-trade-lifecycle.ts:36–37`; all builders emit observed. Guards precede accepted legacy writes/publication in Solana, Polymarket and reviewed Robinhood callers. Polymarket context/wallet upserts occur before its guard but are not accepted-trade writes. **No introduced bug identified in this reviewed slice.** This was not a full documented-standards/diff review of every package11 change.

### Spec
Selected containment and terminal-pagination requirements passed static review. Explicit null cursor terminates full envelopes; missing/contradictory object metadata and full bare-array ambiguity refuse. The reviewer retained package11 as in progress and called out confirmation/reversal, historical rows, content-hash identity/numeric quantities, metadata provenance/global bounds and generic Polygon as unresolved—not closures. Only Read tools were used; the reviewer did not verify tests or diff attribution.

Result: no findings in the narrow Standards axis or narrow Spec axis; both broader original axes remain review-incomplete. Green source checks and this bounded review do not establish runtime or full package acceptance.

## Concurrent aspects and end-to-end integration — latest 2026-11-13 checkpoint

Six agents owned identity, confirmation/history, metadata, whole polling, health/readiness and acceptance gates concurrently in separate files. Compiler/test processes remained serialized under the shared flock on CPU0. A separate integrator connected their contracts. Main reviewed final reports, not duplicate source implementations.

Current source supersedes several historical open-scope statements above:

- The economic/time identity hash is replaced by an explicitly ambiguous transaction/wallet group. Native fill uniqueness still is not available; changed immutable payload refuses rather than becoming another fill.
- Unavailable-verifier fences now refuse applied/reversed intake, confirmation advancement and fresh downstream eligibility even for stored historical applied labels. Observation replay never reapplies/rebuilds source positions. Historical rows and existing execution retries are not repaired.
- Historical complete caches are not trusted; backfills retrieve provider evidence and reuse only operation-local per-asset snapshots. Persisted mapping/risk/tick/end-date/lifecycle comparison, explicit CLOB condition, unique mapping and scalar tick evidence precede continuation. This is not cryptographic or trade-time provenance.
- Whole polling uses finite-keyset durable lease/cursor storage, bounded shared network work and pessimistic pre-network attempt reservations. Missing UNAPPLIED schema fails closed. Price-derived winners are removed; even complete metadata enumeration has blocked economic resolution and the public wrapper rejects. Hard DB/transport cancellation remains unproven.
- Health now exposes observation/quarantine/acceptance attempt evidence and coverage/withheld confirmation. Recent observations are unready; absent optional JSONB schema is unknown/null. Fatal errors downgrade completeness to partial. Alert display explicitly says UNREADY and unknown counters.

**Latest actual integrated checks:** `package11-integration-final-guarded` **444 passed / 42 files, zero failed/skipped, exit0**, finished `2026-11-13T22:36:51.890603Z`; `package11-integration-source-tests-typecheck-green-640` focused source-and-test noEmit **exit0**. Public missing-schema and alert-evidence reds were retained; the initial expanded typecheck had eight fixture diagnostics, corrected minimally with separate evidence. Never add aspect/historical pass totals. This is the permitted offline/mock selection, not full repository or operational acceptance.

Reports: `package11-integration-report.md` and `package11-aspect-{identity,finality,metadata,polling,health,acceptance}-report.md`. Aspect self-reviews are not independent approval. Stable integrated independent Standards/Spec review is pending at this checkpoint.

**Still open:** trusted native identity/verifier/promotion/reversal/republication, historical repair/downstream reconciliation, functional generic Polygon ingestion, dormant accepted legacy identity/precision/fee/rawSQL authority boundaries, actual schema/global role capabilities/pool topology/transaction and transport acceptance, artifacts/full safe builds/runtime/provider compatibility, venue/legal/funded custody certification, and later-package existing-execution retry bypass. Poll/evidence DDL and SQL070 are UNAPPLIED. Package11 remains in-progress;12–29pending.

**Shared-checkout drift:** external commits `5d0558d5530ae7af3ecea2edfb3bda43d0cbccec` (22:34:22Z) and `99c0e16469934b235372df342de8abc8a2c1a155` (22:35:11Z) appeared during verification. Integrator reported its source/config identical to current HEAD. Temporary SSR files tracked externally were later removed by normal Vitest cleanup; no manual recovery. This session performed no commit/push/reset/clean, so earlier no-commit statements describe earlier checkpoints, not the entire final checkout. No live providers/DB/Redis/services/credentials/signing/orders/funds/migrations/deployment by this session.

