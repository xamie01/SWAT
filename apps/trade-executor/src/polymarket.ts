import {
  OrderType,
  OrderSide,
  SignatureType,
  WalletType,
  createPublicClient,
  createSecureClient,
  production,
  type SecureClientOptions
} from '@polymarket/client';
import {
  ApiKeySchema,
  BuilderCodeSchema,
  type BuilderCode
} from '@polymarket/bindings';
import {
  ApiKeyCredsSchema,
  AssetType,
  BuilderApiKeyCredsSchema,
  type ApiKeyCreds,
  type ClobTrade,
  type OpenOrder,
  type OrderBook
} from '@polymarket/bindings/clob';
import {
  fetchBalanceAllowance,
  fetchBuilderFeeRates
} from '@polymarket/client/actions';
import { builderApiKey, type BuilderApiKeyCreds } from '@polymarket/client/node';
import { signerFrom } from '@polymarket/client/ethers-v5';
import { ethers } from 'ethers';
import { UnrecoverableError } from 'bullmq';
import {
  query,
  recordCopyExecutionEvidence,
  transitionCopyExecution
} from '@swat/db';
import { capPositionToAvailableBalance } from './policy.js';

export const POLYMARKET_CLOB_HOST = 'https://clob.polymarket.com';
export const POLYGON_CHAIN_ID = 137;
export const POLYMARKET_SDK_VERSION = '0.2.0';
export const POLYMARKET_DECIMALS = 6;
export const POLYMARKET_SHARE_DECIMALS = 2;

const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;

export const polygonProvider = new ethers.providers.JsonRpcProvider(
  process.env.POLYGON_RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com'
);

export const polymarketSigner = EVM_PRIVATE_KEY
  ? new ethers.Wallet(
      EVM_PRIVATE_KEY.startsWith('0x') ? EVM_PRIVATE_KEY : `0x${EVM_PRIVATE_KEY}`,
      polygonProvider
    )
  : null;

const publicClobClient = createPublicClient({ environment: production });
type PolymarketSecureClient = Awaited<ReturnType<typeof createSecureClient>>;
type PolymarketClientFactory = (
  options: SecureClientOptions
) => Promise<PolymarketSecureClient>;

let secureClobClient: PolymarketSecureClient | null = null;

let liveReadiness = {
  ready: false,
  reason: 'Polymarket startup verification has not completed'
};

export interface PolymarketIdentity {
  signerAddress: string;
  funderAddress: string;
  signatureType: SignatureType;
  signatureTypeName: keyof typeof SignatureType;
  builderCode: BuilderCode;
  directWalletWritesAllowed: boolean;
}

export interface PolymarketClientInitialization extends PolymarketIdentity {
  credentialSource: 'environment' | 'derived';
  builderAuthentication: 'none' | 'local';
  builderMakerFeeBps: number;
  builderTakerFeeBps: number;
}

