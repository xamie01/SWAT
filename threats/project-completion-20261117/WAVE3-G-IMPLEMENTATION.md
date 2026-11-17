# Wave 3 G implementation submission — 2026-11-17

## Status and scope

**Domain G source submission only; independent review, guarded verification and coordinator acceptance remain pending.** Work was sequential and exclusive in `/root/SWAT`, without subagents/background tasks. Read the G contract, relevant governance/H checkpoint, current exact/legacy LP modules, builder/operations/copy/routes/monitor, selected test sources and proposal083. Changed only G-owned source/tests, proposal083, w3-g.config and this requested report. Existing E/F changes were left untouched. No API/web/shared/db barrel, coordinator runner/ledger, sealed Wave1/2 or production migration edits.

No tests, compilers, emits, SQL, services, network, installs, credentials, key generation, signing, git mutation/commit/push were performed. Source inspection, SHA-256 calculation and scoped whitespace inspection are not execution evidence. There are no pass counts, runtime/provider claims or independent self-approval here. No final independent review report exists; this submission does not impersonate one.

## Audit and supported repairs

- Canonical financial values remain unsigned raw strings (at most78 digits), scale integer0..30; USD is microdollars with implicit scale6, not floating dollars. Signed economics reject negative zero, leading zeros, exponent/decimal text and out-of-bound results. Valuation uses BigInt multiplication and one final floor; copy sizing floors raw quantity conservatively. SQL financial values are bound decimal text or JSON strings, and NUMERIC reads use explicit text casts. Number conversions for price/snapping, bounded percentages/counts and legacy display weights are not accounting authority.
- Exact acquisition validates tenant/provider/network/pool/protocol/asset/scale/freshness/value/inventory and conserved positive rung raw allocations. Quote and plan inputs are snapshots; config/exposure/mode are checked again under the tenant owner lock. Unknown legacy capital prevents assessed exposure.
- **Fixed immutable acquisition recovery:** proposal083 and SQL store now persist `acquisition_data`, equal to the initial committed active position. Acquisition/copy retries return that immutable snapshot, not the subsequently closed/rebalanced/current-consent position. Current reads remain separate. Same-key acquisition intent conflicts and copy scale conflicts refuse. Known acquisition retries no longer require a current mode/provider/quote; no new mutation occurs. No backfill guesses for earlier drafts.
- **Fixed rebalance geometry:** recenter the existing distribution/rung count/log-width around trusted quoted currentPrice, snapshot the replacement strategy and conserve identical exact asset inventory. Log-space midpoint avoids intermediate multiplication overflow. Acquisition evidence remains unchanged.
- Operations persist quote/plan/revision/stable receipt key before a queue hint; close admission does not close inventory. Pending receipt leaves operation pending. Receipt acceptance binds identity, tenant, mode, network/protocol/asset/rawscale, quote hash, prior revision/inventory and proceeds. Historical committed quote/receipt recovery does not reprice or require fresh quotes. Receipt, exact fee/cost totals, resulting position, operation completion and history share the transaction. Queue hints now refuse changed non-paper mode; failed mode/queue hints remain false rather than losing the durable response.
- **Fixed copy risk authority:** fresh injected server `copyRisk.assess` evidence is required for new copy mints and bound to provider/tenant/subscription revision/master evidence hash/acquisition intent/pool evidence. Approved risk evidence is persisted in copyOrigin separately from the acquisition intent hash to avoid circular hashing. Missing/rejected/substituted/stale risk fails closed. Master mint evidence is finalized/forward-only/network/venue/wallet bound; wallet snapshot changes and queue USD/position/pool hints remain non-authoritative.
- **Fixed incomplete copy budget observation:** SQL rejects unlinked legacy pending/executing/executed copy rows as unassessed instead of treating them as zero. Exact historical acquisition spend is counted once, including closed positions, and rechecked with current subscription budget/cap under lock. Budget is intentionally cumulative, not automatically recycled after close. Immutable retries precede fresh budget/risk checks.
- **Tightened unapplied083 guards:** immutable acquisition snapshot; prior inventory receipt binding; close cannot replace the historical plan; mutable current autoRebalance can be persisted on receipt settlement while acquisition consent stays immutable; legacy range/strategy changes require the exact completed plan and closed inventory cannot reopen through legacy state.

Source-only regressions added to existing tests cover immutable retry after settlement/mode/provider changes, current-versus-initial SQL reads, scale replay conflicts, recentering/conservation, risk absence/substitution/staleness, legacy copy budget blocking, mode-gated queue replay, canonical microdollar limits and proposed guard text. SQL fixture and proposal substring cases are explicitly not PostgreSQL/trigger execution proof.

