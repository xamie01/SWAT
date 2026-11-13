import { query } from './client.js';
import { withTransaction } from './transaction.js';
import type { UserScope } from './tenancy.js';

export type AuthWalletChainKind = 'evm' | 'solana';

export interface AuthWalletRecord {
  readonly id: string;
  readonly userId: string;
  readonly chainKind: AuthWalletChainKind;
  readonly address: string;
  readonly verifiedAt: Date;
}

interface AuthWalletRow {
  id: string;
  user_id: string;
  chain_kind: AuthWalletChainKind;
  address: string;
  verified_at: Date;
}

function toWallet(row: AuthWalletRow): AuthWalletRecord {
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

export async function linkAuthWallet(
  scope: UserScope,
  input: { chainKind: AuthWalletChainKind; address: string }
): Promise<AuthWalletRecord> {
  try {
    return await withTransaction(async (client) => {
    const { rows } = await client.query<AuthWalletRow>(
      `INSERT INTO user_auth_wallets (user_id, chain_kind, address)
       VALUES ($1, $2, $3)
       -- Re-linking a wallet the same user already owns is a no-op success, not
       -- a conflict: it makes the endpoint idempotent under a retried request.
       ON CONFLICT (chain_kind, address) DO UPDATE
         SET verified_at = NOW()
         WHERE user_auth_wallets.user_id = $1
       RETURNING ${WALLET_COLUMNS}`,
      [scope.userId, input.chainKind, input.address]
    );
    // Zero rows means the ON CONFLICT WHERE excluded it: the row exists and
    // belongs to somebody else.
    if (!rows[0]) throw new WalletAlreadyLinkedError();
    await client.query(`INSERT INTO audit_log (actor_type, actor_id, event, target_type, target_id, metadata)
      VALUES ('user', $1, 'auth.wallet_linked', 'auth_wallet', $2, '{"proof":"siwe-siws"}')`,
      [scope.userId, input.address]);
    return toWallet(rows[0]);
    });
  } catch (error) {
    if (error instanceof WalletAlreadyLinkedError) throw error;
    if ((error as { code?: string }).code === '23505') throw new WalletAlreadyLinkedError();
    throw error;
  }
}

/**
 * Finds the owner of a verified address. Drives wallet-only login.
 *
 * Deliberately not scoped: the caller has no session yet, and the global
 * `UNIQUE (chain_kind, address)` guarantees at most one answer.
 */
export async function findUserIdByAuthWallet(
  chainKind: AuthWalletChainKind,
  address: string
): Promise<string | null> {
  const rows = await query<{ user_id: string }>(
    `SELECT user_id FROM user_auth_wallets WHERE chain_kind = $1 AND address = $2 AND EXISTS (SELECT 1 FROM audit_log a WHERE a.event = 'auth.wallet_linked' AND a.actor_type = 'user' AND a.actor_id = user_auth_wallets.user_id AND a.target_id = user_auth_wallets.address AND a.occurred_at >= user_auth_wallets.verified_at)`,
    [chainKind, address]
  );
  return rows[0]?.user_id ?? null;
}

export async function listAuthWallets(scope: UserScope): Promise<AuthWalletRecord[]> {
  const rows = await query<AuthWalletRow>(
    `SELECT ${WALLET_COLUMNS} FROM user_auth_wallets WHERE user_id = $1 AND EXISTS (SELECT 1 FROM audit_log a WHERE a.event = 'auth.wallet_linked' AND a.actor_type = 'user' AND a.actor_id = user_auth_wallets.user_id AND a.target_id = user_auth_wallets.address AND a.occurred_at >= user_auth_wallets.verified_at) ORDER BY verified_at`,
    [scope.userId]
  );
  return rows.map(toWallet);
}

export async function unlinkAuthWallet(
  scope: UserScope,
  input: { chainKind: AuthWalletChainKind; address: string }
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM user_auth_wallets
      WHERE user_id = $1 AND chain_kind = $2 AND address = $3
      RETURNING id`,
    [scope.userId, input.chainKind, input.address]
  );
  return rows.length > 0;
}
