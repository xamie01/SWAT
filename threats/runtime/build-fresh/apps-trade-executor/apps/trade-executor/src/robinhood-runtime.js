import { fetchDexScreenerLiquidity } from '@swat/shared';
import { decodeRuntimeValue, encodeRuntimeValue } from './runtime-codec.js';
const DEFAULT_STORE_KEY = 'swat:trade-executor:pending:robinhood:v1';
function decodeStoredRobinhoodState(encoded) {
    const stored = decodeRuntimeValue(encoded);
    if (stored.state === 'pending') {
        return {
            state: 'pending',
            pending: {
                ...stored.pending,
                feeTier: stored.pending.feeTier ?? null
            }
        };
    }
    if (stored.resolution.status === 'filled') {
        return {
            state: 'resolved',
            resolution: {
                ...stored.resolution,
                feeTier: stored.resolution.feeTier ?? null
            }
        };
    }
    return { state: 'resolved', resolution: stored.resolution };
}
export function createRedisRobinhoodPendingStore(redis, key = DEFAULT_STORE_KEY) {
    async function read(clientOrderId) {
        const encoded = await redis.hget(key, clientOrderId);
        return encoded ? decodeStoredRobinhoodState(encoded) : null;
    }
    return {
        async findUnresolved(clientOrderId) {
            const stored = await read(clientOrderId);
            return stored?.state === 'pending' ? stored.pending : null;
        },
        async findResolution(clientOrderId) {
            const stored = await read(clientOrderId);
            return stored?.state === 'resolved' ? stored.resolution : null;
        },
        async listUnresolved() {
            const values = await redis.hgetall(key);
            return Object.values(values).flatMap((encoded) => {
                const stored = decodeStoredRobinhoodState(encoded);
                return stored.state === 'pending' ? [stored.pending] : [];
            });
        },
        async save(record) {
            await redis.hset(key, record.clientOrderId, encodeRuntimeValue({
                state: 'pending',
                pending: record
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
export function createRobinhoodSafetyAssessment(options) {
    if (!Number.isFinite(options.minimumLiquidityUsd) || options.minimumLiquidityUsd <= 0) {
        throw new Error('Robinhood minimum liquidity must be positive');
    }
    const liquidityLookup = options.liquidityLookup
        ?? ((token) => fetchDexScreenerLiquidity(token, 'robinhood-chain'));
    const maximumTransferFeeBps = options.maxTransferFeeBps ?? 0;
    if (!Number.isInteger(maximumTransferFeeBps) || maximumTransferFeeBps < 0) {
        throw new Error('Robinhood maximum transfer fee must be a non-negative integer');
    }
    // A single holder above this share can move the price against any exit.
    const maximumHolderShare = 0.5;
    return async (context) => {
        let sellSimulation;
        try {
            const reverseAmount = context.order.direction === 'sell'
                ? context.route.amountOut
                : await options.quote(context.tokenOut, context.tokenIn, context.route.amountOut, context.route.fee);
            sellSimulation = reverseAmount > 0n
                ? {
                    name: 'sell_simulation',
                    status: 'pass',
                    reliable: true,
                    evidence: context.order.direction === 'sell'
                        ? `sell route returned ${reverseAmount.toString()} base units`
                        : `reverse route returned ${reverseAmount.toString()} base units`
                }
                : {
                    name: 'sell_simulation',
                    status: 'fail',
                    reliable: true,
                    evidence: 'reverse route returned zero output'
                };
        }
        catch (error) {
            sellSimulation = {
                name: 'sell_simulation',
                status: 'unknown',
                reliable: false,
                evidence: error instanceof Error ? error.message : 'reverse route lookup failed'
            };
        }
        const liquidityUsd = await liquidityLookup(context.order.token).catch(() => null);
        const liquidity = liquidityUsd === null
            ? {
                name: 'liquidity',
                status: 'unknown',
                reliable: false,
                evidence: 'liquidity provider returned no chain-matched evidence'
            }
            : liquidityUsd >= options.minimumLiquidityUsd
                ? {
                    name: 'liquidity',
                    status: 'pass',
                    reliable: true,
                    evidence: `$${liquidityUsd.toFixed(2)} >= $${options.minimumLiquidityUsd.toFixed(2)}`
                }
                : {
                    name: 'liquidity',
                    status: 'fail',
                    reliable: true,
                    evidence: `$${liquidityUsd.toFixed(2)} < $${options.minimumLiquidityUsd.toFixed(2)}`
                };
        let ownership = {
            name: 'ownership_admin',
            status: 'unknown',
            reliable: false,
            evidence: 'owner() evidence is unavailable for this contract'
        };
        if (options.readOwner) {
            try {
                const owner = await options.readOwner(context.order.token);
                if (owner) {
                    const renounced = /^0x0{40}$/i.test(owner);
                    ownership = {
                        name: 'ownership_admin',
                        status: renounced ? 'pass' : 'fail',
                        reliable: true,
                        evidence: renounced ? 'owner() is the zero address' : `owner() is ${owner}`
                    };
                }
            }
            catch (error) {
                ownership = {
                    name: 'ownership_admin',
                    status: 'unknown',
                    reliable: false,
                    evidence: error instanceof Error ? error.message : 'owner() lookup failed'
                };
            }
        }
        let sourceVerification = {
            name: 'source_verification',
            status: 'unknown',
            reliable: false,
            evidence: 'no reviewed Robinhood explorer source-verification provider is configured'
        };
        if (options.verifySource) {
            try {
                const verified = await options.verifySource(context.order.token);
                if (verified !== null) {
                    sourceVerification = {
                        name: 'source_verification',
                        status: verified ? 'pass' : 'fail',
                        reliable: true,
                        evidence: verified ? 'contract source is verified' : 'contract source is unverified'
                    };
                }
            }
            catch (error) {
                sourceVerification = {
                    name: 'source_verification',
                    status: 'unknown',
                    reliable: false,
                    evidence: error instanceof Error ? error.message : 'source verification lookup failed'
                };
            }
        }
        let holderConcentration = {
            name: 'holder_concentration',
            status: 'unknown',
            reliable: false,
            evidence: 'no reviewed Robinhood holder-distribution provider is configured'
        };
        if (options.readHolderConcentration) {
            try {
                const topShare = await options.readHolderConcentration(context.order.token);
                if (topShare !== null) {
                    if (!Number.isFinite(topShare) || topShare < 0 || topShare > 1) {
                        holderConcentration = {
                            name: 'holder_concentration',
                            status: 'unknown',
                            reliable: false,
                            evidence: `holder concentration provider returned an out-of-range share: ${topShare}`
                        };
                    }
                    else {
                        const concentrated = topShare > maximumHolderShare;
                        holderConcentration = {
                            name: 'holder_concentration',
                            status: concentrated ? 'fail' : 'pass',
                            reliable: true,
                            evidence: `largest non-pool holder controls ${(topShare * 100).toFixed(2)}% of supply`
                        };
                    }
                }
            }
            catch (error) {
                holderConcentration = {
                    name: 'holder_concentration',
                    status: 'unknown',
                    reliable: false,
                    evidence: error instanceof Error ? error.message : 'holder distribution lookup failed'
                };
            }
        }
        let feeOnTransfer = {
            name: 'fee_on_transfer',
            status: 'unknown',
            reliable: false,
            evidence: 'no transfer-tax probe is configured'
        };
        if (options.probeFeeOnTransfer) {
            try {
                const feeBps = await options.probeFeeOnTransfer(context.order.token);
                if (feeBps !== null) {
                    if (!Number.isFinite(feeBps) || feeBps < 0) {
                        feeOnTransfer = {
                            name: 'fee_on_transfer',
                            status: 'unknown',
                            reliable: false,
                            evidence: `transfer-tax probe returned an invalid rate: ${feeBps}`
                        };
                    }
                    else {
                        const taxed = feeBps > maximumTransferFeeBps;
                        feeOnTransfer = {
                            name: 'fee_on_transfer',
                            status: taxed ? 'fail' : 'pass',
                            reliable: true,
                            // V3's exactInputSingle credits the pool less than it was sent,
                            // so a taxed token cannot be exited through this router at all.
                            evidence: taxed
                                ? `token charges ${feeBps} bps on transfer; Uniswap V3 cannot route fee-on-transfer tokens`
                                : 'token transfers untaxed'
                        };
                    }
                }
            }
            catch (error) {
                feeOnTransfer = {
                    name: 'fee_on_transfer',
                    status: 'unknown',
                    reliable: false,
                    evidence: error instanceof Error ? error.message : 'transfer-tax probe failed'
                };
            }
        }
        return {
            checks: [
                sellSimulation,
                liquidity,
                ownership,
                sourceVerification,
                holderConcentration,
                feeOnTransfer
            ]
        };
    };
}
//# sourceMappingURL=robinhood-runtime.js.map