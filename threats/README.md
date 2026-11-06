# Security review — final index

Date: 2026-11-06. Scope: the local WAKE/SWAT checkout. Authorized defensive review; report-only changes.

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
- `runtime/`: timestamped command logs, failed and successful test/build evidence, captured public responses, final summary and cleanup/integrity records.

## Confidence definitions

- **Verified**: relevant code path and callers read end to end; static finding, not necessarily reproduced.
- **Likely**: evidence supports the concern but a local test or missing integration proof is needed.
- **Needs check**: a conditional hypothesis or deployment property not established from source.

Severity is Critical/High/Medium/Low. Never equate an unchecked deployment assumption to a confirmed exploit. Every factual code claim must cite file:line; unread properties are **NOT VERIFIED**. Abuse cases have at most three conceptual steps. Proposed fixes are instructions, not applied changes.

## Final status

All twelve bounded module reviews, static High revalidation, caller-compatible remediation, coverage accounting and synthesis are complete. That phase performed no application tests/builds/live calls. Its deduplicated register remains **76 findings — 24 High, 46 Medium, 6 Low**, with no supported Critical finding or demonstrated live user-vault drain.

The subsequent **single-core runtime verification is complete within its documented scope**: 124/124 integration passes; 3,036/3,042 original unit passes, with six RLS failures under the bootstrap superuser and a separate 10/10 non-superuser RLS rerun; five real public fills persisted as local paper trades; API/LP startup/read checks; backend compilation and dependency audit. Existing local schema/role drift and frontend dependency/build blockers remain unresolved. Funded custody, full multi-user real-source worker execution and on-chain/remote certification remain unverified. No application fixes, installs, real submissions, commits or deployments occurred.

The latest [OWASP and sensitive-data review](06-owasp-and-sensitive-data-review.md) is also complete within its current-source scope: **15 focused findings — 4 High, 8 Medium, 3 Low**, overlapping rather than simply adding to the original register. It establishes sensitive proof logging and authorization/data-propagation flaws, not a production breach or blanket absence of frontend secrets. That phase fetched public official standards only; no application requests, tests, builds, services, fixes or credential-file reads were performed.

Start with [OWASP and credential/data-exposure findings](06-owasp-and-sensitive-data-review.md) for the latest focused assessment, [all retained weaknesses](05-all-security-weaknesses.md) for the full catalogue, then [runtime results and operational fixes](04-runtime-verification.md), [ranked remediation and compound risks](02-synthesis-and-remediation.md), [concise latency/ordering review](03-latency-and-ordering.md), [previous five findings](01-previous-findings.md) and [coverage ledger](coverage-ledger.md). Module completion is not full-file or deployment coverage. Earlier module-level NOT RUN statements describe the static phase; the runtime addendum is authoritative for later executed checks, not proof every proposed regression ran.

Evidence: [finding register](evidence/finding-register.json), [artifact/source-integrity checks](evidence/artifact-validation.json), [redacted offline history scan](evidence/history-scan-summary.json). Existing user files and tracked source were left unchanged; report artifacts remain uncommitted under `threats/`.
