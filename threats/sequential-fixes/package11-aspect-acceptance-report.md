# Package11 aspect — acceptance / unverifiable gates

Date: 2026-11-13. Authority baseline: `8905505595802c21053118b5fab3fd53a8a1654c`, verified with `git rev-parse HEAD`. Existing dirty, uncommitted remediation checkout preserved. **Aspect complete as an offline evidence/checklist deliverable; package11 remains IN-PROGRESS, NOT CLOSED, NOT DEPLOYED, NOT externally certified.** This report does not adjudicate concurrent identity, finality/history, metadata, polling or health implementations. Those peers own their source changes and final evidence; observations below are the bounded source snapshot inspected during this aspect, not a combined final pass.

All paths below are rooted at `/home/xahmie/Documents/SWAT`; citations use repository-relative `file:line` for readability. Line references are the actual read-time checkpoints; concurrent peer edits moved lines during this aspect. Sections 5–7 explicitly note observed identity/finality/health changes at final handoff rather than treating the initial snapshot as their final verdict. Only this report and the uniquely named mocked test are intentional edits. The existing runner generated new-label log/JSON evidence and appended its normal command record; its source/config/guard and the global ledger/notes were not edited. No live PostgreSQL, Redis, provider access, credential/dotenv reads, services, signing, orders, funds, migrations, deployment, installation, production changes, commits or pushes were performed. No external certification is claimed.

## 1. Actual checks and evidence limits

### New executable offline acceptance probe

Owned test: `apps/indexer/src/package11-acceptance-runtime-capability.sequential.test.ts`. It calls the production public page reader and pure trade parser with in-memory `Response` bodies, replaces the DB module with an empty mock, and never calls backfill, a service entrypoint, a DB query, Redis or real fetch.

Executed once, under CPU0 and the shared serialization lock:

```bash
taskset -c 0 flock /tmp/swat-package11-checks.lock python3 /home/xahmie/Documents/SWAT/threats/sequential-fixes/run-check.py package11-acceptance-runtime-capability-green node node_modules/vitest/vitest.mjs run --config threats/sequential-fixes/vitest.config.ts apps/indexer/src/package11-acceptance-runtime-capability.sequential.test.ts --hookTimeout 60000
```

Result: **exit 0; 3 passed / 1 file, 0 failed, 0 skipped**, finished `2026-11-13T21:38:46.349780+00:00`; runner elapsed 7.512 seconds. Runtime actually logged **Node v22.23.3**. Evidence:

- `threats/sequential-fixes/package11-acceptance-runtime-capability-green.log`
- `threats/sequential-fixes/package11-acceptance-runtime-capability-green.json`
- `threats/sequential-fixes/commands.jsonl` new-label command record (line 187 at inspection; subsequent peer records may append).

Assertions prove these limited local facts:

1. Unquoted wire `size=9007199254.740993` and `price=0.640000000000000001` survive this installed runtime and public reader as exact decimal text.
2. Emulating a parser that supplies only the older two-argument reviver contract makes the same public reader reject numeric economics with `Polymarket exact JSON number parsing unavailable`, rather than accept rounded values.
3. Provider-quoted decimal text remains exact without numeric reviver source context.

This is a capability/fail-closed probe, not a red-to-green production fix, a full backfill integration, native event identity proof, an actual older-Node binary test, or deployment acceptance. Vitest transformed the test; **no separate compiler was run by this aspect**. Production's source-token dependency/refusal is `apps/indexer/src/polymarket.ts:168–176`; decimal normalization is `apps/indexer/src/polymarket-helpers.ts:63–95,144–166`. An input already converted to Number cannot recover its original token: normalization uses `String(value)` (`polymarket-helpers.ts:65–67`). The probe therefore exercises raw wire text, not a `JSON.stringify` of already-rounded economics.

### Inherited evidence inspected, not rerun or added together

- `package11-polygon-full-guarded.json`: 321 passed / 31 result files, 0 failed/pending, success true; associated command finished `2026-11-13T21:12:57.541190+00:00`, exit 0. This is the pre-concurrency permitted selection, **not repository-wide `pnpm test` and not a current combined peer checkpoint**.
- `package11-polygon-typecheck-640.log` and its command record: focused source check exit 0, finished `2026-11-13T21:11:25.328045+00:00`. No emission/deployment inferred.
- `package09-source-typecheck-640.log:9`: retained JavaScript heap OOM; command record exit -6 at 640 MB. This was a wider source-alias backend **noEmit check**, not evidence that a full build was attempted here or that package11 source is broken.
- `package11-json-source-capability.log:1`: prior retained numeric token, narrower than the new public-reader probe.
- `commands.jsonl:11` contains a pre-existing non-JSON line. The read-only evidence extractor skipped it and did not rewrite it; command totals are not synthesized from malformed records.

