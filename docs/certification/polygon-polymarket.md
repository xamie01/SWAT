# Polygon / Polymarket Certification

Status: **NOT CERTIFIED**

This file is an evidence checklist for the Polymarket CLOB V2 executor on Polygon. It must not be used to enable `polygon` in `LIVE_ENABLED_CHAINS` until every runtime and manual gate below has concrete, redacted evidence and an independent reviewer has signed off.

## Verification Checklist

1. **Authentication (F-PM3, G3-P3)**
   - [ ] Pin the current official production CLOB V2 SDK and Polygon chain ID 137.
   - [ ] Record the explicit signer, account wallet/funder, and resolved signature type without recording signer material.
   - [ ] Derive or load authenticated L2 credentials without logging them.
   - [ ] Record a successful authenticated account/order round trip.
   - [ ] Attach the registered `bytes32` builder code before signing every order and verify matched attribution.

2. **Collateral & Sizing (F-PM4)**
   - [ ] Verify pUSD (`0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`) balance using 6-decimal units.
   - [ ] Where needed, record a confirmed USDC.e-to-pUSD wrap through the official CollateralOnramp.
   - [ ] Record bounded, least-privilege allowances for the onramp and both current V2 exchange contracts; never record or grant an unlimited ERC-20 allowance.
   - [ ] Prove BUY sizing includes platform/builder fees and SELL sizing cannot exceed confirmed outcome shares.

3. **Execution Rules (F-PM5, F-PM6)**
   - [ ] Attest the current CTF Exchange V2, Neg Risk Exchange V2, pUSD, onramp, CTF, and wallet contracts against official sources and deployed bytecode.
   - [ ] Re-read the correct outcome-token book immediately before submission and enforce market-state, staleness, depth, deviation, and near-certainty gates.
   - [ ] Prove tick-size/minimum-size rounding for standard and neg-risk markets.
   - [ ] Prove proportional SELL execution for the exact outcome token.

4. **Safety & Reconciliation (G3-P7, G3-P8, G3-P9)**
   - [ ] Prove stable client-order idempotency and duplicate retry rejection.
   - [ ] Record a tiny filled BUY with the CLOB order ID, trade IDs, actual matched size, average price, fees, and settlement transaction hash from the venue.
   - [ ] Record an unfillable order that cancels cleanly and a partial fill whose remainder is cancelled.
   - [ ] Prove restart reconciliation for unresolved submitted/matched/mined states without resubmission.
   - [ ] Keep the CLOB order ID separate from settlement transaction hashes.

5. **Context and Operator Review (G3-P1, G3-P2, G3-P5)**
   - [ ] Attach the existing non-empty, 100%-coverage market-context acceptance evidence.
   - [ ] Confirm the operator account, jurisdiction, venue terms, and funding source are eligible.
   - [ ] Reconcile the final pUSD and outcome-token balances against every recorded fill.

## Evidence

- Live BUY order ID: pending
- Venue trade IDs: pending
- Settlement transaction hash: pending
- Cancelled order ID: pending
- Duplicate client-order rejection: pending
- Restart-reconciled order ID: pending
- Reviewer: pending
- Review date: pending

## Conclusion

`polygon` remains clamped to paper. Unit and fixture tests can validate implementation contracts, but they cannot substitute for authenticated canaries, balance reconciliation, operator eligibility, or reviewer sign-off.
