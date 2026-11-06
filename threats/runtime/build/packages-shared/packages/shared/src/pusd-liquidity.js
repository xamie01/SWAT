/**
 * pUSD withdrawal-liquidity monitoring (`S4-M42`).
 *
 * **This is not a peg monitor, and the distinction is the whole item.** Per
 * Polymarket's own docs, pUSD is *"a standard ERC-20 token on Polygon, backed by
 * USDC. The smart contract -- which enables the withdrawal functionality --
 * enforces the backing. No algorithmic peg, no fractional reserve."* It is also
 * deliberately **not listed on external exchanges**, so there is **no market
 * price to poll** -- a price feed for pUSD would be measuring nothing.
 *
 * What can actually strand a user's funds is named in the withdraw docs:
 *
 *   *"pUSD is unwrapped to USDC via the Collateral Offramp and swapped through
 *   the Uniswap v3 pool for USDC (native). The UI enforces less than 10bp
 *   difference in output amount. **At times, this pool may be exhausted.**"*
 *
 * So the monitored quantity is **liquidity in one specific pool**, which is
 * public and directly measurable, and the reserve address -- which an earlier
 * attempt was blocked on -- is not needed at all.
 *
 * **Deliberately absent: a reserve-ratio check.** Summing USDC held at the pUSD
 * token, Onramp and Offramp against `totalSupply` yields ~0.000003 on a ~488M
 * supply, and `underlying()`, `asset()`, `totalAssets()`, `reserve()`,
 * `convertToAssets()` and `exchangeRate()` all revert on the proxy. That is
 * **not** evidence pUSD is unbacked -- the docs say the contract enforces
 * backing -- only that the formula is wrong and the reserve lives elsewhere. An
 * alarm on that ratio would fire permanently and be ignored inside a day, which
 * is worse than no alarm. Recorded here so it is not re-attempted.
 *
 * Pure module: no network, no clock, no environment. Every input is an argument,
 * which is what makes it testable with no infrastructure and matches
 * `master-capacity.ts` / `stop-loss.ts` / `position-cap.ts`.
 */
/** Verified on Polygon mainnet, 2026-09-01. */
export const PUSD_CONTRACTS = Object.freeze({
    /** pUSD, 6 decimals. */
    pUsd: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
    collateralOnramp: '0x93070a847efEf7F70739046A929D47a521F5B8ee',
    collateralOfframp: '0x2957922Eb93258b93368531d39fAcCA3B4dC5854',
    /**
     * The swap pool the withdraw path routes through. `token0` is USDC.e and
     * `token1` is native USDC; fee tier 100 (0.01%).
     */
    withdrawalPool: '0xd36ec33c8bed5a9f7b6630855f1533455b98a418',
    usdcE: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    usdcNative: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
});
/** pUSD and both USDC variants are 6-decimal. Not 18 -- see `S4-M41`. */
export const PUSD_DECIMALS = 6;
/**
 * Selector of `OnlyUnpaused()`, the error `wrap`/`unwrap` revert with when an
 * admin has paused the asset. Verified two ways: viem's `toFunctionSelector`
 * and a raw keccak256 of the signature both give `0x49b8b3ac`.
 *
 * Worth pinning as a constant because the **pause is the most dangerous failure
 * shape here**: collateral cannot be withdrawn while the token still reports a
 * full balance, so nothing about the user's balance looks wrong.
 */
export const ONLY_UNPAUSED_SELECTOR = '0x49b8b3ac';
/**
 * The venue's own output-difference bound on the withdraw swap: *"The UI enforces
 * less than 10bp difference in output amount."*
 *
 * Adopted rather than invented, so the threshold is defensible. A **widening**
 * spread on this pair is early warning before outright exhaustion, which is why
 * it is assessed rather than merely enforced.
 */
export const PUSD_SWAP_MAX_OUTPUT_DIFFERENCE_BPS = 10;
/**
 * Polymarket's own guidance: *"For very large withdrawals (over $50,000),
 * consider breaking the withdrawal into smaller amounts."* Used as the default
 * single-withdrawal notional the depth check is judged against.
 */
