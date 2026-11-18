# Wave4 S3 pipeline SOURCE closure

## Status and ownership

SOURCE fallback implemented; protected joined runtime execution BLOCKED. I3 is not passed and no positive production, provider, runtime, queue or live capability is claimed.

Only these owned files changed or created:

- `/root/SWAT/tests/qualification/wave4/pipeline.ts`
- `/root/SWAT/tests/qualification/wave4/pipeline.offline.test.ts` (new)
- `/root/SWAT/threats/project-completion-20261117/WAVE4-PIPELINE-SOURCE.md` (new)

No production/auth/SQL/sharedCLI/core/config/runner files changed. No nested agents. Investigation used 13 successful focused file reads plus 4 missing-file probes and narrow textual searches; no repository sweep. No tests, compiler, subprocess, network, SQL, queue, client, child, service, install or git operation was executed. Coordinator exclusively owns CPU0/flock/512MB1fork/640MB checks. The test source declares **56 scoped cases; 0 executed**.

## Concrete SOURCE gaps closed

1. Removed the unreachable draft pipeline. It cast the loose qualifier client to PoolClient, dynamically imported uncontained production entrypoints, accepted worker ports from queue data without proving protected obligation composition, counted applications/receipts, omitted sell/reversal/correction, and expected first-worker statuses `executed`/`confirmed` even though the production paper success status is `paper-filled`.
2. Kept PUBLIC `exercisePaperPipeline` as an unconditional `Promise<never>` refusal, including hostile input, labels, null, and live-looking payloads. No input inspection, factories, environment flag, mock authority or delayed execution import can bypass it. `PipelineComposition` is a type-only requirements declaration, not a capability; sourceClient now names the real pg PoolClient type rather than casting a qualifier SqlClient.
3. Made pipeline module evaluation import-safe with a deliberately closed runtime import set. No runtime `@swat/db`, no production worker/fanout/transaction import, and no dynamic import. Core is type-only so the pipeline does not evaluate core's isolation/containment dependency graph.
4. Implemented `pipelinePreflightContract` over inert observations and retained the CLI-compatible `pipelinePreflight(client)` signature. The latter reads only the supplied owned transaction client and does not own BEGIN/COMMIT, invoke capability lookup, open a pool, set impersonation GUCs, write a registry, or touch a queue/provider. Checks require session_user and current_user both swat_app; bypass off; no tenant or worker-execution impersonation; and no INSERT/UPDATE/DELETE privilege on provider authority, runtime capability, valuation authority or trusted valuation tables. PostgreSQL privilege-list semantics detect any listed mutation privilege, not just INSERT. A lookup EXECUTE grant is diagnostic only. Missing/multiple observations fail assertions. Even all successful negative assertions always retain detailed blockers and runtimeAccepted/liveCapabilityAccepted/protectedCompositionAvailable false.
5. Implemented INTERNAL `requireExactPipelineJournal(actual, expected)` on normalized inert durable exports. Actual is compared against an independently specified exact expected scenario, including every identity, economic value, ordered history and extra row. Cross-reconciliation independently checks source binding/evidence digests and reversal references; immutable original fill fields; effective correction terms; application scope; canonical queued comparison fields and job identity; worker/delivery fence; exact trade values; production financial receipt SHA-256/order; risk epoch/debit; capacity cohort notional; owned acquisition lot and sell allocation/reduction; append-only financial and immutable original evidence history; and no-change replay.
6. Exact decimal quantities use BigInt, including the fixture buy quantity `9007199254740993.125`, sell `1801439850948198.625`, remainder `7205759403792794.5`. Source buy 10 / cost 100 and sell 2 produce source 8 / basis 80. Reversal restores source 10 / basis 100 without erasing an independently settled follower sell, application, lot reduction or worker fence. Follower buy quote 10 / fee .01 yields basis 10.01; sell leaves basis 8.008; independently exported full valuation correction to quote 20 / fee .02 leaves unchanged inventory and basis 16.016, updates risk debit to 20.02, and appends an exact third financial receipt without mutating the originals. Final replay is byte-equivalent under canonical object ordering (except stage label).

The helper is scoped to one owned paper acquisition lot, one complete buy and sell fill, accepted sell-source reversal, one full buy economic correction and replay. Production evidence type is `paper_simulation`. Supported arithmetic must be exactly representable at 18 decimal places; no float, scientific notation, rounding fallback or unsigned-to-live conversion. Partial fills, unknown economics, native-quote conversions, correction chains and multiple lots are not broadly requalified here. Fixtures and exported `authorized` observations are not credentials and never enter production writers. There is no SQL export adapter or manufactured protected execution claim.

## New test inventory (declared, unexecuted)

- Import contract / unconditional negative authority / preflight identity and mutation checks: 18 cases.
- Exact independent literal scenario: 1 case.
- Unchanged-count identity/economic corruption checks: 22 cases.
- Extra durable row rejection: 6 cases.
- Independent cross-checks even when mistaken expected data agrees: 6 cases.
- Settled follower preservation through source reversal, scientific-number refusal, stage-order refusal: 3 cases.

