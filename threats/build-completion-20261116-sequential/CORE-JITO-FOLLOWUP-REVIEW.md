# Independent core/Jito follow-up review — 2026-11-16

Read-only source review; no test/compiler/service/secret execution. Previous origin/partial-status/authority/tenant default/boot fixes confirmed in source, not runtime proof.

## Supported remaining repairs

1. **High: lock order inversion.** worker-settlement.ts uncertainty attempt→execution contrasts jito-receipt.ts execution→attempt. Concurrent late callback and receipt can deadlock. Establish shared position/advisory→execution→attempt order, preserve terminal accounting reread. Existing sequential mocks do not prove concurrency.
2. **High: committed receipt ack recovery.** jito-receipt.ts compares fullJSON before settled marker; confirmed→finalized observation after financial commit/ackloss collides. jito-store exactJSON acknowledgement also fails. Match immutable identity/economics, permit monotonic confirmation observation, acknowledge persisted committed receipt without rewriting financial evidence.
3. **Medium: bounded sweep starvation.** jito-store oldestLIMIT100 always repeats persistent unknowns and never processes101+. Add durable last-checked rotation/cursor bounded scheduling while retaining unknown ownership.

These are local bugs, not external-only capability gates. Repair queued after current LP phase to preserve sequential implementation. No signer/provider/scoped runtime/source verifier readiness inferred. Source descriptor canonical join remains known unfinished and is not counted as a new finding.
