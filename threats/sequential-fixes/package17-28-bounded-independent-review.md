# Bounded authority / limiter independent source review — 2026-11-14

Baseline8905505595802c21053118b5fab3fd53a8a1654c; HEAD08c822d470554ef1f05e701b1abbed7dcb3dbc54. Only actual dirty/new Solana constructor/factory path, inert authority tests, limiter module/tests and narrow APIindex wiring examined; no global425pathdiff acceptance.

## Standards

Initial independent owner failed twice at the provider token-rate limit; those failures are retained, not application results. Fresh read-only reviewer `agent_11b8d51e-4b20-4da9-a241-a20fd0e3a48b` completed with **zero supported documented violations and zero actionable smell findings** within its permitted bounds.

The reviewer inspected the unavailable user-Solana constructor/factory at `apps/trade-executor/src/execution-authority-adapters.ts:491–548`, limiter validation/trusted proxy/buckets at `apps/api/src/package28-limiter.ts:34–79`, and first-import/construction/registration wiring at `apps/api/src/index.ts:1,52–56,142–151`, against `docs/plans/BUILDER-GUIDE.md:35–38`. Ignored compatibility options and duplicate early/explicit validation preserve existing seams and did not support an abstraction finding. The normalized email throttle key is not tenant authorization, and all limiter stores remain process-local.

The reviewer read bounded tests but did not execute or independently reproduce the supplied green/compiler evidence. This is bounded source Standards acceptance, not full-runtime approval.

## Spec

Independent read-only reviewer returned **zero bounded missing/partial requirements, scope creep or implemented-wrong findings**. Actual Solana constructor ignores compatibility options and uses existing unavailable adapter; factory passes opaque options without reading/enumerating/spreading. No synthetic option/environment authority. Operator/EVM bodies/publicshape preserved. Limiter bounds and separate global/IPcredential/account buckets, exactIPhopzero trust, synchronousfirstmodulevalidation, configbeforeFastify and awaitedregistrationbeforeauth/routes with preservedauthscope satisfy explicit contract. Published limiter hashes matched; authorityownerreport not yet present at reviewer pass, now saved separately, no verdict inferred beyond actual source reads.

## Evidence and limits

Authorityred20fail/1,green20/1,expanded/final33/1; limiterred15pass2fail/17total/1 then15green/1samefilewithbothoriginalfailurecases. Countchange17→15 documented broadened consolidated malformedinput/bounds/injectcoverage. Both initial compilerfailures retained; finalESNext/BundlerfocusednoEmit640exit0,notNodeNext/fullindexruntime. Combinedsafe244passed/11actualfiles/0failed/pending/todo run verified from actual JSON. This is not a sum of previous runs or fullpackage acceptance.

No tests/compiler/services/network/credential/signing/sourcewrites by independent reviewers. Genuine deployedauthority/custody/finalbytes/receipt/financialexecution, realauth/index/ingress/sharedstore/multiprocess and four historicalisolationfailures remainexternalorunfinished. Packages17/28 remainin-progress. Exact durableownerreports: package17-authority-bounded-20261114.report.json and package28-limiter-bounded-20261114.report.json.