No broad build, entire suite, integration suite or infrastructure acceptance was rerun. The additional 3 tests must **not** be reported as a present 324-test aggregate.

## 2. Status vocabulary: what may honestly close

The ledger defines `source-fixed-runtime-blocked` separately from `fixed-tested`, and explicitly says containment is not a completed financial feature (`threats/SEQUENTIAL-FIX-LEDGER.md:9`). Package11's inherited notes remain in-progress and enumerate missing implementations (`threats/sequential-fixes/package11-notes.md:2–3,40–48,127–128`).

- **Source-fixed / offline-tested** can describe a bounded implemented behavior with its actual focused test/compiler evidence and stated availability consequence.
- **Source-fixed-runtime-blocked** is appropriate only after the *required source slice* is actually implemented and reviewed, with explicit outstanding artifact/schema/provider/operator checks. It is not a shortcut for missing promotion workers, native attribution, historical repair tooling or global DB capabilities.
- **NOT PERFORMED / unverifiable here** describes external/operator/runtime evidence absent from this scope. It is neither a pass nor a newly reproduced runtime failure.
- **Package closed / stage accepted / venue live** requires its relevant full source and runtime acceptance evidence; this aspect establishes none of those statuses.

The Builder Guide wins sequencing conflicts but defers silent details to source documents (`docs/plans/BUILDER-GUIDE.md:8–9`). Its stage-exit green gate, no-fabricated-fill rule, dedicated migration acceptance and certification-before-live are `:27–39,89–95,170–175`. `(ext)` gates stay open however green mocks are (`docs/testing-aspects.md:69–74`). Do not use this acceptance report to tick global checklists.

## 3. Deployment/build/runtime gate — NOT PERFORMED

**Evidence:** root scripts run Turbo build/test/typecheck (`package.json:5–10`); shared and DB publish `dist/index.js` and `dist/index.d.ts` (`packages/shared/package.json:5–8`, `packages/db/package.json:5–8`). The restricted Vitest config deliberately aliases these packages to current source and uses an empty env directory (`threats/sequential-fixes/vitest.config.ts:14–23`), with one worker/no file parallelism (`:26–35`). These are not production resolution semantics. `docs/stale-dist-hazards.md:11–14,19–29,39–40,123–149` documents the build prohibition and stale-artifact class; its dated mtime/export measurements are historical, **not freshly measured artifact state**. The inspected local compose file supplies infrastructure only (`docker-compose.yml:1–64`), not evidence of the deployed Node binary or app image.

**Blocker:** no trusted rebuilt runtime artifact, installed dependency/Node capability attestation, full safe release build/test result or deployment evidence in this aspect. Do not rerun a memory-heavy build locally merely to re-prove the retained blocker; no build machine or deployment was authorized.

**Future authorized acceptance would prove:** on an adequately resourced approved build environment, reproducible dependency/runtime versions, green relevant full typecheck/test/build against the integrated source, emitted barrels/exports matching source, and a release artifact manifest tied to the reviewed source snapshot. Run the credential-free capability probe in that exact runtime (numeric refusal is safe but an availability incompatibility, not success at ingesting production numeric payloads). Subsequent separately authorized staging verification must exercise the artifact, not source aliases. Record hashes, versions, commands, exit codes and scope; compilation alone does not prove service readiness.

## 4. Installed DB/schema/role/topology gate — NOT PERFORMED; implementation prerequisite also remains

**Evidence:** `packages/db/src/database-role.ts:4–28` requires checked backend/session identity `swat_app` or `swat_migrator`, restricted role flags and `row_security=on`; runtime may not own/create objects. `packages/db/src/client.ts:13–15,32–43` validates on the BEGIN-pinned backend and clears tenant authority. A direct session needs a separate URL and explicit topology attestation, rejects known pooler shapes, checks lock/unlock PID and destroys the client (`packages/db/src/direct-session.ts:5–7,14–22,38–62`). The attestation flag itself is explicitly not proof of topology. Local compose is transaction-pool mode (`docker-compose.yml:40–57`), not runtime verification of any installed deployment.

