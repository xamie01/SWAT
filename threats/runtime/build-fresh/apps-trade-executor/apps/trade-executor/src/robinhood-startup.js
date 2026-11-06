import { resolveChainMode } from '@swat/db';
import { discoverRobinhoodRoute, getRobinhoodLiveReadiness, parseRobinhoodExecutionConfig, QUOTER_ABI, robinhoodPublicClient, setRobinhoodLiveReadiness } from './robinhood.js';
let opsAlertEmitter = null;
let lastOpsAlert = null;
export function configureRobinhoodOpsAlertEmitter(emitter) {
    opsAlertEmitter = emitter;
}
export function getLastRobinhoodOpsAlert() {
    return lastOpsAlert ? { ...lastOpsAlert } : null;
}
async function quoteSanityRoute(client, config) {
    return discoverRobinhoodRoute({
        config,
        tokenIn: config.baseAsset,
        tokenOut: config.sanityToken,
        amountIn: 100000000000000n,
        quote: async (tokenIn, tokenOut, amountIn, fee) => {
            const { result } = await client.simulateContract({
                address: config.quoter,
                abi: QUOTER_ABI,
                functionName: 'quoteExactInputSingle',
                args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }]
            });
            return result[0];
        }
    });
}
export async function verifyRobinhoodEnvironment(options = {}) {
    const resolveMode = options.resolveMode ?? resolveChainMode;
    const mode = await resolveMode('robinhood-chain');
    if (mode.requestedMode !== 'live' && mode.requestedMode !== 'live+shadow') {
        lastOpsAlert = null;
        const state = {
            ready: false,
            reason: 'live_execution_not_requested',
            checkedAt: new Date()
        };
        setRobinhoodLiveReadiness(state);
        return getRobinhoodLiveReadiness();
    }
    const checkedAt = new Date();
    try {
        const config = parseRobinhoodExecutionConfig(options.values);
        await options.runtimeCheck?.();
        const client = options.client ?? robinhoodPublicClient;
        const actualChainId = await client.getChainId();
        if (actualChainId !== config.chainId) {
            throw new Error(`configured chain ID ${config.chainId} does not match RPC chain ID ${actualChainId}`);
        }
        const contracts = new Map([
            ['router', config.router],
            ['quoter', config.quoter],
            ['WETH9', config.weth9],
            ['base asset', config.baseAsset],
            ['sanity token', config.sanityToken]
        ]);
        for (const [label, contract] of contracts) {
            const code = await client.getBytecode({ address: contract });
            if (!code || code === '0x')
                throw new Error(`no deployed bytecode at configured ${label}`);
        }
        const sanity = await quoteSanityRoute(client, config);
        if (sanity.status !== 'route') {
            throw new Error(`known-liquid sanity quote failed across configured tiers: ${sanity.failures.join('; ')}`);
        }
        const tuple = {
            chainId: config.chainId,
            router: config.router,
            quoter: config.quoter,
            weth9: config.weth9,
            baseAsset: config.baseAsset,
            sanityToken: config.sanityToken,
            feeTiers: [...config.feeTiers],
            routerAbiVersion: config.routerAbiVersion,
            quoterAbiVersion: config.quoterAbiVersion
        };
        const state = {
            ready: true,
            reason: 'onchain_environment_verified_for_process',
            checkedAt,
            tuple
        };
        setRobinhoodLiveReadiness(state);
        lastOpsAlert = null;
        console.log('[trade-executor] Robinhood on-chain tuple verified', tuple);
        return getRobinhoodLiveReadiness();
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown Robinhood startup verification failure';
        const state = { ready: false, reason, checkedAt };
        setRobinhoodLiveReadiness(state);
        const alert = {
            type: 'ROBINHOOD_LIVE_NOT_READY',
            chain: 'robinhood-chain',
            severity: 'critical',
            reason,
            checkedAt: checkedAt.toISOString(),
            requestedMode: mode.requestedMode
        };
        lastOpsAlert = alert;
        const emit = options.emitOpsAlert ?? opsAlertEmitter;
        if (emit) {
            try {
                await emit(alert);
            }
            catch (alertError) {
                console.error('[trade-executor] Robinhood readiness ops alert delivery failed', alertError);
            }
        }
        console.error('[trade-executor] Robinhood live readiness clamped', { reason, checkedAt: alert.checkedAt });
        return getRobinhoodLiveReadiness();
    }
}
//# sourceMappingURL=robinhood-startup.js.map