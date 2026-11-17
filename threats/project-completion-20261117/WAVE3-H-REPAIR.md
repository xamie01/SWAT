# Wave 3 H local repair checkpoint — 2026-11-17

**H SOURCE REFROZEN; repair slot released. Local source repair only, NOT accepted, tested or self-approved.**

Authority: coordinator explicitly reopened H repair slot, then instructed refreeze/report before final F interface integration. Original submission `/root/SWAT/threats/project-completion-20261117/WAVE3-H-IMPLEMENTATION.md` is preserved; this checkpoint supersedes affected hashes but does not claim final E/F/G domain acceptance. No E/F/G source, shared barrel/root entrypoint/schema/registry/permission edits.

## Six supported independent findings repaired locally

- **H-R1:** Added pure `/root/SWAT/apps/web/lib/financial-request-state.ts` and connected FinancialRequestPanel. Before admission dispatch, immutable exact request/key/kind/position/venue is snapshotted and written through an explicit persistence seam. Failed storage write prevents dispatch. Browser persistence is partitioned by authenticated account/operation surface, contains no OTP, and restores dispatching as outcome-unknown. Lost admission response cannot generate a replacement key or edit request; retry reuses the stored exact operation. Known-ID unknown confirmation reconciles durable status, retaining intent/authorization IDs. Only explicit route pre-admission validation codes permit edit; transport errors/5xx/conflict/unknown denial stay fenced. Observed responses must match immutable key/fields/path/venue and noncontradictory progress. API still performs all authority checks; client persistence is not authority.
- **H-R2:** Terminal is modeled independently of partial/uncertain status. Nonterminal partial remains fenced; verified terminal partial/failed/settled/cancelled requires an explicit startFresh action before another newly authorized request. Terminal partial notice states remaining exposure is not closed. No time/expiry-based local cancellation or reauthorization.
- **H-R3:** All direct SQL inside `/root/SWAT/apps/api/src/routes/me.ts` now uses `scopedQuery(scope,sql,params)` or subscription-derived `gate.scope`, not unscoped query plus WHERE userId. Account/positions/grants/revoke, other tenant joins/history/feed reads supply session scope; no wildcard bypass. Zero-row local revoke says no active records changed, not falsely disabled. Retained route tests adapt boundary fixtures; portfolio test explicitly asserts principal scope on six account/position/vault/revoke calls. This is source/injected seam coverage, not actual PG/RLS execution proof.
- **H-R4:** Discover builder links omit absent/nonfinite/nonpositive prices. Pure finite price/bounds helpers only derive recorded bounds from a valid explicit observation; builder labels manual example/user bounds versus recorded-price suggestion (freshness unverified), rather than pretending null means price1.
- **H-R5:** Shared copy panel consumes actual `closedPositionCount` (not nonexistent totalPositions) and finite [0,1] `winRate` ratio times100. Null/invalid count/ratio stays unassessed. Pure DTO model tests use0.75→75.0%, boundaries and invalid values.
- **H-R6:** Discover uses a discriminated Observation and one mutually exclusive loading/unavailable/observed-empty/records presentation. Failure cannot render No Pools alongside an error. Overlapping read versions cannot overwrite newer observations. Loading/refresh text says recorded observations, not onchain scan/computation. All risk badges say recorded/unverified, never PASSED/AUDIT or accepted protection. Pure observation/risk tests cover failed versus successful empty and score labels.

Reducing route fixture inventory now100 matches authoritative exposure100; final cumulative100 settles fixture inventory to0. Previously1000 versus100 mismatch was supported; repaired H fixture only, not F fixture source.

## Pure behavior tests and manifest

`/root/SWAT/threats/project-completion-20261117/w3-h.config.ts` now selects15 literal files: prior13 plus `/root/SWAT/apps/web/lib/financial-request-state.sequential.test.ts` and `/root/SWAT/apps/web/lib/lp-observation.sequential.test.ts`. No glob/filter/service filename; same inherited harness/guards/resource settings.

New pure state-machine tests drive pre-dispatch persistence, persistence failure, lost admission response, immutable input snapshot despite mutation, reload unknown fence, definite validation versus ambiguous failure, lost confirmation identity retention/no OTP persistence, nonterminal partial fence, terminal partial explicit fresh request, response substitution denial, audited cancelled terminal observation, and uncertain reload. These are actual state transitions, not substring-only assertions or browser evidence. LP tests drive actual count/ratio/price/range/observation/risk functions. No browser permitted or executed.