`packages/db/sql/070_runtime_role_boundary.sql:1–3` is marked **NOT APPLIED** and requires prior audited provisioning/ownership/baseline. It revokes runtime grants (`:28–39`) then grants only its reviewed tenant set (`:45–51,64–71`); that set does **not** include `source_trades`, source confirmation/application/history tables, `wallet_positions`, `wallets`, `tokens`, `polymarket_*` or ingestion-health global tables. Ingestion persists global context/wallet/canonical rows (`apps/indexer/src/polymarket.ts:492–537`; `packages/db/src/copy-trade-lifecycle.ts:634–710`).

**Precise consequence:** simply applying proposed 070 and providing `swat_app` credentials does not establish functioning public indexer ingestion. Global/indexer capabilities must be separately designed/reviewed before an allowed runtime can perform required writes. Using migrator/superuser credentials or bypass flags to make acceptance pass would defeat the inherited boundary, not close it. This is a shared package09/runtime dependency; no SQL or capability source was edited here.

The migration runner refuses a non-prefix checksum history or guessed legacy replay, demands independent baseline audit and explicit quiescence, and applies a pending suffix atomically (`packages/db/src/migrate.ts:22–39,46–75,98–109`). Existing SQL text and passing fake-query tests do not attest an installed database, replay outcome, constraints or privileges.

**Future authorized acceptance would prove:** independently inventory actual installed schema/history/checksums/owners/functions/policies/indexes and reviewed capabilities; verify the installed/source baseline without pretending edited legacy SQL was reapplied. Under separately approved maintenance, establish replay-safe forward changes and scratch double-replay/staging-copy evidence required by `docs/plans/BUILDER-GUIDE.md:36,172–175`. Then demonstrate least-privilege indexer writes, tenant isolation, transaction rollback and pool checkout scope reset with the real installed DB/PgBouncer topology; prove physical session lock ownership/busy exclusion/cleanup separately. Preserve uncertain-submission reconciliation on session loss. **None of these DB reads, operations or migrations occurred.**

### Exact economics and schema trust

Canonical source economics begin with unbounded SQL `NUMERIC` (`packages/db/sql/023_copy_trade_lifecycle.sql:10–12`) and are parameterized/cast with immutable-payload comparison (`packages/db/src/copy-trade-lifecycle.ts:623–675,699–710`). This supports a source contract, not an installed precision guarantee. Numeric parsers choose number-or-string by safe/significant-digit rules (`packages/db/src/numeric.ts:12–44`); acceptance must compare canonical decimal values, not assume every DB-returned numeric is a string.

Legacy `polymarket_trades` has **size NUMERIC(40,18), price NUMERIC(20,18)** and an economics/time conflict key (`packages/db/sql/026_polymarket_context.sql:23–42`; `packages/db/src/polymarket.ts:262–285`). Canonical parsing permits price scale 36 and derived notional scale 42, while accepted legacy projections still require six-decimal collateral and convert USD to Number (`apps/indexer/src/polymarket.ts:468–476,543–566`). Observation containment currently prevents that accepted branch (`:538–541`); it does not prove lossless accepted precision.

**Future authorized acceptance would prove:** exact large quantity, price-scale36 and notional-scale42 round trips against the actual canonical columns/driver; bounded valid schema behavior; replay and immutable-payload collision semantics under concurrency. Before any acceptance restoration, define a reviewed legacy projection/schema policy that neither silently rounds accepted economics nor pretends the scale42 notional is six-decimal collateral. No schema migration or deployed precision claim is made here.

## 5. Provider completeness/native identity/finality gates — NOT PERFORMED

**Wire/provider completeness:** source pagination recognizes explicit object terminal metadata, rejects ambiguity/cycles/limits, but retains short bare-array compatibility (`apps/indexer/src/polymarket.ts:89–94,168–239`). A synthetic short array is not proof that a real provider's history is complete. Provider naming `confirmed` is not a finality certificate; all inspected builders emit observed (`apps/indexer/src/source-trade-lifecycle.ts:110–111,170–171,210–211`), and both input and stored confirmation must be applied for copying (`:31–41`).

