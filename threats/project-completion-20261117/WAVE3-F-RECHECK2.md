# Wave3 F independent recheck2 — narrow source review only

Date: 2026-11-17. Scope: independent sequential review of F8/F9/F10, withdrawal OTP single-use/outbox atomicity, and transactional economics fixture rollback. Reviewed `/root/SWAT/threats/project-completion-20261117/WAVE3-F-REPAIR2.md` and the relevant current SQL, services, store, adapter, runner, and affected test source. No implementation was edited. This report is the only requested repository write.

**Disposition: the targeted repair2 source obligations are supported by the current source, including the coordinator's post-wait clock correction on both F9 paths. No new supported implementation blocker was identified within this narrow recheck. This is NOT runtime acceptance or a passing-test claim.** Existing PostgreSQL, independent provider/mapping/accounting, custody/OTP, and integration qualification blockers remain.

## Review boundaries and baseline

- Fourteen bounded, sequential source/read/inspection tool calls; no agents, parallel delegation, or background work.
- No tests, compiler, SQL parser, migration execution, network, secrets, credentials, services, installs, provider calls, signing, funds, commits, or publication.
- SHA256 hashing and scoped `git diff` were source inspection only. Other pre-existing working-tree changes were not modified or accepted by this F review.
- The earlier 20/20 manifest match before the coordinator SQL/test edits is the supplied historical baseline, not an observation newly reproduced here. This review independently compared the current 20 entries twice: **18 match repair2; 2 are revised**, with identical current hashes at the final observation.
- Repair2 report SHA256: `418cd263fbaf68a3c444b3384673a5dfc028e8010945eb766bcef200c59183e4`.

## F8 — exact same-intent closed-exposure fee-only accounting

**Source-supported.** `/root/SWAT/threats/project-completion-20261117/082-withdrawal-reducing-schema.proposal.sql:327-374` locks owned intent, then attempt, then position. Receipt selection binds receipt/intent/user/attempt. Existing position-application replay returns the stored result before accounting again (335-338); fresh receipts reject terminal attempts and quantity/fee regression (339-340). Independent economics admission must match exact receipt, tenant, intent, position, quantity delta, and fee delta (342-345).

The closed branch at 357-365 requires all of:

- quantity delta = 0, current raw quantity = 0, resulting raw quantity = 0;
- prior position application for this position, **same intent and user**, and same side;
- matching applied financial receipt journal via receipt/intent/user;
- prior receipt belonging to the **current attempt**, with cumulative quantity equal to the attempt's current accounted quantity;
- prior position application `after_raw=0`.

There is **no UPDATE in the closed branch**. Position size/status mutation exists only in the separate open/closing branch (366-369); other statuses raise (370). Thus an unrelated preclosed or liquidated position does not gain fee-only eligibility from zero size alone, and the closed branch neither reduces quantity again nor reopens exposure. A new immutable position application is still written (371-373).

The financial application checks the canonical position/economics joins for any quantity or fee delta (393-401), derives progress from the receipt (407-413), and atomically derives reservation release/paid-fee accounting (414-417). The deferred constraint at 423-433 requires the position journal and matching financial application to commit together.

`/root/SWAT/packages/db/src/polymarket-perps.ts:334-367` validates fee denomination, exact admitted receipt hash/current deltas, independent economics, invokes the restricted SQL function instead of arbitrary position writes, and validates unchanged zero exposure for delta zero. `/root/SWAT/apps/trade-executor/src/reducing-orchestration.ts:55-80` checks admitted exact replay before fresh accounting, computes independent quantity/fee deltas, and calls accounting for either nonzero delta on the same transaction/client. Receipt acceptance does not require the original now-stale admission exposure to still be open.

Affected authored evidence, not executed:

- `/root/SWAT/apps/trade-executor/src/reducing-orchestration.test.ts:179-189`: nonterminal cumulative100/fee2 closes position100→0 without financially terminalizing; final cumulative100/fee5 yields delta0/fee3, remains closed, persists two economics journals, releases budgets, and adds no accounting call on repeated run.
- `/root/SWAT/packages/db/src/polymarket-perps.reducing.test.ts:36-42`: actual adapter with mocked restricted-function results returns before0/after0 and requires economics for fee-only change.
- `/root/SWAT/packages/db/src/withdrawal-store.test.ts:98-103`: static closed-branch assertions. These are presence assertions, not execution or a complete negative-case proof for the SQL joins. The exact same-intent/attempt/application join was inspected directly above.

## F9 — parent locking, INSERT versus cancel, and post-wait expiry

**Source-supported with coordinator correction.** Exact current evidence in `/root/SWAT/threats/project-completion-20261117/082-withdrawal-reducing-schema.proposal.sql`:

