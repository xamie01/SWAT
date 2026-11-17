# Exclusive implementation roster — 2026-11-17

| Wave | Owner | Scope | State |
| --- | --- | --- | --- |
| 1 | source/fanout | accepted source/obligations | accepted and sealed; do not redo |
| 2 | C / D | scoped runtime and immutable corrections | accepted local source/injected; WAVE2-ACCEPTANCE.md |
| 2 review | independent read-only reviewer | supported repair/raw evidence recheck | complete; WAVE2-FINAL-RECHECK.md |
| all | coordinator | barrels, runner/config approval, migration allocation/integration, freeze/joins/reports/acceptance | Wave3 checkpoint written; source unaccepted |
| 3 | E | custody/grants/credentials and executor deployed authority adapters | partial supported repairs; stopped provider quota; NO final repair report |
| 3 | F | durable withdrawal/reducing domain; NO me.ts edits | repair2 report present; stopped provider quota; independent affected recheck/tests pending |
| 3 | G | apps/lp/src and packages/db/src/lp-* | partial exactdomain/actualjoins; contract/config/schema present; stopped provider quota; NO final report/review |
| 3 | H | sole me.ts/API/web integrator | local repairs source-rechecked; final F/G joins and tests pending; owners stopped |
| 3 review | independent read-only reviewers | frozen E/F/H supported findings/rechecks | retained reports; G/final joins pending; NO Wave3 acceptance |

User resumed source completion after configured provider quota refresh. Exclusive E/G owners resumed with their existing contexts; F source frozen under independent read-only repair2 recheck; H final join awaits reviewed contracts. Former owners remain stopped, root LP replacement idle. Don't resume former owner while replacement edits same scope. At most three concurrent implementation owners, exclusive paths per WAVE3-CONTRACTS; only H edits me.ts. F supplies contracts rather than API edits. Coordinator owns barrels/schema integration/config registry, no global test during source edits.

Resume from WAVE3-RESUME.md and WAVE3-INTERRUPTED-STATE.json, not stale initial summaries. Initial implementation/review/repair reports preserved; provider failure isn't a passed test or completed report. Wave3 source may not compile; no tests/emits/compilers run. Source/injected/runtime/live levels distinct, production readiness false. No host services, migration apply/provision, install/download, credentials, signing/keygen, funds, commit/push/publish or Wave4 advancement.
