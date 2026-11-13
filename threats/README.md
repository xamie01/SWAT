# Security review — final index

Date: original reviews 2026-11-06; latest post-fix review 2026-11-08. Scope: the local WAKE/SWAT checkout. Authorized defensive reviews; assessment changes remain report-only.

## Latest post-fix result

Start with [07 — post-remediation OWASP, secrets and deep logic review](07-post-remediation-review.md), the [complete closure ledger](post-fix-8905505/closure-ledger.md), and [executed verification](post-fix-8905505/verification.md). At HEAD `8905505`, the **97/97 completion claim is not supported**. Of the original 76 retained findings: 5 source-closed, 3 source-removed, 25 partial, 39 open, 4 unverified. Across the overlapping 97 tracked IDs: 10 source-closed, 4 source-removed, 33 partial, 43 open, 7 unverified.

Post-fix local checks were sequential on CPU 0: 176 existing tests passed; 17 new synthetic assertions ran, with 16 failures and one pass; the PDA syntax check and frontend typecheck failed; selected backend source typecheck passed at 640 MB after a bounded-heap failure. A bounded source/existing-client literal scan found no candidate production secret, but sensitive transport/error paths remain. No application fixes, credentials, services, real DB/Redis, network targets, signing, trades, installs, commits or pushes were used in this pass. Earlier reports/results below are historical baselines, not assertions that their findings remain unchanged or that the user's later remediation never occurred.

## Output location and rules

All artifacts are under `threats/`. The requested per-module `security-review/NN-<module>.md` convention is nested here as `threats/security-review/` so no writes occur outside the authorized threat folder. Application source, existing configuration/dependencies and user files remain unchanged. The original static phase prohibited network calls. The user's later runtime request authorized sequential tests/builds, isolated PostgreSQL/Redis and bounded public read-only live calls; [the runtime addendum](04-runtime-verification.md) records exactly what ran. No real credentials, working exploit code, real trades, fund movements or remote mutations were used.

## Deliverables

- `00-repository-map.md`: two-level tree, services/entry points, datastores, secrets by variable name only, trust boundaries.
- `coverage-ledger.md`: final module inventory, source LOC and explicit depth/coverage status.
- `01-previous-findings.md`: previous five threats, corrected premises, disposition and cross-reference to current findings.
- `security-review/01-api.md` through `security-review/11-infrastructure-supply-chain.md`, plus discovered modules as needed: boundaries, findings, numbered fixes, invariants/tests, exclusions and evidence inventories.
- `02-synthesis-and-remediation.md`: deduplicated counts, compound risks, top ten fixes, ordered closure work and regression checklist.
- `03-latency-and-ordering.md`: concise execution-specific incorrect premises, measured-vs-unmeasured latency and ordering protections.
- `04-runtime-verification.md`: single-core migrations, regressions, service startup, public live-data replay, runtime findings/fixes and explicit remaining certification gaps.
- `05-all-security-weaknesses.md`: catalogue of all 76 retained weaknesses, including Low-severity and conditional concerns, with runtime overlaps distinguished.
- `06-owasp-and-sensitive-data-review.md`: current-source OWASP Web 2025/API 2023/ASVS 5.0.0 mapping; 15 focused authorization and data-exposure findings, with prior overlaps, safe handling guidance and explicit bundle/deployment exclusions.
- `07-post-remediation-review.md`: current fix verification, OWASP/sensitive-data/deep-logic findings, closure counts, concrete regression failures and remaining acceptance gates.
- `post-fix-8905505/`: four detailed source partitions, full closure ledger, guarded synthetic tests, compiler results, browser-literal scan and source-integrity evidence.
- `runtime/`: timestamped command logs, failed and successful test/build evidence, captured public responses, final summary and cleanup/integrity records.

## Confidence definitions

- **Verified**: relevant code path and callers read end to end; static finding, not necessarily reproduced.
- **Likely**: evidence supports the concern but a local test or missing integration proof is needed.
- **Needs check**: a conditional hypothesis or deployment property not established from source.

Severity is Critical/High/Medium/Low. Never equate an unchecked deployment assumption to a confirmed exploit. Every factual code claim must cite file:line; unread properties are **NOT VERIFIED**. Abuse cases have at most three conceptual steps. Proposed fixes are instructions, not applied changes.

## Historical assessment status (before user remediation)

All twelve bounded module reviews, static High revalidation, caller-compatible remediation, coverage accounting and synthesis are complete. That phase performed no application tests/builds/live calls. Its deduplicated register remains **76 findings — 24 High, 46 Medium, 6 Low**, with no supported Critical finding or demonstrated live user-vault drain.

The subsequent **single-core runtime verification is complete within its documented scope**: 124/124 integration passes; 3,036/3,042 original unit passes, with six RLS failures under the bootstrap superuser and a separate 10/10 non-superuser RLS rerun; five real public fills persisted as local paper trades; API/LP startup/read checks; backend compilation and dependency audit. Existing local schema/role drift and frontend dependency/build blockers remain unresolved. Funded custody, full multi-user real-source worker execution and on-chain/remote certification remain unverified. No application fixes, installs, real submissions, commits or deployments occurred.

The pre-remediation [OWASP and sensitive-data review](06-owasp-and-sensitive-data-review.md) was also complete within its then-current source scope: **15 focused findings — 4 High, 8 Medium, 3 Low**, overlapping rather than simply adding to the original register. It establishes sensitive proof logging and authorization/data-propagation flaws, not a production breach or blanket absence of frontend secrets. That phase fetched public official standards only; no application requests, tests, builds, services, fixes or credential-file reads were performed.

For historical baseline details, read [OWASP and credential/data-exposure findings](06-owasp-and-sensitive-data-review.md), [all retained weaknesses](05-all-security-weaknesses.md), then [runtime results and operational fixes](04-runtime-verification.md), [ranked remediation and compound risks](02-synthesis-and-remediation.md), [concise latency/ordering review](03-latency-and-ordering.md), [previous five findings](01-previous-findings.md) and [coverage ledger](coverage-ledger.md). Module completion is not full-file or deployment coverage. Earlier module-level NOT RUN statements describe the static phase; each runtime/verification addendum is authoritative only for its own later executed checks, not proof every proposed regression ran.

Historical evidence: [finding register](evidence/finding-register.json), [artifact/source-integrity checks](evidence/artifact-validation.json), [redacted offline history scan](evidence/history-scan-summary.json). The user committed the earlier assessment and applied remediation in subsequent commits; this re-review preserves those records and writes only the new assessment and index changes under `threats/`.
