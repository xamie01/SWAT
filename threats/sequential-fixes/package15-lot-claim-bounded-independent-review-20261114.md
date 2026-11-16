# Lot-claim bounded independent review — 2026-11-14

Baseline8905505595802c21053118b5fab3fd53a8a1654c; observedHEAD08c822d470554ef1f05e701b1abbed7dcb3dbc54. Scope: current recovery dirty/new lot-allocation and lifecycle claim boundaries, not full diff or economic runtime.

## Standards

Separate read-only reviewer completed zero documented violations and zero actionable heuristic smells. Null-operator/tenant/account distinction, same-client master reservations, exact SQL replay and deliberately repeated provenance predicates conform to cited Builder Guide/ADR0001/0007 constraints within the bounded seam. Mock SQL and source-only qualifications remain honest. No runtime or PostgreSQL arithmetic/concurrency acceptance.

## Spec

Separate reviewer found one High, high source-confidence acquisition-evidence gap: `lot-allocation.ts:138–153` and `copy-trade-lifecycle.ts:1398–1414,1435–1464` join acquisition/source but do not bind `lot.acquisition_evidence_id` to the same acquisition execution and active applied confirmation/application. SQL058 provides independent foreign keys, not this equality. The evidence reversal path deactivates application while the lot synchronization path returns for reversed/unconfirmed evidence, so a retained positive lot need not represent current applied acquisition. Conditional on such retained invalid/reversed lots, another master's aggregate balance could fund an explicit exit against the stale master's lot. No invalid deployed data or actual financial abuse was observed.

The exclusive lot owner is reassigned to prove current applied confirmed/finalized evidence and active application, bound actual position/tenant/account/chain/token, on the same caller client for availability, explicit ownership and replay; missing/mismatched/reversed proof must refuse. No source verifier enablement or historical repair is authorized. Corrected evidence and independent recheck pending. A Standards pass does not hide this Spec finding.

## Evidence

Coordinator verified14current source/test/harness hashes, actual red7passed24failed/1file, firstgreen31/1, final32/1 and retained neighbors65passed1failed/4files. Focused source+test noEmit640exit0 after fixture-type compiler red. Neighbor PNL projection separately corrected (fresh21/2 and70/5; independent Spec pending); manifests overlap and cannot be summed or substituted. Source verifier remains false; source-success wiring is only structural. Full per-lot allocation/current policy/worker/receipt/trade/settlement/schema/RLS/history remain blocked or unfinished.
