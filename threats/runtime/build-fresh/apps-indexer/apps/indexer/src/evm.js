import { createPublicClient, erc20Abi, http, parseAbiItem } from 'viem';
import { polygon } from 'viem/chains';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { query, upsertToken, upsertWallet, insertParsedTransaction, updateTokenLaunchTimestamp, refreshWalletActivity, logDiscoveryRun } from '@swat/db';
import { prefixChainValue, REDIS_CHANNELS, QUEUES, createWalletBackfillJob, resolveChainValue, fetchTokenPriceUsd } from '@swat/shared';
import { IngestionBatchError } from './ingestion-health.js';
import { classifyRobinhoodReceipt, parseRobinhoodIngestionConfig } from './robinhood-ingestion.js';
import { persistRobinhoodSourceTrade, SourceTradePersistenceError } from './source-trade-lifecycle.js';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';
const BASE_TOKENS = {
    polygon: new Set([
        '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270'.toLowerCase(), // WMATIC
        '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'.toLowerCase(), // USDC (native)
        '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'.toLowerCase(), // USDC (bridged)
        '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'.toLowerCase(), // USDT
        '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619'.toLowerCase(), // WETH
    ]),
    'robinhood-chain': new Set()
};
function getBaseTokens(chain) {
    const set = new Set(BASE_TOKENS[chain] ?? []);
    if (chain === 'robinhood-chain' && process.env.ROBINHOOD_BASE_ASSET) {
        set.add(process.env.ROBINHOOD_BASE_ASSET.toLowerCase());
    }
    return set;
}
function isBaseToken(address, _symbol, chain) {
    const addr = address.toLowerCase();
    // H-18: Verify base-asset identity strictly by contract address, never spoofable symbol
    return getBaseTokens(chain).has(addr);
}
// Instantiate clients
function getPublicClient(chain) {
    if (chain === 'polygon') {
        const url = process.env.POLYGON_RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com';
        return createPublicClient({ chain: polygon, transport: http(url) });
    }
    else if (chain === 'robinhood-chain') {
        const url = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
        // The chain ID is a deployment fact verified by the executor startup gate. The
        // indexer intentionally does not embed an unreviewed chain definition.
        return createPublicClient({ transport: http(url) });
    }
    throw new Error(`Unsupported chain: ${chain}`);
}
async function fetchEvmTokenMetadata(client, tokenAddress, chain) {
    try {
        const [decimals, name, symbol] = await Promise.all([
            client.readContract({
                address: tokenAddress,
                abi: erc20Abi,
                functionName: 'decimals'
            }).catch(() => null),
            client.readContract({
                address: tokenAddress,
                abi: erc20Abi,
                functionName: 'name'
            }).catch(() => 'Unknown'),
            client.readContract({
                address: tokenAddress,
                abi: erc20Abi,
                functionName: 'symbol'
            }).catch(() => 'UNKNOWN')
        ]);
        if (decimals === null)
            return null;
        return { decimals: Number(decimals), name: String(name), symbol: String(symbol) };
    }
    catch {
        return null;
    }
}
const tokenMetadataCache = new Map();
async function getEvmTokenMetadata(client, tokenAddress, chain) {
    const addr = tokenAddress.toLowerCase();
    const cacheKey = `${chain}:${addr}`;
    if (tokenMetadataCache.has(cacheKey))
        return tokenMetadataCache.get(cacheKey);
    // Try DB first
    const dbRows = await query(`SELECT decimals, symbol, name FROM tokens WHERE mint = $1 AND chain = $2`, [prefixChainValue(addr, chain), chain]);
    if (dbRows.length > 0 && dbRows[0].decimals !== null) {
        const meta = {
            decimals: dbRows[0].decimals,
            symbol: dbRows[0].symbol ?? 'UNKNOWN',
            name: dbRows[0].name ?? 'Unknown'
        };
        tokenMetadataCache.set(cacheKey, meta);
        return meta;
    }
    // Fallback to contract read
    const meta = await fetchEvmTokenMetadata(client, tokenAddress, chain);
    if (!meta)
        return null;
    // Upsert into tokens table
    await upsertToken(addr, {
        chain,
        decimals: meta.decimals,
        symbol: meta.symbol,
        name: meta.name
    });
    tokenMetadataCache.set(cacheKey, meta);
    return meta;
}
export async function backfillEvmWallet(address, chain, dependencies = {}) {
    const normalizedAddress = resolveChainValue(address, chain).raw;
    const client = dependencies.client ?? getPublicClient(chain);
    const publish = dependencies.publish
        ?? ((channel, message) => redis.publish(channel, message));
    const currentBlock = await client.getBlockNumber();
    const blockWindow = BigInt(process.env.EVM_BACKFILL_BLOCKS ?? '100000');
    const logChunkSize = BigInt(process.env.EVM_LOG_CHUNK_SIZE ?? '2000');
    if (logChunkSize <= 0n)
        throw new Error('EVM_LOG_CHUNK_SIZE must be positive');
    const fromBlock = currentBlock - blockWindow > 0n ? currentBlock - blockWindow : 0n;
    console.log(`[indexer] EVM backfill querying logs for ${normalizedAddress} on ${chain} from block ${fromBlock}`);
    const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
    const collectedLogs = [];
    for (let chunkStart = fromBlock; chunkStart <= currentBlock; chunkStart += logChunkSize) {
        const chunkEnd = chunkStart + logChunkSize - 1n > currentBlock
            ? currentBlock
            : chunkStart + logChunkSize - 1n;
        const [sentLogs, receivedLogs] = await Promise.all([
            client.getLogs({
                event: transferEvent,
                args: { from: normalizedAddress },
                fromBlock: chunkStart,
                toBlock: chunkEnd
            }),
            client.getLogs({
                event: transferEvent,
                args: { to: normalizedAddress },
                fromBlock: chunkStart,
                toBlock: chunkEnd
            })
        ]);
        collectedLogs.push(...sentLogs, ...receivedLogs);
    }
    const dedupedLogs = new Map();
    for (const log of collectedLogs) {
        const key = `${log.transactionHash}:${log.logIndex}`;
        dedupedLogs.set(key, log);
    }
    const allLogs = [...dedupedLogs.values()].sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) {
            return Number(a.blockNumber - b.blockNumber);
        }
        return Number(a.transactionIndex - b.transactionIndex);
    });
    const logsByTx = new Map();
    for (const log of allLogs) {
        const hash = log.transactionHash;
        if (!logsByTx.has(hash)) {
            logsByTx.set(hash, []);
        }
        logsByTx.get(hash).push(log);
    }
    console.log(`[indexer] EVM backfill found ${logsByTx.size} unique transactions for ${normalizedAddress}`);
    let inserted = 0;
    let skipped = 0;
    let failed = 0;
    let latestBlockTime = null;
    let lastEventAt = null;
    let sourceTradeFailure = null;
    const blockCache = new Map();
    async function getBlockTimestamp(blockNumber) {
        if (blockCache.has(blockNumber))
            return blockCache.get(blockNumber);
        const block = await client.getBlock({ blockNumber });
        const ts = Number(block.timestamp);
        blockCache.set(blockNumber, ts);
        return ts;
    }
    const BATCH_SIZE = Number(process.env.BACKFILL_BATCH_SIZE ?? 5);
    const txHashes = Array.from(logsByTx.keys());
    for (let i = 0; i < txHashes.length; i += BATCH_SIZE) {
        const batch = txHashes.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (hash) => {
            try {
                const txLogs = logsByTx.get(hash);
                const firstLog = txLogs[0];
                const blockNumber = firstLog.blockNumber;
                const blockTime = await getBlockTimestamp(blockNumber);
                const timestamp = new Date(blockTime * 1000);
                if (!lastEventAt || timestamp > lastEventAt)
                    lastEventAt = timestamp;
                const receipt = await client.getTransactionReceipt({ hash: hash });
                let reviewedRobinhoodSwap = null;
                if (chain === 'robinhood-chain') {
                    let ingestionConfig;
                    try {
                        ingestionConfig = parseRobinhoodIngestionConfig();
                    }
                    catch (error) {
                        console.warn('[indexer] Robinhood reviewed router/pool configuration is unavailable:', error);
                        skipped++;
                        return;
                    }
                    const classification = classifyRobinhoodReceipt({
                        status: receipt.status,
                        from: receipt.from,
                        to: receipt.to,
                        transactionHash: hash,
                        logs: receipt.logs.map((log) => ({
                            address: log.address,
                            data: log.data,
                            topics: log.topics,
                            logIndex: log.logIndex,
                            transactionHash: log.transactionHash
                        }))
                    }, normalizedAddress, ingestionConfig);
                    if (classification.status === 'rejected') {
                        skipped++;
                        return;
                    }
                    reviewedRobinhoodSwap = classification;
                }
                // Separate user's transfers
                const userSent = [];
                const userReceived = [];
                for (const log of txLogs) {
                    const meta = await getEvmTokenMetadata(client, log.address, chain);
                    if (!meta)
                        continue;
                    const amount = log.args.value ? BigInt(log.args.value) : 0n;
                    const from = log.args.from?.toLowerCase();
                    const to = log.args.to?.toLowerCase();
                    if (from === normalizedAddress && to === normalizedAddress)
                        continue;
                    if (from === normalizedAddress) {
                        userSent.push({ token: log.address.toLowerCase(), amount, ...meta });
                    }
                    if (to === normalizedAddress) {
                        userReceived.push({ token: log.address.toLowerCase(), amount, ...meta });
                    }
                }
                // Determine tokenIn, tokenOut, direction, targetToken
                let tokenIn = '';
                let tokenOut = '';
                let amountIn = '0';
                let amountOut = '0';
                let direction = 'buy';
                let targetToken = '';
                let targetDecimals = null;
                if (reviewedRobinhoodSwap) {
                    tokenIn = reviewedRobinhoodSwap.tokenIn;
                    tokenOut = reviewedRobinhoodSwap.tokenOut;
                    amountIn = reviewedRobinhoodSwap.amountIn.toString();
                    amountOut = reviewedRobinhoodSwap.amountOut.toString();
                    direction = reviewedRobinhoodSwap.direction;
                    targetToken = reviewedRobinhoodSwap.targetToken;
                    const targetMetadata = await getEvmTokenMetadata(client, targetToken, chain);
                    if (!targetMetadata) {
                        skipped++;
                        return;
                    }
                    targetDecimals = targetMetadata.decimals;
                }
                else if (userSent.length > 0 && userReceived.length > 0) {
                    // Cross-token swap
                    const sentBase = userSent.find(s => isBaseToken(s.token, s.symbol, chain));
                    const receivedBase = userReceived.find(r => isBaseToken(r.token, r.symbol, chain));
                    if (sentBase && !receivedBase) {
                        // Sent base, received speculative => Buy
                        const spec = userReceived[0];
                        tokenIn = sentBase.token;
                        tokenOut = spec.token;
                        amountIn = sentBase.amount.toString();
                        amountOut = spec.amount.toString();
                        targetToken = spec.token;
                        direction = 'buy';
                    }
                    else if (!sentBase && receivedBase) {
                        // Sent speculative, received base => Sell
                        const spec = userSent[0];
                        tokenIn = spec.token;
                        tokenOut = receivedBase.token;
                        amountIn = spec.amount.toString();
                        amountOut = receivedBase.amount.toString();
                        targetToken = spec.token;
                        direction = 'sell';
                    }
                    else {
                        // Arbitrary swap
                        const sent = userSent[0];
                        const received = userReceived[0];
                        tokenIn = sent.token;
                        tokenOut = received.token;
                        amountIn = sent.amount.toString();
                        amountOut = received.amount.toString();
                        targetToken = received.token;
                        direction = 'buy';
                    }
                }
                else if (userReceived.length > 0) {
                    // Received token only, check for native value
                    const spec = userReceived[0];
                    const tx = await client.getTransaction({ hash: hash });
                    if (tx.value > 0n) {
                        tokenIn = NATIVE_TOKEN;
                        tokenOut = spec.token;
                        amountIn = tx.value.toString();
                        amountOut = spec.amount.toString();
                        targetToken = spec.token;
                        direction = 'buy';
                    }
                    else {
                        // Airdrop or simple transfer
                        tokenIn = NATIVE_TOKEN;
                        tokenOut = spec.token;
                        amountIn = '0';
                        amountOut = spec.amount.toString();
                        targetToken = spec.token;
                        direction = 'buy';
                    }
                }
                else if (userSent.length > 0) {
                    // Sent token only, check if they received base token (from receipt logs)
                    const spec = userSent[0];
                    let receivedBaseFromReceipt;
                    for (const log of receipt.logs) {
                        // Check for Transfer log
                        if (log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
                            const toAddress = log.topics[2] ? '0x' + log.topics[2].substring(26) : '';
                            if (toAddress.toLowerCase() === normalizedAddress) {
                                const meta = await getEvmTokenMetadata(client, log.address, chain);
                                if (!meta)
                                    continue;
                                if (isBaseToken(log.address, meta.symbol, chain)) {
                                    // Found the base transfer!
                                    const amount = log.data ? BigInt(log.data) : 0n;
                                    receivedBaseFromReceipt = { token: log.address.toLowerCase(), amount };
                                    break;
                                }
                            }
                        }
                    }
                    if (receivedBaseFromReceipt) {
                        tokenIn = spec.token;
                        tokenOut = receivedBaseFromReceipt.token;
                        amountIn = spec.amount.toString();
                        amountOut = receivedBaseFromReceipt.amount.toString();
                        targetToken = spec.token;
                        direction = 'sell';
                    }
                    else {
                        // Simple send
                        tokenIn = spec.token;
                        tokenOut = NATIVE_TOKEN;
                        amountIn = spec.amount.toString();
                        amountOut = '0';
                        targetToken = spec.token;
                        direction = 'sell';
                    }
                }
                else {
                    skipped++;
                    return;
                }
                // Fetch target token USD price (from DexScreener if available)
                const targetPrice = await fetchTokenPriceUsd(prefixChainValue(targetToken, chain)).catch(() => null);
                let amountInUsd = null;
                let amountOutUsd = null;
                if (targetPrice) {
                    const specDecimals = targetDecimals ?? (direction === 'buy'
                        ? (userReceived.find(r => r.token === targetToken)?.decimals ?? 18)
                        : (userSent.find(s => s.token === targetToken)?.decimals ?? 18));
                    const specAmount = direction === 'buy' ? amountOut : amountIn;
                    const floatAmount = Number(BigInt(specAmount)) / (10 ** specDecimals);
                    const usdVal = floatAmount * targetPrice;
                    amountInUsd = usdVal;
                    amountOutUsd = usdVal;
                }
                if (tokenIn === NATIVE_TOKEN || tokenOut === NATIVE_TOKEN) {
                    await upsertToken(NATIVE_TOKEN, {
                        chain,
                        decimals: 18,
                        symbol: chain === 'polygon' ? 'POL' : 'ETH',
                        name: chain === 'polygon' ? 'Polygon' : 'Ether'
                    });
                }
                const persisted = await insertParsedTransaction({
                    signature: hash,
                    chain,
                    walletAddress: normalizedAddress,
                    tokenIn,
                    tokenOut,
                    amountIn,
                    amountOut,
                    amountInUsd,
                    amountOutUsd,
                    direction,
                    targetToken,
                    programId: reviewedRobinhoodSwap ? 'uniswap-v3-reviewed' : 'uniswap',
                    slot: Number(blockNumber),
                    timestamp,
                    blockTime
                });
                const walletTargetQuantity = (direction === 'buy' ? userReceived : userSent)
                    .filter((transfer) => transfer.token === targetToken)
                    .reduce((total, transfer) => total + transfer.amount, 0n);
                if (reviewedRobinhoodSwap && walletTargetQuantity <= 0n) {
                    throw new Error('Reviewed Robinhood swap has no target-token wallet transfer');
                }
                const sourceTrade = reviewedRobinhoodSwap
                    ? await persistRobinhoodSourceTrade({
                        transactionHash: hash,
                        walletAddress: normalizedAddress,
                        tokenMint: targetToken,
                        side: direction,
                        quantity: walletTargetQuantity.toString(),
                        eventAt: timestamp,
                        blockNumber
                    })
                    : null;
                if (persisted) {
                    inserted++;
                    if (!latestBlockTime || blockTime > latestBlockTime) {
                        latestBlockTime = blockTime;
                    }
                    await updateTokenLaunchTimestamp(targetToken, timestamp, chain);
                    // Publish Swap event to Redis
                    await publish(REDIS_CHANNELS.walletSwap, JSON.stringify({
                        chain,
                        walletAddress: prefixChainValue(normalizedAddress, chain),
                        signature: hash,
                        sourceTradeId: sourceTrade?.event.id,
                        tokenMint: prefixChainValue(targetToken, chain),
                        direction,
                        amountUsd: amountInUsd,
                        timestamp: timestamp.toISOString()
                    }));
                }
                else {
                    skipped++;
                }
            }
            catch (err) {
                console.warn(`[indexer] Failed to process EVM transaction ${hash}:`, err);
                failed++;
                if (err instanceof SourceTradePersistenceError) {
                    sourceTradeFailure ??= err;
                }
            }
        }));
    }
    const result = {
        fetched: txHashes.length,
        inserted,
        skipped,
        failed,
        lastEventAt
    };
    try {
        await refreshWalletActivity(prefixChainValue(normalizedAddress, chain), latestBlockTime ? new Date(latestBlockTime * 1000) : null, inserted);
    }
    catch (error) {
        throw new IngestionBatchError(`Failed to refresh ${chain} wallet activity for ${normalizedAddress}`, { ...result, failed: result.failed + 1 }, { cause: error });
    }
    if (sourceTradeFailure) {
        throw new IngestionBatchError(`Canonical ${chain} source-trade persistence failed for ${normalizedAddress}`, result, { cause: sourceTradeFailure });
    }
    return result;
}
/**
 * Discover and seed early & big buyers of an EVM ERC-20 token on Robinhood Chain or Polygon.
 */