## Current DTO handoff for H

Authoritative source types are `/root/SWAT/packages/db/src/lp-exact.ts`; service factory is `/root/SWAT/packages/db/src/lp-paper-service.ts`. LP adapters currently import explicit `@swat/db/dist/lp-exact.js` and `@swat/db/dist/lp-paper-service.js` paths; coordinator must separately qualify package exports/declarations/emits. Do not edit barrels to join this submission implicitly.

- `LpRawAmount = { raw: string; scale: number }`: raw never Number; scale is metadata. Money fields ending `MicroUsd` are canonical integer strings at implicit scale6; signed `realizedMicroUsd`, `inventoryChangeMicroUsd`, decision `netMicroUsd` may be negative. Unknown evidence/economics remains null, never zero. Revision is a canonical string, not Number. Geometric price bounds/currentPrice and rung count remain numbers, not USD valuation.
- `POST /v1/lp/positions/deploy-exact`: body exactly `{ operationKey, chain, poolAddress, depositAsset, deposit:{raw,scale}, strategy:{distribution,rangeLower,rangeUpper,rungCount}, autoRebalance? }`. Strategy distribution spot/curve/bidask, rungCount1..64. Current implementation requires resolved strategy; template/custom union is **not** this DTO. No public userId, provider, quote, receipt, economics or copy origin. Returns `{positionId,position,mode:'paper',broadcast:false,capabilities}`. Body invalid400, providerless503, refused409.
- `GET /v1/lp/positions/:positionId/exact`: `{position,capabilities}` or404/503. Position has immutable acquisition identity/key/fingerprint/mode/deposit/value/quote/copyOrigin and mutable currentAmount/plan/revision/state/autoRebalance/exact cumulative fees/costs/nullable realized/lastReceiptKey. Acquisition retries return initial snapshot; this GET is current state. H must not mistake a retry's initial active state for a live current-state observation.
- Existing `POST /v1/lp/positions/:positionId/rebalance` and `/close`: body exactly `{operationKey}`; public automatic/plan/receipt/projection/tenant fields refused. Returns `{operation,queued,broadcast:false,economics?}`; economics is included on new admission but may be absent on immutable retry. Operation is `{id,userId,positionId,operationKey,fingerprint,action,positionRevision,amountBefore,quote,plan,receiptKey,status,receipt}` with status pending/completed. Close plan null; close admission pending is not closed state. Rebalance plan is immutable recentered strategy. `GET /v1/lp/operations/:operationId` returns `{operation,broadcast:false}` or404/503. Public receipt submission is not exposed.
- `POST /v1/lp/copy/mint-exact`: body exactly `{subscriptionId,eventId,assetScale}`. Scale remains a requested metadata hint that trusted quotes must bind; retry substitution refuses. Returns `{position,mode:'paper',broadcast:false,capabilities}`. Authority comes from tenant subscription + trusted mint/quote/risk ports, never queue USD hints. `copyOrigin.riskEvidence` is optional in the type for prior injected-record compatibility, but required/persisted by new copyMint admissions; absence is not approved risk.
- `GET /v1/lp/capabilities`: sourceImplemented true, fractionalRawscaleDto true, legacyNumericDtoFractionalCapability false, runtimeAccepted false, liveCapabilityAccepted false. `injectedPortsConfigured` reports protocol-port presence **only**, not master/risk/full copy availability or runtime acceptance.
- Legacy `/v1/lp/positions/deploy` remains503. Legacy list uses numeric observation DTO, `quantityCapability:'legacy-numeric-observation-only'`, exactQuantity null, legacyNumericDtoFractionalCapability false. Legacy subscriptions/history use numeric dollar DTOs; exact subscription-budget creation and exact list/UI transport are not joined. H's prior safe-whole API/web interface is unchanged and must remain fractional-unavailable until explicit reopen/coordinator join. Never synthesize exact raw quantities from it.
- Tenant principal owns scope. Supported injected shapes: Solana Meteora-DLMM; Uniswap-v3 on configured EVM chains; Pancake-v3 on BSC. Raydium-CLMM/Uniswap-v4 hooks are unavailable, not aliases. All quoted amounts refer to one explicitly identified deposit asset; not a multi-asset live LP settlement model.

## Import-safety inventory for literal selection

