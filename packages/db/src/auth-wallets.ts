import { scopedQuery } from './tenancy.js';
import type { UserScope } from './tenancy.js';
import type { OwnedAuthStore } from './auth-owned.js';
import { WalletAlreadyLinkedError } from './auth-owned.js';
export { WalletAlreadyLinkedError };
export type AuthWalletChainKind = 'evm' | 'solana';
export interface AuthWalletRecord {
  readonly id:string; readonly userId:string; readonly chainKind:AuthWalletChainKind;
  readonly address:string; readonly verifiedAt:Date;
}
/** No caller UserScope/claimed user id may mint wallet provenance. Legacy callers
 * must supply the protected store plus an active session token; SQL app DML is revoked. */
export async function linkAuthWallet(store: OwnedAuthStore,token:string,input:{chainKind:AuthWalletChainKind;address:string}):Promise<AuthWalletRecord> {
  if(!store || typeof store.linkWallet!=='function' || typeof token!=='string') throw new Error('Protected auth store/session required');
  return store.linkWallet(token,input);
}
export async function findUserIdByAuthWallet(store: OwnedAuthStore,token:string):Promise<string|null> {
  if(!store || typeof store.resolveSession!=='function') throw new Error('Protected session required; unscoped wallet owner lookup prohibited');
  return (await store.resolveSession(token))?.user.id ?? null;
}
/** Only tenant verified-wallet read required by existing me/billing. Protected sidecar
 * cannot be forged by app audit inserts or historical proof labels. */
export async function listAuthWallets(scope:UserScope):Promise<AuthWalletRecord[]> {
  const rows=await scopedQuery(scope,`SELECT w.id,w.user_id,w.chain_kind,w.address,w.verified_at FROM user_auth_wallets w
    JOIN auth_wallet_proofs p ON p.wallet_id=w.id AND p.user_id=w.user_id AND p.chain_kind=w.chain_kind
      AND p.address=w.address AND p.verified_at=w.verified_at WHERE w.user_id=$1 ORDER BY w.verified_at`,[scope.userId]);
  return rows.map(r=>({id:r.id,userId:r.user_id,chainKind:r.chain_kind,address:r.address,verifiedAt:r.verified_at}));
}
export async function unlinkAuthWallet(store:OwnedAuthStore,token:string,input:{chainKind:AuthWalletChainKind;address:string}):Promise<boolean> {
  if(!store || typeof store.unlinkWallet!=='function') throw new Error('Protected auth store/session required');
  return store.unlinkWallet(token,input);
}
