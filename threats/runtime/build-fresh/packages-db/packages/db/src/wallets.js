import { query } from './client.js';
import { withTransaction } from './transaction.js';
import { getChainPrefix, resolveChainAddress, stripChainPrefix } from '@swat/shared';
export async function listWallets(chain) {
    return query(`SELECT address, chain, nickname, source, status, total_trades, win_rate, realized_roi, unrealized_roi, composite_score, tier, created_at, updated_at
     FROM wallets
     ${chain ? 'WHERE chain = $1' : ''}
     ORDER BY composite_score DESC NULLS LAST, created_at DESC`, chain ? [chain] : []);
}
export async function getWallet(address, chain = 'solana') {
    const prefixedAddress = resolveChainAddress(address, chain).prefixed;
    const rows = await query(`SELECT address, chain, nickname, source, status, total_trades, win_rate, realized_roi, unrealized_roi, composite_score, tier, created_at, updated_at
     FROM wallets
     WHERE address = $1
       AND chain = $2`, [prefixedAddress, chain]);
    return rows[0] ?? null;
}
export async function upsertWallet(wallet) {
    const resolved = resolveChainAddress(wallet.address, wallet.chain);
    const { chain, prefixed: address } = resolved;
    const rows = await query(`INSERT INTO wallets (address, chain, source, nickname, discovery_method)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (address) DO UPDATE SET
       chain = COALESCE(EXCLUDED.chain, wallets.chain),
       nickname = COALESCE(EXCLUDED.nickname, wallets.nickname),
       source = CASE
         WHEN wallets.source IN ('manual', 'shiller') THEN wallets.source
         ELSE EXCLUDED.source
       END,
       -- Only set discovery_method when provided; never clear an existing value.
       discovery_method = COALESCE(EXCLUDED.discovery_method, wallets.discovery_method),
       updated_at = NOW()
     RETURNING *`, [address, chain, wallet.source, wallet.nickname ?? null, wallet.discoveryMethod ?? null]);
    return rows[0];
}
export async function resolvePrefixedAddress(address, chain) {
    const existingChain = getChainPrefix(address);
    if (existingChain || chain) {
        return resolveChainAddress(address, chain).prefixed;
    }
    const raw = stripChainPrefix(address);
    const rows = await query(`SELECT address FROM wallets 
     WHERE address = $1 
        OR address = 'solana:' || $1 
        OR address = 'polygon:' || $1 
        OR address = 'robinhood-chain:' || $1 
     LIMIT 1`, [raw]);
    if (rows[0]?.address)
        return resolveChainAddress(rows[0].address).prefixed;
    if (raw.toLowerCase().startsWith('0x')) {
        throw new Error('Unable to resolve raw EVM address without an explicit chain');
    }
    return resolveChainAddress(raw, 'solana').prefixed;
}
export async function deleteWallet(address, chain) {
    const prefixed = await resolvePrefixedAddress(address, chain);
    await query('DELETE FROM wallets WHERE address = $1', [prefixed]);
}
/**
 * Delete a wallet and all rows that reference it. `deleteWallet` alone fails with
 * a foreign-key violation once the wallet has transactions / cluster memberships /
 * funding edges, so remove children first, inside a transaction.
 */
export async function deleteWalletCascade(address, chain) {
    const prefixed = await resolvePrefixedAddress(address, chain);
    // A single pooled client so the deletes actually form one transaction.
    await withTransaction(async (client) => {
        await client.query('DELETE FROM cluster_memberships WHERE wallet_address = $1', [prefixed]);
        await client.query('DELETE FROM transactions WHERE wallet_address = $1', [prefixed]);
        await client.query('DELETE FROM wallet_relationships WHERE wallet_a = $1 OR wallet_b = $1', [prefixed]);
        await client.query('DELETE FROM wallets WHERE address = $1', [prefixed]);
    });
}
export async function refreshWalletActivity(address, lastActive, tradeIncrement = 0) {
    const chain = getChainPrefix(address) ?? 'solana';
    const prefixedAddress = resolveChainAddress(address, chain).prefixed;
    // last_active is kept MONOTONIC via GREATEST so a concurrent webhook (which
    // passes its own timestamp) can't clobber a newer value written by the bulk
    // backfill, and vice-versa. GREATEST ignores NULLs; COALESCE adds the NOW()
    // fallback when both the new value and the existing column are NULL.
    const rows = await query(`UPDATE wallets w
     SET
       status = 'active',
       last_active = COALESCE(GREATEST(w.last_active, $2::timestamp), NOW()),
       total_trades = COALESCE(w.total_trades, 0) + $3::int,
       updated_at = NOW()
     WHERE w.address = $1
     RETURNING *`, [prefixedAddress, lastActive ?? null, tradeIncrement]);
    return rows[0] ?? null;
}
//# sourceMappingURL=wallets.js.map