export const PUSD_LARGE_WITHDRAWAL_USD = 50_000;
function finite(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
/**
 * Assesses the pUSD withdrawal path.
 *
 * Order of precedence in `reasonCode`: a paused offramp outranks thin depth,
 * because a pause blocks every withdrawal regardless of liquidity while thin
 * depth only blocks large ones.
 */
export function assessPusdWithdrawalPath(input) {
    const failures = [];
    const unassessed = [];
    const notes = [];
    // ---- Pause: checked first because it is unconditional. -------------------
    if (input.collateralPaused === null) {
        unassessed.push('pause-state-unknown');
    }
    else if (input.collateralPaused) {
        failures.push('pusd-collateral-paused');
        notes.push('collateral wrap/unwrap is paused (OnlyUnpaused)');
    }
    // ---- Redeemability: the end-to-end property we actually depend on. -------
    if (input.simulatedUnwrap === null) {
        unassessed.push('redeemability-untested');
    }
    else if (input.simulatedUnwrap === 'reverted') {
        failures.push('pusd-unwrap-reverts');
        notes.push('simulated unwrap reverted');
    }
    // ---- Depth, native side only. -------------------------------------------
    const depth = input.depth.nativeUsdcAvailable;
    if (!finite(depth)) {
        unassessed.push('pool-depth-unknown');
        // The float alarm reads the same figure, so it cannot run either. Recorded
        // separately only when the float itself is the missing half.
    }
    else {
        const floor = finite(input.depthFloorUsd) ? input.depthFloorUsd : PUSD_LARGE_WITHDRAWAL_USD;
        if (depth < floor) {
            failures.push('pusd-pool-depth-below-floor');
            notes.push(`native USDC depth ${depth} below floor ${floor}`);
        }
        if (!finite(input.aggregateFloatUsd)) {
            unassessed.push('float-unknown');
        }
        else if (depth < input.aggregateFloatUsd) {
            // The alarm that matters at our scale: not "is a withdrawal possible" but
            // "could all of our users exit". ~195k of measured depth against a ~488M
            // pUSD supply means the pool, not the supply, bounds our float.
            failures.push('pusd-pool-depth-below-float');
            notes.push(`native USDC depth ${depth} below aggregate float ${input.aggregateFloatUsd}`);
        }
    }
    // ---- Swap-leg spread: early warning before exhaustion. ------------------
    if (!finite(input.swapOutputDifferenceBps)) {
        unassessed.push('swap-output-unknown');
    }
    else if (input.swapOutputDifferenceBps > PUSD_SWAP_MAX_OUTPUT_DIFFERENCE_BPS) {
        failures.push('pusd-swap-output-outside-bound');
        notes.push(`swap output difference ${input.swapOutputDifferenceBps}bps exceeds `
            + `${PUSD_SWAP_MAX_OUTPUT_DIFFERENCE_BPS}bps`);
    }
    if (failures.length > 0) {
        return {
            outcome: 'impaired',
            reasonCode: failures[0],
            failures,
            unassessed,
            detail: notes.join('; ')
        };
    }
    if (unassessed.length > 0) {
        return {
            outcome: 'healthy-partial',
            reasonCode: 'pusd-partially-assessed',
            failures,
            unassessed,
            detail: `nothing failed, but unassessed: ${unassessed.join(', ')}`
        };
    }
    return {
        outcome: 'healthy',
        reasonCode: 'pusd-withdrawal-path-healthy',
        failures,
        unassessed,
        detail: 'pause, redeemability, depth, float and swap spread all checked and passing'
    };
}
/**
 * True only for a fully-checked pass.
 *
 * The single predicate callers should use, so `healthy-partial` cannot be waved
 * through by testing `outcome !== 'impaired'` -- the same reason
 * `isPermitted` exists in the authority policy.
 */
export function pusdWithdrawalsHealthy(verdict) {
    return verdict.outcome === 'healthy';
}
/**
 * Recognises a revert as the documented pause rather than a generic failure.
 *
 * Takes the revert data because the caller owns the RPC; keeping this pure means
 * the pause/unknown distinction is testable without a chain.
 */
export function isOnlyUnpausedRevert(revertData) {
    return typeof revertData === 'string'
        && revertData.toLowerCase().startsWith(ONLY_UNPAUSED_SELECTOR);
}
//# sourceMappingURL=pusd-liquidity.js.map