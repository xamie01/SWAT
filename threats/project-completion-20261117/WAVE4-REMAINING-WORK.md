# Wave 4 remaining work and Wave 5 transition — 2026-11-20

## Outcome and current boundary

P1 protected LP admission, P2 migration installation and P3 authentication have **bounded independent source acceptance**. Wave4 is not source-complete or runtime-accepted. The last reconciled source freeze passed948 main tests/36 files,46 separate load contracts and five noEmit checks; it becomes historical when P4 changes consumed source. Existing accepted source and raw epochs remain retained.

**P4a implementation has begun.** The current slice makes actual production lifecycle, trade, risk, fanout and worker code accessible through explicit owned transaction/client leaves. It does not create another qualification-only pipeline, activate services, allocate SQL or loosen grants.

## Remaining source packages, in execution order

| Package | Concrete deliverable | Completion gate |
| --- | --- | --- |
| P0 coordinator | Finish independent runner review; maintain literal inventories, immutable commands/results/manifests and report consistency. | Reviewed runner behavior and reconciled affected epochs. |
| P4a pipeline foundations — active | Shared pool-free lifecycle/intake/signal/trade/risk implementations; direct fanout/worker/quote imports; shared mirror state; production reuse of owned obligation scope. | Actual fresh source-import containment and joined injected contracts; affected production regressions/typechecks; independent source review. |
| P4b protected backing | Owned source/provider intake, current recipient admission/cohort enumeration, exact sizing, capability registration/lookup, risk, independent paper receipts and valuation/correction writers. | Strict callable production adapters and reviewed provisioning/validation source, with missing approved identities explicitly refused. |
| P4c executed scenario and observer | Buy, source sell, verified reversal, immutable value/fee correction and replay through production intake, verification, fanout and worker; independently observed durable journals after checked COMMIT. | Exact source/obligation/execution/attempt/receipt/position/lot/risk/capacity identity and economic conservation; rollback/uncertain-COMMIT refusal; independent source review. |
| P5a custody | Owned wrapping, enrollment, execution unwrapping and delegation using distinct protected secret admissions; lifecycle/revocation/expiry/ABA scenarios. | Joined production scenarios and precise capability/rollback evidence contracts. |
| P5b withdrawal and reducing | Protected one-use OTP capture/digest/delivery, cooling/funding/reservation/outbox; unknown-execution reconciliation; spot lots/perps collateral with independent receipts/accounting. | Exact same-client transitions, replay/fault conservation and narrow settler composition. |
| P5c LP and shared financial integration | Protected initialization/master/risk, complete acquisition/copy/rebalance/close/recovery history and economic observers; join all financial adapters. | Preserve accepted ONE-CLOSE/protected admission boundaries and independently verify complete scenario contracts. |
| P6 races and faults | Competing canonical claims/admissions, duplicate retry, tenant/account interference, post-lock expiry/cancel, fee races and fee-only completion; source/outbox/worker/Redis faults at commit/enqueue/ack boundaries. | Joined blocking/outcome and immutable journal conservation contracts; ordinary BullMQ stall recovery preserved. |
| P7 durable load correctness | Run-bound fixture consumers; HTTP attempt/admission/job completion/durable economics joins; resource/server/slow-log evidence integration. | No queue/HTTP-count-only success; preserve100000 seed, random10000 pool and9000 peak accepted schedule. |
| P8 private executable coordinator | Concrete I1–I8 source adapters, bounded config/capability composition, cancellation/uncertain-COMMIT fences, partial/failure evidence, drains and cleanup/operator handoff. | Every exit records evidence; long load lifecycle remains separate from core deadline; no public execution enable by deleting refusals. |
| P9 final source audit | Independently inspect every requirement and executable path; repair supported findings; reconcile all affected raw checks and source hashes. | No missing implementation or unresolved supported source finding. Only then classify source-complete-pending-runtime. |

Reviews and verification occur **between each bounded owner**, not only at the end. One implementation or review subagent is active at a time, and no checks run while consumed source is changing.

### P4a reserved implementation

