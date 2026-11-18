# S5 withdrawal/reducing qualification source

Source-only implementation. Not Wave4 completion, real SQL/server acceptance, runtime acceptance, live-capability acceptance, Package28 acceptance, or production readiness.

## Ownership and execution boundary

Only these new files belong to this change:

- `/root/SWAT/tests/qualification/wave4/withdrawal-scenarios.ts`
- `/root/SWAT/tests/qualification/wave4/withdrawal.offline.test.ts`
- `/root/SWAT/threats/project-completion-20261117/WAVE4-WITHDRAWAL-SOURCE.md`

Existing production modules, SQL, domains, shared CLI/config/runner/evidence, and accepted Waves1–3 contracts were not edited. No nested agents, background tasks, tests, compiler/typecheck, install, git operation, SQL/Redis/BullMQ/network/service execution, connection construction, or child construction was performed. Focused inspection used 15 source reads/searches. Coordinator must perform any permitted validation under the CPU0 shared lock; this note contains no passing-check claim.

The TypeScript constructs only the keyless production withdrawal/reducing domain service factories and inert fixture ports. It does not construct runtime services. Transactions and SQL clients are caller-owned. The source hard-selects the actual `withdrawalSqlStore`, does not accept a harness store replacement, and does not import ambient DB clients, runtime infrastructure, existing domains, or a production runtime `@swat/db` barrel. Financial identity/port types are type-only imports; no tenant-scope casts or capture-authority casts are introduced.

Every source result preserves `sqlServerAccepted=false`, `runtimeAccepted=false`, `liveCapabilityAccepted=false`, and `productionReady=false`. A source observation is not an acceptance assertion: results retain unresolved SQL acceptance and protected-capability provenance dependencies. Runtime and joined-pipeline execution remain refused; Package28 acceptance remains unchanged and is not inherited. No function is connected to the shared qualification runner, CLI, pipeline, or evidence writer.

## Genuinely implemented source behavior

The scenario functions execute the actual production services and repository SQL against the supplied transaction port. Their journal queries read tenant-filtered counts, immutable store projections, and exact reservation denomination/account columns. They do not read an OTP code/digest, secret, quote, receipt body, or accounting body.

| Source function | Concrete behavior | Scope limit |
| --- | --- | --- |
| `qualifyWithdrawalOtpRequest` | Fresh request and same-key retry use one authorization/intent identity; request remains unconsumed/unreserved/unqueued; code and digest absent from projection; unconfirmed delivery blocks | Does not capture the code, establish keyed OTP authority, or establish protected delivery provenance |
| `qualifyWithdrawalOneUse` | Actual submit and exact-code retry; one consumption, exact source/fee reservations, one intent-hash-bound outbox; no attempt/receipt/accounting; unchanged durable journal on retry | Input is production `SubmitWithdrawal`, not a harness capture port; an actual protected principal delivery/submit path is still required |
| `qualifyWithdrawalSubmitRefusal` | Exact production protocol error required; bad-code increment must commit; other covered failures preserve journal; no false success on infrastructure exceptions | Inert fixture verifies service behavior, not PostgreSQL locking/constraints |
| `qualifyWithdrawalCoolingRefusal` | Production minimum 24-hour cooling check refuses before OTP; fresh intent rollback checked through actual store `byKey` | Authoritative custody/destination timestamps must come from production protected eligibility seam |
| `qualifyReducingAdmission` | Production direction derivation, exact quantity/price preservation, distinct exposure and funding budgets, one unchanged outbox on retry | Admission/reservation only; not canonical reducing accounting |
| `qualifyReducingAdmissionRefusal` | Actual revision/exposure/mode/over-close/reservation rejection; missing or unadmitted perps mapping explicitly blocked with fresh-intent rollback | Never persists a mapping or treats collateral/fee labels as authority |
| `qualifyUnadmittedReceipt` | For an already persisted exact nonterminal uncertain attempt, actual `admittedReceipt` refuses an unadmitted hostile projection; journal unchanged | Negative boundary only, not verification or reconciliation; missing attempt blocks instead of fabricating a dispatch fence |
| `blockedWithdrawalCapabilities` | Explicit unresolved OTP, dispatch/reconciliation, canonical-accounting/collateral dependencies | No successful scenario assertions are attached to these dependency entries |