function requiredTrimmed(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required for Polymarket live execution`);
  return trimmed;
}

export function parsePolymarketSignatureType(value: string | undefined): {
  value: SignatureType;
  name: keyof typeof SignatureType;
} {
  const name = requiredTrimmed(value, 'POLYMARKET_SIGNATURE_TYPE').toUpperCase();
  switch (name) {
    case 'EOA':
      return { value: SignatureType.EOA, name: 'EOA' };
    case 'POLY_PROXY':
      return { value: SignatureType.POLY_PROXY, name: 'POLY_PROXY' };
    case 'POLY_GNOSIS_SAFE':
      return { value: SignatureType.POLY_GNOSIS_SAFE, name: 'POLY_GNOSIS_SAFE' };
    case 'POLY_1271':
      return { value: SignatureType.POLY_1271, name: 'POLY_1271' };
    default:
      throw new Error(`Unsupported POLYMARKET_SIGNATURE_TYPE: ${name}`);
  }
}

export function parsePolymarketBuilderCode(value: string | undefined): BuilderCode {
  const builderCode = requiredTrimmed(value, 'POLYMARKET_BUILDER_CODE');
  if (!/^0x[0-9a-fA-F]{64}$/.test(builderCode)) {
    throw new Error('POLYMARKET_BUILDER_CODE must be a bytes32 value (0x plus 64 hex characters)');
  }
  return BuilderCodeSchema.parse(builderCode.toLowerCase());
}

export function loadPolymarketApiCredentials(
  env: NodeJS.ProcessEnv = process.env
): ApiKeyCreds | null {
  const values = [
    env.POLYMARKET_API_KEY?.trim(),
    env.POLYMARKET_API_SECRET?.trim(),
    env.POLYMARKET_API_PASSPHRASE?.trim()
  ];
  const present = values.filter(Boolean).length;
  if (present === 0) return null;
  if (present !== values.length) {
    throw new Error(
      'POLYMARKET_API_KEY, POLYMARKET_API_SECRET, and POLYMARKET_API_PASSPHRASE must be configured together'
    );
  }
  return ApiKeyCredsSchema.parse({
    apiKey: values[0],
    secret: values[1],
    passphrase: values[2]
  });
}

export function loadPolymarketBuilderCredentials(
  env: NodeJS.ProcessEnv = process.env
): BuilderApiKeyCreds | null {
  const values = [
    env.POLYMARKET_BUILDER_API_KEY?.trim(),
    env.POLYMARKET_BUILDER_API_SECRET?.trim(),
    env.POLYMARKET_BUILDER_API_PASSPHRASE?.trim()
  ];
  const present = values.filter(Boolean).length;
  if (present === 0) return null;
  if (present !== values.length) {
    throw new Error(
      'POLYMARKET_BUILDER_API_KEY, POLYMARKET_BUILDER_API_SECRET, and ' +
      'POLYMARKET_BUILDER_API_PASSPHRASE must be configured together'
    );
  }
  return BuilderApiKeyCredsSchema.parse({
    key: values[0],
    secret: values[1],
    passphrase: values[2]
  });
}

export function resolvePolymarketIdentity(
  signerAddress: string,
  env: NodeJS.ProcessEnv = process.env
): PolymarketIdentity {
  const normalizedSigner = ethers.utils.getAddress(signerAddress);
  const signatureType = parsePolymarketSignatureType(env.POLYMARKET_SIGNATURE_TYPE);
  const configuredFunder = env.POLYMARKET_FUNDER_ADDRESS?.trim();
  const funderAddress = configuredFunder
    ? ethers.utils.getAddress(configuredFunder)
    : normalizedSigner;

  if (signatureType.value === SignatureType.EOA && funderAddress !== normalizedSigner) {
    throw new Error('EOA signature mode requires POLYMARKET_FUNDER_ADDRESS to equal the signer');
  }
  if (signatureType.value !== SignatureType.EOA && !configuredFunder) {
    throw new Error('POLYMARKET_FUNDER_ADDRESS is required for proxy, Safe, or EIP-1271 signing');
  }

  return {
    signerAddress: normalizedSigner,
    funderAddress,
    signatureType: signatureType.value,
    signatureTypeName: signatureType.name,
    builderCode: parsePolymarketBuilderCode(env.POLYMARKET_BUILDER_CODE),
    directWalletWritesAllowed:
      signatureType.value === SignatureType.EOA && funderAddress === normalizedSigner
  };
}

function assertCredentials(credentials: unknown): asserts credentials is ApiKeyCreds {
  if (
    typeof credentials !== 'object' ||
    credentials === null ||
    !('key' in credentials) ||
    !('secret' in credentials) ||
    !('passphrase' in credentials) ||
    !ApiKeySchema.safeParse(credentials.key).success ||
    typeof credentials.secret !== 'string' ||
    credentials.secret.trim() === '' ||
    typeof credentials.passphrase !== 'string' ||
    credentials.passphrase.trim() === ''
  ) {
    throw new Error('Polymarket returned incomplete L2 API credentials');
  }
}

export function assertSupportedPolymarketRuntime(nodeVersion = process.versions.node): void {
  const major = Number(nodeVersion.split('.')[0]);
  if (!Number.isInteger(major) || major < 24) {
    throw new Error(
      `@polymarket/client ${POLYMARKET_SDK_VERSION} requires Node.js 24 or newer; found ${nodeVersion}`
    );
  }
}

function expectedWalletType(signatureType: SignatureType): WalletType {
  switch (signatureType) {
    case SignatureType.EOA:
      return WalletType.EOA;
    case SignatureType.POLY_PROXY:
      return WalletType.POLY_PROXY;
    case SignatureType.POLY_GNOSIS_SAFE:
      return WalletType.GNOSIS_SAFE;
    case SignatureType.POLY_1271:
      return WalletType.DEPOSIT_WALLET;
  }
}

function requireSecureClobClient(): PolymarketSecureClient {
  if (!secureClobClient) {
    throw new UnrecoverableError('Polymarket authenticated client is not initialized');
  }
  return secureClobClient;
}

export function setPolymarketClientForTesting(client: PolymarketSecureClient | null): void {
  secureClobClient = client;
}

export async function initializePolymarketClient(
  env: NodeJS.ProcessEnv = process.env,
  clientFactory: PolymarketClientFactory = createSecureClient,
  nodeVersion = process.versions.node
): Promise<PolymarketClientInitialization> {
  secureClobClient = null;
  setPolymarketLiveReadiness(
    false,
    'Polymarket authenticated client initialization is in progress'
  );
  assertSupportedPolymarketRuntime(nodeVersion);
  if (!polymarketSigner) {
    throw new Error('EVM_PRIVATE_KEY is required for Polymarket live execution');
  }

  const identity = resolvePolymarketIdentity(polymarketSigner.address, env);
  const credentials = loadPolymarketApiCredentials(env);
  const builderCredentials = loadPolymarketBuilderCredentials(env);
  const credentialSource = credentials ? 'environment' : 'derived';
  const options: SecureClientOptions = {
    environment: production,
    signer: signerFrom(polymarketSigner),
    wallet: identity.funderAddress,
    ...(credentials ? { credentials } : {}),
    ...(builderCredentials ? { apiKey: builderApiKey(builderCredentials) } : {})
  };
  const authenticatedClient = await clientFactory(options);
  assertCredentials(authenticatedClient.credentials);
  if (authenticatedClient.account.signer.toLowerCase() !== identity.signerAddress.toLowerCase()) {
    throw new Error('Authenticated CLOB signer does not match EVM_PRIVATE_KEY');
  }
  if (authenticatedClient.account.wallet.toLowerCase() !== identity.funderAddress.toLowerCase()) {
    throw new Error('Authenticated CLOB wallet does not match POLYMARKET_FUNDER_ADDRESS');
  }
  const requiredWalletType = expectedWalletType(identity.signatureType);
  if (authenticatedClient.account.walletType !== requiredWalletType) {
    throw new Error(
      `POLYMARKET_SIGNATURE_TYPE ${identity.signatureTypeName} does not match the SDK-classified wallet`
    );
  }

  const [closedOnly, openOrdersPage, builderFeeRates] = await Promise.all([
    authenticatedClient.fetchClosedOnlyMode(),
    authenticatedClient.listOpenOrders().firstPage(),
    fetchBuilderFeeRates(authenticatedClient, { builderCode: identity.builderCode })
  ]);
  if (closedOnly) {
    throw new Error('Polymarket account is in closed-only mode');
  }
  if (!Array.isArray(openOrdersPage.items)) {
    throw new Error('Authenticated CLOB open-order round trip returned an invalid page');
  }
  const builderMakerFeeBps = boundedBuilderFeeBps(builderFeeRates.maker, 'maker', 50);
  const builderTakerFeeBps = boundedBuilderFeeBps(builderFeeRates.taker, 'taker', 100);

  secureClobClient = authenticatedClient;
  return {
    ...identity,
    credentialSource,
    builderAuthentication: builderCredentials ? 'local' : 'none',
    builderMakerFeeBps,
    builderTakerFeeBps
  };
}

function boundedBuilderFeeBps(rate: number, label: string, maximumBps: number): number {
  const scaled = rate * 10_000;
  const basisPoints = Math.round(scaled);
  if (
    !Number.isFinite(rate) ||
    rate < 0 ||
    Math.abs(scaled - basisPoints) > 1e-9 ||
    basisPoints > maximumBps
  ) {
    throw new Error(`Polymarket returned ${label} builder fees outside the supported limits`);
  }
  return basisPoints;
}

export function setPolymarketLiveReadiness(ready: boolean, reason?: string): void {
  liveReadiness = {
    ready,
    reason: reason ?? (ready ? 'verified' : 'Polymarket live readiness was revoked')
  };
}

export function getPolymarketLiveReadiness(): Readonly<typeof liveReadiness> {
  return liveReadiness;
}

export function parsePolymarketFixed6(value: string, label: string): number {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new UnrecoverableError(`Polymarket returned an invalid ${label}`);
  }
  const units = BigInt(value);
  const whole = units / 1_000_000n;
  const fraction = units % 1_000_000n;
  const result = Number(whole) + Number(fraction) / 1_000_000;
  if (!Number.isSafeInteger(Number(whole)) || !Number.isFinite(result)) {
    throw new UnrecoverableError(`Polymarket ${label} exceeds the supported numeric range`);
  }
  return result;
}

export async function getPolymarketAvailableBalance(
  tokenID: string,
  direction: 'buy' | 'sell'
): Promise<number> {
  const params = direction === 'buy'
    ? { assetType: AssetType.COLLATERAL }
    : { assetType: AssetType.CONDITIONAL, tokenId: tokenID };
  const client = requireSecureClobClient();
  const result = await fetchBalanceAllowance(client, params);
  return parsePolymarketFixed6(result.balance, `${direction} balance`);
}

export async function getPolymarketAskPrice(
  tokenID: string,
  side: OrderSide = OrderSide.BUY
): Promise<number> {
  const book = await (secureClobClient ?? publicClobClient).fetchOrderBook({ tokenId: tokenID });
  const levels = side === OrderSide.BUY ? book.asks : book.bids;
  if (!levels || levels.length === 0) {
    throw new UnrecoverableError(
      `No ${side === OrderSide.BUY ? 'asks' : 'bids'} available for token ${tokenID}`
    );
  }

  const prices = levels.map((level) => Number(level.price));
  if (prices.some((price) => !Number.isFinite(price) || price <= 0 || price >= 1)) {
    throw new UnrecoverableError(`Polymarket returned an invalid order-book price for ${tokenID}`);
  }
  return side === OrderSide.BUY ? Math.min(...prices) : Math.max(...prices);
}

export interface PolymarketBookPlan {
  bestPrice: number;
  limitPrice: number;
  averagePrice: number;
  estimatedShares: number;
  estimatedNotionalUsd: number;
  slippageBps: number;
}

function parsePositiveDecimal(value: string, label: string): number {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
    throw new UnrecoverableError(`Polymarket returned an invalid ${label}`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UnrecoverableError(`Polymarket returned an invalid ${label}`);
  }
  return parsed;
}

function floorDecimal(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.floor((value + Number.EPSILON) * scale) / scale;
}

function validateBookTimestamp(book: OrderBook, now = Date.now()): void {
  if (book.timestamp === undefined || book.timestamp === null) {
    throw new UnrecoverableError('Polymarket order book is missing its observation timestamp');
  }
  const timestamp = Number(book.timestamp);
  const maxAgeMs = Number(process.env.POLYMARKET_MAX_BOOK_AGE_MS ?? '15000');
  if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1_000 || maxAgeMs > 120_000) {
    throw new UnrecoverableError(
      'POLYMARKET_MAX_BOOK_AGE_MS must be an integer between 1000 and 120000'
    );
  }
  if (!Number.isFinite(timestamp) || timestamp > now + 5_000 || now - timestamp > maxAgeMs) {
    throw new UnrecoverableError('Polymarket order book observation is stale or invalid');
  }
}

export function planPolymarketBookOrder(
  book: OrderBook,
  direction: 'buy' | 'sell',
  requestedAmount: number,
  maxSlippageBps: number,
  now = Date.now()
): PolymarketBookPlan {
  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
    throw new UnrecoverableError('Polymarket order amount must be positive');
  }
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps > 5_000) {
    throw new UnrecoverableError('POLYMARKET_SLIPPAGE_BPS must be an integer from 0 to 5000');
  }
  validateBookTimestamp(book, now);

  const tickSize = parsePositiveDecimal(String(book.tickSize), 'tick size');
  const minimumShares = parsePositiveDecimal(String(book.minOrderSize), 'minimum order size');
  const rawLevels = direction === 'buy' ? book.asks : book.bids;
  if (rawLevels.length === 0) {
    throw new UnrecoverableError(
      `No ${direction === 'buy' ? 'asks' : 'bids'} available for token ${book.tokenId}`
    );
  }

  const levels = rawLevels
    .map((level) => ({
      price: parsePositiveDecimal(String(level.price), 'order-book price'),
      size: parsePositiveDecimal(String(level.size), 'order-book size')
    }))
    .sort((left, right) => direction === 'buy'
      ? left.price - right.price
      : right.price - left.price);

  for (const level of levels) {
    if (level.price >= 1) {
      throw new UnrecoverableError(`Polymarket returned an invalid order-book price for ${book.tokenId}`);
    }
    const tickRatio = level.price / tickSize;
    if (Math.abs(tickRatio - Math.round(tickRatio)) > 1e-8) {
      throw new UnrecoverableError('Polymarket order-book price is off the current tick-size grid');
    }
  }

  let remaining = requestedAmount;
  let shares = 0;
  let notional = 0;
  let limitPrice = levels[0]!.price;
  for (const level of levels) {
    if (remaining <= 1e-9) break;
    if (direction === 'buy') {
      const levelNotional = level.size * level.price;
      const consumedNotional = Math.min(remaining, levelNotional);
      shares += consumedNotional / level.price;
      notional += consumedNotional;
      remaining -= consumedNotional;
    } else {
      const consumedShares = Math.min(remaining, level.size);
      shares += consumedShares;
      notional += consumedShares * level.price;
      remaining -= consumedShares;
    }
    limitPrice = level.price;
  }

  if (remaining > 1e-8) {
    throw new UnrecoverableError('Polymarket Protection: order book is too thin for the requested size');
  }

  shares = floorDecimal(shares, POLYMARKET_SHARE_DECIMALS);
  if (shares < minimumShares) {
    throw new UnrecoverableError(
      `Polymarket order is below the ${minimumShares}-share minimum after venue rounding`
    );
  }
  const bestPrice = levels[0]!.price;
  const slippageBps = direction === 'buy'
    ? ((limitPrice / bestPrice) - 1) * 10_000
    : (1 - (limitPrice / bestPrice)) * 10_000;
  if (slippageBps > maxSlippageBps + 1e-8) {
    throw new UnrecoverableError(
      `Polymarket Protection: required depth exceeds ${maxSlippageBps} bps slippage`
    );
  }

  return {
    bestPrice,
    limitPrice,
    averagePrice: notional / (direction === 'buy' ? shares : requestedAmount),
    estimatedShares: shares,
    estimatedNotionalUsd: notional,
    slippageBps
  };
}

function collateralAvailableForPrincipal(available: number): number {
  const feeBufferBps = Number(process.env.POLYMARKET_FEE_BUFFER_BPS ?? '300');
  if (!Number.isInteger(feeBufferBps) || feeBufferBps < 0 || feeBufferBps > 5000) {
    throw new UnrecoverableError(
      'POLYMARKET_FEE_BUFFER_BPS must be an integer between 0 and 5000'
    );
  }
  return available * 10_000 / (10_000 + feeBufferBps);
}

export async function triggerPolymarket(params: {
  signalId: string;
  tokenID: string;
  spendAmountUsd: number;
  direction: 'buy' | 'sell';
  sellShares?: number;
}) {
  if (!liveReadiness.ready) {
    throw new UnrecoverableError(`Polymarket live execution is not ready: ${liveReadiness.reason}`);
  }
  if (!polymarketSigner) {
    throw new UnrecoverableError('Polymarket signer is not initialized');
  }

  try {
    const identity = resolvePolymarketIdentity(polymarketSigner.address);
    const client = requireSecureClobClient();
    const existingExecutions = await query<{ venue_order_id: string | null; status: string }>(
      `SELECT trade.venue_order_id, trade.status
         FROM trades trade
         LEFT JOIN copy_executions execution ON execution.id = trade.copy_execution_id
        WHERE (trade.signal_id::text = $1 OR execution.client_order_id = $1)
          AND trade.chain = 'polygon'
          AND trade.execution_mode = 'live'
          AND trade.executor = 'polymarket-clob'
          AND trade.status NOT IN ('failed', 'skipped', 'cancelled', 'rejected')
        ORDER BY trade.executed_at DESC
        LIMIT 1`,
      [params.signalId]
    );
    if (existingExecutions.length > 0) {
      throw new UnrecoverableError(
        `Polymarket Protection: signal ${params.signalId} already has an active execution`
      );
    }
    const openOrders = await client.listOpenOrders({ tokenId: params.tokenID }).firstPage();
    if (openOrders.items.length > 0) {
      throw new UnrecoverableError(
        `Polymarket Protection: Open orders already exist for ${params.tokenID}. Aborting to prevent double-spend.`
      );
    }

    const availableBalance = await getPolymarketAvailableBalance(params.tokenID, params.direction);
    let spendAmountUsd = params.spendAmountUsd;
    let requestedShares = params.sellShares ?? 0;
    if (params.direction === 'buy') {
      spendAmountUsd = capPositionToAvailableBalance({
        requested: params.spendAmountUsd,
        available: collateralAvailableForPrincipal(availableBalance),
        maximum: params.spendAmountUsd,
        precision: POLYMARKET_DECIMALS
      });
    } else if (params.sellShares === undefined) {
      throw new UnrecoverableError('Polymarket sells require an exact requested share quantity');
    }

    if (params.direction === 'sell') {
      requestedShares = capPositionToAvailableBalance({
        requested: requestedShares,
        available: availableBalance,
        maximum: requestedShares,
        precision: POLYMARKET_SHARE_DECIMALS
      });
    }
    if (
      (params.direction === 'buy' && spendAmountUsd <= 0)
      || (params.direction === 'sell' && requestedShares <= 0)
    ) {
      throw new UnrecoverableError(
        `Polymarket ${params.direction} balance is insufficient for the minimum order size`
      );
    }

    const book = await client.fetchOrderBook({ tokenId: params.tokenID });
    const maxSlippageBps = Number(process.env.POLYMARKET_SLIPPAGE_BPS ?? '200');
    const plan = planPolymarketBookOrder(
      book,
      params.direction,
      params.direction === 'buy' ? spendAmountUsd : requestedShares,
      maxSlippageBps
    );
    const maximumEntryPrice = Number(process.env.POLYMARKET_MAX_ENTRY_PRICE ?? '0.97');
    const minimumExitPrice = Number(process.env.POLYMARKET_MIN_EXIT_PRICE ?? '0.01');
    if (
      !Number.isFinite(maximumEntryPrice) || maximumEntryPrice <= 0 || maximumEntryPrice >= 1 ||
      !Number.isFinite(minimumExitPrice) || minimumExitPrice <= 0 || minimumExitPrice >= 1
    ) {
      throw new UnrecoverableError('Polymarket entry/exit price bounds are invalid');
    }
    if (
      (params.direction === 'buy' && plan.limitPrice > maximumEntryPrice) ||
      (params.direction === 'sell' && plan.limitPrice < minimumExitPrice)
    ) {
      throw new UnrecoverableError(
        `Polymarket Protection: Price ${plan.limitPrice} outside safe bounds configured for this executor`
      );
    }

    const tradeSide = params.direction === 'buy' ? OrderSide.BUY : OrderSide.SELL;
    const order = await client.createMarketOrder(params.direction === 'buy'
      ? {
          tokenId: params.tokenID,
          side: OrderSide.BUY,
          amount: spendAmountUsd,
          maxSpend: spendAmountUsd,
          maxPrice: plan.limitPrice,
          orderType: OrderType.FAK,
          builderCode: identity.builderCode
        }
      : {
          tokenId: params.tokenID,
          side: OrderSide.SELL,
          shares: requestedShares,
          minPrice: plan.limitPrice,
          orderType: OrderType.FAK,
          builderCode: identity.builderCode
        });
    if (
      typeof order.builder !== 'string' ||
      order.builder.toLowerCase() !== identity.builderCode
    ) {
      throw new UnrecoverableError('Polymarket signed order omitted the configured builder code');
    }

    const startTime = Date.now();
    const response = await client.postOrder(order);
    const latencyMs = Date.now() - startTime;
    if (!response.ok) {
      throw new UnrecoverableError(`Polymarket order rejected: ${response.code}: ${response.message}`);
    }

    const pendingResult = (reason: string) => ({
      orderId: response.orderId,
      status: response.status,
      executionStatus: 'pending_confirmation' as const,
      reason,
      settlementTransactionHashes: response.transactionsHashes ?? [],
      tradeIds: response.tradeIds ?? [],
      latencyMs,
      spendAmountUsd: 0,
      shares: 0,
      averagePrice: null,
      feesUsd: null,
      requestedSpendAmountUsd: params.direction === 'buy' ? spendAmountUsd : plan.estimatedNotionalUsd,
      requestedShares: params.direction === 'buy' ? plan.estimatedShares : requestedShares,
      slippageBps: plan.slippageBps
    });
    if (response.tradeIds.length === 0) {
      return pendingResult(`Polymarket order was accepted with venue status ${response.status}`);
    }

    let settlementTransactionHashes: string[];
    try {
      const timeoutMs = Number(process.env.POLYMARKET_SETTLEMENT_TIMEOUT_MS ?? '30000');
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
        throw new Error(
          'POLYMARKET_SETTLEMENT_TIMEOUT_MS must be an integer between 1000 and 120000'
        );
      }
      settlementTransactionHashes = await client.waitForOrderFillSettlement(response, { timeoutMs });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return pendingResult(`Polymarket fill settlement is unresolved: ${message}`);
    }

    const fills: ClobTrade[] = [];
    try {
      for (const tradeId of response.tradeIds) {
        const page = await client.listAccountTrades({ id: tradeId }).firstPage();
        const fill = page.items.find((item) => item.id === tradeId);
        if (!fill || fill.tokenId !== params.tokenID || fill.takerOrderId !== response.orderId) {
          return pendingResult(`Polymarket fill ${tradeId} could not be attributed to the submitted order`);
        }
        fills.push(fill);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return pendingResult(`Polymarket fill details are unresolved: ${message}`);
    }

    const confirmedFills = fills.filter((fill) => fill.status.toUpperCase() === 'CONFIRMED');
    if (confirmedFills.length !== fills.length || confirmedFills.length === 0) {
      return pendingResult('Polymarket fills have not all reached confirmed terminal state');
    }
    let actualShares = 0;
    let actualNotionalUsd = 0;
    let feesUsd = 0;
    for (const fill of confirmedFills) {
      const size = parsePositiveDecimal(String(fill.size), 'confirmed fill size');
      const price = parsePositiveDecimal(String(fill.price), 'confirmed fill price');
      const feeRateBps = Number(fill.feeRateBps);
      if (!Number.isFinite(feeRateBps) || feeRateBps < 0) {
        return pendingResult(`Polymarket fill ${fill.id} has an invalid fee rate`);
      }
      actualShares += size;
      actualNotionalUsd += size * price;
      if (fill.traderSide === 'TAKER') {
        feesUsd += size * (feeRateBps / 10_000) * price * (1 - price);
      }
    }
    const requested = params.direction === 'buy' ? plan.estimatedShares : requestedShares;
    const executionStatus = params.direction === 'buy'
      ? actualNotionalUsd + feesUsd + 0.01 < spendAmountUsd ? 'partial' : 'filled'
      : actualShares + 1e-8 < requestedShares ? 'partial' : 'filled';
    const hashes = Array.from(new Set([
      ...settlementTransactionHashes,
      ...confirmedFills.map((fill) => fill.transactionHash).filter(Boolean)
    ]));
    if (hashes.length === 0) {
      return pendingResult('Polymarket confirmed fills did not include settlement identity');
    }

    return {
      orderId: response.orderId,
      status: response.status,
      executionStatus,
      settlementTransactionHashes: hashes,
      tradeIds: response.tradeIds,
      latencyMs,
      spendAmountUsd: actualNotionalUsd,
      shares: actualShares,
      averagePrice: actualNotionalUsd / actualShares,
      feesUsd,
      requestedSpendAmountUsd: params.direction === 'buy' ? spendAmountUsd : plan.estimatedNotionalUsd,
      requestedShares: requested,
      slippageBps: plan.slippageBps
    };
  } catch (error: unknown) {
    if (error instanceof UnrecoverableError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new UnrecoverableError(`Polymarket execution failed: ${message}`);
  }
}

type PendingPolymarketTrade = {
  id: string;
  signal_id: string | null;
  copy_execution_id: string | null;
  token_mint: string;
  direction: 'buy' | 'sell';
  venue_order_id: string;
  submitted_at: Date | string | null;
};

type OrderState = 'pending' | 'matched' | 'cancelled' | 'failed' | 'ambiguous';

export type PolymarketReconciliationStatus =
  | 'pending_confirmation'
  | 'partial'
  | 'filled'
  | 'cancelled'
  | 'failed'
  | 'ambiguous';

export interface PolymarketReconciliationOutcome {
  tradeId: string;
  orderId: string;
  status: PolymarketReconciliationStatus;
  reason?: string;
  shares?: number;
  amountUsd?: number;
  averagePrice?: number;
  feesUsd?: number | null;
  venueTradeIds?: string[];
  settlementTransactionHashes?: string[];
}

type AssociatedTradeEvidence = {
  confirmed: ClobTrade[];
  failedIds: string[];
  pendingIds: string[];
  missingIds: string[];
};

type ConfirmedFillSummary = {
  shares: number;
  amountUsd: number;
  averagePrice: number;
  feesUsd: number | null;
  venueTradeIds: string[];
  settlementTransactionHashes: string[];
  occurredAt: Date;
};

const POLYMARKET_ORDER_TIMEOUT_MS = 10 * 60 * 1000;

function nonNegativeDecimal(value: string, label: string): number {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
    throw new Error(`Polymarket returned an invalid ${label}`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Polymarket returned an invalid ${label}`);
  }
  return parsed;
}

