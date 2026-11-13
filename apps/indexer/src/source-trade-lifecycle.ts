import {
  recordSourceTradeEvent,
  type SourceTradeEventInput
} from '@swat/db';
import {
  isAppliedSourceConfirmation,
  resolveChainAddress,
  resolveChainValue
} from '@swat/shared';
import {
  USDC_MINT,
  USDT_MINT,
  type CanonicalSolanaSwapEvent
} from './parse.js';
import { normalizePolymarketDecimal, normalizePolymarketPrice, type ConfirmedPolymarketTrade } from './polymarket-helpers.js';

export type SolanaIngestionSource = 'solana-backfill' | 'solana-webhook';

export class SourceTradePersistenceError extends Error {
  constructor(
    readonly chain: SourceTradeEventInput['chain'],
    options: { cause: unknown }
  ) {
    const detail = options.cause instanceof Error ? `: ${options.cause.message}` : '';
    super(`Failed to persist ${chain} canonical source trade${detail}`, options);
    this.name = 'SourceTradePersistenceError';
  }
}

async function persistSourceTrade(input: SourceTradeEventInput) {
  try {
    const result = await recordSourceTradeEvent(input);
    return {
      ...result,
      eligibleForCopy: isAppliedSourceConfirmation(input.confirmationState)
        && isAppliedSourceConfirmation(result.event.confirmationState)
    };
  } catch (cause) {
    throw new SourceTradePersistenceError(input.chain, { cause });
  }
}

function normalizeAtomicQuantity(value: string): string {
  if (!/^\d+$/.test(value)) throw new Error('Atomic quantity must be an unsigned integer');
  const normalized = value.replace(/^0+(?=\d)/, '');
  if (normalized === '0') throw new Error('Atomic quantity must be greater than zero');
  return normalized;
}

function normalizeEvmHash(value: string, field: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${field} must be a 32-byte hex value`);
  return value.toLowerCase();
}

function formatScaledInteger(value: string, decimals: number): string {
  if (!/^\d+$/.test(value)) throw new Error('Atomic quantity must be an unsigned integer');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error('Token decimals must be an integer between 0 and 255');
  }

  const normalized = value.replace(/^0+(?=\d)/, '');
  if (decimals === 0) return normalized;
  const padded = normalized.padStart(decimals + 1, '0');
  const integer = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${integer}.${fraction}` : integer;
}

function deterministicSolanaPricing(
  event: CanonicalSolanaSwapEvent
): Pick<SourceTradeEventInput, 'amountUsd' | 'priceUsd'> {
  const quoteAmount = event.direction === 'buy'
    ? (event.tokenIn === USDC_MINT || event.tokenIn === USDT_MINT ? event.amountIn : null)
    : (event.tokenOut === USDC_MINT || event.tokenOut === USDT_MINT ? event.amountOut : null);
  if (quoteAmount === null) return { amountUsd: null, priceUsd: null };

  return {
    amountUsd: formatScaledInteger(quoteAmount, 6),
    // Parsed transaction balances do not currently carry target decimals.
    // Externally-fetched metadata can change availability between replays, so
    // it must not become part of the immutable source payload.
    priceUsd: null
  };
}

export function buildSolanaSourceTradeInput(input: {
  event: CanonicalSolanaSwapEvent;
  source: SolanaIngestionSource;
}): SourceTradeEventInput {
  const { event } = input;
  const wallet = resolveChainAddress(event.walletAddress, 'solana');
  const token = resolveChainValue(event.targetToken, 'solana');
  const quantity = normalizeAtomicQuantity(
    event.direction === 'buy' ? event.amountOut : event.amountIn
  );
  const pricing = deterministicSolanaPricing(event);
  return {
    chain: 'solana',
    sourceEventType: 'transaction',
    sourceEventId: event.transactionIdentity,
    sourceEventIndex: wallet.raw,
    transactionHash: event.transactionIdentity,
    walletAddress: wallet.raw,
    tokenMint: token.raw,
    side: event.direction,
    quantity,
    ...pricing,
    eventAt: event.occurredAt,
    confirmationState: 'observed',
    confirmationEvidenceId: `solana-observation:${input.source}:${event.transactionIdentity}:${event.slot ?? 'unknown-slot'}`
  };
}

