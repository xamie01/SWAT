# Wave 3 coordinator integration and verification repairs

Source review references: WAVE3-E-RECHECK.md, WAVE3-F-RECHECK2.md, WAVE3-G-REVIEW.md plus WAVE3-G-RECHECK.md, WAVE3-H-FINAL-REVIEW.md.

## Reviewed integration

081/082/083 proposal files were copied byte-for-byte into packages/db/sql/081_custody_grants_delegation.sql, 082_withdrawal_reducing_intent.sql and 083_lp_exact_paper_operations.sql. They were NOT applied. No role, database, service, wallet or provider was provisioned.

DB barrel exposes the reviewed production custody, withdrawal, reducing and exact LP modules; fixtures are not exported. Existing package main/types plus explicit dist subpath imports are retained. Web uses a type-only relative import of emitted lp-exact declarations because web does not declare @swat/db as a dependency; no new runtime dependency or lockfile change.

## Supported additional repairs

- F9: parent-lock ordering already present; changed INSERT and cancel expiry comparisons to clock_timestamp() so statement-start time does not admit an expired intent after a lock wait. WAVE3-F-RECHECK2.md independently closed this source issue.
- G-1: schema083 now requires pending/no-receipt admission on INSERT; completed UPDATE requires durable receipt; exact position guard independently joins operation/user/position/receipt key/data. Source regression added and WAVE3-G-RECHECK.md independently closed the finding.
- Outer mandated flock and the runner's reopened lock would self-deadlock. Runner now duplicates the inherited same-inode file description when present and reacquires exclusive flock on it; otherwise opens/locks normally. Added a keyless nonblocking regression. CPU0, memory limits, offline guard and command grammar remain unchanged. Runner requires an evidence label before kind and target; commands retain this actual grammar.

## Preserved failed verification and scoped repairs

- executor emit01: TS2540 in reducing-orchestration fixture. Only local fixture mapped type made mutable; production readonly contracts preserved. emit02 passed.
- E tests01: 246/249; invalid historical 42-hex-digit EVM fixture corrected to 40, production validator unchanged. tests02 passed249.
- G tests01: 158/160; legacy source assertions matched FOR UPDATE as a modifying UPDATE. Matched statement-leading UPDATE instead; production locking and tests retained. tests02 passed160.
- H tests01: 167/168; OTP substring matched canonical amount digits. Asserted exact scalar secret absence and forbidden fields instead; exact amount remains intact. tests02 passed168.
- web typecheck01: absent @swat/db dependency declaration import plus malformed test casts/readonly delete/generic inference. Type-only explicit relative DB declaration import and fixture typing repaired. typecheck02 passed.

All failures and logs remain in immutable build-w3-* evidence. No assertion counts include repeated runs. Final freeze/reruns and independent reconciliation are required before WAVE3-ACCEPTANCE.md and ledger acceptance. Source/injected acceptance does not certify browser rendering, PostgreSQL16/Redis, real concurrency/crashes, trusted external providers, production or live financial execution.
