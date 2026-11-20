# Wave 4 second authentication repair checkpoint — 2026-11-19

**The three findings from the independent P3 repair re-review are implemented and pass 781 main offline tests across 36 literal files, 46 separate load contracts and five noEmit compiler checks. Independent acceptance remains pending at this checkpoint. Wave 4 is not source-complete; P4 has not started.**

This checkpoint supersedes the 748/36 repair test epoch for consumed source, not the independent verdict. The original [six-finding review](WAVE4-AUTHENTICATION-REVIEW.md) and subsequent [three-finding repair re-review](WAVE4-AUTHENTICATION-REPAIR-REVIEW.md) remain unchanged historical records.

## Supported repairs

- **A — Internal foreign-key enforcement.** `auth-catalog-dependencies.ts` validates the exact four enforcement paths for every reviewed auth FK by child/parent relation, constraint/dependency association, builtin function identity/options, AFTER ROW event, nondeferrable state and enabled state. Generated trigger names and dynamic OIDs are not hard-coded. The outer gate rejects additional internal triggers outside the reviewed FK closure. Hostile contracts cover missing, disabled, substituted, misassociated, malformed and extra enforcement triggers in all three catalog phases and before handoff.
- **B — Shared staging target binding.** Exported reference/candidate schema helpers bind the supplied installation to the inspected disposable container database/address/port and the actual connected database/system identity before privileged acquisition. Reference binding is inspected and observed again after migration COMMIT, before external handoff. Reference and candidate auth clusters must have distinct system identifiers. Candidate validation never provisions or activates. Refusal/order contracts cover inspected and connected mismatches and shared clusters without real Docker inspection or SQL.
- **C — Runtime lease custody.** Qualification checks clean direct `swat_app` identity and positive backend before target observation and checked BEGIN. It rechecks cleanliness/backend before BEGIN and identity/backend after BEGIN and before settlement. Borrowed or drifted leases are discarded without settling unrelated work. An ACL-aborted transaction whose identity cannot be re-observed is discarded rather than claiming rollback. A COMMIT attempt with uncertain outcome never triggers rollback. New contracts exercise open transactions, role/session/settings/membership/backend/target mismatch, identity/backend drift, aborted-transaction observation and COMMIT uncertainty.

No SQL087 bytes, seven-transfer 079/082 broker, app authority or auth-owned production-store semantics were widened. SQL083/084 refusal and public qualification/positive-pipeline refusal remain.

## Verification repairs and retained failures

`build-w4-auth-rerepair-main-offline-01` retained 775 passed and six failed assertions out of 781. Four drift tests expected an inner identity error although the negative qualification driver wraps non-ACL failures; assertions now require the actual fail-closed outer error and still prove no COMMIT/ROLLBACK. Two new schema fixtures omitted Node's `execFile` custom promisification; the mock now returns `{stdout,stderr}` as the actual API does. No production refusal was loosened.

`build-w4-auth-rerepair-qualification-typecheck-01` failed because the fixture inferred a zero-argument mock release rather than the owned lease contract. The factory now returns `AuthClientLease`, preserving `release(broken: boolean)` without mock-specific type leakage. All original failed artifacts and intermediate green epochs remain immutable and separate.

## Final frozen verification

| Immutable check label | Result |
| --- | --- |
| `build-w4-auth-rerepair-main-offline-03` | 781 passed; 36 unique literal files; zero failed/skipped/todo |
| `build-w4-auth-rerepair-load-offline-01` | 46 passed; one literal file; actual MJS preflight child exercised |
| `build-w4-auth-rerepair-db-typecheck-02` | DB noEmit; incremental false; exit 0 |
| `build-w4-auth-rerepair-qualification-typecheck-02` | Qualification noEmit; incremental false; exit 0 |
| `build-w4-auth-rerepair-api-typecheck-01` | API noEmit; exit 0 |
| `build-w4-auth-rerepair-api-tests-typecheck-01` | API tests noEmit; exit 0 |
| `build-w4-auth-rerepair-lp-typecheck-01` | LP noEmit; exit 0 |

All seven share consumed-input manifest SHA-256 `d151ca0b2a2ef93a5a78d08549ae2eb0f09fb2f2a3ff47aa895c3641a33b8ac8` and report unchanged inputs. Reconciliation verifies command/log/result/manifest byte hashes, exact literal file sets, per-file assertions and full current runner inventory equality. Report-only updates are excluded by runner policy; executable configs and hash approvals remain included. The main config hash remains `e884d87fe41cbce907af4d2bfa7e1135e9983f473826ec81c7e6043a3a18e611`; load config remains `2adbfa9d60d2206fc26f71fc17d19edd0fd731f30061ca7f21f46d55e5b9ebec`.

Main auth provisioning now has 43 tests, authentication qualification 26 and build-schema 17. Other literal scopes retain their current counts. Main and load counts are not summed into runtime-qualified behavior. DB production source outputs remain from the separately retained fresh emit `build-w4-auth-repair-db-emit-01`; this repair changed deployment/qualification source, not DB emitted implementation. Earlier 748/36 and 709/35 checkpoints remain historical.

Verification was sequential under CPU0 shared flock, one test fork/512MB Node heap and compiler640MB, synthetic environment and offline network/credential guard. `timeoutSeconds:null` does not remove application transaction/operation/cancellation/shutdown/load-drain deadlines. `git diff --check` passed after the final source edit. No owner or check remains active; only independent read-only re-review is pending.

## Acceptance boundary

The independent re-review of A/B/C is pending; implemented repairs and passing contracts do not supersede its REJECT by themselves. P1/P2 retain earlier bounded source acceptance. P3 acceptance remains false until a new independent verdict. P4–P8 implementation and P9 audit remain outstanding; Wave5 is blocked.

No runtime services, real Docker inspection, SQL application, seeding, real credentials, live signing capability, funds, actual load traffic, commit, push or publication occurred. Tests used synthetic catalog/lock fixtures, ephemeral signatures and source-loader children only. Actual PostgreSQL16 catalog/deparser/ACL/RLS/locking/COMMIT, Redis/BullMQ/PgBouncer, load and cleanup observations remain unqualified.

`sourceComplete=false`, `authenticationSourceAccepted=false`, `runtimeAccepted=false`, `liveCapabilityAccepted=false`, `productionReady=false`.