`/root/SWAT/threats/project-completion-20261117/w3-g.config.ts` selects14 literal existing non-service test filenames, with exact db subpath aliases placed before inherited broad aliases. Harness uses one fork/worker, no file parallelism, inherited pg/ioredis blocking setup, and requires coordinator runner environment/manifest. It was not loaded or executed here.

| Selected file (absolute) | Source import boundary / isolation |
| --- | --- |
| `/root/SWAT/packages/db/src/lp-exact.sequential.test.ts` | Pure lp-exact runtime import; node:crypto only, shared types erased. No startup. |
| `/root/SWAT/packages/db/src/lp-paper-protocol.sequential.test.ts` | lp-paper-service/fixture/exact with type-only tenancy; in-memory injected ports and clock. No SQL client import. |
| `/root/SWAT/packages/db/src/lp-paper-store.sequential.test.ts` | Hoisted tenancy mock blocks default SQL dependency; explicitly injected fake client. No PG execution. |
| `/root/SWAT/packages/db/src/lp-lifecycle.sequential.test.ts` | Tenancy mocked; legacy lifecycle + lp-positions shared import; node:fs reads only076/proposal083. Inherited pg/Redis blockers still required. |
| `/root/SWAT/packages/db/src/lp-positions.test.ts` | Tenancy scopedQuery/transaction mocks; shared predicate import transitively reaches shared barrel. No application startup import. |
| `/root/SWAT/packages/db/src/lp-copy-trading.test.ts` | Tenancy scopedQuery mock; module functions only. |
| `/root/SWAT/packages/db/src/lp-guardrails.test.ts` | Client mock; real tenancy/transaction/role-check control flow against fake client. This is not PG/RLS proof. |
| `/root/SWAT/apps/lp/src/builder/exact-paper.sequential.test.ts` | Hoisted db barrel mock; exact subpaths are pure/injected; ladder geometry, operations, copy processor and monitor only. BullMQ is imported but Queue/Worker factories are not called. |
| `/root/SWAT/apps/lp/src/builder/build-position.test.ts` | Inert legacy builder, type-only db/chain builders; no startup. |
| `/root/SWAT/apps/lp/src/lifecycle.sequential.test.ts` | Db barrel mock; operation adapters only. |
| `/root/SWAT/apps/lp/src/routes-exact.sequential.test.ts` | Db barrel mock; routes/auth/scanner geometry/exact adapters; Fastify ready/inject/close inside test bodies, never listen. |
| `/root/SWAT/apps/lp/src/routes.test.ts` | Db barrel mock; Fastify/cookie/crypto/auth/routes; request injection only, no service entry. |
| `/root/SWAT/apps/lp/src/copy/copy.test.ts` | Db barrel mock; pure legacy sizing/snapshot listener + copy processor. BullMQ factories not invoked. |
| `/root/SWAT/apps/lp/src/monitor/monitor-job.test.ts` | Injected monitor/pure classifier/exact economics; no scheduler/startup. |

Important exclusions/caveats: `/root/SWAT/apps/lp/src/index.ts` has top-level logger/provider construction, Redis, listen, cron/workers and is **unsafe to import for offline selection**. None of these selected tests import it. `/root/SWAT/packages/db/src/lp-paper-store.ts` is **not pure by default import**: tenancy→transaction→client configures pg pools, requires DATABASE_URL and may install shutdown handlers outside test mode. Its selected test mocks tenancy before import. Db barrel runtime imports in app tests are mocked; they must not be treated as inherently safe. Shared barrel transitive imports and third-party BullMQ/Fastify loading remain coordinator import-review obligations; this inventory is source-bounded, not an executed all-transitive safety certification. Inherited safety setup blocks pg connect/query and Redis construction but is not itself a full network sandbox.

## Capability limitations and required next gate

No default trusted quote/receipt/master/risk source exists. Current LP entry constructs an exact providerless domain; valuation/economic authority is absent and tenant recovery enumeration is not configured. Do not start it to verify this submission. Live mutation is refused regardless of flags/source labels. No real protocol oracle decoding, signing, broadcasting, external settlement, reserve sweep, custody/withdrawal join, cross-tenant queue recovery or provider activation was implemented or accepted.

Proposal083 is new, unapplied and requires schema/role/RLS/SQL-trigger review plus coordinator migration integration. No reconstructive backfill of previous mutable exact records is supported. Real PG owner-lock serialization, concurrent retries/receipt races, crash atomicity, durable queue behavior, RLS/privileges and external provider trust remain unqualified. JSON/trigger shape checks do not replace trusted service validation or constitute cryptographic external-provider authentication. Default server injected ports are trusted constructor capabilities, not public labels.