function normalizedVenueStatus(value: string): string {
  return value.trim().toUpperCase().replace(/^ORDER_STATUS_/, '');
}

function normalizedTradeStatus(value: string): string {
  return value.trim().toUpperCase().replace(/^TRADE_STATUS_/, '');
}

function classifyOrderState(status: string): OrderState {
  switch (normalizedVenueStatus(status)) {
    case 'LIVE':
    case 'OPEN':
    case 'DELAYED':
    case 'PENDING':
      return 'pending';
    case 'MATCHED':
    case 'FILLED':
    case 'COMPLETED':
      return 'matched';
    case 'CANCELLED':
    case 'CANCELED':
    case 'EXPIRED':
      return 'cancelled';
    case 'FAILED':
    case 'REJECTED':
    case 'INVALID':
      return 'failed';
    default:
      return 'ambiguous';
  }
}

function unprefixedPolygonToken(value: string): string {
  return value.startsWith('polygon:') ? value.slice('polygon:'.length) : value;
}

function quantitiesMatch(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-8, Math.max(left, right) * 1e-8);
}

function validateFetchedOrder(row: PendingPolymarketTrade, order: OpenOrder): {
  originalSize: number;
  matchedSize: number;
} {
  if (order.id !== row.venue_order_id) {
    throw new Error(`Polymarket returned order ${order.id} for requested order ${row.venue_order_id}`);
  }
  if (String(order.tokenId) !== unprefixedPolygonToken(row.token_mint)) {
    throw new Error(`Polymarket order ${order.id} token does not match its persisted trade`);
  }
  if (order.side.trim().toUpperCase() !== row.direction.toUpperCase()) {
    throw new Error(`Polymarket order ${order.id} side does not match its persisted trade`);
  }
  if (order.orderType.trim().toUpperCase() !== OrderType.FAK) {
    throw new Error(`Polymarket order ${order.id} is not the expected FAK order`);
  }

  const originalSize = nonNegativeDecimal(String(order.originalSize), 'order original size');
  const matchedSize = nonNegativeDecimal(String(order.sizeMatched), 'order matched size');
  if (originalSize <= 0 || matchedSize > originalSize && !quantitiesMatch(matchedSize, originalSize)) {
    throw new Error(`Polymarket order ${order.id} returned inconsistent matched quantities`);
  }
  return { originalSize, matchedSize };
}

