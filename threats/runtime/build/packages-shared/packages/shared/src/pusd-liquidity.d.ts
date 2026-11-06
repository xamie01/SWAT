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
export declare const PUSD_CONTRACTS: Readonly<{
    /** pUSD, 6 decimals. */
    readonly pUsd: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
    readonly collateralOnramp: "0x93070a847efEf7F70739046A929D47a521F5B8ee";
    readonly collateralOfframp: "0x2957922Eb93258b93368531d39fAcCA3B4dC5854";
    /**
     * The swap pool the withdraw path routes through. `token0` is USDC.e and
     * `token1` is native USDC; fee tier 100 (0.01%).
     */
    readonly withdrawalPool: "0xd36ec33c8bed5a9f7b6630855f1533455b98a418";
    readonly usdcE: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
    readonly usdcNative: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
}>;
/** pUSD and both USDC variants are 6-decimal. Not 18 -- see `S4-M41`. */
export declare const PUSD_DECIMALS = 6;
/**
 * Selector of `OnlyUnpaused()`, the error `wrap`/`unwrap` revert with when an
 * admin has paused the asset. Verified two ways: viem's `toFunctionSelector`
 * and a raw keccak256 of the signature both give `0x49b8b3ac`.
 *
 * Worth pinning as a constant because the **pause is the most dangerous failure
 * shape here**: collateral cannot be withdrawn while the token still reports a
 * full balance, so nothing about the user's balance looks wrong.
 */
export declare const ONLY_UNPAUSED_SELECTOR = "0x49b8b3ac";
/**
 * The venue's own output-difference bound on the withdraw swap: *"The UI enforces
 * less than 10bp difference in output amount."*
 *
 * Adopted rather than invented, so the threshold is defensible. A **widening**
 * spread on this pair is early warning before outright exhaustion, which is why
 * it is assessed rather than merely enforced.
 */
export declare const PUSD_SWAP_MAX_OUTPUT_DIFFERENCE_BPS = 10;
/**
 * Polymarket's own guidance: *"For very large withdrawals (over $50,000),
 * consider breaking the withdrawal into smaller amounts."* Used as the default
 * single-withdrawal notional the depth check is judged against.
 */
export declare const PUSD_LARGE_WITHDRAWAL_USD = 50000;
/**
 * Why an assessment could not be completed. **Never a pass**, and never zero.
 *
 * Mirrors `MasterCapacityUnassessedReason`: unknown is a named code, because a
 * missing figure and a figure of zero demand opposite responses -- one is "go
 * look at the feed", the other is "stop withdrawing".
 */
export type PusdUnassessedReason = 
/** No native-USDC depth figure was supplied, or it was not a finite number. */
'pool-depth-unknown'
/** Our aggregate float is unknown, so the float-relative alarm cannot run. */
 | 'float-unknown'
/** The pause state could not be read (RPC failure, not a paused result). */
 | 'pause-state-unknown'
/** The unwrap simulation could not be performed at all. */
 | 'redeemability-untested'
/** No quoted output, so the 10bp bound cannot be checked. */
 | 'swap-output-unknown';
/** What the monitor concluded. */
export type PusdOutcome = 
/** Everything checked passed, and nothing was left unchecked. */
'healthy'
/**
 * What was checked passed, but something was unassessable. **Not a clean
 * pass**, and a distinct outcome so a dashboard can never render it as one --
 * the same distinction `master-capacity.ts` draws for an admit under partial
 * information.
 */
 | 'healthy-partial'
/** A checked condition failed. Withdrawals are impaired or will be. */
 | 'impaired';
export type PusdReasonCode = 'pusd-withdrawal-path-healthy'
/** Native-USDC depth below the absolute floor. */
 | 'pusd-pool-depth-below-floor'
/** Depth below our own aggregate float: users collectively cannot exit. */
 | 'pusd-pool-depth-below-float'
/** An admin has paused wrap/unwrap. */
 | 'pusd-collateral-paused'
/** A simulated unwrap reverted. */
 | 'pusd-unwrap-reverts'
/** Swap output difference exceeds the venue's own 10bp bound. */
 | 'pusd-swap-output-outside-bound'
/** Nothing failed, but not everything could be checked. */
 | 'pusd-partially-assessed';
/**
 * Native-USDC depth, and only native.
 *
 * **The field is named for the side that matters, and the other side is not
 * accepted at all.** A withdrawal runs USDC.e to native USDC, so it *drains* the
 * native leg: an interface taking an undifferentiated "pool balance", or a
 * `{token0, token1}` pair, invites reading the wrong number and would report a
 * healthy pool while the exitable side was empty. `null` means unknown.
 */
export interface PusdPoolDepth {
    readonly nativeUsdcAvailable: number | null;
}
export interface PusdMonitorInput {
    readonly depth: PusdPoolDepth;
    /**
     * Total pUSD our users collectively hold, in USD. `null` is unknown, which
     * disables the float-relative alarm with its own reason rather than passing.
     */
    readonly aggregateFloatUsd: number | null;
    /**
     * Absolute floor for native-USDC depth. Defaults to the venue's own
     * large-withdrawal guidance: below this, a single ordinary large withdrawal
     * cannot clear.
     */
    readonly depthFloorUsd?: number;
    /** `true` = paused, `false` = not paused, `null` = could not read. */
    readonly collateralPaused: boolean | null;
    /**
     * Result of a simulated `unwrap` (`eth_call`, never a send). `'ok'` /
     * `'reverted'` / `null` for not attempted or attempt failed.
     */
    readonly simulatedUnwrap: 'ok' | 'reverted' | null;
    /**
     * Observed output difference on the swap leg, in basis points. `null` when no
     * quote was obtained.
     */
    readonly swapOutputDifferenceBps: number | null;
}
export interface PusdMonitorVerdict {
    readonly outcome: PusdOutcome;
    readonly reasonCode: PusdReasonCode;
    /** Every failing condition, not just the first — an operator needs all of them. */
    readonly failures: readonly PusdReasonCode[];
    /**
     * What this verdict says **nothing** about. An empty array is the only thing
     * that means "fully checked", which is why `healthy` requires it.
     */
    readonly unassessed: readonly PusdUnassessedReason[];
    /** Ops-facing detail. Carries figures, so it is never rendered to a user. */
    readonly detail: string;
}
/**
 * Assesses the pUSD withdrawal path.
 *
 * Order of precedence in `reasonCode`: a paused offramp outranks thin depth,
 * because a pause blocks every withdrawal regardless of liquidity while thin
 * depth only blocks large ones.
 */
export declare function assessPusdWithdrawalPath(input: PusdMonitorInput): PusdMonitorVerdict;
/**
 * True only for a fully-checked pass.
 *
 * The single predicate callers should use, so `healthy-partial` cannot be waved
 * through by testing `outcome !== 'impaired'` -- the same reason
 * `isPermitted` exists in the authority policy.
 */
export declare function pusdWithdrawalsHealthy(verdict: PusdMonitorVerdict): boolean;
/**
 * Recognises a revert as the documented pause rather than a generic failure.
 *
 * Takes the revert data because the caller owns the RPC; keeping this pure means
 * the pause/unknown distinction is testable without a chain.
 */
export declare function isOnlyUnpausedRevert(revertData: string | null | undefined): boolean;
//# sourceMappingURL=pusd-liquidity.d.ts.map