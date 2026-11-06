import type { UserScope } from './tenancy.js';
export type AuthWalletChainKind = 'evm' | 'solana';
export interface AuthWalletRecord {
    readonly id: string;
    readonly userId: string;
    readonly chainKind: AuthWalletChainKind;
    readonly address: string;
    readonly verifiedAt: Date;
}
/**
 * Raised when the address is already linked to a different user.
 *
 * This is a 409, never a silent re-link: quietly moving a verified wallet
 * between accounts would let anyone who can sign for an address take over its
 * role as a withdrawal destination (Stage 4).
 */
export declare class WalletAlreadyLinkedError extends Error {
    constructor();
}
export declare function linkAuthWallet(scope: UserScope, input: {
    chainKind: AuthWalletChainKind;
    address: string;
}): Promise<AuthWalletRecord>;
/**
 * Finds the owner of a verified address. Drives wallet-only login.
 *
 * Deliberately not scoped: the caller has no session yet, and the global
 * `UNIQUE (chain_kind, address)` guarantees at most one answer.
 */
export declare function findUserIdByAuthWallet(chainKind: AuthWalletChainKind, address: string): Promise<string | null>;
export declare function listAuthWallets(scope: UserScope): Promise<AuthWalletRecord[]>;
export declare function unlinkAuthWallet(scope: UserScope, input: {
    chainKind: AuthWalletChainKind;
    address: string;
}): Promise<boolean>;
//# sourceMappingURL=auth-wallets.d.ts.map