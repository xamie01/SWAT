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
import {
  classifyPolymarketOrderLiveness,
  interpretPolymarketCancellation,
  planPolymarketRungRetirement,
  polymarketCancellationError,
  type PolymarketCancellationReading
} from './polymarket-cancellation.js';
import {
  assertPolymarketMarketOpenForSubmission,
  fetchPolymarketMarketState,
  type PolymarketMarketState
} from './polymarket-market-state.js';
import {
  planPolymarketMirrorBound,
  resolvePolymarketMirrorToleranceBps,
  type PolymarketMirrorBoundDecision
} from './polymarket-mirror-bound.js';
import {
  escalatePolymarketExit,
  POLYMARKET_GTD_MINIMUM_HORIZON_MS,
  type PolymarketExitAlert,
  type PolymarketExitEscalationOutcome,
  type PolymarketExitLimitRung,
  type PolymarketExitRedeem
} from './polymarket-exit-escalation.js';
import {
  evaluatePolymarketSignalStaleness,
  resolvePolymarketStalenessPolicy,
  type PolymarketStalenessPolicy
} from './polymarket-staleness.js';
import { globalPolymarketRelayerBudget } from './polymarket-relayer-budget.js';
import { checkPolymarketGeoEligibility } from './polymarket-geo.js';

/**
 * The staleness policy, resolved once (`S4-M18`).
 *
 * Memoised rather than read per order: `resolvePolymarketStalenessPolicy` parses
 * and validates environment, and doing that on the money path would repeat the
 * work and let a mid-run environment change silently alter what is refused. Lazy
 * rather than at import so a malformed value surfaces on the first Polymarket
 * order with a clear error, instead of during module load of an unrelated test.
 */
let cachedStalenessPolicy: PolymarketStalenessPolicy | null = null;
function defaultStalenessPolicy(): PolymarketStalenessPolicy {
  if (!cachedStalenessPolicy) cachedStalenessPolicy = resolvePolymarketStalenessPolicy();
  return cachedStalenessPolicy;
}

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

/**
 * The authenticated client, or null when Polymarket is not configured.
 *
 * Nullable counterpart to `requireSecureClobClient`, for callers that must
 * degrade rather than fail — the redemption sweep runs on a timer and an absent
 * client is the normal paper-mode posture, not an error worth throwing on every
 * tick.
 */
