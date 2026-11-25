# Wave 4 continued-batch verification inventory — draft, 2026-11-24

## Boundary

This is a source-only inventory draft, not an approved command binding or evidence of execution. Historical literal configs and raw artifacts remain unchanged. New approval manifests may be generated only after complete consumed-source freeze and independent runner acceptance. No tests, Python parsing, compilation, fresh emit or verification hashes have run in the continued batch.

The selected command must use the existing guarded runner, shared `/tmp/swat-package11-checks.lock`, CPU0, one fork, 512 MB test heap, 640 MB compiler heap, synthetic/offline environment, immutable attempt labels and `--timeout-seconds 0`. Application acquisition, transaction, cancellation, shutdown and load-drain deadlines remain finite. Test/noEmit and fresh-emit manifests are separate. Repeated/overlapping scopes are never added together as coverage.

## New and affected literal tests not represented by the historical main/fanout inventories

### Pipeline backing and forward proposals

- `tests/qualification/wave4/pipeline-source-backing.offline.test.ts`
- `tests/qualification/wave4/pipeline-follower-backing.offline.test.ts`
- `tests/qualification/wave4/pipeline-worker-backing.offline.test.ts`
- `tests/qualification/wave4/pipeline-provisioning.offline.test.ts`
- `packages/db/src/exact-follower-sizing.sequential.test.ts`
- `tests/qualification/wave4/pipeline-executed.offline.test.ts` — authored and frozen; independent source review pending, unrun.
- `tests/qualification/wave4/pipeline-sql-observer.offline.test.ts` — authored and frozen; independent source review pending, unrun.

### Financial composition and custody projection

- `tests/qualification/wave4/custody-owned-composition.offline.test.ts`
- `tests/qualification/wave4/withdrawal-owned-composition.offline.test.ts`
- `tests/qualification/wave4/reducing-owned-composition.offline.test.ts`
- `tests/qualification/wave4/lp-owned-composition.offline.test.ts`
- `tests/qualification/wave4/financial-backing.offline.test.ts`
- `packages/db/src/execution-grant-projection.test.ts`
- `packages/db/src/execution-grants.test.ts`
- `packages/db/src/execution-grants.sequential.test.ts`
- `packages/db/src/custody-store.test.ts`
- `packages/db/src/custody-credentials.test.ts`
- `packages/db/src/custody-enrollment.test.ts`
- `packages/db/src/custody-contract.test.ts`
- `packages/db/src/custody-execution.test.ts`
- `packages/db/src/withdrawal-store.test.ts`
- `packages/db/src/withdrawal-protocol.test.ts`
- `packages/db/src/reducing-protocol.test.ts`

### Protected load composition and finite independent lifetime

- `tests/qualification/wave4/load-fixture-consumers.offline.test.ts`
- `tests/qualification/wave4/load-durable-economics.offline.test.ts`
- `tests/qualification/wave4/load-capture-backing.offline.test.ts`
- `tests/qualification/wave4/load-lifetime.offline.test.ts`

### Existing canonical affected regressions

The new literal candidate is `threats/project-completion-20261117/w4-continued-20261124.config.ts` (28 files, including the affected source-claim regression). Its inspected offline imported-closure review returned bounded TypeScript source-safety ACCEPT, but rejected the Python static selection's cache-capable runner loader. The source-bytes loader repair is frozen under independent review. Active executed repairs and the forthcoming economics test require affected import re-review and updated literal inventory. The config is not bound or executable yet. The post-lock clock repair is also historically selected by `w4-p4b-fanout.config.ts`. Historical `w4-main.config.ts`, `w4-p4b-fanout.config.ts` and `w4-load.config.ts` remain separate regression scopes. Any new selected config must use explicit literal filenames and the existing production `@swat/db/dist/<leaf>.js` source alias; do not import the database runtime barrel as a substitute.

### Python runner

- `scripts/build-completion-runner.test.py` — direct generated-evidence exclusion, consumed symlink target closure, collision-safe namespace/type-strict approval and leader-preserving cleanup regressions remain unrun. Independent affected collision repair review returned bounded source ACCEPT. Its execution path must be separately reviewed; a Python import/parsing shortcut during source mutation is prohibited.

The moved runtime contract/port is now canonical in `packages/db/src/wave4-load-contract.ts`; the qualification `load-durable-contract.ts` is an explicit compatibility re-export facade. Independent bounded source review accepted extraction and corrected original/new-attempt replay semantics. This is not compiler or SQL090 acceptance.

## Compiler/fresh-emit boundaries

Existing exact configs are `packages/db/tsconfig.json`, `tsconfig.qualification.json`, `apps/signal-engine/tsconfig.json`, `apps/trade-executor/tsconfig.json`, `apps/api/tsconfig.json`, `apps/api/tsconfig.test.json` and `apps/lp/tsconfig.json`. Review the imported closure and package `rootDir: src` boundaries before selecting them. Database production leaves must not obtain runtime dependencies from qualification files outside the package. No root Turbo/full Next build, installation, download or migration is part of this inventory.

## Remaining source coverage

Canonical competing-claim/fault schedules, authenticated public-load lifecycle, private I1–I8 integration, exact observer enrollment, complete SQL088–090 lock/ACL/catalog/FK closure, canonical withdrawal ledger and zero-base fee-only evidence remain source work. No drafted inventory, authored mock, supplied role string or historical passing count closes those requirements.
