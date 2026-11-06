import { resolveChainAddress } from '@swat/shared';
import { createTrojanAdapter, createTrojanWebhookTransport, prepareTrojanOrder, reconcileTrojanSubmission } from './trojan.js';
import { decodeRuntimeValue, encodeRuntimeValue } from './runtime-codec.js';
const DEFAULT_STORE_KEY = 'swat:trade-executor:pending:trojan:v1';
export function createRedisTrojanPendingStore(redis, key = DEFAULT_STORE_KEY) {
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
            await redis.hset(key, pending.submission.clientOrderId, encodeRuntimeValue({
                state: 'pending',
                pending
            }));
        },
        async resolve(clientOrderId, resolution) {
            await redis.hset(key, clientOrderId, encodeRuntimeValue({
                state: 'resolved',
                resolution
            }));
        }
    };
}
export function createTrojanRuntime(options) {
    if (!Number.isInteger(options.pendingTtlMs) || options.pendingTtlMs < 60_000) {
        throw new Error('Trojan pending TTL must be at least 60 seconds');
    }
    const now = options.now ?? (() => new Date());
    return {
        /**
         * Probe one signature directly, bypassing the pending store.
         *
         * The canonical reconciliation coordinator needs this: it handles executions
         * whose pending-store entry is already gone, so `reconcile()` below — which
         * iterates that store — structurally cannot see them.
         */
        readConfirmation: options.readConfirmation,
        async submit(input) {
            const existing = await options.pendingStore.findPending(input.signalId);
            if (existing)
                return existing.submission;
            const resolution = await options.pendingStore.findResolution(input.signalId);
            if (resolution) {
                return { status: 'already_resolved', clientOrderId: input.signalId, resolution };
            }
            const beforeBalance = await options.readBalance(input.tokenMint);
            const order = input.direction === 'buy'
                ? {
                    side: 'buy',
                    signalId: input.signalId,
                    tokenMint: input.tokenMint,
                    amountLamports: input.amountLamports ?? '',
                    slippageBps: input.slippageBps,
                    beforeBalance
                }
                : {
                    side: 'sell',
                    signalId: input.signalId,
                    tokenMint: input.tokenMint,
                    sellProportionBps: input.sellProportionBps ?? 10_000,
                    maximumTokenAmountBaseUnits: input.maximumTokenAmountBaseUnits,
                    slippageBps: input.slippageBps,
                    beforeBalance
                };
            const prepared = prepareTrojanOrder(order);
            const startedAt = now();
            const expiresAt = new Date(startedAt.getTime() + options.pendingTtlMs);
            // Persist an ambiguous intent before the network call. A process crash can
            // therefore never turn an unknown submission into an automatic resubmit.
            await options.pendingStore.save({
                submission: {
                    status: 'submission_unknown',
                    clientOrderId: prepared.clientOrderId,
                    reason: 'transport-error',
                    order: prepared,
                    firstAttemptAt: startedAt,
                    lastAttemptAt: startedAt,
                    attempts: 0
                },
                expiresAt
            });
            const submission = await options.adapter.submit(order);
            if (submission.status === 'rejected') {
                await options.pendingStore.resolve(submission.clientOrderId, {
                    status: 'rejected',
                    clientOrderId: submission.clientOrderId,
                    httpStatus: submission.httpStatus
                });
                return submission;
            }
            await options.pendingStore.save({ submission, expiresAt });
            return submission;
        },
        async reconcile(nowAt = now()) {
            if (!options.readConfirmation) {
                throw new Error('Trojan confirmation reader is not configured');
            }
            return reconcileTrojanPending({
                pendingStore: options.pendingStore,
                readConfirmation: options.readConfirmation,
                readBalance: options.readBalance,
                now: nowAt
            });
        }
    };
}
export async function reconcileTrojanPending(input) {
    const now = input.now ?? new Date();
    const results = [];
    for (const pending of await input.pendingStore.listPending()) {
        const submission = pending.submission;
        if (submission.status === 'submission_unknown') {
            if (now >= pending.expiresAt) {
                const result = {
                    status: 'ambiguous',
                    clientOrderId: submission.clientOrderId,
                    reason: 'submission identity remained unknown until the reconciliation deadline'
                };
                await input.pendingStore.resolve(submission.clientOrderId, result);
                results.push(result);
            }
            else {
                results.push({ status: 'submission_unknown', clientOrderId: submission.clientOrderId });
            }
            continue;
        }
        let confirmation;
        try {
            confirmation = await input.readConfirmation(submission.transactionIdentity);
        }
        catch {
            results.push({
                status: 'pending_confirmation',
                transactionIdentity: submission.transactionIdentity
            });
            continue;
        }
        if (confirmation.status === 'not-found' && now >= pending.expiresAt) {
            const result = {
                status: 'ambiguous',
                clientOrderId: submission.clientOrderId,
                reason: 'transaction identity was not found before the reconciliation deadline'
            };
            await input.pendingStore.resolve(submission.clientOrderId, result);
            results.push(result);
            continue;
        }
        let afterBalance;
        if (confirmation.status === 'confirmed') {
            try {
                afterBalance = await input.readBalance(submission.order.tokenMint);
            }
            catch {
                results.push({
                    status: 'pending_reconciliation',
                    transactionIdentity: submission.transactionIdentity
                });
                continue;
            }
        }
        const result = reconcileTrojanSubmission({ submission, confirmation, afterBalance });
        results.push(result);
        if (result.status === 'filled' || result.status === 'failed' || result.status === 'inconsistent') {
            await input.pendingStore.resolve(submission.clientOrderId, result);
        }
    }
    return results;
}
async function rpcRequest(options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
        const response = await options.fetchImpl(options.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({ jsonrpc: '2.0', id: `swat-${options.method}`, method: options.method, params: options.params })
        });
        if (!response.ok)
            throw new Error(`Helius RPC ${options.method} returned HTTP ${response.status}`);
        const body = await response.json();
        if (body.error || body.result === undefined) {
            throw new Error(`Helius RPC ${options.method} failed: ${String(body.error?.message ?? 'missing result')}`);
        }
        return body.result;
    }
    finally {
        clearTimeout(timer);
    }
}
export function createHeliusTrojanRuntimeClient(options) {
    const walletAddress = resolveChainAddress(options.walletAddress, 'solana').raw;
    if (!options.apiKey)
        throw new Error('HELIUS_API_KEY is required for Trojan reconciliation');
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
        throw new Error('Helius runtime timeout must be a positive integer');
    }
    const url = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(options.apiKey)}`;
    const fetchImpl = options.fetchImpl ?? fetch;
    const now = options.now ?? (() => new Date());
    return {
        async readBalance(tokenMint) {
            const [native, tokens] = await Promise.all([
                rpcRequest({
                    url,
                    method: 'getBalance',
                    params: [walletAddress, { commitment: 'confirmed' }],
                    timeoutMs: options.timeoutMs,
                    fetchImpl
                }),
                rpcRequest({
                    url,
                    method: 'getTokenAccountsByOwner',
                    params: [walletAddress, { mint: tokenMint }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
                    timeoutMs: options.timeoutMs,
                    fetchImpl
                })
            ]);
            if (typeof native.value !== 'number' || !Number.isSafeInteger(native.value) || native.value < 0) {
                throw new Error('Helius returned an invalid native lamport balance');
            }
            if (!Array.isArray(tokens.value))
                throw new Error('Helius returned invalid token accounts');
            let tokenBaseUnits = 0n;
            for (const account of tokens.value) {
                const amount = account.account?.data?.parsed?.info?.tokenAmount?.amount;
                if (typeof amount !== 'string' || !/^\d+$/.test(amount)) {
                    throw new Error('Helius returned an invalid token account balance');
                }
                tokenBaseUnits += BigInt(amount);
            }
            return {
                walletAddress,
                tokenMint,
                nativeLamports: native.value.toString(),
                tokenBaseUnits: tokenBaseUnits.toString(),
                observedAt: now(),
                slot: Math.max(native.context?.slot ?? 0, tokens.context?.slot ?? 0) || undefined
            };
        },
        async readConfirmation(transactionIdentity) {
            const result = await rpcRequest({
                url,
                method: 'getSignatureStatuses',
                params: [[transactionIdentity], { searchTransactionHistory: true }],
                timeoutMs: options.timeoutMs,
                fetchImpl
            });
            if (!Array.isArray(result.value) || result.value.length !== 1) {
                throw new Error('Helius returned invalid signature status evidence');
            }
            const status = result.value[0];
            const observedAt = now();
            if (!status || (status.confirmationStatus !== 'confirmed' && status.confirmationStatus !== 'finalized')) {
                return { transactionIdentity, status: 'not-found', observedAt };
            }
            return {
                transactionIdentity,
                status: status.err === null || status.err === undefined ? 'confirmed' : 'failed',
                observedAt,
                ...(typeof status.slot === 'number' && Number.isSafeInteger(status.slot) ? { slot: status.slot } : {})
            };
        }
    };
}
export function createSwatTrojanWebhookCodec() {
    return {
        encode(order) {
            const common = {
                action: order.side,
                token: order.tokenMint,
                slippage_bps: order.slippageBps,
                mev_protection: true,
                source: 'SWAT_ENGINE',
                signal_id: order.signalId,
                client_order_id: order.clientOrderId,
                wallet_address: order.beforeBalance.walletAddress
            };
            return order.side === 'buy'
                ? { ...common, amount_lamports: order.amountLamports }
                : {
                    ...common,
                    token_amount_base_units: order.tokenAmountBaseUnits,
                    sell_proportion_bps: order.sellProportionBps
                };
        },
        decode(body) {
            const value = body;
            const identity = value?.transactionIdentity ?? value?.signature;
            if (typeof identity !== 'string' || identity.length === 0) {
                return { transactionIdentity: '' };
            }
            return { transactionIdentity: identity };
        }
    };
}
let configuredRuntime = null;
let runtimeReadiness = { ready: false, reason: 'runtime_not_configured' };
export function configureTrojanRuntime(runtime) {
    configuredRuntime = runtime;
    runtimeReadiness = { ready: true, reason: 'runtime_configured' };
}
export function setTrojanRuntimeUnavailable(reason) {
    configuredRuntime = null;
    runtimeReadiness = { ready: false, reason };
}
export function getTrojanLiveReadiness() {
    return { ...runtimeReadiness };
}
export function getConfiguredTrojanRuntime() {
    return configuredRuntime;
}
export function createTrojanRuntimeFromEnvironment(redis) {
    const url = process.env.TROJAN_WEBHOOK_URL?.trim();
    const walletAddress = process.env.TROJAN_WALLET_ADDRESS?.trim();
    const apiKey = process.env.HELIUS_API_KEY?.trim();
    if (!url)
        throw new Error('TROJAN_WEBHOOK_URL is required for Solana live execution');
    if (!walletAddress)
        throw new Error('TROJAN_WALLET_ADDRESS is required for Solana live execution');
    if (!apiKey)
        throw new Error('HELIUS_API_KEY is required for Solana live execution');
    const timeoutMs = Number(process.env.TROJAN_TIMEOUT_MS ?? 15_000);
    const rpcTimeoutMs = Number(process.env.HELIUS_RPC_TIMEOUT_MS ?? 15_000);
    const pendingTtlMs = Number(process.env.TROJAN_PENDING_TTL_MS ?? 600_000);
    const maxAttempts = Number(process.env.TROJAN_MAX_ATTEMPTS ?? 1);
    const rpc = createHeliusTrojanRuntimeClient({ walletAddress, apiKey, timeoutMs: rpcTimeoutMs });
    const adapter = createTrojanAdapter(createTrojanWebhookTransport({
        url,
        apiKey: process.env.TROJAN_API_KEY,
        codec: createSwatTrojanWebhookCodec()
    }), {
        timeoutMs,
        maxAttempts,
        retryDelayMs: Number(process.env.TROJAN_RETRY_DELAY_MS ?? 0)
    });
    return createTrojanRuntime({
        adapter,
        pendingStore: createRedisTrojanPendingStore(redis),
        readBalance: rpc.readBalance,
        readConfirmation: rpc.readConfirmation,
        pendingTtlMs
    });
}
export async function triggerTrojan(params) {
    if (!configuredRuntime)
        throw new Error(`Trojan live runtime is unavailable: ${runtimeReadiness.reason}`);
    const direction = params.direction ?? 'buy';
    const amountLamports = Math.round(params.amountSol * 1_000_000_000);
    if (direction === 'buy' && (!Number.isSafeInteger(amountLamports) || amountLamports <= 0)) {
        throw new Error('Trojan BUY amount must resolve to positive safe lamports');
    }
    return configuredRuntime.submit({
        signalId: params.signalId,
        tokenMint: params.tokenMint,
        direction,
        ...(direction === 'buy' ? { amountLamports: amountLamports.toString() } : {}),
        sellProportionBps: params.sellProportionBps,
        maximumTokenAmountBaseUnits: params.maximumTokenAmountBaseUnits,
        slippageBps: params.slippageBps ?? 1500
    });
}
//# sourceMappingURL=trojan-runtime.js.map