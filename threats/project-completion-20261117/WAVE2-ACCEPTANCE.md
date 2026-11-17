# Wave 2 coordinator acceptance — 2026-11-17

**Accepted: local source integration and injected offline contracts.** Real PostgreSQL/RLS/concurrency, provider, signer, runtime and live capability acceptance remain false. Wave 1 remains sealed; no Wave 1 acceptance claim is redone or broadened.

## Final repair and integration

Both migration destinations already existed and were byte-identical to the retained proposals when resuming. Preserved existing integration rather than moving/deleting evidence or overwriting unrelated work:

- `packages/db/sql/079_claim_runtime_capabilities.sql`: SHA256 `960642ce04c9f7ffc9fb599bde1edcec4159fed6277f522d74ee11a702aa3cc3`.
- `packages/db/sql/080_immutable_valuation_corrections.sql`: SHA256 `9811a908c5ce769f10e7761502ef0b6786bcb4101a353081e478ff0d49ac030b`.

080 now compares valuation/authority and source-provider/proof admission expiries against trigger-assigned `NEW.accepted_at := statement_timestamp()`, not transaction-start `now()`. Both proposal and integrated source match. Six source-regression cases explicitly do not claim PostgreSQL trigger execution.

Independent read-only reconciliation confirmed repairs for SQL parameter numbering, allocation row-lock privilege with immutable trigger, position/execution/delivery lock ordering, partial outstanding allocations, explicit-lot correction lineage, historical acceptance expiry and carried quote/fee field origins. See `WAVE2-FINAL-RECHECK.md`; the earlier `WAVE2-REVIEW.md` remains retained, not rewritten as an initial clean pass.

## Raw results and actual commands

All selected assertions below passed with zero failed/skipped/pending/todo. Counts derive from each raw `assertionResults`, not suites, and reruns are not summed. Table-driven cases with identical names retain separate collection indices.

| Final selected record | Literal files | Assertions |
| --- | ---: | ---: |
| `build-w2-final-runtime-tests-01` | 6 | 104 |
| `build-w2-final-financial-tests-01` | 5 | 75 |
| `build-w2-review-source-allocation-tests-01` | 3 | 110 |
| `build-w2-final-queue-tests-02` | 3 | 54 |
| **Deduplicated total** | **17** | **343** |

Commands, invoked with `python3 -I /root/SWAT/scripts/build-completion-runner.py` and `--evidence-dir threats/project-completion-20261117`:

```text
build-w2-final-runtime-tests-01 test threats/project-completion-20261117/w2-runtime.config.ts
build-w2-final-financial-tests-01 test threats/project-completion-20261117/w2-financial.config.ts
build-w2-review-source-allocation-tests-01 test threats/project-completion-20261117/w2-source-allocation.config.ts
build-w2-final-queue-tests-02 test threats/project-completion-20261117/w1-fanout.config.ts
build-w2-final-emit-db-01 emit db
build-w2-final-emit-trade-executor-01 emit trade-executor
```

Each command retains `.command.json`, `.inputs.json`, `.log`, and test `.json` where applicable. Both emits exit 0: 340 DB and 420 executor artifact hashes verified. Source, JavaScript and declaration barrels include the runtime capability, exact sizing/decimal, allocation, valuation correction and canonical descriptor exports.

Coordinator reconciliation command:

```text
taskset -c 0 flock /tmp/swat-package11-checks.lock python3 -I /root/SWAT/scripts/reconcile-wave2-evidence.py
```

`WAVE2-FINAL-EVIDENCE.json` SHA256 `90c482cd90ec4a30088783ddc41209b37d391048ccdcfa95b70921ca65a0c6b3` records all 343 assertions, collection indices, source/command/log/result/artifact hashes and limitations. All checks used CPU0 and shared flock; tests 512MB/one fork, compilers 640MB; no timeouts, and inputs stable during each command. Historical unrelated snapshot differences are not a current-global-source certificate. Selected test source fingerprints and current emitted artifacts were individually reconciled.

## Retained failures and honest scope

The earlier post-review reports were not green: runtime 100 passed/4 failed; queue 53 passed/1 failed. Four runtime failures were a Vitest `it.each` fixture passing one reduction object as SQL `rows`; fixed fixture shape without changing denial logic. Queue initially lacked the real descriptor validator and durable delivery/score SQL fixture; after repairing those, first final rerun retained 53 passed/1 failed because a stale expected source-verifier refusal actually reached absent execution policy. Final test asserts `execution-policy-unavailable`, no quote and no authorization. It does not claim to test source verification through its injected context. All failed records remain on disk. Older package export failure is likewise retained and superseded by final successful emits.

No production migration applied, role/capability seeded, host service/container started, credentials read, provider called, key generated, transaction signed, funds moved, dependency installed, or commit/push/publish performed. 079 operator grants/provisioning and 080 independent valuation writer remain intentionally unavailable pending separately authenticated isolated qualification. Local acceptance permits Wave 3 implementation, not runtime certification or automatic Wave 4 execution.