Total 56. No broad duplicate Wave1–3 suite or mock protected server composition. No SQL client is instantiated or mocked for preflight execution; tests only inspect preflight SQL text and consume inert observation rows.

## Runtime imports actually retained

- `node:crypto` — exact receipt/journal SHA-256.
- `/root/SWAT/packages/db/src/source-verification.ts` — canonical immutable source binding/evidence, exact raw quantity, binding/evidence digests. Its shared import is type-only; runtime dependency is node:crypto.
- `/root/SWAT/packages/db/src/worker-valuation-corrections.ts` — exact money/quantity normalization and production original-evidence digest. Its only runtime transitive leaf is `/root/SWAT/packages/db/src/source-verification-store.ts`, which itself runtime-imports only source-verification.ts and does not own a pool/transaction. No production WithClient SQL writer is invoked by reconciliation.

Erased requirements-only imports: pg PoolClient; `/root/SWAT/apps/signal-engine/src/fanout-canonical.ts`; `/root/SWAT/apps/signal-engine/src/fanout-enqueue.ts`; `/root/SWAT/apps/trade-executor/src/worker-policy.ts`; `/root/SWAT/tests/qualification/wave4/core.ts`.

## Exact protected composition blockers and required production changes

These needs were reported before implementing the fallback. They are not edits made in this task.

1. `/root/SWAT/apps/signal-engine/src/fanout-enqueue.ts` runtime imports `ensureFanoutEnumeration`, batch/claim/fail/complete/list/preparation/queued helpers from `@swat/db`. `/root/SWAT/packages/db/src/index.ts` re-exports client.ts and transaction.ts. `/root/SWAT/packages/db/src/client.ts` constructs `new Pool` during module evaluation. Supplied DurableFanoutCaller.transaction cannot prevent import side effects. A pool-free production durable delivery/composition leaf must source these WithClient helpers from `/root/SWAT/packages/db/src/package13-fanout-delivery.ts` and preserve its complete-cohort, stable-exclusion, canonical-admission/preparation, commit-before-queue and queue-repair semantics. fanout-canonical.ts itself uses type-only DB imports; changing its interface cannot fix fanout-enqueue's runtime barrel.
2. `/root/SWAT/apps/trade-executor/src/worker-policy.ts` runtime imports its lifecycle, policy, settlement, risk and fanout helpers from `@swat/db`. A direct import replacement alone is insufficient: `/root/SWAT/packages/db/src/worker-execution.ts` imports copy-trade-lifecycle.ts; `/root/SWAT/packages/db/src/worker-settlement.ts` imports copy-trade-lifecycle.ts, trades.ts and risk-policy.ts; those modules import client.ts and/or transaction.ts. Need production pool-free WithClient boundaries for those operations and a canonical worker leaf using them, retaining position→execution→worker fence ordering, policy rechecks, exact source-sell acquisition proof, risk epoch reservation, commit-before-effect, independently owned durable financial receipt, uncertainty retention and no resubmission. The source-only qualifier must not reproduce that worker with invented ports.
3. `/root/SWAT/packages/db/src/obligation-runtime-capability.ts` runtime imports tenancy.ts and transaction.ts; tenancy.ts also runtime imports transaction.ts; transaction.ts imports the ambient pool. Its optional input.transaction defaults to withTransaction. Need a production **mandatory supplied owned transaction**, pool-free protected-obligation leaf plus pool-free tenant-scope primitives. Preserve `swat_claim_runtime_capability` lookup on every short transaction; runtime role/backend registration; immutable execution/descriptor/obligation identity; revision, expiry/revocation, captured-terms comparison; queue copyExecutionId as lookup-only comparison; tenant set ONLY from persisted capability; bypass off; operator refusal. Neither a queue userId, cast, string, boolean nor an env flag can supply this change.
4. Import containment is necessary but not sufficient. Reviewed server intake of a newly inserted immutable source row, independent TrustedSourceVerifier and matching durable provider authority; protected worker backend/obligation registration and separately reviewed lookup EXECUTE grant; current recipient admission; exact follower entry sizing; independently owned paper valuation/receipt; and trusted correction authority/valuation lineage writers remain unsupplied by the CLI. Do not mint those from qualifier snapshots or grant broad registry writes to swat_app. Any privilege/SQL/production changes require separate exact review.
5. Operator obligation domain remains unsupported by createObligationScopedTransaction. A real durable cohort must explicitly exclude it under reviewed enumeration semantics. The inert normalized exclusion is evidence of the negative contract, not a new production stable-exclusion code or permission to skip arbitrary recipients. Provider-unavailable, missing paper valuation and live receipt-adapter refusal remain intact; no provider or live adapter was called or implemented.

## Acceptance boundary

This closes real SOURCE defects, not an executable joined pipeline or a roadmap substituted for source. Coordinator checks may validate syntax/types and the 56 contracts under the prescribed containment, but passing those cannot remove I3 blockers. Separately reviewed production containment/composition and authorized disposable execution are still required before claiming durable runtime evidence or opening the public entrypoint.