async function fetchAssociatedTradeEvidence(
  client: PolymarketSecureClient,
  order: OpenOrder
): Promise<AssociatedTradeEvidence> {
  const evidence: AssociatedTradeEvidence = {
    confirmed: [],
    failedIds: [],
    pendingIds: [],
    missingIds: []
  };
  const tradeIds = [...new Set(order.associateTrades.filter((id) => id.trim() !== ''))];
  for (const tradeId of tradeIds) {
    const page = await client.listAccountTrades({ id: tradeId }).firstPage();
    const trade = page.items.find((item) => item.id === tradeId);
    if (!trade) {
      evidence.missingIds.push(tradeId);
      continue;
    }
    const status = normalizedTradeStatus(trade.status);
    if (status === 'CONFIRMED') {
      evidence.confirmed.push(trade);
    } else if (status === 'FAILED') {
      evidence.failedIds.push(tradeId);
    } else {
      evidence.pendingIds.push(tradeId);
    }
  }
  return evidence;
}

function summarizeConfirmedFills(order: OpenOrder, fills: ClobTrade[]): ConfirmedFillSummary {
  let shares = 0;
  let amountUsd = 0;
  let feesUsd = 0;
  let allFeesAvailable = true;
  let occurredAt = new Date(0);
  const venueTradeIds: string[] = [];
  const settlementTransactionHashes = new Set<string>();

  for (const fill of fills) {
    if (String(fill.tokenId) !== String(order.tokenId)) {
      throw new Error(`Polymarket fill ${fill.id} has a different token from order ${order.id}`);
    }

    const legs = fill.takerOrderId === order.id
      ? [{
          size: String(fill.size),
          price: String(fill.price),
          feeRateBps: fill.feeRateBps
        }]
      : fill.makerOrders
          .filter((makerOrder) => makerOrder.orderId === order.id)
          .map((makerOrder) => ({
            size: String(makerOrder.matchedAmount),
            price: String(makerOrder.price),
            feeRateBps: makerOrder.feeRateBps
          }));
    if (legs.length === 0) {
      throw new Error(`Polymarket fill ${fill.id} is not attributable to order ${order.id}`);
    }

    for (const leg of legs) {
      const legShares = nonNegativeDecimal(leg.size, `fill ${fill.id} size`);
      const price = nonNegativeDecimal(leg.price, `fill ${fill.id} price`);
      if (legShares <= 0 || price <= 0 || price >= 1) {
        throw new Error(`Polymarket fill ${fill.id} returned invalid execution quantities`);
      }
      shares += legShares;
      amountUsd += legShares * price;

      if (leg.feeRateBps === null || leg.feeRateBps === undefined || leg.feeRateBps === '') {
        allFeesAvailable = false;
      } else {
        const feeRateBps = nonNegativeDecimal(String(leg.feeRateBps), `fill ${fill.id} fee rate`);
        feesUsd += legShares * (feeRateBps / 10_000) * price * (1 - price);
      }
    }

    const transactionHash = fill.transactionHash.trim();
    if (!transactionHash) {
      throw new Error(`Polymarket confirmed fill ${fill.id} omitted its settlement transaction hash`);
    }
    venueTradeIds.push(fill.id);
    settlementTransactionHashes.add(transactionHash);

    const matchedAt = new Date(fill.matchedAt);
    if (Number.isNaN(matchedAt.getTime())) {
      throw new Error(`Polymarket fill ${fill.id} returned an invalid match timestamp`);
    }
    if (matchedAt > occurredAt) occurredAt = matchedAt;
  }

  if (shares <= 0 || amountUsd <= 0 || settlementTransactionHashes.size === 0) {
    throw new Error(`Polymarket order ${order.id} has incomplete confirmed fill evidence`);
  }
  return {
    shares,
    amountUsd,
    averagePrice: amountUsd / shares,
    feesUsd: allFeesAvailable ? feesUsd : null,
    venueTradeIds,
    settlementTransactionHashes: [...settlementTransactionHashes],
    occurredAt
  };
}