Import safety: pure new modules import ApiError/types and existing model only, no service/listen/RPC/provider SDK. Tests use inert values and in-memory persistence callback. Browser localStorage/current user API is only invoked in component effect, not pure module/test import. Existing retained route tests hoist scopedQuery/db/shared/viem mocks; new F/E injected suites retain actual factories under inert SQL/wrap boundaries. No signing/keygen/credentials. Source aliases do not establish emitted artifacts or runtime acceptance.

## Deferred final domain synchronization — explicitly incomplete

**Final F fee interface is NOT joined at this checkpoint.** E/F dependencies changed during review/repair; current mandatory feeAssetId/feeAssetScale/feeFundingAccountId (even zero fee), Funding/eligibility/receipt shapes and cancelled lifecycle require final F refreeze + affected independent recheck, then explicit H reopen. Existing H strict API schemas/projections/transport DTO/form/injected F fixtures remain previous-interface snapshots and are **not execution-ready against evolving F**. Do not run H final integration config yet; no claimed compile/pass counts. Pure frontend machine recognizes a verified audited cancelled outcome only; API cancelled projection/routing and final fee fields remain to join, not guessed/defaulted. Future changes invalidate dependency hashes.

E custody metadata/authority lifecycle is also evolving. Existing injected local-record/linked-account/consent/deployment facade obligations retained; no CLOB signing/credential acquisition, unwrap, or runtime activation. G unavailable/unsubmitted; exact/fractional LP capability remains honestly missing and legacy safe-whole paper DTO retained.

Client fence limitations: localStorage preserves this operation across reloads in the same account/operation surface; not a cross-device/cross-tab atomic journal or server authorization/cancellation authority. Authoritative durable exact request/attempt and uncertainty resolution remain F responsibilities. Browser execution/storage failure behavior remains unverified; no browser acceptance inferred. Unknown confirmation can reconcile without exposing/persisting OTP; explicit retry after verified awaiting state uses same stored identifiers.

Coordinator root providerless invocation remains unchanged. No new db barrel export or executor unwrap import. Current db emits/declaration/artifact and runtime provider/consent/receipt admission joins remain coordinator-only after approved freeze. Aggregate close-all unavailable. All configured/source/injected/runtime/live labels remain separated, runtime/live false defaults.

## Actual actions and freeze protocol

Read-only review/source inspection, dedicated Edit/Write, scoped grep and sha256sum, and scoped git diff --check only. **No tests/compilers/emits/SQL/browser/services/network/install/keygen/signing/credentials/commit/push/publish executed.** Final scoped whitespace check emitted no findings; not test acceptance. Original hashes/evidence retained. Final15-file manifest import/hash approval, all-source global freeze, final F/E interface join and independent affected rereview required before guarded CPU0/flock512MB onefork tests/640MB compiler checks. No independent selfapproval.

## Complete H source/test/config manifest at local checkpoint

Classification: entries marked REPAIR below changed in this repair slot; PREVIOUS-H entries retained H implementation; INHERITED/CONTEXT below retained inputs explicitly included rather than omitted. Git diff includes inherited source changes and is not a clean-baseline owner change list.

### REPAIR paths (including new pure source/tests)

```text
9cc6725bf43153d1527dcc371940444de2642b6931be6657e23db73ffab1db69  /root/SWAT/apps/api/src/routes/me.ts
07f7b96be39cf03375cee24de791a03054082dfdda351505f38907f75057d1d1  /root/SWAT/apps/api/src/routes/me.authority.sequential.test.ts
17ee67e94f3d2682f12f8d8b6bf552d024199742c0879781980320f394858e0d  /root/SWAT/apps/api/src/routes/me.withdrawal.sequential.test.ts
abee34303c583886b6a6d5adc25e3fdc24c8600fa4f715e78337a9031f812328  /root/SWAT/apps/api/src/routes/me.grants.sequential.test.ts
56e52bf48109091e786b7fad8885374905bdc87cfbb09c2bd21420e7cea2234a  /root/SWAT/apps/api/src/routes/me.portfolio.sequential.test.ts
da12f964aaf19fed0be8a7ddf9e05203088ee9d6871ada78f1bbdf1cb6de5f59  /root/SWAT/apps/api/src/routes/package23-perps-close.sequential.test.ts
6f9d3508b2cb4ea58d9320c5aca39100b58ee150670cdbf7eeef1edc701218e2  /root/SWAT/apps/api/src/routes/me.reducing.injected.sequential.test.ts
90d20e18792ee52a1fe5f650fc0b2ca1aba9c3d1b956d3eddaea8d6690aa28cc  /root/SWAT/apps/web/lib/domain-transport.ts
1f8331dc4158a524d18d7771b85ade99d3798f7d03f3220a4149de2e853e9cff  /root/SWAT/apps/web/lib/financial-request-state.ts
ab0bdbf302928a157b350b636048352eac84e0ed34fa6be255657aee45dc5cd5  /root/SWAT/apps/web/lib/financial-request-state.sequential.test.ts
a4dedfba7bf829cf46768f454e854d052e703feb6d0d4593fe8b0b5f0dcf187b  /root/SWAT/apps/web/lib/lp-observation.ts
c5ae3852d4b936b641501bada7d987f3504de0ee8dd05faa17431fabceed4ac8  /root/SWAT/apps/web/lib/lp-observation.sequential.test.ts
454230e5e4f505ffa4f0b13dbc7eef625eea04e660109a8aee75d92cf378359f  /root/SWAT/apps/web/components/FinancialRequestPanel.tsx
cee912bb35443a4b45c191154aefd58dd2c90271757d2033da29ac296c3d158b  /root/SWAT/apps/web/components/LpCopyPanel.tsx
58b3f4d3dd579b08f0e8d08e2bc1601a60f5ac0494c178d51b3c8712c6afa04b  /root/SWAT/apps/web/app/lp/builder/page.tsx
6619b843ebcc72dfd4b1d8e07768312bffb4416fb3c2cbcd34f585aeb016ef5c  /root/SWAT/apps/web/app/lp/discover/page.tsx
2f18b95bbca763c5f6886ea33945ff4b10beac57da81c732378b4405d4629a69  /root/SWAT/threats/project-completion-20261117/w3-h.config.ts
```

