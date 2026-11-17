# Jito/source local checkpoint — 2026-11-16

## Implemented and verified locally

- Durable canonical execution/tenant/account/fence claim and independent exact sell quantity validation.
- Immutable independent intent, two exact signed transactions/signatures committed before POST; lost POST responses remain unknown, not resubmittable.
- Strict quantified receipts bind canonical direction/token, recipient, raw size, minimum output, token scale, finality and bounded fees.
- Durable same-client receipt ownership invokes `reconcileWorkerFillWithClient`; `accountingComplete` required before receipt marker; runtime acknowledgement only after COMMIT.
- Config/dispatch canonical quote and receipt adapter contracts exposed; default signer/provider/scoped runtime remain unavailable.
- Source observation quarantine preserved; invoked durable fanout/admission/recovery proofs added, no verifier or source feature rewrite.

## Actual evidence

All checks through approved literal runner CPU0/lock/guard; tests512MB, compilers640MB.

| Label | Result |
| --- | --- |
| build-jito-green-01 | exit0,43 tests |
| build-jito-typecheck-db-01 / build-jito-emit-db-01 / build-jito-typecheck-executor-01 | exit0 |
| build-jito-neighbors-01 | exit1 obsolete partial mock missing required export |
| build-jito-neighbors-02 | exit0,16 tests in3 files |
| build-jito-green-02 | exit0,47 final tests in2 files |
| build-jito-typecheck-db-02 / build-jito-emit-db-02 / build-jito-typecheck-executor-02 | exit0 |

Final deduplicated scope: **63 passed in5 files**, not sum of reruns. Input manifests unchanged for accepted runs; `git diff --check` clean. Mocked client/adapter tests are not PostgreSQL concurrency/isolation, real receipts, deployment or live acceptance. SQL075 **unapplied**.

## Changed paths

DB `jito-pending.ts`, `jito-receipt.ts`, `jito-store.ts`, `sql/075_durable_jito_receipts.sql`; executor `jupiter-jito-runtime.ts`, `jupiter-jito-config.ts`, `solana-dispatch.ts`; focused new executor/DB `jito-durable.sequential.test.ts`, updated `package17-solana-durability.sequential.test.ts`; indexer `source-unavailable.sequential.test.ts`, signal-engine `source-durable.sequential.test.ts`. Reviewed configs and raw records in this directory.

## Remaining work/gates

Parent actual boot joins `getConfiguredCanonicalJitoQuote` / `settleConfiguredJitoResolution` and late uncertainty race correction remain pending at checkpoint. Source fanout descriptors lack canonical claim/exact worker payload linkage: locally unfinished, not an external-only blocker. Source verifier, final-message signer, trusted valuation/receipt provider, approved scoped tenant/operator runtime and installed schema/isolation remain unavailable. No environment flag or fabricated certification closes them.

Previously flagged independent DB quantity/direction checks are corrected and tested. Financially unpriced immutable evidence remains unresolved; no in-place repricing or duplicate fake fill is permitted.
