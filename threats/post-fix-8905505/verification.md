# Post-fix local verification

**Date:** 2026-11-08. **Reviewed commit:** `8905505595802c21053118b5fab3fd53a8a1654c`.

## Results

| Check | Result | Evidence |
|---|---|---|
| Seven existing pure/helper suites | **74 passed** | `existing-pure-regressions.json`, `.log` |
| Five existing changed regression suites | **102 passed** | `existing-changed-regressions.json`, `.log` |
| New API security invariants | **4 failed / 4** | `api-invariants-offline.json`, `.log` |
| New parser/session invariants | **5 failed, 1 passed / 6** | `parser-session-invariants.json`, `.log` |
| New sensitive-flow/health invariants | **4 failed / 4** | `sensitive-flow-invariants.json`, `.log` |
| New Jito durability invariants, stateful store | **3 failed / 3** | `jito-invariants-stateful.json`, `.log` |
| Standalone PDA server syntax | **Failed**: duplicate lexical declaration at line 302 | `pda-syntax.log` |
| Frontend no-emit typecheck | **Failed**: ten unresolved-module diagnostics | `web-source-typecheck.log` |
| Backend source-aliased no-emit typecheck | **Passed on bounded 640 MB retry**; initial 512 MB heap exhausted | `backend-source-typecheck-640.log`, initial `backend-source-typecheck.log` |
| Sensitive literal scan | **No candidate matched** in 118 current source files and 22 existing client artifacts, 2,862,617 bytes | `sensitive-literal-scan.json` |

**Unique executed tests:** 176 existing assertions passed; 17 new adversarial/control assertions ran, of which 16 failed and one passed. That is **193 unique tests, 177 passed, 16 failed**. Jito's earlier stateless-store attempt and later stateful-store verification are reruns of the same three assertions, not extra unique tests. The failed Vite startup occurred before test execution and is not included in the test count.

These expected-security assertions deliberately fail against current unsafe behavior. They are not marked expected-fail in Vitest and have not been made green by weakening their expectations. Existing green tests do not negate a missing boundary the new assertions cover.

## What was reproduced

1. **Robinhood invalid proof:** actual registered Fastify handlers received a synthetic formatted address/invalid signature while the recovery dependency rejected. The query spy observed a wallet-link INSERT; a separate assertion received HTTP 200 rather than rejection. Authentication principal, database and sealing were synthetic. This is not a real wallet link or on-chain authorization.
2. **Payment claimant mismatch:** an owned pending memo plus an otherwise accepted transaction with an unrelated payer reached the credit writer. The payment dependency was mocked; the route's ownership logic was real.
3. **Wrong event type:** the actual Polygon verifier accepted a synthetic USDC-log layout with an invalid event-signature topic. The receipt provider was mocked. This establishes absence of event-type validation; the standard Approval implication is source/ABI reasoning, not a live Approval/payment exploit.
4. **Source provenance:** the actual pure parser accepted opposite token movements without a swap instruction and accepted an explicitly failed synthetic transaction object. Honest failed Solana transactions normally roll back token movements; the latter fixture checks a missing defensive status guard rather than claiming otherwise.
5. **Mixed-asset ambiguity:** the parser chose an additional high-raw-unit token from a three-leg fixture rather than refusing ambiguous attribution.
6. **Fee attribution:** the actual enhanced-webhook adapter/parser credited another payer's fee to the tracked wallet; 1,000,000,000 expected lamports became 999,995,000.
7. **Revoked-session race:** the real cache implementation admitted a late pre-revocation mocked database result after logout and served it from cache. No real session existed.
8. **Transport:** actual production-mode API/LP SSR resolvers returned remote HTTP defaults when synthetic configuration omitted overrides. No HTTP request was made.
9. **Credential-bearing error:** a clearly synthetic path marker survived the actual RPC-failover exception and log serializer. No real token was used, and Redis publication was not called.
10. **Health:** a fake HTTP-success JSON-RPC response with `result: null` was marked healthy by the actual probe helper.
11. **Jito order durability:** the actual runtime called the fake transport before saving recovery state; two overlapping asynchronous calls on one event loop each sent despite a stateful memory store; a retryable lost-response result stored `pending_unknown` rather than a recoverable transaction identity. Quotes, signed artifacts, tip accounts and venue responses were inert strings/mocks—no key derivation, real transaction, broadcast or funds movement.
12. **PDA parse regression:** `node --check` reports `SyntaxError: Identifier 'requestedLamports' has already been declared` at `pda-test-ui/server.mjs:302`. The server was never started.

Jito overlap is asynchronous scheduling on **one CPU**, not two-core processing. This test does not establish the exact behavior of every Redis/worker deployment; it establishes that the reviewed runtime interface has no atomic submit ownership and its supplied store can observe both calls before either persists.

## Existing regression scope

Passed unchanged existing tests:

- `apps/indexer/src/parse.test.ts`: 19.
- `apps/indexer/src/webhook-helpers.test.ts`: 4.
- `apps/web/lib/api.test.ts`: 21.
- `packages/shared/src/authority/envelope.test.ts`: 9.
- `packages/shared/src/billing.test.ts`: 8.
- `packages/db/src/lot-allocation.test.ts`: 4.
- `apps/trade-executor/src/solana-executor-selection.test.ts`: 9.
- `apps/trade-executor/src/execution-authority-adapters.test.ts`: 36.
- `packages/db/src/fanout-eligibility.test.ts`: 35.
- `apps/api/src/routes/billing.test.ts`: 14.
- `packages/db/src/billing.test.ts`: 11.
- `apps/api/src/routes/withdraw.test.ts`: 6.

Five of the six changed test files were run. The changed shadow suite was inspected only at setup/diff scope and not run because it imports the full executor entrypoint; the timeout change alone is not a regression proof. The tests above used a custom review configuration with source aliases, not the repository's broad root/Turbo or integration setup. Database/Redis access was explicitly blocked or replaced with test doubles. These are not integration, deployment or production-build passes.

## Compiler scope

The frontend typecheck used the current `apps/web/tsconfig.json` with `--noEmit --incremental false`. It failed to resolve AppKit/react, AppKit adapters/networks, Wagmi, TanStack Query, Solana web3 and Tailwind. Those packages are declared in the current manifest; no install was performed to reconcile local `node_modules`. The result proves the current checkout cannot complete that typecheck, not that a clean dependency installation would necessarily fail.

The backend check used `backend-source-typecheck.json` with source aliases and included API, executor, indexer, signal engine, shared and DB non-test TypeScript. It first exhausted its 512 MB Node heap, then completed with 640 MB after available memory was checked. This is **not** the original package-by-package emitted production build, nor LP/scorer/discovery/alerts/Rust build certification. No source, package `dist`, or `tsbuildinfo` output was written.

## Literal scan limits and positive observations

The scanner examined non-test current web/API/LP/PDA code plus existing local `.next/static` client JS/map/JSON artifacts using bounded patterns for private-key headers, credential-bearing URLs, structured provider tokens, sensitive literal assignments and credential query URLs. It returned zero candidates and emitted no suspect values. It found public variable names including WalletConnect/Reown project IDs; such project identifiers are intended browser configuration and not private keys.

Existing client artifacts were not rebuilt or proven to correspond to current HEAD. A failed current frontend typecheck makes it especially inappropriate to call the existing bundle current or safe by certification. No runtime-injected secret, API response body, actual logs, dotenv value, server bundle, deployment setting or historical credential was inspected. Obfuscated/unrecognized secrets can evade heuristics. Source-proven secret/data **flows** remain actionable even with zero literal hits.

## Safety, harness errors and reproducibility

- `run-check.py` pins itself and children to CPU 0, executes commands sequentially, caps the Node heap and applies a 240-second command timeout. Thread-count environment variables are one. The host, unrelated processes and Docker daemon were not globally repinned.
- Environment inheritance is allowlisted; database/Redis URLs, addresses and signatures are synthetic. `DOTENV_CONFIG_PATH=/dev/null`, test/paper mode and auto-execution off are set. No real credential file is needed.
- `offline-guard.cjs` blocks Node outbound socket/HTTP/HTTPS/datagram/fetch methods and sensitive-file reads. `test-safety.ts` blocks real PostgreSQL and Redis drivers. This is a conservative testing guard, not a formally complete operating-system sandbox. Known tested modules were also reviewed for side effects.
- First Vite startup tried loading the root dotenv; the guard rejected it **before reading**. The report-only config was corrected to use an empty review `envDir`. `api-invariants.log` preserves that harness failure; the subsequent `api-invariants-offline` run executed the real assertions. No real dotenv was opened.
- Initial API harness referenced a nonexistent `chains.js`; this was corrected to the real `validation.js` before execution. It was a harness-path correction, not an application defect.
- Initial Jito test used always-empty mock getters. It was strengthened to an actual stateful Map-backed pending/resolved store; all three failures reproduced. Only the stronger result is used in final counts.
- One delegated review request was rate-limited before returning findings; the coordinator completed the database/indexer partition directly. No findings are inferred from that failed request.
- The huge initial Git diff-stat output included committed assessment artifacts and was not treated as a reviewed code diff. Later scope excluded reports/build/lockfile noise.
- The first report-validator invocation stopped on a malformed regular expression before producing acceptance evidence. The report-only pattern was corrected; the subsequent structural/source-integrity check passed. This was an audit-tool error, not an application failure.
- Commands, exit codes, durations and CPU affinity are recorded in `commands.jsonl`. No package installation, actual database/Redis connection, service start, target/public network request, trade, deployment, commit or push occurred in this post-fix review.

The existing integration chaos suite was deliberately excluded because its current code terminates other DB/Redis clients. Installed roles/schema and full two-user worker/contract acceptance remain unverified; the current closure ledger marks these limits rather than carrying forward old successful runs as new evidence.