### PREVIOUS-H unchanged implementation / selected tests

```text
e9239f7e60c972c7c751c6eb15e6a01a5357c83e7aa13b704d3bb8a3c20db5a0  /root/SWAT/apps/api/src/routes/me-financial.ts
0aaaa42bed0a9bc4ab5a2094e51a8b347493f9b2dbe8fe4c922c481fd30fa932  /root/SWAT/apps/api/src/routes/me-custody.ts
5e4cf7e346b80002e77c8a4945e1709494b9f338cd6bf8ef5db090215c93b1d8  /root/SWAT/apps/api/src/routes/me.withdrawal.injected.sequential.test.ts
5f7f51944367603017c2c3fb9ef5c6c6c1771fcadb87926bb106c890c90cb52e  /root/SWAT/apps/api/src/routes/me.custody.injected.sequential.test.ts
4cb22ad592e3dbe453a21e4b213ce1cbc7b59a19864fa0b4c4bd9ba7d24551db  /root/SWAT/apps/web/lib/domain-transport.sequential.test.ts
2b3123c06f799f98fafdb897cf7c2af17cd3f39361c00177458d9b4313d33eb3  /root/SWAT/apps/web/lib/portfolio-model.ts
bedeeb9976928c5e66449eb011ac72d566562837127c15a5bcef07c55971ec63  /root/SWAT/apps/web/app/positions/page.tsx
942f2f58e8780ba9687b39c1d577141288f3136d7cfa645a0809e9aa3094e799  /root/SWAT/apps/web/app/vault/page.tsx
e896d2b3cc58ed465c62cc2a155effeaf81032ad54f0ad590bdfcbd4c3adc839  /root/SWAT/apps/web/app/lp/positions/page.tsx
a0c72ba073e1ce07248822867a54a5bab59653ea8280585614dead7d45026259  /root/SWAT/apps/web/app/lp/copy/page.tsx
02eee00b3057302f06a2ea224f49c058e27a16b4b922fcf29536e06e3cd935d3  /root/SWAT/apps/web/app/lp/whales/page.tsx
63d8aa042e3e06955e2626b29d7a56264cd4987aa2565cfa17401af00772e084  /root/SWAT/apps/web/app/workspace/views/LpView.tsx
```

### INHERITED / contextual H inputs and selected retained tests (not repaired except portfolio route fixture above)

Seven specifically requested review inputs covered: me.portfolio.sequential.test.ts (now repaired/hash above), API tsconfig/test tsconfig, web portfolio-model.sequential/transport.sequential/wallets.ts/WalletConnectModalButton.tsx. Additional transport/config/model inputs included below.

