import { requireFinancial, type WithdrawalSqlClient } from '@swat/db/dist/withdrawal-contract.js';

/** SQL082 settler is a restricted NOLOGIN function owner, never an app SET ROLE or supplied label. */
export async function assertOwnedFinancialSettler(client: WithdrawalSqlClient): Promise<void> {
  const rows = (await client.query<Record<string,unknown>>(`SELECT owner.rolname AS owner_role,
    owner.rolcanlogin,owner.rolsuper,owner.rolbypassrls,owner.rolinherit,owner.rolcreaterole,owner.rolcreatedb,owner.rolreplication,
    proc.prosecdef,proc.proconfig,
    has_function_privilege(current_user,proc.oid,'EXECUTE') AS can_execute,
    EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=owner.oid OR roleid=owner.oid) AS has_memberships
    FROM pg_catalog.pg_proc proc JOIN pg_catalog.pg_roles owner ON owner.oid=proc.proowner
    WHERE proc.oid=to_regprocedure('public.swat_apply_perps_reducing_receipt(uuid,text)')
      /* financial-owned:settler */`)).rows;
  const r=rows[0];
  requireFinancial(rows.length===1 && r && r.owner_role==='swat_financial_settler' && r.prosecdef===true && r.can_execute===true
    && ['rolcanlogin','rolsuper','rolbypassrls','rolinherit','rolcreaterole','rolcreatedb','rolreplication','has_memberships']
      .every(key=>r[key]===false) && Array.isArray(r.proconfig) && r.proconfig.length===1 && r.proconfig[0]==='search_path=pg_catalog',
  'financial-distinct-protected-settler-unavailable');
}