async function setPendingReconciliationState(
  row: PendingPolymarketTrade,
  venueStatus: string,
  reason: string | null
): Promise<void> {
  await query(
    `UPDATE trades
        SET venue_status = $2,
            error_message = $3
      WHERE id = $1
        AND status = 'pending_confirmation'`,
    [row.id, venueStatus, reason]
  );
}

async function markAmbiguous(
  row: PendingPolymarketTrade,
  reason: string
): Promise<PolymarketReconciliationOutcome> {
  if (row.copy_execution_id) {
    await transitionCopyExecution({
      executionId: row.copy_execution_id,
      nextState: 'reconciliation_required',
      reason,
      nextReconciliationAt: new Date(Date.now() + 30_000)
    });
  }
  await setPendingReconciliationState(row, 'ambiguous', reason);
  return {
    tradeId: row.id,
    orderId: row.venue_order_id,
    status: 'ambiguous',
    reason
  };
}

async function finishWithoutFill(
  row: PendingPolymarketTrade,
  status: 'cancelled' | 'failed',
  venueStatus: string,
  reason: string
): Promise<PolymarketReconciliationOutcome> {
  if (row.copy_execution_id) {
    await transitionCopyExecution({
      executionId: row.copy_execution_id,
      nextState: status,
      reason
    });
  }
  await query<{ id: string }>(
    `WITH reconciled AS (
       UPDATE trades
          SET status = $2,
              venue_status = $3,
              venue_trade_ids = '[]'::jsonb,
              settlement_transaction_hashes = '[]'::jsonb,
              error_message = $4
        WHERE id = $1
          AND status = 'pending_confirmation'
      RETURNING id, signal_id
     ), released_signal AS (
       UPDATE signals
          SET status = 'pending'
        WHERE id IN (SELECT signal_id FROM reconciled WHERE signal_id IS NOT NULL)
          AND status = 'executing'
      RETURNING id
     )
     SELECT id FROM reconciled`,
    [row.id, status, venueStatus, reason]
  );
  return {
    tradeId: row.id,
    orderId: row.venue_order_id,
    status,
    reason
  };
}

