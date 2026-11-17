# Sequential build-completion remediation — 2026-11-16

## Context and baseline

Requested outcome: implement fixes sequentially, verify each coherent phase, and write the final report after local remediation and review. Starting commit: `564818d71daaa8bab73dff47f28697d14438143d`; initial worktree clean. This plan supersedes parallel implementation assignments, not historical evidence.

## Rules

- One implementation/check phase at a time; preserve unrelated and historical work.
- Tests/compilers/Python checks use CPU0 and `/tmp/swat-package11-checks.lock`. Node tests: 512 MB, one fork. Compilers/emits: 640 MB.
- No root build/broad test suite, full Next build, dev/container startup, dependency downloads, credentials, key generation/signing, live trading, production migrations, publication, commits or pushes.
- Reuse canonical DB claims, exact quantity checks, pure policy evaluation and durable receipt contracts. Missing trustworthy source/price/receipt/control/custody inputs remain unavailable, never fabricated or restored with flags.
- Retain actual diagnostics, raw logs, selected literal tests, hashes and command results. Mock/source checks are not SQL concurrency, native ABI, live execution or deployment acceptance.

## Ordered phases

1. **Portable verification:** add reviewed command-class runner, repository-relative paths, lock/affinity/heap limits, timeout, synthetic guarded environment and unique non-overwriting evidence. Reuse `package12-29-harness.ts` literal selection and actual manifest verification. Test runner independently.
2. **Build baseline:** refresh shared then DB emitted dependencies, check consumers/tools/integration/web noEmit sequentially; fix genuine diagnostics without weakening nullable lifecycle assertions. Reproduce and correct focused API authority/financial refusal tests.
3. **Schema/transaction foundations:** preserve migration history, add only missing forward schema, expose required same-client APIs and align durable roles/control/receipt/fanout/LP contracts. Keep real infrastructure/isolation acceptance blocked absent independent approved DB/Redis.
4. **Canonical worker policy:** use `assertLotExitExecutionMatches`, `claimLotExitExecutionWithClient`, exact DB lot snapshots and `evaluateExecutionPolicy`; remove queue-boolean authority and float-based exact sizing. Enforce tenant/account/master/acquisition mode/current policy/replay/terminal scope and scorer claim/wind-down joins.
5. **Atomic accounting:** join `reserveRiskSpend`, cumulative evidence, capacity and trade/lot settlement on one client; preserve unknown/partial liabilities and durable epochs; refuse untrusted live prices. Commit before acknowledgement.
6. **Jito durability:** pass canonical identity/independent intent, implement durable claim/prepare/receipt adapters, join runtime `settle` to atomic accounting. Preserve exact bytes before POST, uncertainty and unavailable final-message signer.
7. **Source/fanout:** join durable enumeration/admission/queue/outcome recovery and reducing candidate policy. Complete local lifecycle validation but retain quarantine and verifier-unavailable behavior without legitimate external proof.
8. **LP:** distinguish trusted USD from token quantity, immutable acquisition mode, same-client reservation/create, paper monitor/rebalance/close and recovery. No fake live execution or state-only live closure.
9. **API/web:** remove fabricated geo approval/expiry/holdings/safe margin, expose unavailable/unassessed states and disable unsupported actions. Preserve auth and custody/withdrawal/financial refusals.
10. **Solana/ML:** complete policy/governance source contexts and budget/resource enforcement; strengthen local inert artifact/CLI/storage tests and genuine native parity test gates. Compile/ABI/native parity remain unverified if approved tools absent.
11. **Final review/evidence:** align CI/DEPLOYMENT/current completion docs, final deduplicated bounded tests/emits/typechecks/static ops/scans/diff check, independent read-only review, repairs and affected reruns, then `FINAL-REPORT.md`.

## Verification and reporting

Each phase records source diagnostics or red regression, minimal fix, green/neighbor checks, actual exit codes, tool/config/test/source hashes and remaining gates. No failure is relabeled as passed. A blocked dependent phase does not prevent independent local fixes. Final report distinguishes implemented/tested, integrated/runtime-unverified, external-blocked and intentionally unavailable. Full web/native/runtime/deployment/live completion cannot be asserted from this bounded pass.
