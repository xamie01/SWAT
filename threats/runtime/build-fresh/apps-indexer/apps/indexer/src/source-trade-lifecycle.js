import { createHash } from 'node:crypto';
import { recordSourceTradeEvent } from '@swat/db';
import { resolveChainAddress, resolveChainValue } from '@swat/shared';
import { USDC_MINT, USDT_MINT } from './parse.js';
export class SourceTradePersistenceError extends Error {
    chain;
    constructor(chain, options) {
        const detail = options.cause instanceof Error ? `: ${options.cause.message}` : '';
        super(`Failed to persist ${chain} canonical source trade${detail}`, options);
        this.chain = chain;
        this.name = 'SourceTradePersistenceError';
    }
}
async function persistSourceTrade(input) {
    try {
        return await recordSourceTradeEvent(input);
    }
    catch (cause) {
        throw new SourceTradePersistenceError(input.chain, { cause });
    }
}
function normalizeAtomicQuantity(value) {
    if (!/^\d+$/.test(value))
        throw new Error('Atomic quantity must be an unsigned integer');
    const normalized = value.replace(/^0+(?=\d)/, '');
    if (normalized === '0')
        throw new Error('Atomic quantity must be greater than zero');
    return normalized;
}
function normalizeEvmHash(value, field) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(value))
        throw new Error(`${field} must be a 32-byte hex value`);
    return value.toLowerCase();
}
function formatScaledInteger(value, decimals) {
    if (!/^\d+$/.test(value))
        throw new Error('Atomic quantity must be an unsigned integer');
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
        throw new Error('Token decimals must be an integer between 0 and 255');
    }
    const normalized = value.replace(/^0+(?=\d)/, '');
    if (decimals === 0)
        return normalized;
    const padded = normalized.padStart(decimals + 1, '0');
    const integer = padded.slice(0, -decimals);
    const fraction = padded.slice(-decimals).replace(/0+$/, '');
    return fraction ? `${integer}.${fraction}` : integer;
}
function deterministicSolanaPricing(event) {
    const quoteAmount = event.direction === 'buy'
        ? (event.tokenIn === USDC_MINT || event.tokenIn === USDT_MINT ? event.amountIn : null)
        : (event.tokenOut === USDC_MINT || event.tokenOut === USDT_MINT ? event.amountOut : null);
    if (quoteAmount === null)
        return { amountUsd: null, priceUsd: null };
    return {
        amountUsd: formatScaledInteger(quoteAmount, 6),
        // Parsed transaction balances do not currently carry target decimals.
        // Externally-fetched metadata can change availability between replays, so
        // it must not become part of the immutable source payload.
        priceUsd: null
    };
}
export function buildSolanaSourceTradeInput(input) {
    const { event } = input;
    const wallet = resolveChainAddress(event.walletAddress, 'solana');
    const token = resolveChainValue(event.targetToken, 'solana');
    const quantity = normalizeAtomicQuantity(event.direction === 'buy' ? event.amountOut : event.amountIn);
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
        confirmationState: 'confirmed',
        confirmationEvidenceId: `${input.source}:${event.transactionIdentity}:${event.slot ?? 'unknown-slot'}`
    };
}
export async function persistSolanaSourceTrade(input) {
    return persistSourceTrade(buildSolanaSourceTradeInput(input));
}
function polymarketFillIndex(trade, quantity) {
    const identity = [
        trade.transactionHash,
        trade.proxyWallet,
        trade.conditionId,
        trade.asset,
        trade.side,
        quantity,
        String(trade.price),
        trade.timestamp.toISOString()
    ].join('\u0000');
    return createHash('sha256').update(identity).digest('hex');
}
export function buildPolymarketSourceTradeInput(input) {
    const { trade } = input;
    const transactionHash = normalizeEvmHash(trade.transactionHash, 'Polymarket transaction hash');
    const conditionId = normalizeEvmHash(trade.conditionId, 'Polymarket condition ID');
    const wallet = resolveChainAddress(trade.proxyWallet, 'polygon');
    const token = resolveChainValue(trade.asset, 'polygon');
    const quantity = normalizeAtomicQuantity(input.quantity);
    const sourceEventIndex = polymarketFillIndex({
        ...trade,
        transactionHash,
        conditionId,
        proxyWallet: wallet.raw,
        asset: token.raw
    }, quantity);
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
        amountUsd: input.amountUsd,
        priceUsd: trade.price,
        eventAt: trade.timestamp,
        confirmationState: 'confirmed',
        confirmationEvidenceId: `polymarket-data-api:${transactionHash}:${sourceEventIndex}`
    };
}
export async function persistPolymarketSourceTrade(input) {
    return persistSourceTrade(buildPolymarketSourceTradeInput(input));
}
export function buildRobinhoodSourceTradeInput(input) {
    const transactionHash = normalizeEvmHash(input.transactionHash, 'Robinhood transaction hash');
    const wallet = resolveChainAddress(input.walletAddress, 'robinhood-chain');
    const token = resolveChainAddress(input.tokenMint, 'robinhood-chain');
    const quantity = normalizeAtomicQuantity(input.quantity);
    if (input.blockNumber < 0n)
        throw new Error('Robinhood block number must not be negative');
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
        confirmationState: 'confirmed',
        confirmationEvidenceId: `robinhood-receipt:${transactionHash}:${input.blockNumber}`
    };
}
export async function persistRobinhoodSourceTrade(input) {
    return persistSourceTrade(buildRobinhoodSourceTradeInput(input));
}
//# sourceMappingURL=source-trade-lifecycle.js.map