async function finishConfirmedFill(
  row: PendingPolymarketTrade,
  order: OpenOrder,
  status: 'partial' | 'filled',
  summary: ConfirmedFillSummary
): Promise<PolymarketReconciliationOutcome> {
  if (row.copy_execution_id) {
    await recordCopyExecutionEvidence({
      executionId: row.copy_execution_id,
      evidenceType: 'venue_fill',
      evidenceId: `order:${order.id}`,
      baseQuantity: summary.shares.toString(),
      quoteQuantity: summary.amountUsd.toString(),
      priceUsd: summary.averagePrice.toString(),
      confirmationState: 'confirmed',
      completesExecution: true,
      occurredAt: summary.occurredAt
    });
  }
  await query<{ id: string }>(
    `WITH reconciled AS (
       UPDATE trades
          SET status = $2,
              amount_sol = $3,
              amount_usd = $3,
              token_amount = $4,
              price_usd = $5,
              fee_usd = $6,
              signature = COALESCE($7, signature),
              venue_status = $8,
              venue_trade_ids = $9::jsonb,
              settlement_transaction_hashes = $10::jsonb,
              error_message = NULL,
              confirmed_at = COALESCE(confirmed_at, NOW())
        WHERE id = $1
          AND status = 'pending_confirmation'
      RETURNING id, signal_id
     ), executed_signal AS (
       UPDATE signals
          SET status = 'executed',
              executed_at = COALESCE(executed_at, NOW())
        WHERE id IN (SELECT signal_id FROM reconciled WHERE signal_id IS NOT NULL)
      RETURNING id
     )
     SELECT id FROM reconciled`,
    [
      row.id,
      status,
      summary.amountUsd,
      summary.shares,
      summary.averagePrice,
      summary.feesUsd,
      summary.settlementTransactionHashes[0] ?? null,
      order.status,
      JSON.stringify(summary.venueTradeIds),
      JSON.stringify(summary.settlementTransactionHashes)
    ]
  );
  return {
    tradeId: row.id,
    orderId: row.venue_order_id,
    status,
    shares: summary.shares,
    amountUsd: summary.amountUsd,
    averagePrice: summary.averagePrice,
    feesUsd: summary.feesUsd,
    venueTradeIds: summary.venueTradeIds,
    settlementTransactionHashes: summary.settlementTransactionHashes
  };
}

