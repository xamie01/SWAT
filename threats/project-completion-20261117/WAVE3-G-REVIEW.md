# Wave 3 G independent final source review

Date: 2026-11-17. Repository: `/root/SWAT`. HEAD: `b64854e3d2e81b16b3c11018729940a9351bc0ce`; inspected working-tree source includes uncommitted changes.

## Verdict

**Not clean: one supported blocker in unapplied proposal083.** The inspected TypeScript service path supports the requested G financial/retry/copy invariants, but the proposed database completion fence has a receiptless INSERT bypass. This is a source review, not runtime acceptance or an assertion that any test passed. G review was completed and this report written before H review began. The previously requested standalone G review that did not run is not evidence used here.

## G-1 — proposal083 permits completed-operation insertion without a durable receipt

- `/root/SWAT/threats/project-completion-20261117/083-lp-schema.proposal.sql:44-64` permits an INSERT with `status='completed'`, non-null `completed_at`, and JSON `receipt.receiptKey` equal to the row key. It does not require a row in `lp_exact_receipts`.
- The durable-receipt requirement at lines 97-100 is attached only to **BEFORE UPDATE OR DELETE** at lines 104-105. INSERT does not execute it. The application role is granted INSERT on operations at line 175.
- The position-update guard at lines 116-131 finds a completed operation and derives resulting inventory/totals/close realized value from its embedded receipt; it does not independently join the durable receipts table. Consequently a same-tenant completed operation inserted with matching prior revision/inventory and embedded receipt can authorize an exact-position update without any durable receipt record.
- This contradicts the proposal's receipt-backed completion/financial-update fence. The normal service insert at `/root/SWAT/packages/db/src/lp-paper-store.ts:125-134` is pending and does not use the bypass; no public receipt route or exploit execution is claimed. Impact is the proposed SQL boundary, not evidence of a deployed vulnerability: 083 remains unapplied.
- Required repair: reject completed operations at INSERT (pending/null receipt/null completion only), or enforce equivalent durable-receipt linkage for every insertion/completion path. Keep the current atomic settlement ordering. Re-review the proposal before integration; PostgreSQL qualification remains separate.

## Source invariants supported in inspected paths

- **Exact microdollars/conservation:** `/root/SWAT/packages/db/src/lp-exact.ts:211-250,312-338` validates bounded canonical rawscale and signed/unsigned microdollar strings, values with BigInt multiplication and one final floor, sizes budget conservatively, keeps unknown economics null, and requires positive asset-scale-bound rung allocations summing exactly to deposit. `/root/SWAT/apps/lp/src/builder/exact-paper.ts:8-32` distributes integer shares and deterministic remainder without losing raw inventory. Numeric geometry/weights are not monetary valuation authority. SQL binds decimal text/JSON and explicitly casts NUMERIC financial reads to text.
- **Immutable retries/current reads:** `/root/SWAT/packages/db/src/lp-paper-service.ts:193-218,294-303,350-360` snapshots input/evidence, resolves known acquisition/copy retries before fresh mode/provider/risk/budget admission, refuses fingerprint/scale conflicts, and rechecks fresh admissions under the transaction. `/root/SWAT/packages/db/src/lp-paper-store.ts:15-19,34-36,75-77,106-123` separates immutable `acquisition_data` from current position data/state/consent. Proposal083 lines 32-43 and 110-114 prevent initial-snapshot substitution and later changes.
- **Operations/current revision:** `/root/SWAT/packages/db/src/lp-paper-service.ts:141-168,220-282` persists admission without closing inventory, fences pending operations/current revision/inventory/automatic consent, snapshots recentered plans, binds receipts to trusted provider/network/tenant/protocol/asset/rawscale/quote hash/key/proceeds, leaves absent receipts pending, and accepts historical settled evidence without repricing. `/root/SWAT/packages/db/src/lp-paper-store.ts:136-152,158-166` places receipt, completion, resulting position and journal writes on the same tenant client behind the user-owner lock. Proposal guards cover immutable acquisition/operation intent and legacy plan/close mutation, subject to G-1.
- **Trusted copy mint/risk/budget:** `/root/SWAT/packages/db/src/lp-paper-service.ts:294-360` requires canonical active tenant subscription plus trusted finalized forward-only wallet/network/venue-bound mint evidence; approved fresh risk binds subscription revision/master hash/acquisition intent/pool evidence and is persisted separately from intent hashing. Remaining budget is BigInt and subscription authority/budget/cap/exposure/mode/freshness are rechecked under lock. `/root/SWAT/packages/db/src/lp-paper-store.ts:79-87` refuses unlinked legacy pending/executing/executed copy capital and counts immutable historical acquisition spend once, including closed positions. `/root/SWAT/apps/lp/src/copy/copy-worker.ts:28-38` delegates acquisition authority to canonical service records rather than legacy USD/pool hints.
- **Public/truthful boundaries:** `/root/SWAT/apps/lp/src/routes.ts:225-283,286-343` allowlists exact request fields, scopes by principal, exposes no receipt submission, refuses legacy numeric acquisition and uses durable receipt operations. `/root/SWAT/packages/db/src/lp-lifecycle.ts:17-28,62-72` makes legacy float admission/receiptless completion inert. `/root/SWAT/apps/lp/src/index.ts:160` constructs a providerless exact domain; `/root/SWAT/packages/db/src/lp-paper-service.ts:373-375` explicitly withholds runtime/live acceptance. A configured domain lacking protocol ports refuses new admission as 409, while an absent domain is 503; the submission's blanket providerless503 description is not universally exact.