- 258: direct attempt INSERT guard first selects owned parent `FOR UPDATE`.
- 259-260: only after that lock returns, it rejects nonqueued, terminal, cancelled, hash-mismatched parents and checks `parent.expires_at<=clock_timestamp()`.
- 474-475: cancellation first selects the same owned parent `FOR UPDATE`.
- 478-480: only after that lock returns, it checks `parent.expires_at>clock_timestamp()` and committed-attempt existence before allowing cancellation.
- 481-487: cancellation takes ordered budget locks, terminalizes/cancels the intent, releases reservations, and appends audit in the same function/transaction.

This addresses the statement-start-time hole: a statement that starts before expiry but waits until after expiry cannot qualify INSERT using its old statement timestamp. A cancellation statement that waits across expiry also evaluates the actual post-wait time. `statement_timestamp()` remains for audit timestamps; it is no longer used for these two expiry decisions. Repair2's prose at 16 still describes `statement_timestamp()` and therefore must not be treated as the current corrected expiry implementation.

Source ordering supports both interleavings: if INSERT wins the parent lock and commits an attempt, cancellation's later absence proof rejects; if cancellation wins, INSERT's later locked parent validation rejects cancelled/terminal state. Existing unique intent attempt and FK bindings remain, and direct runtime app INSERT remains narrowly granted at 578-579; there is no bypass/service-role widening in the coordinator diff.

`/root/SWAT/packages/db/src/withdrawal-store.ts:53-55,94-107` and `/root/SWAT/apps/trade-executor/src/reducing-orchestration.ts:90-112` show service runner paths lock parent before reading/creating attempt or cancelling. The runner cancellation path already obtains the parent through `byId` before the store's budget locks/function call.

`/root/SWAT/packages/db/src/withdrawal-store.test.ts:83-97` is updated for both `clock_timestamp()` comparisons and asserts INSERT lock-before-status plus absence of the old INSERT expiry comparison. The coordinator diff changes only the two SQL expiry comparisons and corresponding test expectations. No SQL/RLS/FK/lock-wait engine behavior was executed or accepted; genuine database isolation/current-role/concurrency qualification remains required.

## F10 — independently admitted collateral mapping

**Source-supported; trusted external evidence remains mandatory.** `/root/SWAT/packages/db/src/reducing-contract.ts:34-50` defines a separate trusted mapping port and validates tenant/position/account/venue/chain/network/mode/instrument/scale, mapping identity/revision/proof, collateral denomination/account, and fresh observed/valid time. `/root/SWAT/packages/db/src/reducing-contract.ts:7-15,26-32` keeps collateral out of the public reducing request/immutable intent constructor; public fee fields are not collateral authority.

`/root/SWAT/packages/db/src/reducing-service.ts:29-55` requires the port for perps, invokes it on the same client after budget/exposure/funding locks, refreshes database time, validates the mapping, and requires independently persisted mapping identity/hash for this owned position. This same `revalidate` function is used before attempt preparation and immediately before dispatch by `/root/SWAT/apps/trade-executor/src/reducing-orchestration.ts:110-111,128-135`. Spot does not require a perps mapping.

SQL source joins in `/root/SWAT/threats/project-completion-20261117/082-withdrawal-reducing-schema.proposal.sql`:

- 100-108: mapping keyed by immutable mapping ID and owned position FK, **not an uncommitted runtime intent FK**.
- 240-244: perps outbox requires a still-valid matching position/tenant/account/chain/network/mode/instrument/scale mapping.
- 494-517: only independent receipt writer INSERT is admitted; mutation is rejected; actual owned instrument and exact JSON/column bindings are required.
- 525-541: economics chooses the admitted mapping using journal `venueMappingId` plus exact tenant/position/account/chain/network/mode/instrument/scale, and binds journal collateral asset/scale/account to that mapping, **not** public fee asset/scale/account.
- 554-566,586,594-596: mapping/economics FORCE tenant RLS and select permissions, independent-writer-only INSERT, and scoped position-read policy/helper access. No app mapping INSERT grant.

Affected authored evidence, not executed:

- `/root/SWAT/apps/trade-executor/src/reducing-orchestration.test.ts:191-202`: MATIC fee18 stays distinct from admitted USDC collateral6 in the actual fixture journal; an unadmitted mapping denies admission before outbox and rolls back intent creation.
- `/root/SWAT/packages/db/src/withdrawal-store.test.ts:104-112`: independent mapping/economics binding and absence of intent FK/public fee-label comparison.
- `/root/SWAT/packages/db/src/reducing-protocol.test.ts:9-18,20-57` and `/root/SWAT/apps/trade-executor/src/polymarket-perps.test.ts:27-43`: actual injected service admissions now supply explicit mapping/funding ports and remain queued rather than claiming closure.

