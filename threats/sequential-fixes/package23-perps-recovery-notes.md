# Package23 perps close bounded recovery

Coordinator owns the bounded perps DB close/tenant queries and registered API close integration after every previous owner returned no active task. This does not include Trojan execution helper or venue runtime acceptance. Existing partial source and tests are preserved.

## Before correction

Actual source read: `packages/db/src/polymarket-perps.ts:276-283` performs an UPDATE to closed without venue reducing action/receipt, then returns false from empty rows. `getUserPerpsPositions:221-231` omits closing exposure. Registered route `apps/api/src/routes/me.ts:1038-1046` calls the mutating helper, returns 404 on false and would claim closed on true. No canonical venue close/reconciliation adapter is connected. The original PF-SEC-07 finding and saved DB regression support this root defect. Installed exposure/schema/roles are NOT VERIFIED.

Source correction is held until the explicit harness clears and the actual red can be recorded. Added deterministic route regression `apps/api/src/routes/package23-perps-close.sequential.test.ts` uses real Fastify injection/requireUser/route, mocked complete DB/shared boundaries and inert principals. No auth registration, listener, service index, keygen/signing or DB transport is imported. Existing DB regression mocks client and transaction while retaining forUser, database-role only has type imports. Both test identities are explicit in `package23-perps-recovery.config.ts`; source+test noEmit config saved separately. No tests/compiler run yet.

Required minimal correction: user-scoped SELECT open/closing ownership, false for absent/closed/other tenant with no writes, named unavailable error for actual open/closing exposure, typed API503 without success or closed claim, preserve other errors, open portfolio retains closing liabilities. All tenant perps account/position/order queries use existing scopedQuery(forUser(userId)); global instrument metadata retains existing query seam. This is financial close containment, not a functioning reducing order.

All checks CPU0/shared flock/historical runner with unique labels and 512MB tests/640MB focused compiler only. No services/live/provider/credentials/signing/installs/applied migrations/Git publishing or cleanup.

## Correction and executed bounded evidence (2026-11-14)

The held status above is the pre-correction checkpoint, superseded by these retained runs:

- `package23-perps-close-red-20261114g.json`: exit1, 4 passed / 13 failed / 0 pending/todo, exactly two actual files. Twelve DB failures reproduced unscoped queries, destructive local close and omitted closing liabilities; one registered-route failure reproduced generic500 instead of typed503.
- `package23-perps-close-green-20261114j.json`: exit0, all17 passed / 0 failed / 0 pending/todo, same exact two actual files. Database tests12; registered Fastify route tests5.
- `package23-perps-close-noemit-20261114k-640.log`: focused DB+API source and tests noEmit exit0, zero diagnostics. No emitted-dist/full-API build or runtime certification.

Saved minimal correction: all account/position/order tenant queries use existing scopedQuery(forUser(...)); shared instrument metadata remains unchanged. closePerpsPosition SELECTs only the tenant's open/closing position, returnsfalse if absent and throws PerpsCloseUnavailableError otherwise. It performs no exposure mutation. The registered authenticated route returns typed503 supportedfalse for this error,404 for absence and preserves unrelated failures; no success/closed/queue claim. Both default and explicit open portfolio reads include closing liabilities.

Source fingerprints at review dispatch: DB `bbca1daecf7cd8467338ef562a84ac800f56a7d52bf9898fe75db897031fd1e3`; me.ts `921d679f36242243e245086d266d9cc99fe9627e84af75f61360a918b0b45d9d`; route test `962ac794b3c9b2c51be9c9693e7c2a946376818fb7aef0211cf5146568516c8e`. Independent bounded Standards0violations/heuristic smells; fresh Spec0missing/partialrequirements/scopecreep/implementedwrong findings after earlier reviewer providerfailed twice. See `package16-23-bounded-independent-review.md`.

Safe registered-route neighbors were independently import-reviewed and then executed: `package23-perps-neighbors-20261114l.json`, exit0,27passed/0failed/pending/todo, exactlyfive actual files: DBperps12,perpsroute5,me.authority5,me.grants4,me.withdrawal1. This later checkpoint includes the17focused tests; do not sum them as44. No existing fixture edits were needed for the added imported typed error.

This closes only the source-level fake-close behavior as refusal containment, not a functioning reducing-order feature. Historical hidden positions, schema/RLS/roles/production privileges, real venue execution/receipt/reconciliation and Trojan's durable distributed intent remain unverified or unavailable. Package23 stays in-progress. Evidence checkpoints are separate, never summed into a new acceptance total.