OTP one-use deliberately permits an exact consumed-code retry to return the already queued record. That is production semantics: one consumption/outbox/reservation, not rejection of all retries. Wrong consumed-code retries cannot change financial state.

Reservations compare exact decimal raw strings and use `BigInt`; exposure, source cash, native fees, and collateral are not added across denominations/accounts/purposes. This is genuine exact admission checking, not a claim that a canonical fill/lot/PnL/margin journal was applied.

## Offline tests added, not run

Both `describe` groups execute production functions; they are not merely static scenario labels. The fixture implements a bounded sequential SQL transcript with snapshot rollback and injected failures. It has no receipt/mapping admission or accounting/application implementation. It refuses unknown SQL markers. Its sole generic `Row[]` cast is the typed query transport adapter; it does not grant quote, receipt, capture, secret, or execution authority. Hostile receipt and well-shaped unadmitted mapping projections are negative data only.

The withdrawal tests cover:

- One OTP issue/delivery across request replay, delivery after fixture commit, no public code/digest projection, same-client eligibility/funding ports.
- One consumption, same-client reserve/consume/outbox/queue writes, exact principal/native-fee budgets, unchanged consumed-code replay; identical denomination/account fee combination by exact sum.
- Five committed wrong-code failures and subsequent lock; wrong consumed-code retry; failed/unknown delivery; request-key conflict; foreign-principal service refusal (fixture filtering, not real RLS).
- Exact OTP-expiry boundary; cooling-policy lower bound; less-than/exactly-24-hour cooling boundary; changed destination cooling on submit and queued service `revalidate`; stale balance, changed mode, insufficient balance.
- Inert failures at consume/outbox/queue/commit and zero-row consume conflict restore reservation/authorization/outbox state; issuance commit failure never delivers.
- Actual store unadmitted-receipt refusal against an explicitly inert negative uncertain precondition; missing attempt remains blocked and no attempt is manufactured by the source scenario.

The reducing tests cover:

- Actual spot service admission/retry with exact quantity and exact limit price, distinct exposure/native-fee reservations.
- Over-close, stale revision, stale exposure, changed mode, and competing exposure reservation refusals, with fresh admission rollback.
- LONG and SHORT perps requests fail closed with no independent mapping, including zero fees.
- A well-shaped USDC collateral mapping projection remains unadmitted despite separate MATIC fee labels; no admission writer is simulated.
- Production `reducingRemainder`, `rawToDecimal`, and `decimalToRaw`: exact large raw values, reducing direction, zero-crossing refusal, and scale-loss refusal. These are arithmetic contracts, not actual ledger accounting.

No real SQL row locks, RLS, roles, triggers, deferred constraints, transaction-pool resets, concurrency, queue delivery, crash/fence acceptance, authenticated receipts, provider tombstones, canonical lots/PnL/collateral/margin, or network effects are observed by these tests. Fixture rollback is not deferred PostgreSQL commit acceptance. Calling the production service's `revalidate` is not proof of runner placement at an actual dispatch fence.

### Exact imports

`/root/SWAT/tests/qualification/wave4/withdrawal-scenarios.ts` imports only these production source modules:

- `/root/SWAT/packages/db/src/withdrawal-service.ts`: `createWithdrawalService`, `withdrawalBudgets`; type-only `WithdrawalServicePorts`, `SubmitWithdrawal`.
- `/root/SWAT/packages/db/src/reducing-service.ts`: `createReducingService`; type-only `ReducingServicePorts`.
- `/root/SWAT/packages/db/src/reducing-contract.ts`: `reducingBudgets`; type-only `ReducingIntent`, `ReducingRequest`.
- `/root/SWAT/packages/db/src/withdrawal-contract.ts`: `financialBudgetKey`, `financialHash`, `WithdrawalProtocolError`; type-only financial budget/receipt/record and withdrawal intent/request/transaction types.
- `/root/SWAT/packages/db/src/withdrawal-store.ts`: `withdrawalSqlStore`.

`/root/SWAT/tests/qualification/wave4/withdrawal.offline.test.ts` imports:

- `vitest`: `describe`, `expect`, `it`.
- `/root/SWAT/packages/db/src/withdrawal-service.ts`: `createWithdrawalService`; type-only `WithdrawalEligibility`, `WithdrawalServicePorts`.
- `/root/SWAT/packages/db/src/reducing-service.ts`: `createReducingService`; type-only `ReducingServicePorts`.
- `/root/SWAT/packages/db/src/reducing-contract.ts`: `reducingIntent`, `reducingRemainder`, `decimalToRaw`, `rawToDecimal`; type-only `ReducingExposure`, `ReducingRequest`, `ReducingVenueMapping`.
- `/root/SWAT/packages/db/src/withdrawal-contract.ts`: `financialHash`, `withdrawalIntent`; type-only `FinancialReceipt`, `FinancialStatus`, `WithdrawalIntent`, `WithdrawalRequest`, `WithdrawalSqlClient`, `WithdrawalTransaction`.
- `/root/SWAT/tests/qualification/wave4/withdrawal-scenarios.ts`: the exported scenarios/journal/boundary plus type-only reservation/result projections. This transitively imports the actual SQL store.

No existing financial test-fixture authority helpers, runtime/DB barrel mocks, ambient clients, runner, provider adapter, shared domains/CLI/config/pipeline, child, or infrastructure module is imported by either new TypeScript file.

## Blocked requirements and necessary production-owner work

1. **Protected OTP/capture/secret authority.** `/root/SWAT/packages/db/src/withdrawal-service.ts` exposes required `issue/digest/deliver` and `lockEligibility/lockFunding` seams but does not implement protected production authority. Deterministic inert hashes and synthetic ownership/balance evidence are not deployed authority. A production-owner principal-bound, keyed one-use OTP service and protected delivery/submit path, plus authoritative same-client custody/settings/balance/destination locks, remain dependencies. This source adds no capture callback, arbitrary authority flag, or secret admission.

2. **Keyless executor import seam.** `/root/SWAT/apps/trade-executor/src/reducing-orchestration.ts` has runtime `@swat/db` imports for `createDurableFinancialRunner` and `reducingAccountingAdapter` dependencies. `/root/SWAT/apps/trade-executor/src/reducing-provider.ts` also uses runtime barrel imports. Necessary production fix: expose these using existing keyless contracts/services/store direct leaf imports, preserving types and behavior. Until then these new files cannot import them without violating the ambient barrel/client restriction. No harness reimplementation, cast, alias, or barrel mock substitutes for this fix.

3. **Outbox/uncertain reconciliation acceptance.** Source concretely checks admission outbox identity/atomic service writes. Production runner code inspected defines durable attempt preparation, write-ahead uncertain fence, reconcile-only existing attempts, and authenticated receipt application; these effects are not exercised here. Actual attempt-bound atomic-deadline transfer authority, authenticated reconcile/verify, restricted independent receipt admission writer, and authorized failure/crash qualification remain required. For terminal zero-fill/absence, a provider-authenticated permanent no-future-acceptance tombstone is required. Plain absence/timeout/local expiry is not release authority.

4. **Exact reducing accounting and collateral.** Production `/root/SWAT/packages/db/src/reducing-contract.ts` requires canonical spot lot/evidence settlement and an economics reference on every perps fill, including zero fee. `/root/SWAT/packages/db/src/reducing-service.ts` requires the independently admitted deployed venue mapping. Actual protected receipt admission, canonical spot lot/ledger accounting, independent perps collateral denomination/account mapping, and every-fill realized-PnL/collateral/margin/fee journals on the same client remain unavailable. Merely returning reference labels or constructing mapping/economics objects does not implement them; this source does neither as successful authority.

5. **Real SQL and shared integration ownership.** Migrator/runtime role authentication, deployed financial schema privileges/guards, restricted verifier/mapping writers, forced tenant RLS, triggers/deferred constraints, and real SQL acceptance are not validated or changed. S2 LP privilege proposal/seed preflight dependencies remain separately unresolved. Owner-only future runner integration and locked validation are required; this independent inert source neither needs runtime inputs to be written nor bypasses refusal once written.

No additional production defect is asserted from this bounded inspection beyond the forbidden runtime barrel dependency blocking safe reuse. The other items are concrete unfulfilled capability/acceptance dependencies, not fabricated harness authority or claims of completed requirements.