**Native identity:** the initially inspected Polymarket typed trade includes transaction hash/economics/time but no native fill/log identifier (`apps/indexer/src/polymarket-helpers.ts:15–26,144–166`). During final handoff inspection the identity peer replaced the former content hash with an explicit `ambiguous-data-api-wallet-v1` wallet/transaction observation group (`apps/indexer/src/source-trade-lifecycle.ts:122–156`). Its comments explicitly forbid interpreting that group as an independent fill or giving it applied confirmation. This is source containment, not provider-native identity or proof that identical independent fills remain distinct; the peer owns final implementation evidence. Native-provider semantics still need external/reference evidence, and existing legacy conflict-key/transaction consumers must be reconciled before accepted publication.

**Finality:** initial inspection of `advanceSourceTradeConfirmation` showed caller-labelled evidence/state, row locking and source-position rebuilding, not authenticated chain/provider certification. During final handoff inspection that boundary was still present (`packages/db/src/copy-trade-lifecycle.ts:729–756`), while the finality peer had restricted intake to observed, disabled intake application rebuilding and returned `eligibleForCopy:false` (`:605–615,711–725`). These are moving source checkpoints; defer the finished boundary verdict to the peer report. The targeted apps production-source search found no promotion caller at initial inspection. No source change here supplies an external chain/provider certificate. ADR-0006 explicitly leaves Robinhood rollup escape/ordering/pending visibility/reorg-finality verification open (`docs/adr/0006-robinhood-sequencer-trust.md:210–244`) and requires honest three-way observed outcomes (`:94–104`). The ADR's chain-scoped sequencer assumption is not a new empirically proven deployment fact and cannot be generalized to Polygon/Solana.

**Future authorized acceptance would prove:** independently reviewed real/provider-exported samples preserving native log/fill IDs, multiple identical-economics fills in one transaction, correction/replay semantics, exact wire decimal fields, opaque cursors and terminal completeness relative to an explicit reference set. Pin provider/network/schema versions. A reviewed finality policy must then verify canonical network/transaction/block or slot evidence, non-success/unknown/reorg handling, restart-safe promotion/reversal and exactly-once downstream handoff. A receipt success, high slot/block number, HTTP200, Data API label or synthetic evidence ID alone is insufficient. Native identity tooling/finality worker source completion is peers' responsibility; no live sample or certificate was obtained here.

## 6. Historical repair / irreversible downstream effects gate — NOT PERFORMED

**Evidence:** migration 023 defaults historical status to confirmed (`packages/db/sql/023_copy_trade_lifecycle.sql:13`); 028 carries legacy observed/confirmed/finalized/reversed status into confirmation state (`packages/db/sql/028_copy_execution_lifecycle.sql:14–34`). Initial candidate SQL admitted stored confirmed/finalized states (at `packages/db/src/copy-trade-lifecycle.ts:872`, moved to `:881` during final handoff inspection). New observed replay is not an applied-data audit/demotion of older eligible rows; the peer's changed intake now avoids historical application reactivation (`:711–725`). At final handoff inspection the existing-execution claim still returned before the later fresh source-confirmation guard (`:1844–1859`; later guard identified by `Source trade is`), an explicitly separate execution-work dependency retained in package11 notes (`threats/sequential-fixes/package11-notes.md:46–48`). These citations record bounded moving checkpoints, not a final peer implementation verdict.

**Blocker:** no historical inventory, demotion/reversal, poisoned-context revalidation, rounded-economic recovery, legacy dedup repair or downstream execution reconciliation was performed. An already-sent order or confirmed external fill cannot be undone by deleting/demoting a source row. The history peer's future containment/tooling tests cannot replace applied-data acceptance.

**Future authorized acceptance checklist:**

- [ ] Freeze a reviewed source/runtime/schema snapshot and independently identify affected historical source/legacy transaction/context rows, confirmation evidence, positions, candidate signals, dispatched signals, queued/retrying executions and application records. Record unknown evidence/irrecoverable precision honestly; never regenerate "exact" decimals from rounded values.
- [ ] Dry-run an approved repair against an isolated restored copy with immutable provenance and before/after counts. Validate collisions, true duplicates vs independent native fills, negative-risk/outcome context and source position ordering; do not infer historical identity from current economic hashes.
- [ ] Reconcile confirmed external executions separately from source quarantine; maintain an audit trail and manual-resolution state for uncertain effects, without new signing/orders or silent refunds/reversals. Restore acceptance only after the separately ordered retry/claim guard is corrected and verified.
- [ ] Rebuild source/aggregate/master-lot accounting from immutable evidence, preserving tenant/master ownership and explicit legacy balances. ADR-0007 forbids rebuilding master identity from current subscriptions and requires dual-ledger transactional consistency (`docs/adr/0007-master-attributed-inventory.md:25–48,118–120,150–158`). This is a downstream repair constraint, not a new package11 promise to implement S4-M3.
- [ ] Under future explicit approval only, apply the reviewed repair with rollback/backup, replay/idempotency checks, independent discrepancy review and evidence of no duplicate downstream copy. **All unchecked, NOT PERFORMED.**

