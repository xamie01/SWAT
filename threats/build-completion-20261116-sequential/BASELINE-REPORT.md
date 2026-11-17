# Build baseline checkpoint — 2026-11-16

Starting commit `564818d71daaa8bab73dff47f28697d14438143d`. This is bounded build/source evidence, not full web/native/runtime acceptance.

## Actual checks

- Runner self-tests: 5 passed (`build-runner-self-01.command.json`).
- Shared emit, DB emit and standard shared/DB noEmit: exit0.
- Initial package failures retained in `build-baseline-typecheck-*-01.log`: API test source outside rootDir; signal-engine missing pg type dependency; alert/discovery cross-package source imports; scorer stale exact-lot fixtures; web stale setter/test/config narrowing errors; integration pg module resolution.
- Repairs: DB exports notification APIs and PoolClient; consumers use package boundary; import-safe reference driver for independently authorized schema generation; API production build excludes test sources (tests still explicitly executed); canonical scorer fixtures preserve acquisition/identity and reject submitted requeue; web transport tests and mainnet-only narrowing corrected; fabricated vault fallback removed.
- Final baseline package noEmit: shared, DB, API, indexer, signal-engine, trade-executor, scorer, discovery, alert-service, LP, web, tools and integration all exit0. See latest `build-baseline-typecheck-*.command.json` (02 for repaired targets, 01 for unchanged green targets).
- API red: 13 passed /1 failed /2 actual files. Financial refusal tests already passed; geo approval projection failed.
- API green after real handler correction: 14 passed /2 actual files (`build-api-baseline-green-01.json`).
- Scorer close-all + web transport neighbors: 8 passed /2 actual files (`build-neighbors-01.json`).
- `git diff --check`: exit0 at checkpoint.

## Qualifications

Tests use reviewed literal selections and the offline Node network/credential guard. Ordinary package typechecks resolve refreshed emitted dependencies; integration compilation and harness tests intentionally use source aliases and are source-program checks, not artifact/runtime certification. API production config excludes tests: selected tests were executed, but a separate API-test noEmit gate remains pending. Early runner records do not hash the full consumed input graph and are limited checkpoints; final hash-bound reruns are required. No production infrastructure, network provider, signing, keys, credentials, migrations or services run. Full Next build, fresh Next-generated route types, Rust/Anchor/ABI, native ML, SQL concurrency and paper end-to-end runtime remain separate gates.

Generated compiler artifacts/cache are not source delivery or immutable build identity. Final source/config hashes and affected reruns are required after subsequent remediation.
