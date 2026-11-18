# Protected LP admission independent review — 2026-11-18

## Verdict

**Source repair required. PostgreSQL behavior unexecuted. Wave4 source-complete=false.**

Independent reviewer `agent_c0de1817-182d-4025-8ab7-e17914cf7036` inspected eight bounded source excerpts without Bash, tests, edits, services or credentials. Sealed083's stacked behavior was not reviewed. SQL084 refusal remains intact.

## Blocking findings assigned for repair

1. SQL085 required an isolated NOLOGIN admitter while SQL/TypeScript require direct current_user=session_user=swat_lp_admitter. NOLOGIN cannot authenticate. Repair must distinguish disabled provisioning from separately authorized direct-login activation; no SET ROLE shortcut or migration-controlled activation.
2. UNIQUE(user_id,intent_hash) aliases distinct acquisitions whose operationKey is deliberately absent from the existing intent hash. Bind admission identity to full immutable acquisition context/operation key without dropping economic hash checks or full comparison.
3. Runtime projects legacy state/auto_rebalance over exact JSON, while085 compares unmodified exact JSON. Define one supported canonical projection for all protected context joins; preserve sealed083 and verify compatibility.

## Additional supported hardening

- Reject NULL exposed SQL chronology parameters explicitly; inspected trigger callers did not demonstrate a financial-write bypass.
- Return/check stored quote_hash independently in admission lookup; normal writer computed it correctly, but inconsistent stored commitment was invisible to the DTO.
- Refresh/guard legacy rung allocations and refuse reopening closed legacy rows. An085-local omission is not proof of a stacked083/085 bypass.
- Add distinct-acquisition, legacy/exact divergence, stored commitment and NULL-time contracts. Static substring contracts do not parse or execute PostgreSQL.

## Supported inspected properties

Mandatory SELECT-only lookup on the same runtime client precedes acquisition/operation/receipt mutations. Settlement writes receipt then completion/exact/legacy accounting. Quote expiry is checked at admission/financial INSERT; later settlement binds operation chronology. FORCE RLS and admitter-only INSERT are present in source. Existing receipts do not receive automatic grandfathered authority in inspected085 joins.

## Verification checkpoint before repairs

- `build-w4-main-typecheck-24`: qualification noEmit/incremental=false, exit0.
- `build-w4-main-offline-25`: 481 passing tests,17 files, exit0.
- Both use CPU0 shared flock, test512MB/onefork or compiler640MB, synthetic/offline guard, timeoutSeconds=null.
- Shared workspace input manifest SHA256: `a3f4bad95cdd007d8a706ee135d2e16d5d6ec6bb3b1d2bd003bf3882da022292`.
- Test result SHA256: `c4971f3d18e601abec64d3b5ea7f5606e0ff2effdd824e643455e05bd62c1438`.
- Earlier typecheck22 and offline24 failures retained. Chronology fixture was repaired without weakening validation.

This checkpoint is superseded by later source edits, including coordinator evidence-session work and assigned LP repairs. It is not current-byte acceptance, runtime proof, provider admission or a whole-wave closeout.
