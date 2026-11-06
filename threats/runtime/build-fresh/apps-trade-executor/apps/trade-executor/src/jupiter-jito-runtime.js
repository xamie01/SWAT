import { buildJupiterSwap, fetchTokenPriceUsd, getJitoBundleStatus, getJitoTipAccounts, getJitoTipFloor, lamportsToUsd, selectJitoTip, selectTipAccount, submitJitoBundle } from '@swat/shared';
import { decodeRuntimeValue, encodeRuntimeValue } from './runtime-codec.js';
/**
 * Solana execution over Jupiter + Jito bundles (DG-1, checklist S3-1…S3-5).
 *
 * Replaces the Trojan webhook path. The state machine deliberately mirrors
 * `trojan-runtime.ts` — `pending_confirmation` handed to the existing sweeper,
 * terminal resolutions cached by client order id — so the executor's
 * reconciliation semantics carry over unchanged and only the transport differs.
 *
 * **Bundles, never public RPC.** A swap broadcast to the public mempool is
 * visible to searchers before it lands, which is the window a sandwich needs.
 * Bundles go straight to block builders and land atomically, so there is also no
 * partial-fill state to reconcile.
 */
const DEFAULT_STORE_KEY = 'swat:trade-executor:pending:jupiter-jito:v1';
/**
 * Wrapped SOL. The tip is paid in lamports; `feeUsd` needs a USD price for them.
 *
 * Duplicated rather than imported from `solana-dispatch.ts`, which already exports
 * the same constant — that module imports *this* one, so importing back would
 * close an import cycle.
 */
