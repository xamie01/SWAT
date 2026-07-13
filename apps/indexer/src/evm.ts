import { createPublicClient, http, parseAbiItem, erc20Abi } from 'viem';
import { polygon } from 'viem/chains';
import { Redis } from 'ioredis';
import {
  query,
  upsertToken,
  insertParsedTransaction,
  updateTokenLaunchTimestamp,
  refreshWalletActivity
} from '@swat/db';
import { REDIS_CHANNELS, fetchTokenPriceUsd } from '@swat/shared';

export type WalletChain = 'solana' | 'polygon' | 'robinhood-chain';

// Define Robinhood Chain custom definition
const robinhoodChain = {
  id: 4663,
  name: 'Robinhood Chain',
  network: 'robinhood-chain',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.chain.robinhood.com'] },
    public: { http: ['https://rpc.mainnet.chain.robinhood.com'] },
  },
} as const;

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

const BASE_TOKENS: Record<string, Set<string>> = {
  polygon: new Set([
    '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270'.toLowerCase(), // WMATIC
    '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'.toLowerCase(), // USDC (native)
    '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'.toLowerCase(), // USDC (bridged)
    '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'.toLowerCase(), // USDT
    '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619'.toLowerCase(), // WETH
  ]),
  'robinhood-chain': new Set([
    '0x2F7FF2B57B2F6b72a08B6f8F73B8A8888b14e9f7'.toLowerCase(), // WETH example
  ])
};

const BASE_SYMBOLS = new Set(['weth', 'usdc', 'usdt', 'wmatic', 'wpol', 'eth', 'pol']);

function isBaseToken(address: string, symbol: string, chain: WalletChain): boolean {
  const addr = address.toLowerCase();
  if (BASE_TOKENS[chain]?.has(addr)) return true;
  if (BASE_SYMBOLS.has(symbol.toLowerCase())) return true;
  return false;
}

// Instantiate clients
function getPublicClient(chain: WalletChain) {
  if (chain === 'polygon') {
    const url = process.env.POLYGON_RPC_URL ?? 'https://polygon-rpc.com';
    return createPublicClient({ chain: polygon, transport: http(url) });
  } else if (chain === 'robinhood-chain') {
    const url = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
    return createPublicClient({ chain: robinhoodChain, transport: http(url) });
  }
  throw new Error(`Unsupported chain: ${chain}`);
}

async function fetchEvmTokenMetadata(client: any, tokenAddress: `0x${string}`, chain: WalletChain) {
  try {
    const [decimals, name, symbol] = await Promise.all([
      client.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'decimals'
      }).catch(() => 18),
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
    return { decimals: Number(decimals), name: String(name), symbol: String(symbol) };
  } catch {
    return { decimals: 18, name: 'Unknown', symbol: 'UNKNOWN' };
  }
}

const tokenMetadataCache = new Map<string, { decimals: number; symbol: string; name: string }>();

async function getEvmTokenMetadata(client: any, tokenAddress: `0x${string}`, chain: WalletChain) {
  const addr = tokenAddress.toLowerCase();
  if (tokenMetadataCache.has(addr)) return tokenMetadataCache.get(addr)!;

  // Try DB first
  const dbRows = await query<{ decimals: number | null; symbol: string | null; name: string | null }>(
    `SELECT decimals, symbol, name FROM tokens WHERE mint = $1 AND chain = $2`,
    [addr, chain]
  );
  if (dbRows.length > 0 && dbRows[0].decimals !== null) {
    const meta = {
      decimals: dbRows[0].decimals,
      symbol: dbRows[0].symbol ?? 'UNKNOWN',
      name: dbRows[0].name ?? 'Unknown'
    };
    tokenMetadataCache.set(addr, meta);
    return meta;
  }

  // Fallback to contract read
  const meta = await fetchEvmTokenMetadata(client, tokenAddress, chain);
  
  // Upsert into tokens table
  await upsertToken(addr, {
    chain,
    decimals: meta.decimals,
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
    symbol: meta.symbol,
    name: meta.name
  });

  tokenMetadataCache.set(addr, meta);
  return meta;
}