- Move canonical lifecycle bodies/types/SQL into `copy-trade-lifecycle-owned.ts`; ambient compatibility facades delegate shared code. Add actual `recordSourceTradeEventWithClient`, `insertSourceTradeSignalWithClient` and candidate/lookup seams. Preserve validation-before-acquisition, public confirmation refusal, exact replay/quarantine, accepted-provider lookup, policy/lot capture and lock ordering.
- Share `trades-owned.ts` and `risk-spend-owned.ts` with legacy wrappers. Preserve exact money, cumulative evidence/epochs, conservative unknown liability and correction replay.
- Correct `fanout-enqueue`, canonical worker, worker execution/settlement and paper quote imports to explicit leaves. Share mirror-state logic outside ambient subscriptions.
- Reuse `obligation-runtime-owned.ts` for production adapter composition, preserving stronger validations and protected lookup on every transaction. No third capability implementation.
- Add actual fresh source-loader child containment and joined injected production intake/signal contracts, then rerun affected lifecycle/source/sell/lot/trade/risk/settlement/correction/fanout/subscription/worker/obligation regressions.

P4b must still supply ambient candidate enumeration and boot-private current admission through owned composition. SQL077/079 and the capability matrix expose real missing provisioning/validation source: source-provider/capability/valuation capabilities and `swat_fanout` must be explicitly represented. These are not merely missing passwords. Any new suffix is centrally allocated after inspection; the seven-transfer broker and application authority remain unchanged.

## Runtime qualification still required for full Wave 4

Source-complete is a useful milestone, but full Wave4 acceptance requires separately authorized disposable infrastructure and actual I1–I8 observations:

1. **I1:** independent PostgreSQL16 reference/candidate and Redis7 identities, image/tool/source hashes, resource/network/volume ownership, exact migration journal and schema/catalog comparison, actual process/socket/server containment.
2. **I2:** installed direct least-privilege identities, external activation, forced RLS/ACL/cross-tenant tests, clean direct/pooled transaction reset, inspected PgBouncer mapping/mode/limits.
3. **I3:** real protected paper pipeline, exact durable fills/accounting/corrections and replay, independent receipt/provider evidence.
4. **I4:** actual custody/delegation, OTP/outbox/cooling, reducing/collateral and LP constraints/transactions with correctly privileged writers. Permission refusal alone is not trigger proof.
5. **I5:** actual canonical/cross-account competing transactions, blocking/waits, expiry/cancel/fee races and exact rollback conservation.
6. **I6:** controlled owned pre/postcommit/enqueue/ack faults, real BullMQ stall/redelivery, no lost obligations or duplicate economics, retained attempts/events/receipts.
7. **I7:**100000 new synthetic users, random10000 authenticated identity pool, gradual2000+7000 to9000 peak; weighted ordinary endpoints, actual throughput/phase/limiter/pooling/queue/memory/host evidence and durable completion/economics. Retain the accepted default27-minute schedule plus bounded drain.
8. **I8:** actual cleanup/drain/pending/server/child/time/resource evidence, independent runtime review, supported repair/rerun and coordinator acceptance/ledger reconciliation.

The exact environment/images/tools/targets, approved identities/credentials, provisioning/migration/seeding/fault/load/cleanup authorization and independent observations are external runtime inputs. No local edit, configuration flag, hash or mock grants this authorization.

## Wave 5 transition

**Wave5 source preparation can be planned separately, but dependent Wave5 runtime acceptance cannot advance until genuine Wave4 I1–I8 acceptance.** Source-complete-pending-runtime does not erase this dependency.

Wave5 J/K preparation must cover fresh Next/browser behavior; Rust/Anchor/IDL/CPI rollback; native ML parity; immutable image/dependency/build artifacts and disabled publication CI; service graph/TLS/state/monitoring/restart; encrypted backup and actual restore proof. These are not yet a qualified dedicated Wave5 implementation. Current work is directed at finishing Wave4 rather than relabeling missing tasks as Wave5.

## Preserved execution rules

Local reversible source edits and reviewed offline checks only. CPU0 shared flock; one test fork/512MB Node heap, compiler640MB; immutable labels; `--timeout-seconds 0` removes only runner caps. Transaction/operation/cancellation/shutdown/load-drain safety deadlines remain. No root Turbo/full Next build, infrastructure/services, SQL application, real credentials/signing/funds, commit/push/publication. Preserve sealed Waves1–3, accepted queue/load except supported affected changes, SQL083, refused084 and SQL087 pins, unrelated working tree, seven broker transfers and public qualification/Package28 refusals.

Status is tracked in [source-completion map](WAVE4-SOURCE-COMPLETION-MAP.md), [main checkpoint](WAVE4-MAIN-CHECKPOINT.md), [evidence](WAVE4-MAIN-EVIDENCE.json) and [stage ledger](STAGE-LEDGER.json). Full runtime requirements remain in [qualification plan](WAVE4-QUALIFICATION.md).