const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
export function createRedisJupiterJitoStore(redis, key = DEFAULT_STORE_KEY) {
    async function read(clientOrderId) {
        const encoded = await redis.hget(key, clientOrderId);
        return encoded ? decodeRuntimeValue(encoded) : null;
    }
    return {
        async findPending(clientOrderId) {
            const stored = await read(clientOrderId);
            return stored?.state === 'pending' ? stored.pending : null;
        },
        async findResolution(clientOrderId) {
            const stored = await read(clientOrderId);
            return stored?.state === 'resolved' ? stored.resolution : null;
        },
        async listPending() {
            const values = await redis.hgetall(key);
            return Object.values(values).flatMap((encoded) => {
                const stored = decodeRuntimeValue(encoded);
                return stored.state === 'pending' ? [stored.pending] : [];
            });
        },
        async save(pending) {
            await redis.hset(key, pending.clientOrderId, encodeRuntimeValue({ state: 'pending', pending }));
        },
        async resolve(clientOrderId, resolution) {
            await redis.hset(key, clientOrderId, encodeRuntimeValue({ state: 'resolved', resolution }));
        }
    };
}
export function createJupiterJitoRuntime(options) {
    if (!Number.isInteger(options.pendingTtlMs) || options.pendingTtlMs < 60_000) {
        throw new Error('pendingTtlMs must be an integer of at least 60000');
    }
    if (!Number.isInteger(options.maxTipLamports) || options.maxTipLamports <= 0) {
        // Without a positive cap the tip is unbounded, and the tip is real SOL
        // charged against position P&L on every trade.
        throw new Error('maxTipLamports must be a positive integer');
    }
    const now = options.now ?? (() => new Date());
    async function submit(input) {
        // Terminal states are sticky: a resolved order must never be resubmitted,
        // however many times the queue redelivers the job.
        const resolved = await options.pendingStore.findResolution(input.clientOrderId);
        if (resolved) {
            return { status: 'already_resolved', clientOrderId: input.clientOrderId, resolution: resolved };
        }
        const pending = await options.pendingStore.findPending(input.clientOrderId);
        if (pending) {
            return {
                status: 'pending_confirmation',
                clientOrderId: input.clientOrderId,
                bundleId: pending.bundleId,
                lastValidBlockHeight: pending.lastValidBlockHeight
            };
        }
        const built = await buildJupiterSwap({
            quote: input.quote,
            userPublicKey: input.signerPublicKey,
            // No priority fee: the Jito tip is what buys inclusion, and layering a
            // priority fee on top is paying twice for the same thing.
            computeUnitPriceMicroLamports: undefined,
            apiKey: options.jupiterApiKey
        });
        if (!built) {
            return { status: 'rejected', clientOrderId: input.clientOrderId, reason: 'swap-build-failed' };
        }
        // Pre-trade simulation (checklist S4-M15).
        //
        // **Why the gate lives inside the runtime rather than in front of it.** The
        // artifact that has to be simulated is the built transaction, and it only
        // ever exists here: `solana-dispatch.ts` holds a quote, and
        // `buildJupiterSwap` is called from this function, after the idempotency
        // guards. Simulating from dispatch would mean either building the swap twice
        // (two paid Jupiter `/swap` calls producing two different transactions, so
        // the one simulated is not the one submitted) or hoisting the build above the
        // resolved/pending checks, which is exactly the ordering that must not change
        // — a redelivered job would then build and simulate a swap for an order that
        // is already terminal.
        //
        // It runs *before* the tip floor is fetched and before anything is signed, so
        // a refused route costs one RPC round trip and nothing else. A skip here is
        // `rejected`, never `submission_unknown`: no bundle was transmitted, so there
        // is no venue-side state to reconcile.
        if (options.simulation) {
            const decision = await options.simulation.evaluate({
                transactionBase64: built.swapTransaction,
                clientOrderId: input.clientOrderId
            });
            if (decision.kind === 'skip') {
                return {
                    status: 'rejected',
                    clientOrderId: input.clientOrderId,
                    reason: `${decision.code}: ${decision.reason}`,
                    code: decision.code
                };
            }
        }
        const floor = await getJitoTipFloor(options.jito);
        const tipLamports = selectJitoTip({
            floor,
            percentile: options.tipPercentile ?? 'p75',
            maxTipLamports: options.maxTipLamports,
            fallbackTipLamports: options.fallbackTipLamports
        });
        // Resolved at runtime, TTL-cached, and falling back to the hard-coded set
        // (S4-P18). Never empty, so `selectTipAccount` always has something to pick.
        const tipAccounts = await getJitoTipAccounts(options.jito);
        const tipAccount = selectTipAccount(input.clientOrderId, tipAccounts);
        let signedSwap;
        let signedTip;
        try {
            signedSwap = await options.signTransaction(built.swapTransaction);
            signedTip = await options.signTransaction(await options.buildTipTransaction({ tipAccount, lamports: tipLamports }));
        }
        catch (error) {
            // Nothing was transmitted, so this is unambiguously a rejection rather
            // than an unknown submission.
            return {
                status: 'rejected',
                clientOrderId: input.clientOrderId,
                reason: `signing-failed: ${error instanceof Error ? error.message : 'unknown'}`
            };
        }
        const result = await submitJitoBundle([signedSwap, signedTip], options.jito);
        if (!result.ok) {
            if (result.retryable) {
                // Genuinely ambiguous: the block engine may have received the bundle.
                // Recorded as pending with no bundle id so the sweeper investigates
                // rather than the caller resubmitting blind.
                //
                // It is NOT downgraded to a public RPC broadcast (S3-5). Doing so would
                // silently reintroduce exactly the front-running exposure bundles exist
                // to remove, and the operator would still believe they were protected.
                return {
                    status: 'submission_unknown',
                    clientOrderId: input.clientOrderId,
                    reason: result.reason
                };
            }
            return { status: 'rejected', clientOrderId: input.clientOrderId, reason: result.reason };
        }
        await options.pendingStore.save({
            clientOrderId: input.clientOrderId,
            bundleId: result.bundleId,
            lastValidBlockHeight: built.lastValidBlockHeight,
            expiresAt: new Date(now().getTime() + options.pendingTtlMs),
            // Carried on the pending record because reconciliation happens in a later
            // process tick — often a later process — and the block engine's status
            // response does not report what the bundle tipped. Recomputing it at
            // reconcile time would re-read a tip floor that has since moved and book a
            // number the chain never saw.
            tipLamports
        });
        return {
            status: 'submitted',
            clientOrderId: input.clientOrderId,
            bundleId: result.bundleId,
            lastValidBlockHeight: built.lastValidBlockHeight
        };
    }
    /**
     * Prices a landed bundle's tip in USD, for `persistTrade`'s `feeUsd`.
     *
     * Only ever called once a bundle is known to have landed — see `reconcile`.
     *
     * Returns `null` on every path where the number would be a guess: a pending
     * record from before S4-P18 that carries no tip, a nonsensical tip, or an
     * unavailable SOL price. `fetchTokenPriceUsd` answers `null` when every one of
     * its upstreams fails, and that must not collapse into a zero fee — zero is a
     * claim that the trade cost nothing, which is a different and false statement.
     */
    async function priceLandedTip(tipLamports) {
        if (typeof tipLamports !== 'number' || !Number.isFinite(tipLamports) || tipLamports <= 0) {
            return null;
        }
        const solPriceUsd = await fetchTokenPriceUsd(WRAPPED_SOL_MINT).catch(() => null);
        return lamportsToUsd(tipLamports, solPriceUsd);
    }
    /**
     * Resolves one pending bundle (checklist S3-4).
     *
     * Returns `null` when the outcome still cannot be observed — deliberately
     * distinct from a `failed` resolution. Treating an unreachable block engine as
     * failure would let the executor conclude a live bundle died and re-enter the
     * position, double-spending it.
     */
    async function reconcile(pending, currentBlockHeight) {
        const status = await getJitoBundleStatus(pending.bundleId, options.jito);
        if (!status)
            return null;
        if (status.status === 'Landed') {
            const signature = status.transactions[0];
            if (!signature) {
                // Landed without an observable signature is not a fill we can quantify.
                // Never fabricate one — the position ledger would be permanently wrong.
                return {
                    status: 'ambiguous',
                    clientOrderId: pending.clientOrderId,
                    reason: 'landed-without-signature'
                };
            }
            // The one branch that books a cost. Everything below either never paid a
            // tip (atomic bundle, never landed) or cannot be observed to have paid one.
            const tipLamports = pending.tipLamports ?? null;
            return {
                status: 'filled',
                clientOrderId: pending.clientOrderId,
                signature,
                slot: status.slot,
                tipLamports,
                feeUsd: await priceLandedTip(tipLamports)
            };
        }
        if (status.status === 'Failed') {
            return { status: 'failed', clientOrderId: pending.clientOrderId, reason: 'bundle-failed' };
        }
        // `Invalid` means the block engine has never seen this id. Combined with an
        // expired blockhash that is a definitive miss; on its own it may just be
        // propagation lag, so it is not resolved here.
        if (typeof currentBlockHeight === 'number' &&
            currentBlockHeight > pending.lastValidBlockHeight) {
            // Past `lastValidBlockHeight` the transaction can never land. This is the
            // only safe point to declare a miss, and it is why resubmission requires a
            // FRESH quote and build — the expired blockhash makes the old transaction
            // permanently unusable, so a blind retry would submit something that
            // cannot execute.
            return {
                status: 'failed',
                clientOrderId: pending.clientOrderId,
                reason: 'blockhash-expired'
            };
        }
        if (now() >= pending.expiresAt) {
            return {
                status: 'ambiguous',
                clientOrderId: pending.clientOrderId,
                reason: 'confirmation-timeout'
            };
        }
        return null;
    }
    async function sweep(currentBlockHeight) {
        const pendings = await options.pendingStore.listPending();
        const resolutions = [];
        for (const pending of pendings) {
            const resolution = await reconcile(pending, currentBlockHeight);
            if (resolution) {
                await options.pendingStore.resolve(pending.clientOrderId, resolution);
                resolutions.push(resolution);
            }
        }
        return resolutions;
    }
    return { submit, reconcile, sweep };
}
//# sourceMappingURL=jupiter-jito-runtime.js.map