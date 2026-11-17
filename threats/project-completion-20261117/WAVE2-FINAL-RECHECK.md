# Wave 2 final independent read-only recheck

2026-11-17. Reviewer independent of implementation owners and coordinator; no edits or tests, compiler, SQL/service/provider execution. Targeted recheck of supported Wave 2 findings and retained evidence only; no Wave 1 reaudit or broad security certification.

## Verdict

**All seven supported prior repairs and final admission-clock finding accepted in current local source/injected scope.** No remaining supported finding in these repairs. Real PostgreSQL/RLS/concurrency, provisioned runtime/operator/provider, signing/live acceptance remain separate blocked gates.

Closure anchors (line references are one-based):

- SQL parameter numbering: `packages/db/src/copy-trade-lifecycle.ts:2257-2269`.
- Immutable allocation row-lock privilege: `packages/db/sql/079_claim_runtime_capabilities.sql:50-53,87-101`.
- Queue position/execution/delivery lock order: `packages/db/src/package13-fanout-delivery.ts:350-401`.
- Partial outstanding proof: `packages/db/src/source-sell-lot-allocation.ts:144-197`.
- Explicit-lot lineage: `packages/db/sql/080_immutable_valuation_corrections.sql:100-135,202-209`; `worker-valuation-corrections.ts:98-104,128-137`.
- Historical acceptance expiry: SQL080:141-188; corrections TS:106-118.
- Carried field provenance: SQL080:143-174,239-250; corrections TS:143-161.
- Final clock: SQL080:197 assigns `statement_timestamp()`; :214 checks valuation/authority expiry and :234 source-provider/proof expiry against `NEW.accepted_at`. No transaction-start clock in that trigger. Six source-regression cases explicitly are not SQL trigger runtime evidence.

Four retained runtime failures were table fixture `rows` shape, not a supported production source weakening. Rewrapped the Vitest callback's one reduction row into an array; all four denial assertions remain. Queue fixture now imports the actual pure descriptor validator and returns stored delivery/score by all five immutable SQL arguments. Its injected context cannot prove source verification: absent policy correctly denies via `apps/trade-executor/src/policy.ts:106`. Final test asserts that missing-policy boundary plus no quote/authorize, not the stale source-verifier refusal.

## Independent evidence reconciliation

343 raw assertions / 17 literal files: 343 passed, zero failed/skipped/pending/todo. Latest per-file reports: runtime104/6, financial75/5, allocation110/3, queue54/3. Every table collection index preserved; repeated fullNames are not collapsed. Retained earlier runtime100/4 failed, queue53/1 failed and final-queue01 53/1 failed are superseded, never summed into final total.

Verified command-to-log/result/input-manifest hashes, tool/config/runner/guard/dependency-lock hashes, successful exits, unchanged-during-command and no timeout records. Final DB/executor emits have 340/420 artifacts matching disk. Final queue02 input manifest SHA256 `5b9206c2785ed80ad28a2e243007daa52dc770bad43a4f012ee9947b2b999abc` had 2373 entries, all matching review snapshot. Earlier manifests differ because of SQL/config changes, emits and later test-only repairs; no claim all commands share one frozen digest. Selected test/affected production inputs match their owning reports; DB/executor production emits unaffected by the two fixture edits.

## Reviewed source fingerprints

```text
737ac99b194299b8d58cc25ba905e59fa5512f1ca0ec8ba71a7100c7b10a15ea packages/db/src/copy-trade-lifecycle.ts
d44beed7a47bef341920225a8a84d3566574cd1403fa63a0e0aee23f5eb43046 packages/db/src/source-sell-evidence.sequential.test.ts
df6ce2a1e2977f9b8b96968792d064ac2aaed141f6862cc1a792706cbf45d7d3 packages/db/src/source-sell-lot-allocation.ts
a33fe2a33db7135f9e6a5a3666e17fb747024199af44c026e3c3a083294d3d54 packages/db/src/source-sell-lot-allocation.sequential.test.ts
d9312e9402f0f3240f71bd18cdc9ed0c5ed7616ebaf9284059b27bcb51bcaf96 packages/db/src/package13-fanout-delivery.ts
5a9ce6428e61d8b74f3de39ec2efe28fd93372527951f291b9cea86b743955ca packages/db/src/worker-valuation-corrections.ts
b367818ce26db88dae1acf03b9b76d1c30d712deeeda94817a8ee7599aa0d31d packages/db/src/worker-valuation-corrections.sequential.test.ts
60c5b32668b4d05d515ee3ad05bdacd1eff9dd16ef273da1272e05b13d971956 packages/db/src/worker-correction-admission.sequential.test.ts
e2e638030edb41bba0f9b083d26acf61ee258439efbbd67e2e08b1887b757972 packages/db/src/worker-settlement.ts
ee5a50b98e649cb09d99ecd885c377d11129082896021fdbca9907eddb3da73e packages/db/src/risk-policy.ts
8f5019faa267542bef0cb30af5aac3cc6ea0a41da63a1f5ad57eaab728343b79 packages/db/src/worker-execution.ts
1b982cb17a6c8c589c214c0cf3a4a36f86b91c56215bb04cd22f9a6a06c3d447 apps/trade-executor/src/worker-policy.ts
177b1559c1c041294bb71db9e7dc7033145059515fb1cd3fa52a6ae211c0c868 apps/trade-executor/src/policy.ts
6dd72e47c931fc0782b359d29db637dae486eeaf069ad40f03e9dcdf8e7eb0e4 apps/signal-engine/src/fanout-canonical.sequential.test.ts
94230306f30f27464ff59509437345f31a1715f57232a5af8d6ef8d14a14d258 packages/db/src/fanout-worker-descriptor.ts
960642ce04c9f7ffc9fb599bde1edcec4159fed6277f522d74ee11a702aa3cc3 packages/db/sql/079_claim_runtime_capabilities.sql
9811a908c5ce769f10e7761502ef0b6786bcb4101a353081e478ff0d49ac030b packages/db/sql/080_immutable_valuation_corrections.sql
```

Proposal/migration pairs byte-identical. Prior independent C/A recheck accepted all four source repairs; prior D recheck accepted three with Medium admission-clock finding, now closed. Original reports and raw failures remain preserved. This file records the reviewer's report, not coordinator self-review.