async function reconcilePendingPolymarketTrade(
  client: PolymarketSecureClient,
  row: PendingPolymarketTrade,
  now: number
): Promise<PolymarketReconciliationOutcome> {
  let order: OpenOrder;
  try {
    order = await client.fetchOrder({ orderId: row.venue_order_id });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return markAmbiguous(row, `Polymarket order fetch is unresolved: ${message}`);
  }

  let quantities: { originalSize: number; matchedSize: number };
  try {
    quantities = validateFetchedOrder(row, order);
  } catch (error: unknown) {
    return markAmbiguous(row, error instanceof Error ? error.message : String(error));
  }

  let orderState = classifyOrderState(order.status);
  if (orderState === 'ambiguous') {
    return markAmbiguous(row, `Polymarket order ${order.id} returned unknown status ${order.status}`);
  }

  let evidence: AssociatedTradeEvidence;
  try {
    evidence = await fetchAssociatedTradeEvidence(client, order);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return markAmbiguous(row, `Polymarket trade evidence lookup is unresolved: ${message}`);
  }

  if (evidence.missingIds.length > 0) {
    const reason = `Polymarket associated trades are not yet readable: ${evidence.missingIds.join(', ')}`;
    if (orderState === 'pending') {
      await setPendingReconciliationState(row, order.status, reason);
      return { tradeId: row.id, orderId: order.id, status: 'pending_confirmation', reason };
    }
    return markAmbiguous(row, reason);
  }
  if (evidence.pendingIds.length > 0) {
    const reason = `Polymarket associated trades are not confirmed: ${evidence.pendingIds.join(', ')}`;
    await setPendingReconciliationState(row, order.status, reason);
    return { tradeId: row.id, orderId: order.id, status: 'pending_confirmation', reason };
  }

  let summary: ConfirmedFillSummary | null = null;
  if (evidence.confirmed.length > 0) {
    try {
      summary = summarizeConfirmedFills(order, evidence.confirmed);
    } catch (error: unknown) {
      return markAmbiguous(row, error instanceof Error ? error.message : String(error));
    }
    if (!quantitiesMatch(summary.shares, quantities.matchedSize)) {
      return markAmbiguous(
        row,
        `Polymarket order ${order.id} matched size does not equal its confirmed trade evidence`
      );
    }
  } else if (quantities.matchedSize > 0) {
    if (evidence.failedIds.length > 0 && orderState !== 'cancelled') {
      return finishWithoutFill(
        row,
        'failed',
        order.status,
        `Polymarket order ${order.id} has only failed settlement trades`
      );
    }
    return markAmbiguous(row, `Polymarket order ${order.id} reports fills without confirmed trades`);
  }

  if (orderState === 'pending') {
    const createdAt = Date.parse(order.createdAt);
    if (!Number.isFinite(createdAt)) {
      return markAmbiguous(row, `Polymarket order ${order.id} returned an invalid creation timestamp`);
    }
    if (!summary && now - createdAt > POLYMARKET_ORDER_TIMEOUT_MS) {
      try {
        const cancellation = await client.cancelOrder({ orderId: order.id });
        if (cancellation.canceled.some((orderId) => String(orderId) === order.id)) {
          console.log(`[trade-executor] Cancelled timed out Polymarket order: ${order.id}`);
          return finishWithoutFill(
            row,
            'cancelled',
            'cancelled',
            'Polymarket order timed out without a confirmed fill'
          );
        }
        return markAmbiguous(row, `Polymarket did not confirm cancellation of timed out order ${order.id}`);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return markAmbiguous(row, `Polymarket cancellation is unresolved: ${message}`);
      }
    }
    const reason = summary
      ? `Polymarket order ${order.id} has confirmed fills but is not terminal`
      : `Polymarket order ${order.id} remains ${order.status}`;
    await setPendingReconciliationState(row, order.status, reason);
    return { tradeId: row.id, orderId: order.id, status: 'pending_confirmation', reason };
  }

  if (summary) {
    const status = quantitiesMatch(summary.shares, quantities.originalSize) ? 'filled' : 'partial';
    return finishConfirmedFill(row, order, status, summary);
  }
  if (orderState === 'cancelled') {
    return finishWithoutFill(
      row,
      'cancelled',
      order.status,
      `Polymarket order ${order.id} was cancelled without a confirmed fill`
    );
  }
  if (orderState === 'failed' || evidence.failedIds.length > 0) {
    return finishWithoutFill(
      row,
      'failed',
      order.status,
      `Polymarket order ${order.id} failed without a confirmed fill`
    );
  }
  return markAmbiguous(row, `Polymarket matched order ${order.id} has no confirmed fill evidence`);
}