Positive fixture ports manually admit mapping evidence; they do not prove an independent deployed writer, authentic collateral resolution, provider account/network/mode binding, or provider guarantees. SQL economics can reference a historical admitted mapping for actual receipt settlement; fresh mapping is an admission/new-effect requirement, not permission to suppress accounting of already-real facts. No runtime mapping/account-settlement acceptance follows from these source checks.

## OTP single-use and outbox atomicity preserved

**Source-supported.** `/root/SWAT/packages/db/src/withdrawal-service.ts:151-184` loads locked intent/authorization, binds exact digest and authorization ID, makes exact consumed replay nonmutating, commits bad-code failure counters via an error marker, revalidates funding/ownership before reservations, conditionally consumes once, and queues outbox/state on the same client. `/root/SWAT/packages/db/src/withdrawal-store.ts:86-92,152-158` shows locked authorization lookup and outbox insertion before queued transition. OTP delivery occurs only after request transaction commit and pending retries never reissue/resend (134-147).

`/root/SWAT/threats/project-completion-20261117/082-withdrawal-reducing-schema.proposal.sql:186-227` rejects consumed-record mutation, nonmonotonic failures, unconfirmed/locked/expired consumption and missing reservations, with a deferred consumed-authorization→exact outbox constraint. The outbox guard at 228-247 requires the reciprocal consumed authorization and reservations. Identity/uniqueness and immutability prevent consuming a second authorization for the same intent or manufacturing a second durable request on exact replay. This review does not establish a production OTP implementation or SQL trigger/runtime acceptance.

Authored coverage in `/root/SWAT/packages/db/src/withdrawal-protocol.test.ts:29-56,58-99,133-136` checks commit-before-delivery, single-use replay, one client for reserve/consume/outbox/queue, SQL-outbox failure rollback, wrong-code lockout, unconfirmed delivery denial, and deferred-commit rollback. No tests were run.

## Economics fixture journal rollback

**Source-supported as a fixture repair, not canonical financial proof.** `/root/SWAT/packages/db/src/withdrawal-test-fixture.ts:11-16,22-49` stores economics rows and position status inside the cloned transactional state and restores the whole snapshot on work or injected deferred commit failure. At 131-133, perps nonzero quantity/fee application requires an actually stored journal; at 152-156 economics rows are appended; at 160-165 quantity, fee balance, and position status are changed inside the same state.

`/root/SWAT/apps/trade-executor/src/reducing-orchestration.test.ts:40-56` writes `fixture:economics` JSON through the same SQL client before account/application, including exact quantity/fee deltas, before/after balances, admitted collateral mapping, and PnL/margin/price/reference fields. At 112-116 it checks grouped same-client journal/account/application calls. At 137-141 it checks application failure rolls journal/inventory back. At 204-213, full100/fee5 deferred failure asserts restored quantity100/statusopen/feeHeld1000/economics0/applications0/intent uncertain, then retry persists one journal and quantity0/statusclosed/feeHeld995.

Limits: the fixture is globally serialized, SQL-marker simulated, manually admitted, and uses canned economics values. Its deferred-commit failure is an explicit injected exception, not a real PostgreSQL deferred trigger. The fixture requires journal presence, not the full deployed SQL economics semantics. Neither its concurrent-worker tests nor persisted journals establish PostgreSQL locking/RLS/ACL/function ownership, actual PnL/margin/collateral conservation, or an authenticated canonical ledger writer.

## Acceptance and remaining gates

The reviewed repairs do not authorize runtime/live deployment or funds. Preserve `supported=false`, `injectedVerified=false`, `runtimeAccepted=false`, and `liveAccepted=false`; `/root/SWAT/packages/db/src/reducing-contract.ts:114-118` and `/root/SWAT/packages/db/src/reducing-service.ts:59` retain that distinction. No passing counts or SQL parse/runtime claims are supplied.

Outstanding qualification includes actual schema082/function ownership/helper ACL/RLS and direct INSERT-versus-cancel lock-wait behavior; independent deployed provider deadline/reduce-only/tombstone and collateral mapping evidence; canonical every-fill PnL/collateral/margin/account settlement; accepted withdrawal/spot accounting, custody/current funding/OTP implementations; and coordinator dispatcher/sweeper/reconciliation/barrel/emitted-artifact/H joins. This narrow review does not reopen or independently reaccept unrelated F1/F2/F4/F6/F7 or other wave implementation work.

## Revised hashes versus repair2

