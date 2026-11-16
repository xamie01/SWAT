# Reducing-exit exact quantity contract correction

Coordinator clarification following the execution integrator's actual source inspection. This is a pending correction, not a verified implementation.

## Supported mismatch

Integrator agent_9b55ebe0-be79-4536-b3f6-5608a3442aec reported that current apps/trade-executor/src/policy.ts OwnedReducingExit quantities are numeric, although producer/lot authority and prior interface reports require exact decimal text. Coordinator did not independently reread this source; actual types are owner/integrator-reported pending owner confirmation.

## Assigned correction

Policy owner agent_f334f590-1e88-4387-914b-9f9615c6fd21 must change availableQuantity/requestedQuantity to exact bounded decimal strings, reject Number input rather than stringify already-rounded economics, and compare exact positive values using existing suitable string/BigInt helpers. No Number coercion at integration. Tests must cover large values above2^53, equivalent decimal normalization, tiny oversell, invalid/nonfinite/zero/negative inputs and existing quantity resource bounds. Units/scales follow actual existing lot policy, not a fabricated universal atomic conversion.

No change to tenant/master/lot/acquisition mode, immutable source token/side, current stops, queued/current tolerance intersection or source-verifier requirements. Missing current policy snapshots/writer and durable runtime authority still refuse before dispatch. No execution availability is inferred from pure policy tests.

## Evidence/ownership

Policy/copy-eligibility files remain sole16 ownership; shared lifecycle/executor integration remains9b55. Existing provisional red/green evidence retained, no overwritten labels. Tests/compiler held until harness corrections/selfchecks/independent bounded rechecks qualify. Saved corrected signature, focused evidence and source/test compiler remain pending.

Integrator also reported retry verifier fence saved before historical execution lookup with regression added, but no new red execution while harness held. This is source containment pending verification; historical repair, actual settlement and final package acceptance remain open. User Solana authority must deny even enabled/injected-signer synthetic-vault paths; missing durable policy/receipt/fanout/risk capabilities must not be fabricated. Existing submitted/unknown liabilities and delivery obligations remain retained, not failed/released by refusal.
