import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem';
import { classifyRobinhoodReceipt, parseRobinhoodIngestionConfig, type RobinhoodReceiptLog } from './robinhood-ingestion.js';

const wallet = '0x1000000000000000000000000000000000000001';
const router = '0x2000000000000000000000000000000000000002';
const pool = '0x3000000000000000000000000000000000000003';
const base = '0x4000000000000000000000000000000000000004';
const token = '0x5000000000000000000000000000000000000005';
const transactionHash = `0x${'a'.repeat(64)}`;
const config = parseRobinhoodIngestionConfig({
  ROBINHOOD_INGESTION_ROUTERS: router, ROBINHOOD_BASE_ASSET: base,
  ROBINHOOD_REVIEWED_POOLS_JSON: JSON.stringify([{ address: pool, token0: base, token1: token }])
});
const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const swap = parseAbiItem('event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)');
function transferLog(address: string, from: string, to: string, value: bigint, logIndex: number): RobinhoodReceiptLog {
  return { address, logIndex, transactionHash,
    topics: encodeEventTopics({ abi: [transfer], eventName: 'Transfer', args: { from, to } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [value]) };
}
function swapLog(amount0: bigint, amount1: bigint, logIndex: number): RobinhoodReceiptLog {
  return { address: pool, logIndex, transactionHash,
    topics: encodeEventTopics({ abi: [swap], eventName: 'Swap', args: { sender: router, recipient: wallet } }),
    data: encodeAbiParameters([{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }], [amount0, amount1, 1n, 1n, 0]) };
}
function classify(logs: RobinhoodReceiptLog[]) {
  return classifyRobinhoodReceipt({ status: 'success', from: wallet, to: router, transactionHash, logs }, wallet, config);
}

describe('Robinhood exact wallet-net receipt economics', () => {
  it('accepts offsetting reviewed swaps using exact net quantities', () => {
    expect(classify([
      swapLog(1000n, -100n, 0), swapLog(-900n, 90n, 1),
      transferLog(base, wallet, pool, 1000n, 2), transferLog(base, pool, wallet, 900n, 3),
      transferLog(token, pool, wallet, 100n, 4), transferLog(token, wallet, pool, 90n, 5)
    ])).toMatchObject({ status: 'classified', direction: 'buy', amountIn: 100n, amountOut: 10n });
  });
  it('refuses gross pool acquisition when the wallet returns most of the target tokens', () => {
    expect(classify([
      swapLog(1000n, -100n, 0),
      transferLog(base, wallet, pool, 1000n, 1),
      transferLog(token, pool, wallet, 100n, 2),
      transferLog(token, wallet, router, 90n, 3)
    ])).toEqual({ status: 'rejected', reason: 'wallet_flow_mismatch' });
  });
});
