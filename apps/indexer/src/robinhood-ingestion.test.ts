import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiItem,
  type Hex
} from 'viem';
import { describe, expect, it } from 'vitest';
import {
  classifyRobinhoodReceipt,
  evaluateRobinhoodFixtureGate,
  measureRobinhoodFixtures,
  parseRobinhoodIngestionConfig,
  type RobinhoodReceiptLog,
  type RobinhoodReviewedFixture
} from './robinhood-ingestion.js';

const wallet = '0x1000000000000000000000000000000000000001';
const router = '0x2000000000000000000000000000000000000002';
const pool = '0x3000000000000000000000000000000000000003';
const base = '0x4000000000000000000000000000000000000004';
const token = '0x5000000000000000000000000000000000000005';
const other = '0x6000000000000000000000000000000000000006';
const transactionHash = `0x${'a'.repeat(64)}`;

const transferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
);
const swapEvent = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'
);

const config = parseRobinhoodIngestionConfig({
  ROBINHOOD_INGESTION_ROUTERS: router,
  ROBINHOOD_BASE_ASSET: base,
  ROBINHOOD_REVIEWED_POOLS_JSON: JSON.stringify([{ address: pool, token0: base, token1: token }])
});

function transferLog(
  address: string,
  from: string,
  to: string,
  value: bigint,
  logIndex: number
): RobinhoodReceiptLog {
  return {
    address,
    topics: encodeEventTopics({ abi: [transferEvent], eventName: 'Transfer', args: { from, to } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    logIndex,
    transactionHash
  };
}

function swapLog(amount0: bigint, amount1: bigint, logIndex = 1): RobinhoodReceiptLog {
  return {
    address: pool,
    topics: encodeEventTopics({
      abi: [swapEvent],
      eventName: 'Swap',
      args: { sender: router, recipient: wallet }
    }),
    data: encodeAbiParameters([
      { type: 'int256' },
      { type: 'int256' },
      { type: 'uint160' },
      { type: 'uint128' },
      { type: 'int24' }
    ], [amount0, amount1, 1n, 1n, 0]),
    logIndex,
    transactionHash
  };
}

function receipt(logs: RobinhoodReceiptLog[]) {
  return {
    status: 'success' as const,
    from: wallet,
    to: router,
    transactionHash,
    logs
  };
}

describe('reviewed Robinhood receipt classification', () => {
  it('decodes BUY and SELL direction from reviewed pool deltas and wallet transfers', () => {
    const buy = classifyRobinhoodReceipt(receipt([
      swapLog(1_000n, -5_000n),
      transferLog(token, pool, wallet, 5_000n, 2)
    ]), wallet, config);
    expect(buy).toMatchObject({
      status: 'classified',
      direction: 'buy',
      tokenIn: base.toLowerCase(),
      tokenOut: token.toLowerCase(),
      amountIn: 1_000n,
      amountOut: 5_000n
    });

    const sell = classifyRobinhoodReceipt(receipt([
      swapLog(-800n, 4_000n),
      transferLog(token, wallet, pool, 4_000n, 2)
    ]), wallet, config);
    expect(sell).toMatchObject({
      status: 'classified',
      direction: 'sell',
      tokenIn: token.toLowerCase(),
      tokenOut: base.toLowerCase(),
      amountIn: 4_000n,
      amountOut: 800n
    });
  });

  it('deduplicates logs without inflating receipt-derived amounts', () => {
    const swap = swapLog(1_000n, -5_000n);
    const transfer = transferLog(token, pool, wallet, 5_000n, 2);
    const result = classifyRobinhoodReceipt(
      receipt([swap, transfer, { ...swap }, { ...transfer }]),
      wallet,
      config
    );
    expect(result).toMatchObject({ status: 'classified', amountIn: 1_000n, amountOut: 5_000n });
  });

  it.each([
    {
      name: 'ordinary transfer',
      logs: [transferLog(token, other, wallet, 5_000n, 1)],
      reason: 'no_reviewed_pool_swap'
    },
    {
      name: 'self transfer',
      logs: [swapLog(1_000n, -5_000n), transferLog(token, wallet, wallet, 5_000n, 2)],
      reason: 'missing_wallet_transfer'
    },
    {
      name: 'ERC-721 transfer',
      logs: [
        swapLog(1_000n, -5_000n),
        {
          address: token,
          topics: [
            transferEvent.topic,
            `0x${'0'.repeat(24)}${other.slice(2)}`,
            `0x${'0'.repeat(24)}${wallet.slice(2)}`,
            `0x${'0'.repeat(63)}1`
          ] as readonly Hex[],
          data: '0x' as const,
          logIndex: 2,
          transactionHash
        }
      ],
      reason: 'missing_wallet_transfer'
    }
  ])('rejects $name receipts', ({ logs, reason }) => {
    expect(classifyRobinhoodReceipt(receipt(logs), wallet, config)).toEqual({
      status: 'rejected',
      reason
    });
  });

  it('rejects a Swap-shaped log emitted by an unreviewed pool', () => {
    const result = classifyRobinhoodReceipt(receipt([
      { ...swapLog(1_000n, -5_000n), address: other },
      transferLog(token, pool, wallet, 5_000n, 2)
    ]), wallet, config);
    expect(result).toEqual({ status: 'rejected', reason: 'no_reviewed_pool_swap' });
  });
});

describe('Robinhood reviewed-fixture metrics', () => {
  const fixtures: RobinhoodReviewedFixture[] = [
    {
      name: 'reviewed buy',
      reviewed: true,
      wallet,
      receipt: receipt([swapLog(1_000n, -5_000n), transferLog(token, pool, wallet, 5_000n, 2)]),
      expected: 'classify',
      expectedDirection: 'buy'
    },
    {
      name: 'reviewed ordinary transfer',
      reviewed: true,
      wallet,
      receipt: receipt([transferLog(token, other, wallet, 5_000n, 1)]),
      expected: 'reject'
    }
  ];

  it('reports inserted/skipped, completeness, direction, and false positives', () => {
    expect(measureRobinhoodFixtures(fixtures, config)).toEqual({
      totalFixtures: 2,
      reviewedFixtures: 2,
      expectedSwaps: 1,
      inserted: 1,
      skipped: 0,
      falsePositives: 0,
      completeness: 1,
      directionSamples: 1,
      correctDirections: 1,
      directionAccuracy: 1
    });
  });

  it('refuses to make a threshold claim for an empty reviewed fixture set', () => {
    const metrics = measureRobinhoodFixtures([], config);
    expect(evaluateRobinhoodFixtureGate(metrics)).toEqual({
      passed: false,
      reasons: [
        'reviewed fixture set is empty',
        'reviewed fixture set has no expected swaps',
        'reviewed fixture set has no direction samples',
        'measured completeness is not greater than 90%',
        'measured direction accuracy is not greater than 95%'
      ]
    });
  });
});
