# Package16 exact policy recovery final

Saved 2026-11-14. Source-only bounded correction; all tests and compiler checks remain HELD pending main-harness qualification. This is not red/green evidence, execution availability, or final package acceptance.

## Assignment and scope

Read `/home/xahmie/Documents/SWAT/threats/sequential-fixes/package16-exact-quantity-contract-correction.md` and actual policy/tests. Modified only:

- `/home/xahmie/Documents/SWAT/apps/trade-executor/src/policy.ts`
- `/home/xahmie/Documents/SWAT/apps/trade-executor/src/policy.test.ts`

This uniquely requested note was first read (reported absent) and checked absent immediately before creation. No integration files, harness/configuration files, database files, or prior evidence were edited.

## Saved contracts and implementation

`/home/xahmie/Documents/SWAT/apps/trade-executor/src/policy.ts:27-35` retains the existing OwnedReducingExit scope, lot, acquisition mode and tolerance fields, with corrected quantity signatures at lines 31-32:

```ts
readonly availableQuantity: string;
readonly requestedQuantity: string;
```

The public evaluator signature is unchanged at line 102:

```ts
export function evaluateExecutionPolicy(input: ExecutionPolicyInput): ExecutionPolicyDecision
```

Local helpers at lines 80-99 bound the entire input spelling to 256 characters before regex or BigInt work, reject non-string runtime values without stringifying Numbers, accept only plain unsigned decimal syntax, require exact positivity, and align the two bounded decimal scales for exact BigInt comparison. No quantity is converted through Number. Scientific notation, signs, surrounding whitespace, zero and malformed/nonfinite text are rejected. Existing compatible forms such as leading/trailing zeroes, `.5` and `5.` are accepted within the resource bound.

Provenance: `/home/xahmie/Documents/SWAT/packages/db/sql/058_copy_position_lots.sql:19-21` defines lot quantities as unqualified PostgreSQL NUMERIC, without a declared precision/scale. The 256-character limit is therefore an explicitly documented policy resource ceiling, not a purported database limit, token decimal scale, or universal atomic-unit conversion. Redundant zeroes count toward the ceiling. Maximum fractional scale and alignment exponent are 255. Existing DB normalization helpers accept Numbers and/or unbounded exponent input and were not reused at this stricter boundary; the local digit/scale BigInt pattern follows the existing exact ledger arithmetic.

The sell quantity guard is at `/home/xahmie/Documents/SWAT/apps/trade-executor/src/policy.ts:135-136`. Scope/master checks, queued/current policy identity and stops, acquisition-mode rules (lines 139-146), and tolerance intersection (lines 131, 147) remain unchanged. This remains a policy intersection only, not a verifier, execution grant, inventory reservation, durable authority or settlement proof. No missing snapshots/writers/verifiers were fabricated.

## Saved regression coverage (not executed)

`/home/xahmie/Documents/SWAT/apps/trade-executor/src/policy.test.ts:77-153` adds exact-quantity cases through the public evaluator:

- Lines 93-99: adjacent quantities above 2^53 and exact equality.
- Lines 101-110: ordinary/above-2^53 oversell, tiny fractional oversell and combined large-integer/tiny-fraction oversell.
- Lines 112-119: equivalent leading/trailing-zero spellings, omitted whole digits and trailing decimal point.
- Lines 121-130: exactly 256-character integer, redundant-zero, fractional-scale and combined-digit spellings.
- Lines 132-137: both comparison directions across the maximum 255-digit fractional scale difference.
- Lines 139-152: invalid values in either quantity field, including primitive/boxed Numbers, unsafe integers, fractional/subnormal/max finite Numbers, zero/negative, NaN/infinities, empty/whitespace/malformed input, exponent notation including enormous exponents, 257-character boundary violations, 10,000-character input, BigInt and other non-string values. Stable case-number titles avoid serializing large or non-JSON values into test names.

The existing fixture now supplies exact `'4'`/`'2'` text. Existing scope/master, stops, acquisition-mode, unavailable snapshot, entry-policy and tolerance regression cases are retained. Static review only; no compiler or test pass is claimed.

## Configurations and safety for main's later qualified checks