```text
01b05fff019e8e897900e125699944971310a1a77a428a91efb21a2c1a77b238  /root/SWAT/apps/web/lib/portfolio-model.sequential.test.ts
cd69444e9a60c30cd44d596cf4c3703f8d4a9c96d6686f0fde66fb69022b7edd  /root/SWAT/apps/web/lib/transport.sequential.test.ts
793c3072bb50e16723b266cbc5c070d98fef91e73e88de6b131007df4a8fc22e  /root/SWAT/apps/web/lib/wallets.ts
b3e61301addfe6cc3a9f0ef80b20ad6ee9147145a059211304ab7c5c9b5e11e1  /root/SWAT/apps/web/lib/wallets.sequential.test.ts
46e61e5d4e08958ed457e95df969cdbd95ba639c9d0639778a9d3f0fd742edcb  /root/SWAT/apps/web/components/WalletConnectModalButton.tsx
7ce19b025f702410bd41ca1018bf09a41f1d29c052542213a2c412a93f95e124  /root/SWAT/apps/api/tsconfig.json
08a7a3f1ecbf7b1a90f827f9f99c6f62a1e63cbcbe3ffa332ad6004dc47f599d  /root/SWAT/apps/api/tsconfig.test.json
31364e1c8e4fd2f878be2333e52a28dc9b17648cb24e690c0a06b00b28050cb3  /root/SWAT/apps/web/lib/api.ts
032d33536cad52351b85ffad04cd214dadc9e07fd7fc9a36f2824ecb692b9c9b  /root/SWAT/apps/web/lib/api-error-message.ts
c98c707d66b06f99426b1db2f2d9de15377360ec9f167c485cd773cdadc4c38b  /root/SWAT/apps/web/lib/api-error-message.test.ts
f4eef9fad0c6d8bfa4f66fcb95386cb15070f9b8fc90332c8d0b88aa099ec341  /root/SWAT/apps/web/lib/backend-target.ts
17b7fa5b345faef2ad2dc818507283d1aa6b0809a263ecbab0a833e6b157aec6  /root/SWAT/apps/web/lib/route-access.ts
ad6a4506fc07a201953e5795982f0703cedc20b3e89c8b41665a96526d121f5f  /root/SWAT/apps/web/tsconfig.json
19b8e291ce179a590a26a8baceccb7eb627dc6f469655003c5818d82b706d934  /root/SWAT/apps/web/next.config.ts
3fbd032892766a169293ee3da69c5e1cb05ddb980c5883f30c85bbd0e0401c2d  /root/SWAT/threats/sequential-fixes/package12-29-harness.ts
8d50902d887ac313a06ebde73d5a39b977fc4067303e5b5fd654b5077e873930  /root/SWAT/threats/sequential-fixes/test-safety.ts
966b8ec41414001f3828feba2f12cfc38cf66cc310c1ef3b20820def54a7cebf  /root/SWAT/threats/sequential-fixes/offline-guard.cjs
```

### READ-ONLY domain dependency snapshot — evolving, NOT final joined/accepted hashes

```text
6e5016df1e8008ae99ef59a8669d89e7cb197fbe971615f581e1bfbdb67ad7d6  /root/SWAT/packages/db/src/custody-contract.ts
36ac59461ffebffc0aee5d1cc2306bf6bf41b21ed10025b91084ee9fe0caa64b  /root/SWAT/packages/db/src/custody-enrollment.ts
d74d2a8636f397386ee16a4eb3962a2e2071bc491a4264c865787aec6bf5f7c7  /root/SWAT/packages/db/src/withdrawal-contract.ts
3e0b0ca150f5e465b3650d78b21b17f306ec5ccf4fab7035fe9fbc24832d70f1  /root/SWAT/packages/db/src/withdrawal-service.ts
6fdfcf19aa4499960f6c2c409784a0ad63901db64affee937c94e605533156b0  /root/SWAT/packages/db/src/withdrawal-store.ts
a8a8effd46978119a7661f6768242acbb11d3b85a3949c9e6ed63d1a3cc61a3f  /root/SWAT/packages/db/src/withdrawal-test-fixture.ts
111c15d0785ea75e788e9213b1d6acfa8f22b53c221715a1e5077bd1ce86e30c  /root/SWAT/packages/db/src/reducing-contract.ts
3450c098355e132ee4beaa0ca13b251712728d5a4df5e2abe60da9895d6a1a36  /root/SWAT/packages/db/src/reducing-service.ts
9224d3207d0a9f49751079b26f74e61a0f70fe63971e51ddc7342a93759727db  /root/SWAT/packages/db/src/tenancy.ts
f185a5c79dec5282c7ad1320683180dd575f62fa4a6b30018f552d1ef9e90271  /root/SWAT/packages/db/src/lp-tracked-wallets.ts
b0b90a783f1af5d87dc65a6d59ded89df7766324921dd15e72e2883fd89d85c9  /root/SWAT/apps/trade-executor/src/reducing-orchestration.ts
```

This explicitly requested repair report is an additional path. Its SHA256 is supplied separately, avoiding a self-referential embedded digest. Coordinator final check runner also fingerprints complete workspace/tool/lock inputs; this checkpoint does not replace that global manifest or grant approval.