## Hashes and review boundary

SHA-256 of inspected authority source/inputs (not merely HEAD):

```text
3cb324f975321c1bbfb927559e03b5d061aefa9f7d98548f4b596c10415ea1a8  /root/SWAT/threats/project-completion-20261117/WAVE3-G-IMPLEMENTATION.md
9bd1653aba665e3daaaa46bc66075d853b055237a52e0be59aabf6349765b670  /root/SWAT/threats/project-completion-20261117/WAVE3-G-CONTRACT.md
65505092e02f1202eed458c8216814cc61df4ede4e0ad57c6ec22f79e2519cd4  /root/SWAT/packages/db/src/lp-exact.ts
267db517d2e03a3e4e9270a82497766cfbc5318bea445b2e2e943b412c4670f3  /root/SWAT/packages/db/src/lp-paper-service.ts
df7df09935d1c25a216f9578300445efd4616402d0ceb444517b66b086f361e9  /root/SWAT/packages/db/src/lp-paper-store.ts
24cb7ba1cb4065fb163671d6922611622b12cb1560d8923aeeda785d4c88de61  /root/SWAT/threats/project-completion-20261117/083-lp-schema.proposal.sql
748c7bf57eb0107ae99e1139b35a1166934d449716ba8c1178e684938e811c93  /root/SWAT/apps/lp/src/builder/exact-paper.ts
82135f775e18a83d9f6e1e1495e5c5f037fffa7bbbc23875ef5e336127c8e429  /root/SWAT/apps/lp/src/operations.ts
caca6039b65e70fff2ca6c4a15adba85a69b11d4e8653c9f6b17c9de9d544c56  /root/SWAT/apps/lp/src/copy/copy-worker.ts
cc9e94407070678ef24f8debfcd1fa95b70776865627267e3e946e1ad316b1d1  /root/SWAT/apps/lp/src/routes.ts
2c57b044325b7621094970aacde2d86a1dee43309dda3dca64a022eef8de523f  /root/SWAT/packages/db/src/lp-lifecycle.ts
d77f9286f9cc28832d0bbcafc7855a5338b22abe11993759463e896f9a94c07e  /root/SWAT/packages/db/src/lp-positions.ts
dfc0a3149eeda2479299e4af3692952f2d2807b8aa09a4d2dfba4b8bf28ba5c1  /root/SWAT/apps/lp/src/index.ts
eb779fae56f1d40e826dca176d2ab2c061fd4d712684e5619a8cc3efe0b9f25e  /root/SWAT/packages/db/sql/076_lp_valued_paper_lifecycle.sql
```

Inspected tightly relevant excerpts only; not an exhaustive repository/transitive-import certification. `/root/SWAT/apps/lp/src/builder/ladder-plan.ts:1-150` was inspected for the geometry/weight boundary, not all protocol snapping code. Tests mentioned in the submission were not run and are not execution evidence. No tests, compilers, emits, SQL application, services, network, secrets, browser, subagents or background actions were used. No implementation was changed. PostgreSQL syntax/trigger behavior/RLS/privileges, concurrency/crash atomicity, queues, package exports/emits, full UI join, trusted external providers, signing/broadcast and live capability remain unqualified. These hashes and findings apply only to the inspected source snapshot; later source changes require re-review.