export async function discoverFromEvmToken(tokenAddress, chain, dependencies = {}) {
    const normalizedAddress = resolveChainValue(tokenAddress, chain).raw.toLowerCase();
    const client = dependencies.client ?? getPublicClient(chain);
    const currentBlock = await client.getBlockNumber();
    const blockWindow = BigInt(process.env.EVM_BACKFILL_BLOCKS ?? '100000');
    const logChunkSize = BigInt(process.env.EVM_LOG_CHUNK_SIZE ?? '2000');
    const fromBlock = currentBlock - blockWindow > 0n ? currentBlock - blockWindow : 0n;
    // Metadata retrieval & caching
    try {
        await getEvmTokenMetadata(client, normalizedAddress, chain);
    }
    catch (err) {
        console.warn(`[indexer] Failed to fetch EVM token metadata for ${normalizedAddress} on ${chain}:`, err);
    }
    console.log(`[indexer] EVM token discovery querying Transfer logs for ${normalizedAddress} on ${chain} from block ${fromBlock}`);
    const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
    const collectedLogs = [];
    for (let chunkStart = fromBlock; chunkStart <= currentBlock; chunkStart += logChunkSize) {
        const chunkEnd = chunkStart + logChunkSize - 1n > currentBlock
            ? currentBlock
            : chunkStart + logChunkSize - 1n;
        try {
            const logs = await client.getLogs({
                address: normalizedAddress,
                event: transferEvent,
                fromBlock: chunkStart,
                toBlock: chunkEnd
            });
            collectedLogs.push(...logs);
        }
        catch (err) {
            console.warn(`[indexer] EVM token discovery chunk failed (${chunkStart}-${chunkEnd}):`, err);
        }
    }
    const buyers = new Map();
    for (const log of collectedLogs) {
        const to = log.args?.to?.toLowerCase();
        const value = log.args?.value;
        if (!to || !value || to === NATIVE_TOKEN || to === normalizedAddress)
            continue;
        if (to === '0x0000000000000000000000000000000000000000')
            continue;
        const blockNum = log.blockNumber ?? currentBlock;
        const cur = buyers.get(to);
        if (cur) {
            cur.amount += value;
            if (blockNum < cur.earliestBlock)
                cur.earliestBlock = blockNum;
        }
        else {
            buyers.set(to, { earliestBlock: blockNum, amount: value });
        }
    }
    const entries = Array.from(buyers.entries());
    const byEarliest = [...entries].sort((a, b) => (a[1].earliestBlock < b[1].earliestBlock ? -1 : a[1].earliestBlock > b[1].earliestBlock ? 1 : 0));
    const early = byEarliest.slice(0, 40).map(([owner]) => owner);
    const earlySet = new Set(early);
    const byAmount = [...entries]
        .filter(([owner]) => !earlySet.has(owner))
        .sort((a, b) => (b[1].amount > a[1].amount ? -1 : b[1].amount < a[1].amount ? 1 : 0));
    const big = byAmount.slice(0, 10).map(([owner]) => owner);
    const targetQueue = dependencies.backfillQueue ?? new Queue(QUEUES.walletBackfill, { connection: redis });
    for (const owner of early) {
        await upsertWallet({ address: owner, chain, source: 'discovered', discoveryMethod: 'token-early' });
        const job = createWalletBackfillJob(owner, chain);
        await targetQueue.add(job.name, job.data, job.options);
    }
    for (const owner of big) {
        await upsertWallet({ address: owner, chain, source: 'discovered', discoveryMethod: 'token-big' });
        const job = createWalletBackfillJob(owner, chain);
        await targetQueue.add(job.name, job.data, job.options);
    }
    await logDiscoveryRun('token', normalizedAddress, early.length + big.length);
    await redis.publish(REDIS_CHANNELS.clusterRefresh, JSON.stringify({ reason: 'token-discovery', mint: normalizedAddress, chain }));
    console.log(`[indexer] EVM token ${normalizedAddress} on ${chain}: seeded ${early.length} early + ${big.length} big buyers from ${buyers.size} candidates`);
    return { earlyBuyers: early.length, bigBuyers: big.length, scanned: collectedLogs.length };
}
//# sourceMappingURL=evm.js.map