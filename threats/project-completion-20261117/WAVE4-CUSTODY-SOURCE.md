# Wave4 custody source checkpoint — 2026-11-18

Status: local source and 16 injected contracts verified in current `build-w4-main-offline-18` (366 tests/13 files); qualification no-emit typecheck16 passes. The expanded independent review found no additional supported custody-scenario defect, but withheld affected acceptance on the SQL privilege/receipt boundary. Deployed custody, SQL and delegation acceptance are absent.

The sequential S4 subagent could not start because of the provider token rate limit. The coordinator created dedicated source files directly; no concurrent agent or alternate model was used.

- `custody-scenarios.ts` invokes actual wrap-only enrollment, current grant observation, full independent binding AAD reconstruction and single-use execution-session access. It checks the public secret-free projection, pinned lifecycle boundary and zeroed owned bytes. A mandatory caller-owned transaction factory exposes the production SQL stores with no ambient fallback.
- `custody.offline.test.ts` uses fresh disposable local AES-256-GCM material and four explicit synthetic bytes, never a wallet key. It invokes production custody logic against an inert store: distinct wrap/unwrap port surfaces, full AAD roundtrip, missing capability, failed simulated commit, tenant/domain/account/policy/revision/expiry substitutions, revoke-retire-reactivate ABA, exact deadline before/during unwrap and ciphertext authentication refusal. All local buffers are cleaned up.
- Runtime imports are the direct `custody-enrollment`, `custody-execution`, `custody-contract` and `custody-store` leaves. Types for tenant/transaction are erased. Offline tests additionally use Node crypto and Vitest. No DB pool/client, network, wallet, provider, signing, queue or service construction is performed.

This is not an implementation or proof of deployed delegation. Separate wrap/unwrap service identities, restricted independent custody-secret admission, authenticated production scope, actual SQL lifecycle/commit/RLS evidence and an atomic execution-boundary delegation check remain unqualified. Existing session consumers must perform the latter at the actual effect boundary; these source tests perform no effect. No fixture signature or trusted delegation receipt is invented.

No shared domains/CLI activation was changed. Runtime/pipeline/Package28 execution refusals remain. `runtimeAccepted=false`, `liveCapabilityAccepted=false`, `productionReady=false`. Full Wave4 is incomplete; Wave5 remains blocked.