| Absolute path | Repair2 SHA256 | Current SHA256 |
| --- | --- | --- |
| /root/SWAT/packages/db/src/withdrawal-store.test.ts | 746a624a4b6edc5e2a97764820e44eb0399e562d54ba1b962f189bc5f29a7461 | 904b45833b6e9d09ee019fa40fa87ce488d1238613dcab050a477fcaf7028057 |
| /root/SWAT/threats/project-completion-20261117/082-withdrawal-reducing-schema.proposal.sql | a268505e351b1c91589137811fa402287f86ce1eb6b2af33f1494d7df4ee4050 | 4d186f7d932545c467b869285693e23d6e06d282a3b7a8a21b2ae22517c3aa53 |

## Current 20-entry manifest

Hashes observed twice during this recheck. Hash inclusion of unchanged entries is manifest coherence only, not a claim that every unrelated file was rereviewed in full or executed.

| Absolute path | Current SHA256 |
| --- | --- |
| /root/SWAT/apps/trade-executor/src/manual-exit.test.ts | 791b01fe2ee5781dd04b4502be3c63b608d6fb739b80f049ea4fc386d524479d |
| /root/SWAT/apps/trade-executor/src/manual-exit.ts | 8a87114139afc8639a256ff213c491cf1eba00dcf75e13dbc6ca1e0093f38daa |
| /root/SWAT/apps/trade-executor/src/polymarket-perps.test.ts | 8719e88eeaa32c64bc03cc8de4e0ba9524b04450b5eb614d019a655bed1b2de3 |
| /root/SWAT/apps/trade-executor/src/polymarket-perps.ts | 70fd3306a6b9fb7727ac1ab6c17b47b593973e683eb3364bcef18422af66ca53 |
| /root/SWAT/apps/trade-executor/src/reducing-orchestration.test.ts | 9afd228d6977f341e37b07ad4828ef88aef01d0e395c203ddd942014c64f6674 |
| /root/SWAT/apps/trade-executor/src/reducing-orchestration.ts | 29d9e9dfcc032d7927217d8542b963860cccd8b8f3e1b613d9dbb2fd60623c1b |
| /root/SWAT/apps/trade-executor/src/reducing-provider.ts | 821fef984e0b1fa7cf40ab81f2487bf6d2c7d87c94cc8fe831b8a0df6cd07ada |
| /root/SWAT/packages/db/src/polymarket-perps.reducing.test.ts | 10eeb6f93a4e72132a8d0c85ea4e7970bcb95b381e57019c8e65edb119762e89 |
| /root/SWAT/packages/db/src/polymarket-perps.ts | f6ade98aa6ba8d34c1441823da3675a17114b1b618273e182725903463a36c2d |
| /root/SWAT/packages/db/src/reducing-contract.ts | 56ce23e7630e05c0389333210037838f89229592071724f25906e243851f4bd2 |
| /root/SWAT/packages/db/src/reducing-protocol.test.ts | 92b70169c9c648f85582e690fbc5af99a9bff51b8c5d8731bdb8232bf483c039 |
| /root/SWAT/packages/db/src/reducing-service.ts | 475e590bfe0a14e03eba8c0405de633988a8c0d8bfabd045f738baaf4ad9c796 |
| /root/SWAT/packages/db/src/withdrawal-contract.ts | d74d2a8636f397386ee16a4eb3962a2e2071bc491a4264c865787aec6bf5f7c7 |
| /root/SWAT/packages/db/src/withdrawal-protocol.test.ts | dafe04d18b39ba056234c6da22f0a5ca3d3edf4ee5368b2703b2e256f39110e5 |
| /root/SWAT/packages/db/src/withdrawal-service.ts | 3e0b0ca150f5e465b3650d78b21b17f306ec5ccf4fab7035fe9fbc24832d70f1 |
| /root/SWAT/packages/db/src/withdrawal-store.test.ts | 904b45833b6e9d09ee019fa40fa87ce488d1238613dcab050a477fcaf7028057 |
| /root/SWAT/packages/db/src/withdrawal-store.ts | 6fdfcf19aa4499960f6c2c409784a0ad63901db64affee937c94e605533156b0 |
| /root/SWAT/packages/db/src/withdrawal-test-fixture.ts | 762d1de6f301bca6d659c4d5369680b3af7b2680294d0f1b73264cf382b9b2c6 |
| /root/SWAT/threats/project-completion-20261117/082-withdrawal-reducing-schema.proposal.sql | 4d186f7d932545c467b869285693e23d6e06d282a3b7a8a21b2ae22517c3aa53 |
| /root/SWAT/threats/project-completion-20261117/w3-f.config.ts | d013ec61b07c20daba8f63ee7543c0e36a2cbfcbc215c6107c6149f09942721b |
