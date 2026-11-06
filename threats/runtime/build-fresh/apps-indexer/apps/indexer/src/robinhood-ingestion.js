import { decodeEventLog, getAddress, parseAbiItem } from 'viem';
const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const swapEvent = parseAbiItem('event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)');
function normalizeAddress(value, label) {
    try {
        return getAddress(value).toLowerCase();
    }
    catch {
        throw new Error(`${label} must be a valid EVM address`);
    }
}
export function parseRobinhoodIngestionConfig(values = process.env) {
    const routerValue = values.ROBINHOOD_INGESTION_ROUTERS ?? values.ROBINHOOD_SWAP_ROUTER;
    const baseAssetValue = values.ROBINHOOD_BASE_ASSET;
    const poolsValue = values.ROBINHOOD_REVIEWED_POOLS_JSON;
    if (!routerValue)
        throw new Error('ROBINHOOD_INGESTION_ROUTERS is required');
    if (!baseAssetValue)
        throw new Error('ROBINHOOD_BASE_ASSET is required');
    if (!poolsValue)
        throw new Error('ROBINHOOD_REVIEWED_POOLS_JSON is required');
    const routers = new Set(routerValue.split(',').map((value) => normalizeAddress(value.trim(), 'Robinhood router')));
    if (routers.size === 0)
        throw new Error('At least one Robinhood router is required');
    let decoded;
    try {
        decoded = JSON.parse(poolsValue);
    }
    catch {
        throw new Error('ROBINHOOD_REVIEWED_POOLS_JSON must be valid JSON');
    }
    if (!Array.isArray(decoded) || decoded.length === 0) {
        throw new Error('ROBINHOOD_REVIEWED_POOLS_JSON must contain a non-empty array');
    }
    const pools = new Map();
    for (const [index, item] of decoded.entries()) {
        if (!item || typeof item !== 'object') {
            throw new Error(`Robinhood reviewed pool ${index} must be an object`);
        }
        const candidate = item;
        if (!candidate.address || !candidate.token0 || !candidate.token1) {
            throw new Error(`Robinhood reviewed pool ${index} is incomplete`);
        }
        const address = normalizeAddress(candidate.address, `Robinhood pool ${index} address`);
        const token0 = normalizeAddress(candidate.token0, `Robinhood pool ${index} token0`);
        const token1 = normalizeAddress(candidate.token1, `Robinhood pool ${index} token1`);
        if (token0 === token1)
            throw new Error(`Robinhood reviewed pool ${index} has identical tokens`);
        if (pools.has(address))
            throw new Error(`Duplicate Robinhood reviewed pool ${address}`);
        pools.set(address, { token0, token1 });
    }
    return {
        routers,
        baseAsset: normalizeAddress(baseAssetValue, 'ROBINHOOD_BASE_ASSET'),
        pools
    };
}
function logIdentity(log) {
    return [
        log.transactionHash ?? '',
        log.logIndex ?? '',
        log.address.toLowerCase(),
        log.data,
        ...log.topics
    ].join(':');
}
function decodeErc20Transfer(log) {
    // ERC-721 Transfer has four topics and no uint256 data. Only the ERC-20 shape is accepted.
    if (log.topics.length !== 3 || !/^0x[0-9a-fA-F]{64}$/.test(log.data))
        return null;
    try {
        const decoded = decodeEventLog({
            abi: [transferEvent],
            data: log.data,
            topics: log.topics
        });
        const args = decoded.args;
        return {
            token: normalizeAddress(log.address, 'Transfer token'),
            from: normalizeAddress(args.from, 'Transfer from'),
            to: normalizeAddress(args.to, 'Transfer to'),
            amount: args.value
        };
    }
    catch {
        return null;
    }
}
export function classifyRobinhoodReceipt(receipt, walletValue, config) {
    if (receipt.status !== 'success')
        return { status: 'rejected', reason: 'reverted_receipt' };
    const wallet = normalizeAddress(walletValue, 'Robinhood wallet');
    if (normalizeAddress(receipt.from, 'Receipt sender') !== wallet) {
        return { status: 'rejected', reason: 'wallet_not_sender' };
    }
    if (!receipt.to || !config.routers.has(normalizeAddress(receipt.to, 'Receipt target'))) {
        return { status: 'rejected', reason: 'unreviewed_router' };
    }
    const uniqueLogs = new Map();
    for (const log of receipt.logs)
        uniqueLogs.set(logIdentity(log), log);
    const tokenDeltas = new Map();
    const poolAddresses = new Set();
    for (const log of uniqueLogs.values()) {
        const poolAddress = normalizeAddress(log.address, 'Receipt log address');
        const pool = config.pools.get(poolAddress);
        if (!pool)
            continue;
        try {
            const decoded = decodeEventLog({
                abi: [swapEvent],
                data: log.data,
                topics: log.topics
            });
            const args = decoded.args;
            tokenDeltas.set(pool.token0, (tokenDeltas.get(pool.token0) ?? 0n) + args.amount0);
            tokenDeltas.set(pool.token1, (tokenDeltas.get(pool.token1) ?? 0n) + args.amount1);
            poolAddresses.add(poolAddress);
        }
        catch {
            // A log from a reviewed pool is not sufficient unless it decodes as the reviewed Swap ABI.
        }
    }
    if (poolAddresses.size === 0) {
        return { status: 'rejected', reason: 'no_reviewed_pool_swap' };
    }
    const baseDelta = tokenDeltas.get(config.baseAsset) ?? 0n;
    const nonBase = [...tokenDeltas.entries()].filter(([token, amount]) => token !== config.baseAsset && amount !== 0n);
    if (baseDelta === 0n || nonBase.length !== 1) {
        return { status: 'rejected', reason: 'ambiguous_route' };
    }
    const [targetToken, targetDelta] = nonBase[0];
    const isBuy = baseDelta > 0n && targetDelta < 0n;
    const isSell = baseDelta < 0n && targetDelta > 0n;
    if (!isBuy && !isSell)
        return { status: 'rejected', reason: 'ambiguous_route' };
    const transfers = [...uniqueLogs.values()]
        .map(decodeErc20Transfer)
        .filter((transfer) => transfer !== null)
        .filter((transfer) => transfer.from !== transfer.to);
    const hasWalletTargetTransfer = transfers.some((transfer) => transfer.token === targetToken && transfer.amount > 0n && (isBuy ? transfer.to === wallet : transfer.from === wallet));
    if (!hasWalletTargetTransfer) {
        return { status: 'rejected', reason: 'missing_wallet_transfer' };
    }
    return isBuy
        ? {
            status: 'classified',
            direction: 'buy',
            tokenIn: config.baseAsset,
            tokenOut: targetToken,
            targetToken,
            amountIn: baseDelta,
            amountOut: -targetDelta,
            poolAddresses: [...poolAddresses]
        }
        : {
            status: 'classified',
            direction: 'sell',
            tokenIn: targetToken,
            tokenOut: config.baseAsset,
            targetToken,
            amountIn: targetDelta,
            amountOut: -baseDelta,
            poolAddresses: [...poolAddresses]
        };
}
export function measureRobinhoodFixtures(fixtures, config) {
    const reviewed = fixtures.filter((fixture) => fixture.reviewed);
    let expectedSwaps = 0;
    let inserted = 0;
    let skipped = 0;
    let falsePositives = 0;
    let directionSamples = 0;
    let correctDirections = 0;
    for (const fixture of reviewed) {
        const result = classifyRobinhoodReceipt(fixture.receipt, fixture.wallet, config);
        if (fixture.expected === 'classify') {
            expectedSwaps++;
            if (result.status === 'classified')
                inserted++;
            else
                skipped++;
            if (fixture.expectedDirection) {
                directionSamples++;
                if (result.status === 'classified' && result.direction === fixture.expectedDirection) {
                    correctDirections++;
                }
            }
        }
        else if (result.status === 'classified') {
            falsePositives++;
        }
    }
    return {
        totalFixtures: fixtures.length,
        reviewedFixtures: reviewed.length,
        expectedSwaps,
        inserted,
        skipped,
        falsePositives,
        completeness: expectedSwaps > 0 ? inserted / expectedSwaps : null,
        directionSamples,
        correctDirections,
        directionAccuracy: directionSamples > 0 ? correctDirections / directionSamples : null
    };
}
export function evaluateRobinhoodFixtureGate(metrics) {
    const reasons = [];
    if (metrics.reviewedFixtures === 0)
        reasons.push('reviewed fixture set is empty');
    if (metrics.expectedSwaps === 0)
        reasons.push('reviewed fixture set has no expected swaps');
    if (metrics.directionSamples === 0)
        reasons.push('reviewed fixture set has no direction samples');
    if (metrics.falsePositives > 0)
        reasons.push('reviewed fixture set produced false positives');
    if (metrics.completeness === null || metrics.completeness <= 0.9) {
        reasons.push('measured completeness is not greater than 90%');
    }
    if (metrics.directionAccuracy === null || metrics.directionAccuracy <= 0.95) {
        reasons.push('measured direction accuracy is not greater than 95%');
    }
    return { passed: reasons.length === 0, reasons };
}
//# sourceMappingURL=robinhood-ingestion.js.map