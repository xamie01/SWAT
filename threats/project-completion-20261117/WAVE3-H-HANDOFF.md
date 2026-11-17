# Wave 3 API/web handoff notes (coordinator)

H is queued until one E/F/G implementation slot is released. Only H may edit `apps/api/src/routes/me.ts`. These notes record the early contracts, not accepted interfaces; finalize after owner handoff and independent review.

## Current joins

- `apps/api/src/index.ts` calls `registerMeRoutes(app,{backfillQueue,tokenDiscoveryQueue})`; no approved external domain provider is wired. Default routes must remain unavailable and must not issue authorization or claim live capability merely because domain source exists.
- `me.ts` contains portfolio/close-all, vault/grant/revoke/challenge/credentials, withdrawal request/confirm, and perps portfolio/close. Existing fail-closed tests are `me.withdrawal.sequential.test.ts`, `me.grants.sequential.test.ts`, `me.portfolio.sequential.test.ts`; preserve default refusals while adding injected-domain tests driving actual handlers.
- Old `otpStore: Map` and email callback are compatibility options only, never durable authority. F supplies exact durable service API; Map cannot become an accepted execution seam.
- Web `portfolio-model.ts` currently has unconditional reducing refusal and enrollment guard; update to accepted route-contract capability observations without making a random flag/label authorization. Runtime/live and source/injected readiness remain separate. Actions report requested/queued/partial/uncertain/settled, never infer closure from HTTP success or order submission.

## E early contract

E plans pure custody-contract/enrollment/execution modules with versioned binding of tenant, chain, kind, normalized account, key version, policy digest and expiry. Enrollment wraps only; execution unwrap is separate and only inside execution-session callback. Public output never carries secret. Keyless vault remains secret-free. Deployed delegation verifies tenant/account/delegate/revision/expiry/action/instrument and decoded signing payload via explicit independent port. Existing default grant registration remains blocked absent approved wrap/deployment provider. H consumes factory/readiness via injected options, no unwrap/keygen in API process.

## F early contract

Request-OTP input exact `{requestKey,chain,assetId,assetScale,sourceWalletId,destination,amountRaw,mode}`; user ID from authenticated principal only. Server supplies expiry/cooling policy. Result intent/authorization identifiers and immutable binding/expiry, not transfer completion. Confirm input only `{intentId,authorizationId,otp}`. Same-client one-use authorization consumption and outbox commit follow fresh ownership/cooling/balance/mode revalidation; exact replay returns existing request, substitutions deny. Tenant-scoped status distinguishes intent/attempt/uncertainty/receipt settlement. No external delivery/execution service implicit in providerless API startup.

Spot/perps service persists exact reducing intent, reserves exposure, stores attempt/outbox before effects, and reconciles uncertain submissions before retry. Receipt deltas cannot cross zero/increase exposure or mark closed without terminal evidence. H consumes these adapters; F never edits me.ts.

## G coordination

Original G local agent failed twice on provider token-rate limit and remains stopped; replacement G session is exclusive LP owner. G submits final valued paper/economic lifecycle and copy contracts. H joins accepted LP operations and honest web states; no native signing/provider flow activated.

## H deliverables

Actual Fastify-injection tests for injected contracts + retained default denial, auth/tenant binding, exact-unit validation, stale/substituted OTP/intents, status/retries/cooling, no false closure, and honest web transports/model states. Source/tests globally frozen before tests; coordinator reviews literal config/import safety and registers hashes, guarded runner CPU0/flock/512MB one fork/640MB compilers. Final independent read-only route/web review and coordinator acceptance required.
