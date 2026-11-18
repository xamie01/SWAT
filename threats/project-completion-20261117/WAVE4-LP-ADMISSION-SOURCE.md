# Wave4 protected LP receipt boundary — additive design and source checkpoint

Date: 2026-11-18. **HIGH finding remains unresolved. The new comparison contract is unwired; it does not provide admission authority or enforce SQL083.**

## Supported boundary finding

The focused source investigation confirmed that SQL083 lets runtime materialize tenant-owned paper receipts and reconcile self-supplied economics. Application quote/receipt checks and canonical body hashes supply consistency, not independently protected evidence. The one-close observer cannot repair this boundary by reading or hashing those rows.

Current production LP startup does not provide an independently authenticated LP quote/settlement admission writer. Existing custody, withdrawal and source verification authority is not interchangeable with LP authority. No role provisioning, runtime activation or implicit certification of existing rows is justified.

## Implemented comparison-only source

`packages/db/src/lp-paper-admission-contract.ts` declares separately protected quote and settlement admission records and compares:

- Full quote and input context, tenant, position/revision and raw inventory.
- Canonical record IDs, original quote freshness at admission, bounded timestamps and optional historical recovery only for an earlier fresh admission.
- Exact quotation valuation and rebalance-positive economic projection using existing direct-leaf validators and BigInt arithmetic.
- Current operation/position/intent fingerprint, complete independently admitted actual receipt terms including fees/costs, quote-admission identity and ordered quote admission, settlement and settlement admission times.

It has no registry writer, SQL adapter, pool, credential loader, HTTP provider, signer or authority factory. Passing caller objects does not establish that they came from protected storage. Production services/stores do not call it yet. Its returned snapshot is comparison output, not an authorization token.

`tests/qualification/wave4/lp-admission.offline.test.ts` has 26 synthetic comparison contracts. They keep admission fixtures separate from candidate modifications and cover absence, provider/network/action/price/economics/context/actual-fee/cost substitutions, matching candidate hashes, revision/intent, quote-expiry historical recovery, rebalance positivity and chronology. They are neither PostgreSQL nor independently verified provider evidence.

## Required additive SQL and production integration

A supported implementation must leave sealed SQL083 and contained SQL084 unchanged and use a newly allocated, independently reviewed canonical proposal:

1. Tenant-composite, append-only quote and settlement admission sidecars with complete input/payload bindings, uniqueness fences and database-controlled admission timestamps.
2. Separately approved authenticated restricted LP admission writer; runtime SELECT only on admissions. No runtime registry writes, membership widening, object ownership, CREATE, RLS bypass or reuse of unrelated authority roles. FORCE RLS and precise policies before grants.
3. Additional acquisition and operation INSERT guards joining protected full quote/context, current position revision/inventory, admission freshness and exact economic arithmetic.
4. Receipt INSERT guards joining protected complete actual settlement terms and its operation/quote. Operation completion and exact-position updates must repeat the protected joins, including for old materialized receipts. INSERT-only repair is insufficient.
5. Strict JSON type/null validation and null-safe comparisons; no automatic admission/backfill from existing runtime rows and no substitution of jsonb text hashing for canonical JSON.
6. Import-safe mandatory owned transaction lookup/store wiring at acquisition, operation admission and settlement. Check again at store write boundaries so direct store callers cannot bypass service checks. Preserve receipt-first checked-commit accounting order, owner locks and ambiguous outcome handling.
7. Actual authenticated writer/provider composition and separately authorized hostile same-tenant direct SQL, ACL/RLS, old-receipt, expiry/recovery, replay, concurrency and trigger qualification.

No canonical SQL suffix was allocated or proposal authored in this checkpoint. The required writer identity and provider/store composition are absent; the design is not a usable migration or accepted capability. Full SQL/runtime repair is not claimed.

## Verification and affected review

Current checks: `build-w4-main-offline-23` passes 422 tests across 15 literal files, including 26 comparison contracts; `build-w4-main-typecheck-21` passes qualification noEmit, incremental false. Both consumed-input manifests have SHA256 `1dfae5d1bb77647abd90bc5360979bff58dcd984797fc9571993d6375b4d0c19`. CPU0 shared flock runner, tests one fork/512MB heap, compiler640MB, synthetic environment/offline guard. Heap bounds do not prove process resource limits.

Independent reviewer `agent_93c18f67-07ea-465c-a1a9-38ae8f7ad6cd` read only the contract and tests, identified missing settlement-after-quote-admission ordering, and otherwise accepted the narrow comparison design. The supported repair adds that ordering and the explicit reversed-chronology regression. Final targeted recheck confirmed narrow repaired COMPARISON-ONLY source acceptance with exactly two bounded Reads and no remaining supported defect in those excerpts. This is not supplied-record authority, store/SQL integration or SQL083 repair acceptance. Reviewer helper/dependency/runtime and raw-command verification is outside that limited review.

SQL083/084, public CLI/pipeline/Package28 refusals, accepted load schedule/source and sealed earlier-wave scopes remain unchanged. No services, credentials, migrations, load, signing, commit or publication. `sourceComplete=false`, `runtimeAccepted=false`, `liveCapabilityAccepted=false`, `productionReady=false`; Wave4 remains incomplete and Wave5 blocked.