export async function backfillEvmWallet(address: string, chain: 'polygon' | 'robinhood-chain') {
  const client = getPublicClient(chain);
  const currentBlock = await client.getBlockNumber();
  const blockWindow = BigInt(process.env.EVM_BACKFILL_BLOCKS ?? '100000');
  const fromBlock = currentBlock - blockWindow > 0n ? currentBlock - blockWindow : 0n;

  console.log(`[indexer] EVM backfill querying logs for ${address} on ${chain} from block ${fromBlock}`);

  const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

  const [sentLogs, receivedLogs] = await Promise.all([
    client.getLogs({
      event: transferEvent,
      args: { from: address as `0x${string}` },
      fromBlock,
      toBlock: 'latest'
    }),
    client.getLogs({
      event: transferEvent,
      args: { to: address as `0x${string}` },
      fromBlock,
      toBlock: 'latest'
    })
  ]);

  const allLogs = [...sentLogs, ...receivedLogs].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) {
      return Number(a.blockNumber! - b.blockNumber!);
    }
    return Number(a.transactionIndex! - b.transactionIndex!);
  });

  const logsByTx = new Map<string, typeof allLogs>();
  for (const log of allLogs) {
    const hash = log.transactionHash!;
    if (!logsByTx.has(hash)) {
      logsByTx.set(hash, []);
    }
    logsByTx.get(hash)!.push(log);
  }

  console.log(`[indexer] EVM backfill found ${logsByTx.size} unique transactions for ${address}`);

  let inserted = 0;
  let skipped = 0;
  let latestBlockTime: number | null = null;

  const blockCache = new Map<bigint, number>();
  async function getBlockTimestamp(blockNumber: bigint) {
    if (blockCache.has(blockNumber)) return blockCache.get(blockNumber)!;
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
        const txLogs = logsByTx.get(hash)!;
        const firstLog = txLogs[0];
        const blockNumber = firstLog.blockNumber!;
        const blockTime = await getBlockTimestamp(blockNumber);
        const timestamp = new Date(blockTime * 1000);

        // Separate user's transfers
        const userSent: Array<{ token: string; amount: bigint; decimals: number; symbol: string; name: string }> = [];
        const userReceived: Array<{ token: string; amount: bigint; decimals: number; symbol: string; name: string }> = [];

        for (const log of txLogs) {
          const meta = await getEvmTokenMetadata(client, log.address, chain);
          const amount = log.args.value ? BigInt(log.args.value) : 0n;
          
          if (log.args.from?.toLowerCase() === address.toLowerCase()) {
            userSent.push({ token: log.address.toLowerCase(), amount, ...meta });
          }
          if (log.args.to?.toLowerCase() === address.toLowerCase()) {
            userReceived.push({ token: log.address.toLowerCase(), amount, ...meta });
          }
        }

        // Determine tokenIn, tokenOut, direction, targetToken
        let tokenIn = '';
        let tokenOut = '';
        let amountIn = '0';
        let amountOut = '0';
        let direction: 'buy' | 'sell' = 'buy';
        let targetToken = '';

        if (userSent.length > 0 && userReceived.length > 0) {
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
          } else if (!sentBase && receivedBase) {
            // Sent speculative, received base => Sell
            const spec = userSent[0];
            tokenIn = spec.token;
            tokenOut = receivedBase.token;
            amountIn = spec.amount.toString();
            amountOut = receivedBase.amount.toString();
            targetToken = spec.token;
            direction = 'sell';
          } else {
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
        } else if (userReceived.length > 0) {
          // Received token only, check for native value
          const spec = userReceived[0];
          const tx = await client.getTransaction({ hash: hash as `0x${string}` });
          if (tx.value > 0n) {
            tokenIn = '0x0000000000000000000000000000000000000000';
            tokenOut = spec.token;
            amountIn = tx.value.toString();
            amountOut = spec.amount.toString();
            targetToken = spec.token;
            direction = 'buy';
          } else {
            // Airdrop or simple transfer
            tokenIn = '0x0000000000000000000000000000000000000000';
            tokenOut = spec.token;
            amountIn = '0';
            amountOut = spec.amount.toString();
            targetToken = spec.token;
            direction = 'buy';
          }
        } else if (userSent.length > 0) {
          // Sent token only, check if they received base token (from receipt logs)
          const spec = userSent[0];
          const receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
          
          let receivedBaseFromReceipt: { token: string; amount: bigint } | undefined;
          for (const log of receipt.logs) {
            // Check for Transfer log
            if (log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
              const toAddress = log.topics[2] ? '0x' + log.topics[2].substring(26) : '';
              if (toAddress.toLowerCase() === address.toLowerCase()) {
                const meta = await getEvmTokenMetadata(client, log.address, chain);
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
          } else {
            // Simple send
            tokenIn = spec.token;
            tokenOut = '0x0000000000000000000000000000000000000000';
            amountIn = spec.amount.toString();
            amountOut = '0';
            targetToken = spec.token;
            direction = 'sell';
          }
        } else {
          skipped++;
          return;
        }

        // Fetch target token USD price (from DexScreener if available)
        const targetPrice = await fetchTokenPriceUsd(targetToken).catch(() => null);
        let amountInUsd: number | null = null;
        let amountOutUsd: number | null = null;

        if (targetPrice) {
          const specDecimals = direction === 'buy' 
            ? (userReceived.find(r => r.token === targetToken)?.decimals ?? 18)
            : (userSent.find(s => s.token === targetToken)?.decimals ?? 18);
          
          const specAmount = direction === 'buy' ? amountOut : amountIn;
          const floatAmount = Number(BigInt(specAmount)) / (10 ** specDecimals);
          const usdVal = floatAmount * targetPrice;
          amountInUsd = usdVal;
          amountOutUsd = usdVal;
        }

        const persisted = await insertParsedTransaction({
          signature: hash,
          chain,
          walletAddress: address,
          tokenIn,
          tokenOut,
          amountIn,
          amountOut,
          amountInUsd,
          amountOutUsd,
          direction,
          targetToken,
          programId: 'uniswap', // generic label
          slot: Number(blockNumber),
          timestamp,
          blockTime
        });

        if (persisted) {
          inserted++;
          if (!latestBlockTime || blockTime > latestBlockTime) {
            latestBlockTime = blockTime;
          }

          await updateTokenLaunchTimestamp(targetToken, timestamp, chain);

          // Publish Swap event to Redis
          await redis.publish(
            REDIS_CHANNELS.walletSwap,
            JSON.stringify({
              chain,
              walletAddress: `${chain}:${address}`,
              signature: hash,
              tokenMint: `${chain}:${targetToken}`,
              direction,
              amountUsd: amountInUsd,
              timestamp: timestamp.toISOString()
            })
          );
        } else {
          skipped++;
        }
      } catch (err) {
        console.warn(`[indexer] Failed to process EVM transaction ${hash}:`, err);
        skipped++;
      }
    }));
  }

  await refreshWalletActivity(`${chain}:${address}`, latestBlockTime ? new Date(latestBlockTime * 1000) : null, inserted);
  return { fetched: txHashes.length, inserted, skipped };
}