export async function persistSolanaSourceTrade(input: {
  event: CanonicalSolanaSwapEvent;
  source: SolanaIngestionSource;
}) {
  return persistSourceTrade(buildSolanaSourceTradeInput(input));
}

export function buildPolymarketSourceTradeInput(input: {
  trade: ConfirmedPolymarketTrade;
  quantity: string;
  amountUsd: string;
}): SourceTradeEventInput {
  const { trade } = input;
  const transactionHash = normalizeEvmHash(trade.transactionHash, 'Polymarket transaction hash');
  normalizeEvmHash(trade.conditionId, 'Polymarket condition ID');
  const wallet = resolveChainAddress(trade.proxyWallet, 'polygon');
  const token = resolveChainValue(trade.asset, 'polygon');
  const quantity = normalizeAtomicQuantity(input.quantity);
  const price = normalizePolymarketPrice(trade.price);
  const amountUsd = normalizePolymarketDecimal(input.amountUsd, 'trade notional', 42);
  // The locally reviewed Data API schema has no independent fill/log ID.
  // This is a wallet/transaction observation GROUP, never a unique fill.
  // Economics, token, side and time stay in the immutable payload: changed
  // reports collide and are refused by persistence, not counted as new fills.
  // Even identical reports may be independent fills; this namespace must
  // remain observed and must never receive applied confirmation certificates.
  const sourceEventIndex = `ambiguous-data-api-wallet-v1:${wallet.raw}`;
  return {
    chain: 'polygon',
    sourceEventType: 'venue_trade',
    sourceEventId: transactionHash,
    sourceEventIndex,
    transactionHash,
    walletAddress: wallet.raw,
    tokenMint: token.raw,
    side: trade.side === 'BUY' ? 'buy' : 'sell',
    quantity,
    amountUsd,
    priceUsd: price,
    eventAt: trade.timestamp,
    confirmationState: 'observed',
    confirmationEvidenceId: `polymarket-data-api-observation:${transactionHash}:${sourceEventIndex}`
  };
}

export async function persistPolymarketSourceTrade(input: {
  trade: ConfirmedPolymarketTrade;
  quantity: string;
  amountUsd: string;
}) {
  return persistSourceTrade(buildPolymarketSourceTradeInput(input));
}

export function buildRobinhoodSourceTradeInput(input: {
  transactionHash: string;
  walletAddress: string;
  tokenMint: string;
  side: 'buy' | 'sell';
  quantity: string;
  eventAt: Date;
  blockNumber: bigint;
}): SourceTradeEventInput {
  const transactionHash = normalizeEvmHash(input.transactionHash, 'Robinhood transaction hash');
  const wallet = resolveChainAddress(input.walletAddress, 'robinhood-chain');
  const token = resolveChainAddress(input.tokenMint, 'robinhood-chain');
  const quantity = normalizeAtomicQuantity(input.quantity);
  if (input.blockNumber < 0n) throw new Error('Robinhood block number must not be negative');
  return {
    chain: 'robinhood-chain',
    sourceEventType: 'transaction',
    sourceEventId: transactionHash,
    sourceEventIndex: wallet.raw,
    transactionHash,
    walletAddress: wallet.raw,
    tokenMint: token.raw,
    side: input.side,
    quantity,
    amountUsd: null,
    priceUsd: null,
    eventAt: input.eventAt,
    confirmationState: 'observed',
    confirmationEvidenceId: `robinhood-receipt-observation:${transactionHash}:${input.blockNumber}`
  };
}

export async function persistRobinhoodSourceTrade(input: {
  transactionHash: string;
  walletAddress: string;
  tokenMint: string;
  side: 'buy' | 'sell';
  quantity: string;
  eventAt: Date;
  blockNumber: bigint;
}) {
  return persistSourceTrade(buildRobinhoodSourceTradeInput(input));
}
