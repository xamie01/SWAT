# Final report validation and limitations

Completed: 2026-11-06. These notes and `artifact-validation.json` describe the **static phase only**. Later tests/builds/services/live reads are recorded in [runtime verification](../04-runtime-verification.md) and [final runtime summary](../runtime/runtime-summary.json); the static validator's `tests_run`/network flags are not a current-session execution summary. The offline report-only validator is [validate-reports.py](validate-reports.py). It reads reports, coverage manifests, inventoried source files and local Git metadata; it writes only under `threats/`. It does not import application code, run application tests or contact services. Its static-phase machine-readable results are in [artifact-validation.json](artifact-validation.json).

## Completed checks

- All twelve expected module reports exist and contain sections A–D. All finding rows use six columns and the required severity/confidence values; no malformed tables were found.
- Checked 939 module source-citation occurrences and 204 root-report source-citation occurrences. No missing cited paths or out-of-range lines were found. No broken local links were found in root reports.
- Counted 82 module observations: 27 High, 48 Medium and 7 Low. Six explicit consolidations produce 76 findings: 24 High, 46 Medium and 6 Low; none rated Critical. Deduplicated confidence is 52 Verified, 21 Likely and 3 Needs check. The retained IDs and folded observations are recorded in [finding-register.json](finding-register.json).
- Updated the coverage ledger from per-module manifests: 709 inventoried files and 167,133 inventory LOC, with 191 in-depth relevant-path files, 73 skim/search files and 445 not reviewed. Partial-file review does not cover unlisted sections; inventory LOC is not audited LOC.
- Compared SHA256 against all 709 baseline source files: no changes. Tracked Git diff was empty; HEAD remained `d5852a0e31e8e9a517c6e7c47ed9623819c7fc71`. Git status contained only the existing untracked `LP-BUILD-RECORD.md`, existing `apps/lp/.zcodeignore`, and the new `threats/` artifacts. No commits or application/configuration fixes were made.
- Static High revalidation and neighboring caller checks are documented in the module reports. Unsupported impact claims were downgraded or explicitly marked NOT VERIFIED.

## What these checks do not establish

Citation validation checks recognized concrete path/range syntax, not the semantic correctness of every claim or completeness of citation coverage. Table validation does not prove that proposed fixes or test descriptions work. Source hashes establish integrity of the inventoried baseline, not every ignored or uninventoried file. `Verified` means relevant source/callers were traced, not a reproduced or deployed exploit.

All application tests, builds, service launches, Solana validators, runtime imports and live calls remain **NOT RUN**. No current real `.env` or credentials were read in this review round. Existing integration/chaos suites were not run because their infrastructure isolation was not established. Proposed regression cases are descriptions, not passing tests.

Deployment, funded accounts, actual runtime roles/firewalls, venue certification, external contracts, dependency internals and external audits remain **NOT VERIFIED**. The separate [history summary](history-scan-summary.json) covers locally reachable Git blobs only and records redacted fingerprints; it does not establish secret validity or a clean history. Binary/encoded content, unreachable/reflog-only history, remote objects and external payloads remain excluded as documented in module 11.

The bounded assessment and report bookkeeping are complete. Implementation and regression execution were not part of the applied changes.
