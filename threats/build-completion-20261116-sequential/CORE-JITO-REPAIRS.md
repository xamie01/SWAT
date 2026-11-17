# Core/Jito follow-up repairs — 2026-11-16

All3 concrete findings repaired locally. Shared worker settlement/uncertainty/reconciliation lock position advisory→execution→attempt, preserve terminal accounting reread. Committed receipt ack recovery validates immutable economics and only monotonic confirmed→finalized observation, uses original persisted financial receipt, no rewrite. Pending sweep atomically rotates max100 via durable last_checked_at/FOR UPDATE SKIP LOCKED; unknown ownership retained.

Actual invoked tests include both worker lock paths, confirmed financial settlement/ackloss/finalization/reack, changed economics/regression refusal,205row rotation across restarted stores. Mock tests are not DB concurrency proof.

Evidence: build-jito-review-green-01 51pass; build-jito-review-core-neighbors-01 78pass; DB noEmit/emit/executor noEmit01 exit0; build-jito-review-green-02 51pass strengthened fixture; DB noEmit02 exit0. **129 deduplicated assertions8files** in this follow-up, don't sum reruns/history. Input manifests unchanged accepted runs, diff check clean. Red basis source/reviewer proof, no pre-fix red executed.

Paths: worker-settlement.ts/test, jito-receipt.ts, jito-store.ts, SQL075, db/executor jito-durable tests. No LP/source expansion. SQL075 unapplied, signer/provider/scoped runtime/source verifier unavailable; source canonical descriptor join remains locally unfinished. Installed SQL/isolation/live/deployment acceptance unexecuted.
