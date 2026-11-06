import { query } from './client.js';
function toWallet(row) {
    return {
        id: row.id,
        userId: row.user_id,
        chainKind: row.chain_kind,
        address: row.address,
        verifiedAt: row.verified_at
    };
}
const WALLET_COLUMNS = 'id, user_id, chain_kind, address, verified_at';
/**
 * Raised when the address is already linked to a different user.
 *
 * This is a 409, never a silent re-link: quietly moving a verified wallet
 * between accounts would let anyone who can sign for an address take over its
 * role as a withdrawal destination (Stage 4).
 */
export class WalletAlreadyLinkedError extends Error {
    constructor() {
        super('Wallet already linked to another account');
        this.name = 'WalletAlreadyLinkedError';
    }
}
export async function linkAuthWallet(scope, input) {
    try {
        const rows = await query(`INSERT INTO user_auth_wallets (user_id, chain_kind, address)
       VALUES ($1, $2, $3)
       -- Re-linking a wallet the same user already owns is a no-op success, not
       -- a conflict: it makes the endpoint idempotent under a retried request.
       ON CONFLICT (chain_kind, address) DO UPDATE
         SET verified_at = NOW()
         WHERE user_auth_wallets.user_id = $1
       RETURNING ${WALLET_COLUMNS}`, [scope.userId, input.chainKind, input.address]);
        // Zero rows means the ON CONFLICT WHERE excluded it: the row exists and
        // belongs to somebody else.
        if (!rows[0])
            throw new WalletAlreadyLinkedError();
        return toWallet(rows[0]);
    }
    catch (error) {
        if (error instanceof WalletAlreadyLinkedError)
            throw error;
        if (error.code === '23505')
            throw new WalletAlreadyLinkedError();
        throw error;
    }
}
/**
 * Finds the owner of a verified address. Drives wallet-only login.
 *
 * Deliberately not scoped: the caller has no session yet, and the global
 * `UNIQUE (chain_kind, address)` guarantees at most one answer.
 */
export async function findUserIdByAuthWallet(chainKind, address) {
    const rows = await query('SELECT user_id FROM user_auth_wallets WHERE chain_kind = $1 AND address = $2', [chainKind, address]);
    return rows[0]?.user_id ?? null;
}
export async function listAuthWallets(scope) {
    const rows = await query(`SELECT ${WALLET_COLUMNS} FROM user_auth_wallets WHERE user_id = $1 ORDER BY verified_at`, [scope.userId]);
    return rows.map(toWallet);
}
export async function unlinkAuthWallet(scope, input) {
    const rows = await query(`DELETE FROM user_auth_wallets
      WHERE user_id = $1 AND chain_kind = $2 AND address = $3
      RETURNING id`, [scope.userId, input.chainKind, input.address]);
    return rows.length > 0;
}
//# sourceMappingURL=auth-wallets.js.map