## 7. Metadata/polling/health runtime gates — NOT PERFORMED

The inspected backfill shares bounded network budgets, but context DB awaits occur outside active DB cancellation (`apps/indexer/src/polymarket.ts:414–465`). Complete cached mapping can be returned after condition/outcome checks without freshness/provenance attestation (`:419–429`; `packages/db/src/polymarket.ts:233–258` exposes completeness, not source-measurement age). Polling's inspected source scans active complete markets and derives a winner from price >=0.99 (`apps/indexer/src/polymarket.ts:667–693`), not independently authenticated final settlement. Peers own freshness/polling/health improvements; this snapshot is not their final verdict.

`runTrackedIngestion` records/rethrows batch/health failures. During final handoff inspection the health peer added observed/quarantined/accepted counters and withheld-confirmation evidence (`apps/indexer/src/ingestion-health.ts:13–24,40–98`). This is useful source-level distinction, **not** actual DB/queue/provider health acceptance or a completed accepted confirmation path; the peer owns its final tests. `docs/plans/BUILDER-GUIDE.md:174–175` requires demonstrated staging and pipeline health evidence, not inferred source readiness.

**Future authorized acceptance would prove:** real installed DB stalls/timeouts and queue cancellation behavior, bounded whole-scan work and fair durable continuation under more markets than one budget, trustworthy metadata age/provenance and negative-risk/outcome consistency, restart behavior and terminal provider failures. Measure ingestion counters against actual observed/quarantined/accepted/published effects; missing or stale readiness must not show healthy copying. Independently authenticate market settlement before downstream redemption. No network/DB load or alert delivery test was conducted.

## 8. Existing executable acceptance harnesses are not offline substitutes

**Do not run these in this scope.** Root acceptance wrappers resolve to indexer scripts that explicitly load `.env` (`package.json:15–16,30`; `apps/indexer/package.json:12–17`).

| Existing harness | What source actually does | What it would NOT certify, even if future authorized execution passed |
|---|---|---|
| `apps/indexer/src/polymarket-context-acceptance.ts` | Random synthetic wallet/market/trade, real DB writes/dedup/context lookup/counts, real cleanup/pool close (`:20–39,45–135,137–153,182–223`) | No production provider/native fill/finality evidence. It directly calls legacy `recordConfirmedPolymarketTrade` and transaction insertion (`:86–112`), bypassing current observed canonical/public quarantine. Its 100% coverage/30s freshness are fixture-derived, not an actual sample. |
| `apps/indexer/src/g0-d11-acceptance.ts` | Creates Redis connections, BullMQ queue/events/worker, substitutes fixture backfills and no-op health recording, writes derived DB transactions (`:78–135,183–203`) | Not actual chain/provider ingestion, current canonical confirmation promotion or production per-venue outage isolation. |
| `apps/indexer/src/polymarket-book-acceptance.ts` | Real Redis connect/ping/runtime/cache and cleanup (`:135–145,188,216–229,289–295`) | Not authenticated orders/fills, current provider settlement, or package11 full backfill acceptance. |
| `tests/integration/pipeline.integration.test.ts` | Persists current observed adapters then immediately expects one eligible candidate (`:109–172,188–194,323–325`); synthetic finalized *copy* evidence appears later (`:257–268`) | This is an **unrun source-contract mismatch**, not an observed test failure: current candidate SQL requires confirmed/finalized source (`packages/db/src/copy-trade-lifecycle.ts:872`). Future authorized integration must distinguish quarantined observation assertions from explicitly staged trusted promotion, rather than weaken production containment to revive old fixture expectations. |

Infrastructure suites load dotenv and DB global setup (`vitest.integration.config.ts:1–23,28–33`). Dedicated test-name guards do not make them read-only/pure. None were imported/executed here. Updating fixture types alone cannot be presented as a passing operational acceptance.

## 9. External/operator gates retained, not invented

The actual external requirements, with no new numeric targets:

- [ ] Solana `S3-9/G1-S1`: real review-window latency, median signal-to-alert <60s and capped Jupiter/Jito canary, truthful states/chain amounts/idempotency (`docs/testing-aspects.md:11–14`; `docs/plans/BUILDER-GUIDE.md:83–95`). **NOT PERFORMED.** ADR-0005 retains certification-before-cutover and separately elevates latency/detection requirements (`docs/adr/0005-single-master-mirroring.md:211–222,270–281`); the older <60s metric is not proof of that newer detection launch dependency.
- [ ] Robinhood `S3-13/G2-R3`: >95% operator-reviewed direction accuracy; `S3-14/G2-R4`: >90% reference-sample completeness; `S3-16/G2-R12`: funded success/failure/restart scenarios; `S3-17/G2-R13`: reviewed certification before enablement (`docs/testing-aspects.md:16–23`). **NOT PERFORMED.** Synthetic wallet-net tests establish neither population accuracy nor provider coverage.
- [ ] Polymarket `S3-21/G3-P3`: authenticated round trip without secret disclosure; `S3-22/G3-P5`: human eligibility/terms/jurisdiction/funding; `S3-23/G3-P11`: capped fill/cancel/duplicate scenarios; `S3-24/G3-P12`: independent certification sign-off (`docs/testing-aspects.md:25–32`). **NOT PERFORMED.** Actual current cert is **NOT CERTIFIED**, with pending IDs/reviewer (`docs/certification/polygon-polymarket.md:3–5,8–38,41–53`); contract/SDK/builder-code/collateral bytecode and fee assumptions need that separate review, not inheritance from old ingestion USDC constants.
- [ ] `S3-26/F-ACC1,F-ACC2`: real simultaneous three-chain workers with an intentionally degraded venue and evidence of cross-chain isolation; `S3-27/F-ACC3`: actual Postgres/Redis/provider credentials/funded prerequisites (`docs/testing-aspects.md:34–37`; `AUDIT-FIX-CHECKLIST.md:573–575`). **NOT PERFORMED.** One mocked worker or a queue split source test is not that evidence.
- [ ] Custody launch `S4-1/DG-2/D13`: counsel-reviewed legal opinion, ToS/risk disclosures, live geo-gates and Polymarket per-user eligibility, including named Robinhood sequencer risk (`docs/testing-aspects.md:43–46`; `docs/adr/0006-robinhood-sequencer-trust.md:118–121,189–196`). **NOT PERFORMED; cannot be closed by source tests.** It is a custody-launch dependency, not a requirement to add custody implementation to this aspect.

Filesystem inspection found **only `docs/certification/polygon-polymarket.md`** in that directory. `Read` returned missing for `docs/certification/solana.md` and `docs/certification/robinhood-chain.md`. In particular, the claim that Solana's cert already exists in `docs/testing-aspects.md:14` is not borne out by this checkout. Do not fabricate absent certification or signatures; future certification owners must reconcile the document inventory. No shared doc was changed here.

`G7-A7/A8/A9,F-ACC4` are retained optional operator KPIs, not release gates under the Builder Guide (`docs/plans/BUILDER-GUIDE.md:165–167`; `AUDIT-FIX-CHECKLIST.md:1404–1405`). They are deliberately **not** added as mandatory package11 closure criteria.

## 10. Final handoff checklist for main review

- [x] Read-only authority/source evidence review completed; explicit scope/status distinction retained.
- [x] New isolated public-reader capability/refusal/quoted-decimal probe executed: 3 passed / 1 file under the required guard/lock/CPU0.
- [x] Historical 321/31 and focused noEmit640 evidence inspected without recombining or rerunning.
- [x] Unapplied DB roles/schema/global-capability dependencies, accepted legacy precision, absent cert files and unrun pipeline-contract mismatch explicitly recorded.
- [ ] Main integrates peer reports/source changes and runs only its separately approved final focused checks; this aspect does not certify concurrent aggregate source.
- [ ] Approved build environment/artifact/runtime version and resolution evidence.
- [ ] Approved installed-schema baseline, capabilities, migration/replay/DB topology acceptance.
- [ ] Native provider identity/completeness and verified promotion/reversal policy evidence.
- [ ] Reviewed, applied historical repair and downstream reconciliation evidence.
- [ ] Metadata/polling/health operational acceptance and required external/operator sign-offs.

**Exit statement:** local acceptance-contract evidence is useful and green; package11 is still incomplete and runtime-blocked across the enumerated gates. Observation refusal remains containment with copying unavailable, not proof of deployed functionality. No operational gate above was closed by this report.