export function getPolymarketClientIfReady(): PolymarketSecureClient | null {
  return secureClobClient;
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
      throw new UnrecoverableError(
        'Polymarket Protection: order-book price is off the current tick-size grid'
      );
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
      `Polymarket Protection: order is below the ${minimumShares}-share minimum after venue rounding`
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

/**
 * Price a paper fill the way the live path prices a real one: walk the book for
 * the requested size instead of assuming the whole order clears at the best
 * level.
 *
 * Taking the best price for any size makes paper systematically optimistic
 * against live - the thinner the book, the wider the gap - which is precisely
 * the error a shadow/paper benchmark exists to avoid. This shares
 * `planPolymarketBookOrder` with the live path so the two cannot drift, and it
 * inherits the same staleness, tick-grid, thin-book, and slippage rejections.
 *
 * `requestedAmount` is USD notional for a buy and shares for a sell, matching
 * the live contract.
 */
export async function simulatePolymarketBookFill(params: {
  tokenID: string;
  direction: 'buy' | 'sell';
  requestedAmount: number;
  now?: number;
}): Promise<PolymarketBookPlan> {
  const client = secureClobClient ?? publicClobClient;
  if (!client) {
    throw new UnrecoverableError('Polymarket order-book client is not initialized');
  }
  const book = await client.fetchOrderBook({ tokenId: params.tokenID });
  const maxSlippageBps = Number(process.env.POLYMARKET_SLIPPAGE_BPS ?? '200');
  return planPolymarketBookOrder(
    book,
    params.direction,
    params.requestedAmount,
    maxSlippageBps,
    params.now
  );
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

/**
 * The master-fill reference a mirrored order is bounded against (`S4-M16`).
 *
 * Supplied only on the mirroring path. A manual or stop-loss order has no master
 * and legitimately carries none, which is why this is optional rather than
 * defaulted — but when it *is* supplied and `masterFillPriceUsd` is absent, the
 * mirror fails closed with a skip instead of falling back to a book-derived
 * bound that nobody sanctioned.
 */
export interface PolymarketMirrorContext {
  /** The canonical source event being mirrored. Present iff this is a copy. */
  readonly sourceTradeId: string;
  /** The tracked wallet's realized price for that event, in USD per share. */
  readonly masterFillPriceUsd: number | null;
  /** Per-user override; falls back to POLYMARKET_MIRROR_TOLERANCE_BPS. */
  readonly toleranceBps?: number;
}

export async function triggerPolymarket(params: {
  signalId: string;
  tokenID: string;
  spendAmountUsd: number;
  direction: 'buy' | 'sell';
  sellShares?: number;
  mirror?: PolymarketMirrorContext;
  /**
   * When the source event this order copies actually happened (`S4-M18`).
   *
   * Optional for the same reason `mirror` is: only a copy has a source event. A
   * manual execute or a stop-loss exit has none, and gating those on a timestamp
   * that does not exist would refuse every one of them. Present-but-unusable
   * still fails closed — the staleness rule below refuses rather than falling
   * back to the flat ceiling.
   */
  sourceEventAt?: Date;
  /** Per-user override; falls back to the POLYMARKET_STALENESS_* environment. */
  stalenessPolicy?: Partial<PolymarketStalenessPolicy>;
  /** Timestamp when user's geo-eligibility was verified via interactive session (S4-P16). */
  geoVerifiedAt?: Date | null;
  /** Injected clock, so the staleness boundary is testable without faking time. */
  now?: () => number;
}) {
  if (!liveReadiness.ready) {
    throw new UnrecoverableError(`Polymarket live execution is not ready: ${liveReadiness.reason}`);
  }
  if (!polymarketSigner) {
    throw new UnrecoverableError('Polymarket signer is not initialized');
  }

  if (params.geoVerifiedAt !== undefined) {
    const geo = checkPolymarketGeoEligibility({
      geoVerifiedAt: params.geoVerifiedAt,
      now: params.now ? new Date(params.now()) : undefined
    });
    if (!geo.eligible) {
      throw new UnrecoverableError(`Polymarket Protection: [${geo.code}] ${geo.reason}`);
    }
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

    // The protective bound we actually sign. On the mirroring path it comes from
    // the master's fill (`S4-M16`); a manual or stop-loss order keeps the
    // book-walk level, which is all the reference such an order has.
    let mirrorDecision: PolymarketMirrorBoundDecision | null = null;
    let boundPrice = plan.limitPrice;
    if (params.mirror) {
      mirrorDecision = planPolymarketMirrorBound({
        direction: params.direction,
        masterFillPrice: params.mirror.masterFillPriceUsd,
        bookLimitPrice: plan.limitPrice,
        tickSize: Number(book.tickSize),
        shares: params.direction === 'buy' ? plan.estimatedShares : requestedShares,
        minimumShares: Number(book.minOrderSize),
        toleranceBps: params.mirror.toleranceBps ?? resolvePolymarketMirrorToleranceBps()
      });
      if (mirrorDecision.kind === 'skip') {
        // "Polymarket Protection" is the marker the job handler matches to record
        // a skipped trade with its reason rather than a failed one.
        throw new UnrecoverableError(
          `Polymarket Protection: ${mirrorDecision.reason} [${mirrorDecision.code}]`
        );
      }
      boundPrice = mirrorDecision.boundPrice;
    }

    const maximumEntryPrice = Number(process.env.POLYMARKET_MAX_ENTRY_PRICE ?? '0.97');
    const minimumExitPrice = Number(process.env.POLYMARKET_MIN_EXIT_PRICE ?? '0.01');
    if (
      !Number.isFinite(maximumEntryPrice) || maximumEntryPrice <= 0 || maximumEntryPrice >= 1 ||
      !Number.isFinite(minimumExitPrice) || minimumExitPrice <= 0 || minimumExitPrice >= 1
    ) {
      throw new UnrecoverableError('Polymarket entry/exit price bounds are invalid');
    }
    // Applied to the bound we are about to sign, not to the book level, so a
    // mirror tolerance can never widen the operator's configured safe range.
    if (
      (params.direction === 'buy' && boundPrice > maximumEntryPrice) ||
      (params.direction === 'sell' && boundPrice < minimumExitPrice)
    ) {
      throw new UnrecoverableError(
        `Polymarket Protection: Price ${boundPrice} outside safe bounds configured for this executor`
      );
    }

    // Last gate before the order exists. The book proves liquidity; this proves
    // the market will still accept an order at all. Deliberately placed after
    // the depth walk and price bounds so the state read is as close to the
    // submission as the code allows.
    const nowMs = (params.now ?? Date.now)();
    const marketState = await assertPolymarketMarketOpenForSubmission({
      conditionId: String(book.conditionId),
      now: nowMs
    });

    // `S4-M18`: a copy's signal age is measured against the market's remaining
    // time-to-resolution, not against a flat ceiling. Evaluated here, after the
    // live market-state read, because `endDate` and `secondsDelay` are what that
    // read returns and both are inputs to the budget — a second Gamma call to get
    // them would be a second, later view of the same market.
    //
    // Only a copy carries `sourceEventAt`. A manual execute or a stop-loss exit
    // has no source event and keeps today's behaviour, exactly as it keeps the
    // book-derived bound when `mirror` is absent.
    //
    // **A copy with no readable event time is refused, not waved through.** Both
    // `mirror` and `sourceEventAt` come from the one `getCanonicalSourceTradeById`
    // read in `index.ts`, so when that row is missing the price half fails closed
    // (a null master price skips) while the timing half would fail *open* — the
    // `if` below simply would not run, and the copy would be indistinguishable
    // from a manual order that never had a source event. That asymmetry is the
    // wrong way round for a safety control: a signal whose age we cannot even
    // establish is exactly the one this budget exists to refuse. `mirror` is the
    // discriminator because it is present iff `payload.sourceTradeId` was.
    if (params.mirror && !params.sourceEventAt) {
      throw new UnrecoverableError(
        'Polymarket Protection: this copy has no readable source event time, so its '
        + 'age against the market\'s remaining time-to-resolution cannot be checked '
        + '[source-event-time-unavailable]'
      );
    }
    if (params.sourceEventAt) {
      const staleness = evaluatePolymarketSignalStaleness({
        signalAt: params.sourceEventAt,
        resolutionAt: marketState.endDate,
        now: nowMs,
        matchingDelaySeconds: marketState.secondsDelay,
        policy: params.stalenessPolicy ?? defaultStalenessPolicy()
      });
      if (staleness.kind === 'stale') {
        // Same marker as the mirror skip: the job handler matches
        // "Polymarket Protection" to record a skipped trade carrying this reason
        // rather than a failed job that would retry into an even older signal.
        throw new UnrecoverableError(
          `Polymarket Protection: ${staleness.reason} [${staleness.code}]`
        );
      }
    }

    const tradeSide = params.direction === 'buy' ? OrderSide.BUY : OrderSide.SELL;
    const order = await client.createMarketOrder(params.direction === 'buy'
      ? {
          tokenId: params.tokenID,
          side: OrderSide.BUY,
          amount: spendAmountUsd,
          maxSpend: spendAmountUsd,
          maxPrice: boundPrice,
          orderType: OrderType.FAK,
          builderCode: identity.builderCode
        }
      : {
          tokenId: params.tokenID,
          side: OrderSide.SELL,
          shares: requestedShares,
          minPrice: boundPrice,
          orderType: OrderType.FAK,
          builderCode: identity.builderCode
        });
    if (
      typeof order.builder !== 'string' ||
      order.builder.toLowerCase() !== identity.builderCode
    ) {
      throw new UnrecoverableError('Polymarket signed order omitted the configured builder code');
    }

    const relayerBudget = globalPolymarketRelayerBudget.checkBudget();
    if (!relayerBudget.allowed) {
      throw new UnrecoverableError(relayerBudget.reason!);
    }

    const startTime = Date.now();
    const response = await client.postOrder(order);
    globalPolymarketRelayerBudget.recordExecution();
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
      slippageBps: plan.slippageBps,
      mirrorBoundPrice: boundPrice,
      mirrorTrackingBps: mirrorDecision?.kind === 'submit' ? mirrorDecision.trackingBps : null
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
      slippageBps: plan.slippageBps,
      mirrorBoundPrice: boundPrice,
      mirrorTrackingBps: mirrorDecision?.kind === 'submit' ? mirrorDecision.trackingBps : null
    };
  } catch (error: unknown) {
    if (error instanceof UnrecoverableError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new UnrecoverableError(`Polymarket execution failed: ${message}`);
  }
}

/**
 * How many times a rung's cancellation is attempted before the ladder stops.
 *
 * Three, because the two states worth retrying are both short-lived: the venue's
 * matching-delay window, and a read of the order that briefly trails the cancel
 * we just sent. Anything still resting after three attempts is a fact about the
 * book rather than a race, and the answer to that is a human.
 */
export const POLYMARKET_RUNG_CANCEL_ATTEMPTS = 3;

/**
 * Pause between cancellation attempts.
 *
 * Two seconds is chosen against the documented 250 ms taker delay with headroom,
 * not against the configurable sports `secondsDelay` — a long game delay is not
 * something to spin on, and the `blocked` branch is the correct answer there.
 */
export const POLYMARKET_RUNG_CANCEL_RETRY_MS = 2_000;

/**
 * Submit one exit-escalation rung as a GTD limit order (`S4-M17`).
 *
 * Separate from `triggerPolymarket` because the two order shapes answer different
 * questions. `triggerPolymarket` mirrors a master's trade and must not rest;
 * this recovers an exit that already failed to fill and is allowed to rest for a
 * bounded window.
 *
 * The `expiration` arrives pre-computed by `planPolymarketExitEscalation`, which
 * owns the documented `now + 60 + N` formula and the 3-minute venue floor. It is
 * re-checked here only for the case where a rung was planned and then sat in a
 * queue long enough to go stale — submitting an already-expired expiration is a
 * guaranteed rejection that would consume a rung.
 */
export async function submitPolymarketExitRung(params: {
  tokenID: string;
  rung: PolymarketExitLimitRung;
  now?: number;
}): Promise<{ orderId: string; status: string; expiration: number }> {
  if (!liveReadiness.ready) {
    throw new UnrecoverableError(`Polymarket live execution is not ready: ${liveReadiness.reason}`);
  }
  if (!polymarketSigner) {
    throw new UnrecoverableError('Polymarket signer is not initialized');
  }
  const now = params.now ?? Date.now();
  const horizonMs = params.rung.expiration * 1000 - now;
  if (horizonMs < POLYMARKET_GTD_MINIMUM_HORIZON_MS) {
    throw new UnrecoverableError(
      `Polymarket exit rung expiration is only ${horizonMs}ms ahead; the venue rejects anything under 3 minutes`
    );
  }

  const identity = resolvePolymarketIdentity(polymarketSigner.address);
  const client = requireSecureClobClient();
  const order = await client.createLimitOrder({
    tokenId: params.tokenID,
    side: OrderSide.SELL,
    price: params.rung.price,
    size: params.rung.shares,
    expiration: params.rung.expiration,
    builderCode: identity.builderCode
  });
  if (
    typeof order.builder !== 'string'
    || order.builder.toLowerCase() !== identity.builderCode
  ) {
    throw new UnrecoverableError('Polymarket signed exit rung omitted the configured builder code');
  }

  const relayerBudget = globalPolymarketRelayerBudget.checkBudget();
  if (!relayerBudget.allowed) {
    throw new UnrecoverableError(relayerBudget.reason!);
  }

  const response = await client.postOrder(order);
  globalPolymarketRelayerBudget.recordExecution();
  if (!response.ok) {
    throw new UnrecoverableError(
      `Polymarket exit rung rejected: ${response.code}: ${response.message}`
    );
  }
  return {
    orderId: response.orderId,
    status: response.status,
    expiration: params.rung.expiration
  };
}

/**
 * Build the `submitRung` port the escalation driver needs.
 *
 * The port's contract is "submit this rung, let it live out its window, then
 * report what it filled", so the waiting lives here rather than in the driver —
 * the driver stays pure enough to test without a clock, and the caller decides
 * whether to occupy a worker for the rung's lifetime or hand it to a delayed job
 * by supplying its own `sleep`.
 *
 * **Retiring the rung before the next one is placed (`S4-M36`).** This used to
 * `await client.cancelOrder(...)` inside a try/catch on the assumption that a
 * failed cancellation throws. It does not: the venue answers **200** with a
 * `canceled` / `not_canceled` split, so a stale order landed in `not_canceled`
 * and the catch never ran. The belt-and-braces cancellation was therefore a
 * no-op on exactly the path it was written for, and the consequence was not
 * cosmetic — a rung still resting on the book plus a non-zero `sizeMatched` read
 * as a partial fill, so the ladder placed the next rung for the remainder and
 * left **two live sell orders whose combined size can exceed the position**.
 *
 * Three things changed, in the order the item ranks them:
 *
 *   1. the fetched order must be **terminal**, not merely partially matched. The
 *      data was always in hand — `fetchOrder` was already called and its status
 *      thrown away while only `sizeMatched` was read.
 *   2. the cancellation response is read through
 *      `interpretPolymarketCancellation`, the one helper both call sites now
 *      share, rather than inferred from the absence of an exception.
 *   3. if the rung is not provably dead the cancel is retried and then the ladder
 *      **stops** with an alert. Failing closed is deliberate and is the opposite
 *      of `S4-M31`: there the worst case was one odd trade, here it is selling a
 *      user's position twice, and the cost of stopping is a slower exit.
 *
 * A cancel refused inside the venue's matching-delay window counts as *wait*, not
 * as failure: `/concepts/order-lifecycle` documents cancels as blocked there, so
 * the refusal is the venue behaving as specified.
 *
 * Every venue call is an injectable port so the retirement logic can be exercised
 * without a signer or a live client.
 */
export function createPolymarketExitRungSubmitter(params: {
  tokenID: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
  submit?: (rung: PolymarketExitLimitRung) => Promise<{ orderId: string }>;
  cancelOrder?: (input: { orderId: string }) => Promise<unknown>;
  fetchOrder?: (input: { orderId: string }) => Promise<OpenOrder>;
  /** Raised when a rung cannot be shown to be dead, before the ladder stops. */
  emitAlert?: (alert: { orderId: string; reason: string }) => Promise<void>;
  maxCancelAttempts?: number;
  cancelRetryDelayMs?: number;
}): (rung: PolymarketExitLimitRung) => Promise<{ filledShares: number }> {
  const sleep = params.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const now = params.now ?? Date.now;
  const log = params.log ?? (() => {});
  const maxCancelAttempts = params.maxCancelAttempts ?? POLYMARKET_RUNG_CANCEL_ATTEMPTS;
  const cancelRetryDelayMs = params.cancelRetryDelayMs ?? POLYMARKET_RUNG_CANCEL_RETRY_MS;

  return async (rung: PolymarketExitLimitRung) => {
    const submission = params.submit
      ? await params.submit(rung)
      : await submitPolymarketExitRung({
        tokenID: params.tokenID,
        rung,
        now: now()
      });
    const cancelOrder = params.cancelOrder
      ?? ((input: { orderId: string }) => requireSecureClobClient().cancelOrder(input));
    const fetchOrder = params.fetchOrder
      ?? ((input: { orderId: string }) => requireSecureClobClient().fetchOrder(input));

    // The venue kills the remainder one minute before the stated expiration, so
    // waiting the effective lifetime is exactly long enough — when the assumption
    // holds. The loop below is what covers the case where it does not.
    await sleep(rung.effectiveLifetimeMs);

    let filledShares = 0;
    let retired = false;
    let blockedReason: string | null = null;

    for (let attempt = 1; attempt <= maxCancelAttempts; attempt += 1) {
      let cancellation: PolymarketCancellationReading;
      try {
        cancellation = interpretPolymarketCancellation(
          await cancelOrder({ orderId: submission.orderId }),
          submission.orderId
        );
      } catch (error: unknown) {
        // A throw is a transport failure, not a statement about the order. It is
        // recorded as such and the fetched order decides.
        cancellation = polymarketCancellationError(error);
      }

      const order = await fetchOrder({ orderId: submission.orderId });
      if (order.id !== submission.orderId) {
        throw new UnrecoverableError(
          `Polymarket returned order ${order.id} for exit rung ${submission.orderId}`
        );
      }
      // Read before the terminal decision so a rung that filled and then went
      // terminal still reports its fill.
      filledShares = nonNegativeDecimal(String(order.sizeMatched), 'exit rung matched size');

      const retirement = planPolymarketRungRetirement({
        orderId: submission.orderId,
        cancellation,
        liveness: classifyPolymarketOrderLiveness(order.status),
        attempt,
        maxAttempts: maxCancelAttempts
      });
      log(`[polymarket-exit] rung ${submission.orderId}: ${retirement.reason}`);

      if (retirement.kind === 'retired') {
        retired = true;
        break;
      }
      if (retirement.kind === 'blocked') {
        blockedReason = retirement.reason;
        break;
      }
      await sleep(cancelRetryDelayMs);
    }

    if (!retired) {
      const reason = blockedReason
        ?? `rung ${submission.orderId} could not be shown to be dead within `
        + `${maxCancelAttempts} cancel attempts`;
      if (params.emitAlert) {
        await params.emitAlert({ orderId: submission.orderId, reason });
      }
      // Fail closed. The escalation sweep catches this per candidate and records
      // it, so one blocked ladder does not stop the others — what it must not do
      // is place the next rung on top of a live one.
      throw new UnrecoverableError(
        `Polymarket exit rung was not provably retired, so the next rung is not placed: ${reason}`
      );
    }

    log(
      `[polymarket-exit] rung ${submission.orderId} at ${rung.price} filled `
      + `${filledShares} of ${rung.shares}`
    );
    return { filledShares };
  };
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

/**
 * Settlement states a venue trade passes through, from the documented set:
 * MATCHED (sent to the executor) -> MINED (in a block) -> CONFIRMED (final),
 * with RETRYING when an onchain attempt failed and is being resubmitted, and
 * FAILED as the terminal failure. Only CONFIRMED may create a fill quantity.
 */
type SettlementState = 'retrying' | 'matched' | 'mined' | 'confirmed' | 'failed';

/**
 * Weakest-first. An order is only as settled as its least-settled trade, so a
 * summary across several associated trades reports the minimum: one MINED plus
 * one RETRYING is a RETRYING position, not a MINED one.
 */
const SETTLEMENT_PRECEDENCE: SettlementState[] = ['retrying', 'matched', 'mined', 'confirmed'];

function classifySettlementState(status: string): SettlementState | null {
  switch (normalizedTradeStatus(status)) {
    case 'CONFIRMED':
      return 'confirmed';
    case 'FAILED':
      return 'failed';
    case 'RETRYING':
      return 'retrying';
    case 'MATCHED':
    // The user stream reports a matched trade that has not yet been broadcast
    // onchain. It is strictly earlier than MINED, so it groups with MATCHED.
    case 'MATCHED_NOT_BROADCASTED':
      return 'matched';
    case 'MINED':
      return 'mined';
    default:
      // Fail closed. An unrecognised settlement status must not be quietly
      // treated as "still pending" - that is how a trade sits forever in a
      // state nobody is watching.
      return null;
  }
}

type AssociatedTradeEvidence = {
  confirmed: ClobTrade[];
  failedIds: string[];
  pendingIds: string[];
  /** Pending trade IDs grouped by their distinct settlement state. */
  pendingByState: Map<SettlementState, string[]>;
  /** Trades whose settlement status is outside the documented set. */
  unknownIds: string[];
  missingIds: string[];
};

/**
 * The weakest settlement state among the still-pending trades, which is what
 * the order as a whole has actually reached.
 */
function weakestPendingSettlement(evidence: AssociatedTradeEvidence): SettlementState | null {
  for (const state of SETTLEMENT_PRECEDENCE) {
    if ((evidence.pendingByState.get(state)?.length ?? 0) > 0) return state;
  }
  return null;
}

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
  // FAK is the entry/exit order type (`S4-M16`), and GTD is the exit-escalation
  // rung (`S4-M17`) — a rung is deliberately allowed to rest for a bounded two
  // minutes because an unfilled exit is worse than a late one. Any other type
  // means an order this executor did not create is being reconciled against one
  // of our trade rows, which is not something to paper over.
  const reconcilableOrderTypes: string[] = [OrderType.FAK, OrderType.GTD];
  if (!reconcilableOrderTypes.includes(order.orderType.trim().toUpperCase())) {
    throw new Error(
      `Polymarket order ${order.id} is not an order type this executor submits (${order.orderType})`
    );
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
    pendingByState: new Map(),
    unknownIds: [],
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
    const state = classifySettlementState(trade.status);
    if (state === 'confirmed') {
      evidence.confirmed.push(trade);
    } else if (state === 'failed') {
      evidence.failedIds.push(tradeId);
    } else if (state === null) {
      evidence.unknownIds.push(tradeId);
    } else {
      evidence.pendingIds.push(tradeId);
      const grouped = evidence.pendingByState.get(state) ?? [];
      grouped.push(tradeId);
      evidence.pendingByState.set(state, grouped);
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
  reason: string | null,
  settlementStatus: SettlementState | null = null
): Promise<void> {
  await query(
    `UPDATE trades
        SET venue_status = $2,
            error_message = $3,
            venue_settlement_status = $4
      WHERE id = $1
        AND status = 'pending_confirmation'`,
    [row.id, venueStatus, reason, settlementStatus]
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
      quoteLeg: { amount: summary.amountUsd.toString(), currency: 'USD' },
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

  if (evidence.unknownIds.length > 0) {
    // An undocumented settlement status is not evidence of anything. Treating
    // it as pending would leave the position parked indefinitely.
    return markAmbiguous(
      row,
      `Polymarket associated trades returned an unrecognised settlement status: ${evidence.unknownIds.join(', ')}`
    );
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
    const settlement = weakestPendingSettlement(evidence);
    const reason =
      `Polymarket associated trades are not confirmed (settlement ${settlement ?? 'unknown'}): `
      + evidence.pendingIds.join(', ');
    await setPendingReconciliationState(row, order.status, reason, settlement);
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
        const cancellation = interpretPolymarketCancellation(
          await client.cancelOrder({ orderId: order.id }),
          order.id
        );
        // One reading of the contract, shared with the exit-rung submitter
        // (`S4-M36`). Only an explicit listing in `canceled` retires the order;
        // a `not_canceled` entry — including "order already matched" — is not a
        // cancellation and must not be recorded as one.
        if (cancellation.kind === 'confirmed') {
          console.log(`[trade-executor] Cancelled timed out Polymarket order: ${order.id}`);
          return finishWithoutFill(
            row,
            'cancelled',
            'cancelled',
            'Polymarket order timed out without a confirmed fill'
          );
        }
        const detail = 'reason' in cancellation ? `: ${cancellation.reason}` : '';
        return markAmbiguous(
          row,
          `Polymarket did not confirm cancellation of timed out order ${order.id} `
          + `(${cancellation.kind})${detail}`
        );
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

/**
 * Drive the exit-escalation ladder for exits that reconciliation has already
 * declared unfilled (`S4-M17`).
 *
 * `pollPolymarketOrders` is where an exit *becomes* known-unfilled: a sell whose
 * FAK reconciled to `cancelled`, `failed`, or `partial` is a position the master
 * has left and the user still holds. Until this sweep existed the ladder in
 * `polymarket-exit-escalation.ts` had no caller, so that state was terminal —
 * the trade row said "cancelled" and nobody sold the shares.
 *
 * **Where it runs.** Inside the single guarded `reconcilePending` pass in
 * `index.ts`, at the tail, after the per-venue sweeps and the canonical
 * coordinator. Not on its own timer (audit finding `C1`): a second timer could
 * overlap this ladder with the reconciliation that classifies its own rungs. At
 * the tail because a ladder occupies the pass for as long as its rungs rest, and
 * the fast sweeps must not queue behind it.
 *
 * **What it deliberately does not do.** It does not resume a partly-walked
 * ladder. `escalatePolymarketExit` holds the rung index in a local, so one call
 * walks the whole ladder or terminates; there is no column to persist a rung in
 * and this module does not invent one. The consequences are stated on
 * `POLYMARKET_EXIT_ESCALATION_SWEEP_LIMIT` and
 * `resolvePolymarketExitReferencePrice`.
 */

/**
 * How many exits one pass will escalate.
 *
 * One by default, and low on purpose. A ladder rests each rung for its full
 * effective lifetime inside this call, so N candidates occupy the guarded
 * reconciliation pass for N ladders' worth of wall clock. Raising this trades
 * reconciliation latency for exit throughput, and the honest fix is not a bigger
 * number — it is persisted rung state so each pass can advance one rung and
 * return.
 */
export const POLYMARKET_EXIT_ESCALATION_SWEEP_LIMIT = 1;

/**
 * How far back a failed exit stays escalatable.
 *
 * An exit that failed an hour ago is not the same trade any more: the market has
 * moved, and re-offering a ladder measured from that reference is the staleness
 * `S4-M18` refuses on the entry path. Bounded rather than unbounded so a backlog
 * of historical failures cannot be replayed by a restart.
 */
export const POLYMARKET_EXIT_ESCALATION_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Reconciliation outcomes that mean "the exit did not complete".
 *
 * `partial` is the case this sweep can actually act on. `cancelled` and `failed`
 * are listed because reconciliation does produce them, but per
 * `/resources/error-codes` a FAK that matches nothing is *rejected* at post time
 * ("no orders found to match with FAK order") rather than resting and being
 * cancelled — so a zero-fill exit often has no `venue_order_id` and never enters
 * this query at all, and when it does it has no persisted reference price. Both
 * are the same missing column; see `resolvePolymarketExitReferencePrice`.
 */
const POLYMARKET_UNFILLED_EXIT_STATUSES: readonly string[] = ['partial', 'cancelled', 'failed'];

export interface PolymarketExitEscalationCandidate {
  readonly id: string;
  readonly copy_execution_id: string | null;
  readonly signal_id: string | null;
  readonly token_mint: string;
  readonly status: string;
  readonly venue_order_id: string;
  /** Average price of the confirmed portion, or null when nothing filled. */
  readonly price_usd: string | number | null;
  readonly token_amount: string | number | null;
  readonly target_amount_usd: string | number | null;
}

export type PolymarketExitReferenceResolution =
  | { readonly kind: 'reference'; readonly referencePrice: number }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * Find the price the failed attempt was bounded at, or say why it cannot be found.
 *
 * The ladder measures rungs down from the price the attempt that just failed
 * offered — see `polymarket-exit-escalation.ts` on why the master's raw fill is
 * the wrong reference. `triggerPolymarket` computes exactly that number
 * (`boundPrice`, returned as `mirrorBoundPrice`) and then drops it: `TradeInsert`
 * has no column for a signed protective bound, so it is not persisted.
 *
 * What survives is `price_usd`, which `finishConfirmedFill` sets to the average
 * price of the *confirmed* portion. For a sell that is a price the venue actually
 * paid us, so it is at or above the bound we signed — a valid, slightly
 * conservative reference. A sell that filled nothing has `price_usd = NULL`
 * (`insertTrade` only writes a price when there is a confirmed fill), and there
 * is nothing else on the row that means "the price we offered":
 * `target_amount_usd` is a requested notional and `token_amount` is null too, so
 * dividing them would invent a price rather than recover one.
 *
 * So this returns `unavailable` for the zero-fill case rather than guessing. That
 * is the honest half of `S4-M17`: the ladder runs for exits that partially
 * filled, and a zero-fill exit is reported as needing the missing column.
 */
export function resolvePolymarketExitReferencePrice(
  row: Pick<PolymarketExitEscalationCandidate, 'id' | 'status' | 'price_usd'>
): PolymarketExitReferenceResolution {
  if (row.price_usd === null || row.price_usd === undefined || row.price_usd === '') {
    return {
      kind: 'unavailable',
      reason:
        `trade ${row.id} reconciled to ${row.status} with no confirmed fill, so no price it `
        + 'offered was persisted; the escalation reference needs the signed mirror bound stored '
        + 'on the trade row'
    };
  }
  const referencePrice = Number(row.price_usd);
  if (!Number.isFinite(referencePrice) || referencePrice <= 0 || referencePrice >= 1) {
    return {
      kind: 'unavailable',
      reason: `trade ${row.id} persisted price ${row.price_usd} is not a valid outcome price`
    };
  }
  return { kind: 'reference', referencePrice };
}

/**
 * Exits this process has already walked a ladder for.
 *
 * Process-local, and that is a stated gap rather than a design: the terminal
 * alert exists so a human decides the next lever, and without a durable marker
 * the next pass sixty seconds later would start the same ladder from rung zero
 * and alert again. A restart forgets, and a second executor instance never knew.
 * The durable form is a claim on the trade row, which does not exist yet.
 */
const escalatedExitTradeIds = new Set<string>();

/** Test seam; also the reset an operator would want after fixing a market by hand. */
export function resetPolymarketExitEscalationMemoryForTesting(): void {
  escalatedExitTradeIds.clear();
}

export interface PolymarketExitEscalationSweepPorts {
  /** Publish the ladder's terminal alert. */
  readonly emitAlert: (
    alert: PolymarketExitAlert,
    candidate: PolymarketExitEscalationCandidate
  ) => Promise<void>;
  readonly loadCandidates?: () => Promise<PolymarketExitEscalationCandidate[]>;
  readonly fetchBook?: (tokenID: string) => Promise<OrderBook>;
  readonly fetchSellableShares?: (tokenID: string) => Promise<number>;
  readonly fetchMarketState?: (conditionId: string) => Promise<PolymarketMarketState>;
  readonly submitRungFor?: (
    tokenID: string
  ) => (rung: PolymarketExitLimitRung) => Promise<{ filledShares: number }>;
  readonly requestRedemption?: (
    redeem: PolymarketExitRedeem,
    candidate: PolymarketExitEscalationCandidate
  ) => Promise<void>;
  readonly escalate?: typeof escalatePolymarketExit;
  readonly limit?: number;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export interface PolymarketExitEscalationSweepResult {
  readonly scanned: number;
  readonly escalated: number;
  readonly completed: number;
  readonly alerted: number;
  readonly redeemed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly skips: readonly { readonly tradeId: string; readonly reason: string }[];
  readonly outcomes: readonly {
    readonly tradeId: string;
    readonly outcome: PolymarketExitEscalationOutcome;
  }[];
}

/**
 * Highest bid on the book, or null when there is no usable bid.
 *
 * Computed as a maximum rather than read from `bids[0]` on purpose. The docs
 * contradict themselves on ordering: `/api-reference/market-data/get-order-book`
 * says bids are "sorted by price descending" (best first) while
 * `/market-data/prices-order-books` says "bids are ordered by ascending price...
 * so the best bid and ask are the last entries". A maximum is correct under
 * either, and indexing would silently price a rung against the *worst* bid under
 * one of them. Do not simplify this.
 */
function bestBidFromBook(book: OrderBook): number | null {
  const bids = book.bids ?? [];
  let best: number | null = null;
  for (const level of bids) {
    const price = Number(level.price);
    if (!Number.isFinite(price) || price <= 0 || price >= 1) continue;
    const size = Number(level.size);
    if (!Number.isFinite(size) || size <= 0) continue;
    if (best === null || price > best) best = price;
  }
  return best;
}

function resolvePolymarketMinimumExitPrice(): number {
  const value = Number(process.env.POLYMARKET_MIN_EXIT_PRICE ?? '0.01');
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new UnrecoverableError('POLYMARKET_MIN_EXIT_PRICE must be between 0 and 1 exclusive');
  }
  return value;
}

async function loadUnfilledPolymarketExits(
  now: number,
  limit: number
): Promise<PolymarketExitEscalationCandidate[]> {
  return query<PolymarketExitEscalationCandidate>(
    `SELECT id, copy_execution_id, signal_id, token_mint, status,
            venue_order_id, price_usd, token_amount, target_amount_usd
       FROM trades
      WHERE chain = 'polygon'
        AND executor = 'polymarket-clob'
        AND execution_mode = 'live'
        AND direction = 'sell'
        AND status = ANY($1::text[])
        AND venue_order_id IS NOT NULL
        AND COALESCE(confirmed_at, submitted_at, executed_at) > $2::timestamptz
      ORDER BY COALESCE(confirmed_at, submitted_at, executed_at) DESC, id DESC
      LIMIT $3`,
    [
      POLYMARKET_UNFILLED_EXIT_STATUSES,
      new Date(now - POLYMARKET_EXIT_ESCALATION_MAX_AGE_MS).toISOString(),
      Math.max(1, limit) * 10
    ]
  );
}

export async function runPolymarketExitEscalationSweep(
  ports: PolymarketExitEscalationSweepPorts
): Promise<PolymarketExitEscalationSweepResult> {
  const log = ports.log ?? (() => {});
  const now = ports.now ?? Date.now;
  const limit = ports.limit ?? POLYMARKET_EXIT_ESCALATION_SWEEP_LIMIT;
  const escalate = ports.escalate ?? escalatePolymarketExit;
  const skips: { tradeId: string; reason: string }[] = [];
  const outcomes: { tradeId: string; outcome: PolymarketExitEscalationOutcome }[] = [];
  let escalated = 0;
  let completed = 0;
  let alerted = 0;
  let redeemed = 0;
  let failed = 0;

  // Escalating means signing and posting a real sell. There is nothing to
  // escalate in paper mode, and the live-readiness gate is the same one
  // `runPolymarketRedemptionSweep` sits behind.
  if (!liveReadiness.ready) {
    return {
      scanned: 0, escalated: 0, completed: 0, alerted: 0, redeemed: 0, failed: 0,
      skipped: 0, skips: [], outcomes: []
    };
  }

  const minimumExitPrice = resolvePolymarketMinimumExitPrice();
  const loadCandidates = ports.loadCandidates
    ?? (() => loadUnfilledPolymarketExits(now(), limit));
  const candidates = await loadCandidates();

  for (const candidate of candidates) {
    if (escalated + alerted + redeemed + completed >= limit) break;
    if (escalatedExitTradeIds.has(candidate.id)) {
      skips.push({
        tradeId: candidate.id,
        reason: 'this process has already walked a ladder for this exit'
      });
      continue;
    }
    const reference = resolvePolymarketExitReferencePrice(candidate);
    if (reference.kind === 'unavailable') {
      skips.push({ tradeId: candidate.id, reason: reference.reason });
      log(`[polymarket-exit] skipping ${candidate.id}: ${reference.reason}`);
      continue;
    }

    const tokenID = unprefixedPolygonToken(candidate.token_mint);
    const fetchBook = ports.fetchBook
      ?? ((id: string) => requireSecureClobClient().fetchOrderBook({ tokenId: id }));
    const fetchSellableShares = ports.fetchSellableShares
      ?? ((id: string) => getPolymarketAvailableBalance(id, 'sell'));
    const fetchMarketState = ports.fetchMarketState
      ?? ((conditionId: string) => fetchPolymarketMarketState(conditionId));

    // The ladder's own `observe` port. Every value it needs is readable from the
    // venue, which is why no schema is required to know *what is left*: the
    // conditional-token balance is the remaining position, and the book carries
    // the tick grid and the venue minimum. Only the reference price is not.
    const observe = async () => {
      const book = await fetchBook(tokenID);
      const [remainingShares, market] = await Promise.all([
        fetchSellableShares(tokenID),
        fetchMarketState(String(book.conditionId))
      ]);
      return {
        remainingShares,
        bestBid: bestBidFromBook(book),
        // Passed through as a share count, matching `planPolymarketBookOrder`.
        // The docs disagree with themselves about the unit —
        // `/trading/place-orders` calls `min_order_size` "the minimum number of
        // shares the CLOB accepts" while `/market-data/market-details` calls the
        // same field a "minimum USDC notional" — so this deliberately keeps the
        // interpretation the rest of this module already uses rather than
        // introducing a second one.
        minimumShares: Number(book.minOrderSize),
        tickSize: Number(book.tickSize),
        market
      };
    };

    // Claimed before the first rung, not after the ladder: a throw partway
    // through has already sold shares, and re-running from rung zero would sell
    // them twice.
    escalatedExitTradeIds.add(candidate.id);
    try {
      const observed = await observe();
      const outcome = await escalate(
        {
          ...observed,
          referencePrice: reference.referencePrice,
          minimumExitPrice
        },
        {
          submitRung: ports.submitRungFor
            ? ports.submitRungFor(tokenID)
            : createPolymarketExitRungSubmitter({ tokenID, log }),
          observe,
          emitAlert: (alert) => ports.emitAlert(alert, candidate),
          requestRedemption: async (redeem) => {
            // No queue and no table: `runPolymarketRedemptionSweep` scans for
            // resolved positions on this same guarded pass, so the correct
            // action is to stop escalating and let it find this one. Inventing a
            // redemption request row would duplicate the sweep's own source of
            // truth.
            if (ports.requestRedemption) await ports.requestRedemption(redeem, candidate);
            else log(`[polymarket-exit] ${candidate.id} defers to the redemption sweep: ${redeem.reason}`);
          },
          now,
          log
        }
      );
      outcomes.push({ tradeId: candidate.id, outcome });
      escalated += outcome.rungsSubmitted > 0 ? 1 : 0;
      if (outcome.terminal === 'alert') alerted += 1;
      else if (outcome.terminal === 'redeem') redeemed += 1;
      else completed += 1;
      log(
        `[polymarket-exit] trade ${candidate.id} ladder ended ${outcome.terminal} after `
        + `${outcome.rungsSubmitted} rungs, filled ${outcome.filledShares}, `
        + `remaining ${outcome.remainingShares}`
      );
    } catch (error: unknown) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      log(`[polymarket-exit] trade ${candidate.id} escalation failed: ${message}`);
    }
  }

  return {
    scanned: candidates.length,
    escalated,
    completed,
    alerted,
    redeemed,
    failed,
    skipped: skips.length,
    skips,
    outcomes
  };
}
