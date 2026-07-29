import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiItem,
  parseGwei,
  type Address,
  type Hex,
  type TransactionReceipt
} from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMemoryRobinhoodPendingStore,
  decodeRobinhoodActualAmounts,
  discoverRobinhoodRoute,
  encodeRobinhoodSwapCalldata,
  executeRobinhoodOrder,
  getRobinhoodRouterAbi,
  parseRobinhoodExecutionConfig,
  reconcileRobinhoodPending,
  RobinhoodRpcFailure,
  type RobinhoodExecutionAdapter,
  type RobinhoodExecutionConfig,
  type RobinhoodPendingStore,
  type RobinhoodSafetyAssessment,
  type RobinhoodTransactionCall
} from './robinhood.js';

const account = '0x1000000000000000000000000000000000000001';
const router = '0x2000000000000000000000000000000000000002';
const quoter = '0x3000000000000000000000000000000000000003';
const weth = '0x4000000000000000000000000000000000000004';
const token = '0x5000000000000000000000000000000000000005';
const sanityToken = '0x6000000000000000000000000000000000000006';
const hash = `0x${'a'.repeat(64)}` as Hex;
const approvalHash = `0x${'b'.repeat(64)}` as Hex;

function configValues(overrides: Record<string, string | undefined> = {}) {
  return {
    ROBINHOOD_CHAIN_ID: '4663',
    ROBINHOOD_RPC_URL: 'http://rpc.invalid',
    ROBINHOOD_SWAP_ROUTER: router,
    ROBINHOOD_QUOTER: quoter,
    ROBINHOOD_WETH9: weth,
    ROBINHOOD_BASE_ASSET: weth,
    ROBINHOOD_SANITY_TOKEN: sanityToken,
    ROBINHOOD_FEE_TIERS: '3000,10000,500',
    ROBINHOOD_ROUTER_ABI_VERSION: 'uniswap-v3-swap-router-01',
    ROBINHOOD_QUOTER_ABI_VERSION: 'uniswap-v3-quoter-v2',
    ROBINHOOD_BASE_ASSET_MODE: 'native-weth',
    ROBINHOOD_GAS_RESERVE_ETH: '0.005',
    ROBINHOOD_MAX_FEE_PER_GAS_GWEI: '10',
    ROBINHOOD_MAX_SWAP_GAS: '500000',
    ROBINHOOD_MAX_APPROVAL_GAS: '100000',
    ROBINHOOD_RECEIPT_TIMEOUT_MS: '60000',
    ROBINHOOD_MAX_SLIPPAGE_BPS: '500',
    ...overrides
  };
}

const transferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
);