/**
 * Reconcile the one pending trade belonging to a canonical execution.
 *
 * `pollPolymarketOrders` sweeps by `status = 'pending_confirmation'`, so an
 * execution whose trade row has already left that status is invisible to it.
 * The reconciliation coordinator claims from `copy_executions` instead and needs
 * to drive a single execution, so it comes through here.
 *
 * Returns null when there is nothing to reconcile — either live readiness is
 * absent or no matching pending trade row exists.
 */
export async function reconcilePolymarketExecution(
  executionId: string,
  now: number = Date.now()
): Promise<PolymarketReconciliationOutcome | null> {
  if (!liveReadiness.ready) return null;
  const client = requireSecureClobClient();
  const [row] = await query<PendingPolymarketTrade>(
    `SELECT id, signal_id, copy_execution_id, token_mint, direction,
            venue_order_id, submitted_at
       FROM trades
      WHERE copy_execution_id = $1
        AND chain = 'polygon'
        AND executor = 'polymarket-clob'
        AND venue_order_id IS NOT NULL
      ORDER BY COALESCE(submitted_at, executed_at) DESC, id DESC
      LIMIT 1`,
    [executionId]
  );
  if (!row) return null;
  return reconcilePendingPolymarketTrade(client, row, now);
}

export async function pollPolymarketOrders(): Promise<PolymarketReconciliationOutcome[]> {
  if (!liveReadiness.ready) return [];
  const outcomes: PolymarketReconciliationOutcome[] = [];
  try {
    const client = requireSecureClobClient();
    const pending = await query<PendingPolymarketTrade>(
      `SELECT id, signal_id, copy_execution_id, token_mint, direction,
              venue_order_id, submitted_at
         FROM trades
        WHERE chain = 'polygon'
          AND execution_mode = 'live'
          AND executor = 'polymarket-clob'
          AND status = 'pending_confirmation'
          AND venue_order_id IS NOT NULL
        ORDER BY COALESCE(submitted_at, executed_at), id
        LIMIT 100`
    );
    const now = Date.now();
    for (const row of pending) {
      try {
        outcomes.push(await reconcilePendingPolymarketTrade(client, row, now));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[trade-executor] Polymarket order ${row.venue_order_id} reconciliation failed: ${message}`
        );
        outcomes.push({
          tradeId: row.id,
          orderId: row.venue_order_id,
          status: 'ambiguous',
          reason: message
        });
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[trade-executor] Polymarket order polling failed: ${message}`);
  }
  return outcomes;
}
