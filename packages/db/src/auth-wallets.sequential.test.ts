import {beforeEach,expect,it,vi} from 'vitest';
const db=vi.hoisted(()=>({scoped:vi.fn()}));
vi.mock('./tenancy.js',()=>({scopedQuery:db.scoped}));
import {listAuthWallets,linkAuthWallet,findUserIdByAuthWallet,unlinkAuthWallet} from './auth-wallets.js';
const userId='11111111-1111-4111-8111-111111111111';
beforeEach(()=>vi.clearAllMocks());
it('uses actual tenant-scoped protected proof join for me/billing reads',async()=>{
 db.scoped.mockResolvedValue([{id:'wallet',user_id:userId,chain_kind:'evm',address:'0x'+'1'.repeat(40),verified_at:new Date('2026-01-01')}]);
 const result=await listAuthWallets({userId} as any);
 expect(result[0]?.userId).toBe(userId);
 expect(db.scoped.mock.calls[0]?.[0]).toEqual({userId});
 expect(db.scoped.mock.calls[0]?.[1]).toContain('JOIN auth_wallet_proofs');
 expect(db.scoped.mock.calls[0]?.[1]).not.toContain('audit_log');
});
it('rejects legacy scope/labels as wallet linking or lookup authority',async()=>{
 await expect(linkAuthWallet({userId} as any,{chainKind:'evm',address:'fixture'} as any,undefined as any)).rejects.toThrow('Protected');
 await expect(findUserIdByAuthWallet('evm' as any,'fixture')).rejects.toThrow('Protected');
 await expect(unlinkAuthWallet({userId} as any,'fixture',{chainKind:'evm',address:'fixture'})).rejects.toThrow('Protected');
});
it('delegates protected writes only with active raw session credential, never user id',async()=>{
 const store={linkWallet:vi.fn(async()=>({id:'wallet'})),unlinkWallet:vi.fn(async()=>true),resolveSession:vi.fn(async()=>({user:{id:userId}}))};
 const input={chainKind:'evm' as const,address:'0x'+'1'.repeat(40)};
 await linkAuthWallet(store as any,'synthetic-session',input);
 expect(store.linkWallet).toHaveBeenCalledWith('synthetic-session',input);
 expect(await unlinkAuthWallet(store as any,'synthetic-session',input)).toBe(true);
 expect(await findUserIdByAuthWallet(store as any,'synthetic-session')).toBe(userId);
});
