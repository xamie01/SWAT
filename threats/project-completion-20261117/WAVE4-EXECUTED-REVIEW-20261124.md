# Executed pipeline independent review — 2026-11-24

## Verdict: REJECT, bounded source only

The independent reviewer read the initial frozen driver/economics/observer and inert test sources. No execution, imports, parsers, compilers, hashes or service/SQL activity occurred. This report records that verdict, not coordinator self-review.

## Supported findings retained

1. `pipeline-executed.ts:120–123` rejects any `DO`, including canonical `ON CONFLICT DO NOTHING` and `DO UPDATE SET`. Required worker/trade/evidence/financial upserts are rejected; ordinary UPDATE SET support does not fix this.
2. `pipeline-executed.ts:249–252` and `pipeline-economics.ts:320–322` require null native quote/price even for valued USD originals. Canonical USD retains amount/amount/USD/1; only absent quote uses four NULLs.
3. `pipeline-executed.ts:220–222,297–299` and `pipeline-economics.ts:356–357` equate independent delivery and worker attempt fences. Recovery must use persisted delivery fence separately from attempt fence.
4. `pipeline-executed.ts:378–379,391–395` reverses sell source before requiring terminal sell replay. Canonical worker requires accepted source context before terminal status; reversed source cannot satisfy this. Driver order/refusal expectations must align without weakening source authorization.
5. `pipeline-economics.ts:32–45` drops physical lease identity before underlying destruction succeeds; failure and late destruction lack quarantine. Retain broken identity and cleanup obligations; do not admit a reissued broken client.
6. `pipeline-sql-observer.ts:148–170` and runtime scanner allow session advisory lock functions. Read-only COMMIT does not clear those persistent effects; distinguish canonical transaction advisory locks.

The positive recovery fixture also uses different attempt/captured revisions and missing captured maxSlippageBps while reconstruction takes trade slippage. Align with canonical historical policy recovery, not caller/current/trade defaults.

## Bounded repair ownership

Three exclusive owners repair driver/test, economics/new inert economics test, and observer/test respectively. No shared file edits. All source checks remain paused during these changes. Independent affected re-review is required after their freezes.

Hash separation, checked-COMMIT uncertainty and SOURCE refusal before acquisition remain preserved in the inspected initial source. Full enrollment/RLS/ACL, correction authority, migrations, public/Package28 activation and runtime acceptance remain absent.