- `/home/xahmie/Documents/SWAT/threats/sequential-fixes/package16-policy-neighbors.config.ts:1-7` is the existing manifest including policy.test.ts plus copy-eligibility.test.ts and the two signal-engine neighbors. It is not a policy-only manifest. It was read, not changed or run.
- `/home/xahmie/Documents/SWAT/threats/sequential-fixes/package16-policy-copy.config.ts` and `/home/xahmie/Documents/SWAT/threats/sequential-fixes/package16-policy-signal.config.ts` do not include policy.test.ts and are not evidence for this correction.
- `/home/xahmie/Documents/SWAT/threats/sequential-fixes/package12-29-harness.ts:69-76,167-202` currently requires unfiltered `run --config/-c <config>` grammar, literal selected files, absolute REVIEW_RESULTS, empty envDir, one fork/worker, no file parallelism and manifest-checking JSON output. Do not bypass its CLI rules with a policy filename filter. Main must qualify the harness and review the entire selected import graph before execution.
- `/home/xahmie/Documents/SWAT/threats/sequential-fixes/test-safety.ts:3-19` mocks PostgreSQL and Redis with refusal guards. Those mocks alone are not proof that all network/signing/service paths are blocked.
- `/home/xahmie/Documents/SWAT/apps/trade-executor/tsconfig.json` includes all src, including policy.test.ts; `/home/xahmie/Documents/SWAT/tsconfig.base.json` targets ES2022. All source/test compilation remains held. The string contract intentionally exposes any still-numeric integration producer to that later compiler check; integration ownership was not crossed.
- `/home/xahmie/Documents/SWAT/threats/runtime-vitest.config.ts` includes integration tests and is not suitable for an unqualified bounded policy check.

No Vitest, compiler, services, live execution, secret reads, key generation, signing, installs, migrations or Git commands ran. Every shell command used taskset -c 0. No background tasks or additional agents were spawned or parked; this owner returns immediately rather than waiting. Idle-agent pruning remains with the main coordinator's agent-management controls.

## Saved SHA-256 signatures

- `/home/xahmie/Documents/SWAT/apps/trade-executor/src/policy.ts`: `177b1559c1c041294bb71db9e7dc7033145059515fb1cd3fa52a6ae211c0c868`
- `/home/xahmie/Documents/SWAT/apps/trade-executor/src/policy.test.ts`: `8d47d6cedeff65663e5354ec815ab9f7bab726ed5f30f742034a256495caa982`

## Coordinator verification after qualified harness release (2026-11-14)

The held status above records the owner's earlier source-only checkpoint. Main corrected both neighboring copy-eligibility fixtures to exact `'4'`/`'2'` strings without adding a Number adapter, reviewed the selected inert imports, and executed the explicit three-file manifest `package16-exact-recovery.config.ts`.

- `package16-exact-policy-green-20261114h.json`: exit0, 152 passed / 0 failed / 0 pending/todo, exactly three actual files: policy.test.ts (112), copy-eligibility.test.ts (21), signal-engine/trade-eligibility.test.ts (19). Report identities verified from actual JSON, not suite counts. Expected mocked database-failure diagnostics were emitted by the negative-path neighbor tests, not infrastructure failures.
- `package16-exact-policy-noemit-20261114i-640.log`: focused source+test noEmit exit0, zero diagnostics. Source-path configuration, not emitted dist/full-service/runtime acceptance.
- Tests and compiler ran sequentially on CPU0 under `/tmp/swat-package11-checks.lock` through the retained runner with synthetic guarded environment and unique labels. No services, providers, credentials, signing, migration or publishing actions.

The numeric contract defect was established by earlier actual source review, not an executed red of the newly added fixture set. Independent bounded Standards review returned0supported violations/heuristic smells; initial Spec owner failed twice at provider rate limit, then fresh tightly scoped independent Spec review returned0supported missing/partial requirements/scopecreep/implementedwrong findings. See `package16-23-bounded-independent-review.md`. Package16 remains in-progress: actual signal/worker integration, authoritative current policy, held-lot reservation and genuine source/settlement capabilities are not established by this evaluator pass. Historical repair remains unavailable.

Main may resume additional qualified bounded checks; historical execution repair, settlement authority and final package acceptance remain open.