Copy budget is cumulative lifetime allocation; no recycled budget on close. Unsupported increase/decrease/burn/collect stays explicit. Copy worker legacy queue metadata is ignored for financial authority; canonical service records/quotes decide scope and venue. USD projections are not realized accounting. Recenter/snapping is paper geometry, not a guarantee of live token ratio/tick liquidity deployment. Strict positive rung dust may refuse small deposits. New exact subscription-budget DTO and aggregated exact position list/UI remain limitations rather than silently converted legacy floats.

Next gate is independent affected-source review, final all-source freeze, import/hash registration, guarded offline checks by coordinator, and explicit H reopen to join exact DTOs. No acceptance claim precedes that gate.

## SHA-256 inventory

All paths below are absolute. Hashes cover submitted/current relevant source, selected tests and proposal/config. This report's own hash is delivered separately to avoid self-reference. Dependency changes invalidate review assumptions.

```text
65505092e02f1202eed458c8216814cc61df4ede4e0ad57c6ec22f79e2519cd4  /root/SWAT/packages/db/src/lp-exact.ts
267db517d2e03a3e4e9270a82497766cfbc5318bea445b2e2e943b412c4670f3  /root/SWAT/packages/db/src/lp-paper-service.ts
df7df09935d1c25a216f9578300445efd4616402d0ceb444517b66b086f361e9  /root/SWAT/packages/db/src/lp-paper-store.ts
0490e8b3fe72e74cf76f7f1d20539179b84c546c96e5b34a536eba7b26f397bd  /root/SWAT/packages/db/src/lp-paper-fixture.ts
2c57b044325b7621094970aacde2d86a1dee43309dda3dca64a022eef8de523f  /root/SWAT/packages/db/src/lp-lifecycle.ts
d77f9286f9cc28832d0bbcafc7855a5338b22abe11993759463e896f9a94c07e  /root/SWAT/packages/db/src/lp-positions.ts
e3627414a6b84a71a548a0d71850eb408bdf76f4e162c1d112ea6201e63d8425  /root/SWAT/packages/db/src/lp-copy-trading.ts
0a6886532c43c92839e05e5661d54497c3c718d9eb662e12cb5d3a8faff0f36a  /root/SWAT/packages/db/src/lp-guardrails.ts
cc9e94407070678ef24f8debfcd1fa95b70776865627267e3e946e1ad316b1d1  /root/SWAT/apps/lp/src/routes.ts
82135f775e18a83d9f6e1e1495e5c5f037fffa7bbbc23875ef5e336127c8e429  /root/SWAT/apps/lp/src/operations.ts
dfc0a3149eeda2479299e4af3692952f2d2807b8aa09a4d2dfba4b8bf28ba5c1  /root/SWAT/apps/lp/src/index.ts
7594154b6f6c5a97374f9bbce9a774ef7fda0a606e11d43c858cc62fd6206a9d  /root/SWAT/apps/lp/src/auth.ts
748c7bf57eb0107ae99e1139b35a1166934d449716ba8c1178e684938e811c93  /root/SWAT/apps/lp/src/builder/exact-paper.ts
e31984bffb472927673537581579ff40d8ad99f8bf21e0dc8ffcf676f7fd06c7  /root/SWAT/apps/lp/src/builder/build-position.ts
139782c17e01f25042c9054507f1fb5a06e23692d59f7792e400984ae1b194b8  /root/SWAT/apps/lp/src/builder/ladder-plan.ts
caca6039b65e70fff2ca6c4a15adba85a69b11d4e8653c9f6b17c9de9d544c56  /root/SWAT/apps/lp/src/copy/copy-worker.ts
73dab13d4766dea1d9fc45ec65a7740aeb540f2a9150094fe107e465cac34f31  /root/SWAT/apps/lp/src/copy/sizing.ts
0bd54313adad03759bb24732e57b03db453b3d473bbbf9bf2cdfa43970225073  /root/SWAT/apps/lp/src/copy/master-listener.ts
dff76057a6c597026dd40d1861c062b45ea061c55e67027f3cd63635e293096f  /root/SWAT/apps/lp/src/monitor/monitor-job.ts
9bd1653aba665e3daaaa46bc66075d853b055237a52e0be59aabf6349765b670  /root/SWAT/threats/project-completion-20261117/WAVE3-G-CONTRACT.md
24cb7ba1cb4065fb163671d6922611622b12cb1560d8923aeeda785d4c88de61  /root/SWAT/threats/project-completion-20261117/083-lp-schema.proposal.sql
8e1351e2ad89afecdd527687d9b64885c60bcbe48b8554b0183f038a44b73d82  /root/SWAT/threats/project-completion-20261117/w3-g.config.ts
b7072c4f0515130ffa656a19427952e7a7493d47cf8b7bbd00b42e8613feaf87  /root/SWAT/packages/db/src/lp-exact.sequential.test.ts
806ebb63d17f287c586ca4c223960fe1787c1e88f33b4e098a8fdf16d5804e8e  /root/SWAT/packages/db/src/lp-paper-protocol.sequential.test.ts
5c150a11a1de69ddf3938ef5ba083f93318ef9fb67889ca9f95816312e28ff55  /root/SWAT/packages/db/src/lp-paper-store.sequential.test.ts
2bb86b7ae4eab2ff907029f4261c306284f39e47bc6b994dcb88f20fe6da4eae  /root/SWAT/packages/db/src/lp-lifecycle.sequential.test.ts
8fb68170799f694cad2b3a05bd4bd3ab9710d889a5bc781b04a0befa592fa7d1  /root/SWAT/packages/db/src/lp-positions.test.ts
182139698f047bfaa503a586cba2c3f0dcff3a651036333c8020e75a6d94fe49  /root/SWAT/packages/db/src/lp-copy-trading.test.ts
1c770fa2031b1fa2f6b0b18fe87fb2e0d22a72d0982c99805a8958d991b55752  /root/SWAT/packages/db/src/lp-guardrails.test.ts
5a4942cd05cb7e71c7adec7d1244f26aa464321aa55198fb8a5fc6ad73b670e5  /root/SWAT/apps/lp/src/builder/exact-paper.sequential.test.ts
1d0d4f50a4d4d3a111763d11c37df97c3c30d19ba06075052019cd22f549f643  /root/SWAT/apps/lp/src/builder/build-position.test.ts
e66669761429c0f20b1359330a0cdbab94ccff8dfba24ae0e8ee874ae641408e  /root/SWAT/apps/lp/src/lifecycle.sequential.test.ts
60c3e115973c858cc1e6ad9bf76a251a1c71399db0033bcf91da21e1c1da23c6  /root/SWAT/apps/lp/src/routes-exact.sequential.test.ts
4d988cbd36469bd70ede08a3193999f0866f9688267da1cf7a6c0782b86697f3  /root/SWAT/apps/lp/src/routes.test.ts
60f6db01da5710e5780fd6d59ff0cd7a4be3fcd0b6b58fc46c1dcc2c0cdc0eeb  /root/SWAT/apps/lp/src/copy/copy.test.ts
6f5095817eaeef3c35f0841ac9c9af8f62e4a7a16123b47876669dc78f71ea2b  /root/SWAT/apps/lp/src/monitor/monitor-job.test.ts
9224d3207d0a9f49751079b26f74e61a0f70fe63971e51ddc7342a93759727db  /root/SWAT/packages/db/src/tenancy.ts
675e7d1899b2ca681b14e2f81367a58526cf96d819e73e014d6632d4aa7994aa  /root/SWAT/packages/db/src/transaction.ts
4a2069cf92c48f40817af17c1ee2207ea40b02304f57047df1cdd63b4f5e0af0  /root/SWAT/packages/db/src/client.ts
b14d0d744d78b481573b032641402679447d9b09c4472702995a445dde8e9f9b  /root/SWAT/packages/db/src/database-role.ts
48f39b827a4616b6a0b60a83f7fb6d52cfb6c254a1f9e6d41dd5c6de2573306e  /root/SWAT/packages/db/src/index.ts
7d0f4d42a05154efe87931866fae45bb1eda33394620d80f92744877837728f5  /root/SWAT/packages/shared/src/index.ts
3fbd032892766a169293ee3da69c5e1cb05ddb980c5883f30c85bbd0e0401c2d  /root/SWAT/threats/sequential-fixes/package12-29-harness.ts
8d50902d887ac313a06ebde73d5a39b977fc4067303e5b5fd654b5077e873930  /root/SWAT/threats/sequential-fixes/test-safety.ts
eb779fae56f1d40e826dca176d2ab2c061fd4d712684e5619a8cc3efe0b9f25e  /root/SWAT/packages/db/sql/076_lp_valued_paper_lifecycle.sql
```