function transferLog(
  address: Address,
  from: Address,
  to: Address,
  amount: bigint,
  logIndex: number
) {
  return {
    address,
    topics: encodeEventTopics({ abi: [transferEvent], eventName: 'Transfer', args: { from, to } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
    logIndex,
    transactionHash: hash,
    blockHash: hash,
    blockNumber: 1n,
    transactionIndex: 0,
    removed: false
  };
}

function receipt(logs: ReturnType<typeof transferLog>[], status: 'success' | 'reverted' = 'success') {
  return {
    status,
    logs,
    gasUsed: 50_000n,
    blockNumber: 1n,
    transactionHash: hash
  } as unknown as TransactionReceipt;
}

const passingSafety: RobinhoodSafetyAssessment = {
  checks: [
    { name: 'sell_simulation', status: 'pass', reliable: true, evidence: 'reverse route quoted' },
    { name: 'liquidity', status: 'pass', reliable: true, evidence: 'configured route quoted' },
    { name: 'ownership_admin', status: 'unknown', reliable: false, evidence: 'provider not configured' },
    { name: 'source_verification', status: 'unknown', reliable: false, evidence: 'provider not configured' },
    { name: 'holder_concentration', status: 'unknown', reliable: false, evidence: 'provider not configured' }
  ]
};

function fakeAdapter(overrides: Partial<RobinhoodExecutionAdapter> = {}): RobinhoodExecutionAdapter {
  return {
    quote: vi.fn().mockResolvedValue(5_000n),
    getNativeBalance: vi.fn().mockResolvedValue(10n ** 18n),
    getTokenBalance: vi.fn().mockResolvedValue(10_000n),
    getAllowance: vi.fn().mockResolvedValue(0n),
    getPendingNonce: vi.fn().mockResolvedValue(7),
    estimateFees: vi.fn().mockResolvedValue({
      maxFeePerGas: parseGwei('1'),
      maxPriorityFeePerGas: parseGwei('0.1')
    }),
    simulate: vi.fn().mockResolvedValue(undefined),
    estimateGas: vi.fn().mockResolvedValue(50_000n),
    send: vi.fn().mockResolvedValue(hash),
    waitForReceipt: vi.fn().mockResolvedValue(receipt([
      transferLog(token, router, account, 4_900n, 1)
    ])),
    getReceipt: vi.fn().mockResolvedValue(null),
    ...overrides
  };
}

async function executeBuy(options: {
  config?: RobinhoodExecutionConfig;
  adapter?: RobinhoodExecutionAdapter;
  pendingStore?: RobinhoodPendingStore;
  clientOrderId?: string;
} = {}) {
  return executeRobinhoodOrder({
    order: {
      clientOrderId: options.clientOrderId ?? 'signal-buy-1',
      token,
      direction: 'buy',
      amountInBaseUnits: 100_000_000_000_000_000n,
      slippageBps: 300
    },
    config: options.config ?? parseRobinhoodExecutionConfig(configValues()),
    account,
    adapter: options.adapter ?? fakeAdapter(),
    pendingStore: options.pendingStore ?? createMemoryRobinhoodPendingStore(),
    safetyAssessment: vi.fn().mockResolvedValue(passingSafety),
    requireReadiness: false
  });
}

describe('Robinhood strict deployment configuration', () => {
  it('requires every deployment fact and rejects self sanity quotes', () => {
    expect(() => parseRobinhoodExecutionConfig(configValues({ ROBINHOOD_SWAP_ROUTER: undefined })))
      .toThrow('ROBINHOOD_SWAP_ROUTER is required');
    expect(() => parseRobinhoodExecutionConfig(configValues({ ROBINHOOD_SANITY_TOKEN: weth })))
      .toThrow('router, quoter, WETH9, and sanity token must be distinct');
    expect(() => parseRobinhoodExecutionConfig(configValues({ ROBINHOOD_ROUTER_ABI_VERSION: 'guessed' })))
      .toThrow('ROBINHOOD_ROUTER_ABI_VERSION is unsupported');
  });

  it('quotes every configured tier and selects the best output', async () => {
    const quote = vi.fn()
      .mockRejectedValueOnce(new Error('pool missing'))
      .mockResolvedValueOnce(8n)
      .mockResolvedValueOnce(10n);
    await expect(discoverRobinhoodRoute({
      config: parseRobinhoodExecutionConfig(configValues()),
      tokenIn: weth,
      tokenOut: token,
      amountIn: 1n,
      quote
    })).resolves.toEqual({ status: 'route', fee: 500, amountOut: 10n });
    expect(quote).toHaveBeenCalledTimes(3);
  });

  it('distinguishes no route from RPC failure', async () => {
    const config = parseRobinhoodExecutionConfig(configValues());
    const noRoute = await discoverRobinhoodRoute({
      config,
      tokenIn: weth,
      tokenOut: token,
      amountIn: 1n,
      quote: async () => { throw new Error('pool reverted'); }
    });
    expect(noRoute.status).toBe('no_route');
    const rpcFailure = await discoverRobinhoodRoute({
      config,
      tokenIn: weth,
      tokenOut: token,
      amountIn: 1n,
      quote: async () => { throw new RobinhoodRpcFailure('RPC offline'); }
    });
    expect(rpcFailure.status).toBe('rpc_failure');
  });
});

describe('Robinhood calldata and receipt truth', () => {
  it('matches the router-01 exactInputSingle golden vector', () => {
    const config = parseRobinhoodExecutionConfig(configValues());
    const calldata = encodeRobinhoodSwapCalldata({
      config,
      tokenIn: weth,
      tokenOut: token,
      fee: 3000,
      recipient: account,
      deadline: 1_700_000_000n,
      amountIn: 1_000_000_000_000_000n,
      amountOutMinimum: 123_456n
    });
    expect(calldata).toBe(
      '0x414bf3890000000000000000000000004000000000000000000000000000000000000004' +
      '0000000000000000000000005000000000000000000000000000000000000005' +
      '0000000000000000000000000000000000000000000000000000000000000bb8' +
      '0000000000000000000000001000000000000000000000000000000000000001' +
      '000000000000000000000000000000000000000000000000000000006553f100' +
      '00000000000000000000000000000000000000000000000000038d7ea4c68000' +
      '000000000000000000000000000000000000000000000000000000000001e240' +
      '0000000000000000000000000000000000000000000000000000000000000000'
    );
    expect(decodeFunctionData({ abi: getRobinhoodRouterAbi(config.routerAbiVersion), data: calldata }))
      .toMatchObject({ functionName: 'exactInputSingle' });
  });

  it('derives BUY and SELL amounts from account Transfer logs and deduplicates logs', () => {
    const buyLog = transferLog(token, router, account, 4_900n, 1);
    expect(decodeRobinhoodActualAmounts({
      receipt: receipt([buyLog, { ...buyLog }]),
      account,
      direction: 'buy',
      token,
      baseAsset: weth,
      submittedAmountIn: 1_000n,
      baseAssetMode: 'native-weth'
    })).toEqual({ actualAmountIn: 1_000n, actualAmountOut: 4_900n });

    expect(decodeRobinhoodActualAmounts({
      receipt: receipt([
        transferLog(token, account, router, 2_000n, 1),
        transferLog(weth, router, account, 900n, 2)
      ]),
      account,
      direction: 'sell',
      token,
      baseAsset: weth,
      submittedAmountIn: 2_000n,
      baseAssetMode: 'native-weth'
    })).toEqual({ actualAmountIn: 2_000n, actualAmountOut: 900n });
  });
});

describe('Robinhood execution state machine', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('bounds minOut, preserves gas reserve, simulates the exact calldata, and returns receipt amounts', async () => {
    const adapter = fakeAdapter();
    const result = await executeBuy({ adapter });
    expect(result).toMatchObject({
      status: 'filled',
      actualAmountIn: 100_000_000_000_000_000n,
      actualAmountOut: 4_900n,
      quotedAmountOut: 5_000n,
      feeTier: 3000,
      signature: hash
    });
    const simulated = vi.mocked(adapter.simulate).mock.calls[0][0];
    const decoded = decodeFunctionData({
      abi: getRobinhoodRouterAbi('uniswap-v3-swap-router-01'),
      data: simulated.data
    });
    expect(decoded.args?.[0]).toMatchObject({ amountOutMinimum: 4_850n });
    expect(simulated.value).toBe(100_000_000_000_000_000n);
  });

  it('caps a proportional SELL to balance and submits an exact approval before the swap', async () => {
    const approvalReceipt = receipt([]);
    const sellReceipt = receipt([
      transferLog(token, account, router, 2_500n, 1),
      transferLog(weth, router, account, 2_000n, 2)
    ]);
    const adapter = fakeAdapter({
      quote: vi.fn().mockResolvedValue(2_100n),
      getTokenBalance: vi.fn().mockResolvedValue(10_000n),
      send: vi.fn().mockResolvedValueOnce(approvalHash).mockResolvedValueOnce(hash),
      waitForReceipt: vi.fn().mockResolvedValueOnce(approvalReceipt).mockResolvedValueOnce(sellReceipt)
    });
    const result = await executeRobinhoodOrder({
      order: {
        clientOrderId: 'signal-sell-1',
        token,
        direction: 'sell',
        amountInBaseUnits: 9_000n,
        proportionBps: 2_500,
        slippageBps: 300
      },
      config: parseRobinhoodExecutionConfig(configValues()),
      account,
      adapter,
      pendingStore: createMemoryRobinhoodPendingStore(),
      safetyAssessment: vi.fn().mockResolvedValue(passingSafety),
      requireReadiness: false
    });
    expect(result).toMatchObject({
      status: 'filled',
      actualAmountIn: 2_500n,
      actualAmountOut: 2_000n,
      amountEth: 0.000000000000002
    });
    expect(adapter.send).toHaveBeenCalledTimes(2);
    const approvalCall = vi.mocked(adapter.send).mock.calls[0][0];
    const approval = decodeFunctionData({ abi: [
      parseAbiItem('function approve(address spender, uint256 amount) returns (bool)')
    ], data: approvalCall.data });
    expect(approval.args).toEqual([router, 2_500n]);
    expect(approvalCall.nonce).toBe(7);
    expect(vi.mocked(adapter.send).mock.calls[1][0].nonce).toBe(8);
  });

  it('returns distinct no-route, simulation-revert, reverted-receipt, RPC, and fee-cap states', async () => {
    await expect(executeBuy({ adapter: fakeAdapter({ quote: vi.fn().mockRejectedValue(new Error('missing pool')) }) }))
      .resolves.toMatchObject({ status: 'skipped', state: 'no_route' });
    await expect(executeBuy({ adapter: fakeAdapter({ simulate: vi.fn().mockRejectedValue(new Error('execution reverted')) }) }))
      .resolves.toMatchObject({ status: 'skipped', state: 'simulation_revert' });
    await expect(executeBuy({ adapter: fakeAdapter({ waitForReceipt: vi.fn().mockResolvedValue(receipt([], 'reverted')) }) }))
      .resolves.toMatchObject({ status: 'failed', state: 'reverted', transactionHash: hash });
    await expect(executeBuy({ adapter: fakeAdapter({ quote: vi.fn().mockRejectedValue(new RobinhoodRpcFailure('RPC offline')) }) }))
      .resolves.toMatchObject({ status: 'failed', state: 'rpc_failure' });
    await expect(executeBuy({ adapter: fakeAdapter({
      estimateFees: vi.fn().mockResolvedValue({ maxFeePerGas: parseGwei('11'), maxPriorityFeePerGas: 1n })
    }) })).resolves.toMatchObject({ status: 'skipped', state: 'gas_fee_cap' });
  });

  it('keeps a timeout pending for ten minutes and never resubmits the stable client order', async () => {
    const pendingStore = createMemoryRobinhoodPendingStore();
    const adapter = fakeAdapter({ waitForReceipt: vi.fn().mockResolvedValue(null) });
    const first = await executeBuy({ adapter, pendingStore, clientOrderId: 'stable-order' });
    expect(first).toMatchObject({
      status: 'pending_confirmation',
      clientOrderId: 'stable-order',
      transactionHash: hash,
      stage: 'swap'
    });
    const second = await executeBuy({ adapter, pendingStore, clientOrderId: 'stable-order' });
    expect(second).toEqual(first);
    expect(adapter.send).toHaveBeenCalledTimes(1);
  });

  it('reconciles a receipt after restart without submitting another transaction', async () => {
    const pendingStore = createMemoryRobinhoodPendingStore();
    const submitAdapter = fakeAdapter({ waitForReceipt: vi.fn().mockResolvedValue(null) });
    const pending = await executeBuy({ adapter: submitAdapter, pendingStore, clientOrderId: 'restart-order' });
    if (pending.status !== 'pending_confirmation') throw new Error('expected pending fixture');

    const restartedAdapter = fakeAdapter({
      getReceipt: vi.fn().mockResolvedValue(receipt([
        transferLog(token, router, account, 4_900n, 1)
      ]))
    });
    const results = await reconcileRobinhoodPending({
      adapter: restartedAdapter,
      pendingStore,
      config: parseRobinhoodExecutionConfig(configValues()),
      now: new Date(pending.expiresAt.getTime() - 1)
    });
    expect(results).toMatchObject([{
      status: 'filled',
      clientOrderId: 'restart-order',
      transactionHash: hash,
      feeTier: 3000,
      latencyMs: pending.expiresAt.getTime() - 1 - (pending.expiresAt.getTime() - 10 * 60_000)
    }]);
    expect(restartedAdapter.send).not.toHaveBeenCalled();
  });

  it('preserves an unknown legacy fee tier through receipt reconciliation', async () => {
    const pendingStore = createMemoryRobinhoodPendingStore();
    await pendingStore.save({
      clientOrderId: 'legacy-fee-order',
      stage: 'swap',
      hash,
      submittedAt: new Date('2026-07-26T10:00:00.000Z'),
      expiresAt: new Date('2026-07-26T10:10:00.000Z'),
      direction: 'buy',
      account,
      token,
      baseAsset: weth,
      amountIn: '100000000000000000',
      quotedAmountOut: '5000',
      feeTier: null,
      slippageBps: 300
    });

    await expect(reconcileRobinhoodPending({
      adapter: fakeAdapter({
        getReceipt: vi.fn().mockResolvedValue(receipt([
          transferLog(token, router, account, 4_900n, 1)
        ]))
      }),
      pendingStore,
      config: parseRobinhoodExecutionConfig(configValues()),
      now: new Date('2026-07-26T10:01:00.000Z')
    })).resolves.toMatchObject([{
      status: 'filled',
      clientOrderId: 'legacy-fee-order',
      feeTier: null
    }]);
    await expect(pendingStore.findResolution('legacy-fee-order')).resolves.toMatchObject({
      status: 'filled',
      feeTier: null
    });
  });

  it('retains the stable client order ID in a reverted receipt resolution', async () => {
    const pendingStore = createMemoryRobinhoodPendingStore();
    await expect(executeBuy({
      pendingStore,
      clientOrderId: 'reverted-order',
      adapter: fakeAdapter({ waitForReceipt: vi.fn().mockResolvedValue(receipt([], 'reverted')) })
    })).resolves.toMatchObject({
      status: 'failed',
      state: 'reverted',
      clientOrderId: 'reverted-order',
      transactionHash: hash
    });
    await expect(pendingStore.findResolution('reverted-order')).resolves.toMatchObject({
      status: 'failed',
      clientOrderId: 'reverted-order'
    });
  });

  it('keeps receipt RPC failures pending and does not fabricate a terminal failure', async () => {
    const pendingStore = createMemoryRobinhoodPendingStore();
    const submitAdapter = fakeAdapter({ waitForReceipt: vi.fn().mockResolvedValue(null) });
    const pending = await executeBuy({
      adapter: submitAdapter,
      pendingStore,
      clientOrderId: 'rpc-reconcile-order'
    });
    if (pending.status !== 'pending_confirmation') throw new Error('expected pending fixture');

    const restartedAdapter = fakeAdapter({
      getReceipt: vi.fn().mockRejectedValue(new Error('RPC temporarily unavailable'))
    });
    await expect(reconcileRobinhoodPending({
      adapter: restartedAdapter,
      pendingStore,
      config: parseRobinhoodExecutionConfig(configValues()),
      now: new Date(pending.expiresAt.getTime() - 1)
    })).resolves.toEqual([pending]);
    await expect(pendingStore.findUnresolved('rpc-reconcile-order')).resolves.not.toBeNull();
    expect(restartedAdapter.send).not.toHaveBeenCalled();
  });

  it('caps native BUY value below balance minus reserve and maximum fee budget', async () => {
    const adapter = fakeAdapter({ getNativeBalance: vi.fn().mockResolvedValue(10_000_000_000_000_000n) });
    const result = await executeBuy({ adapter });
    expect(result.status).toBe('filled');
    const submitted = vi.mocked(adapter.send).mock.calls[0][0];
    expect(submitted.value).toBe(4_500_000_000_000_000n);
  });
});
