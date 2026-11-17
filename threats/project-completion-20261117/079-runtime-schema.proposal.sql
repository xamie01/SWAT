-- SOURCE-ONLY079 proposal. Parent integrates; no provisioning, seed or apply.
-- Provision an isolated NOLOGIN/NOBYPASSRLS/non-superuser/no-membership
-- swat_runtime_lookup owner in a separately reviewed environment first.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles role WHERE role.rolname = 'swat_runtime_lookup'
    AND NOT(role.rolcanlogin OR role.rolsuper OR role.rolbypassrls OR role.rolinherit OR role.rolcreaterole OR role.rolcreatedb OR role.rolreplication)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members member WHERE member.member = role.oid OR member.roleid = role.oid))
  THEN RAISE EXCEPTION 'isolated restricted runtime lookup owner not provisioned'; END IF;
END $$;
CREATE TABLE public.worker_runtime_capabilities (
  capability_id uuid PRIMARY KEY,
  revision text NOT NULL CHECK(length(revision) BETWEEN 1 AND 128),
  execution_id uuid NOT NULL UNIQUE REFERENCES public.copy_executions(id) ON DELETE RESTRICT,
  runtime_role name NOT NULL CHECK(runtime_role = 'swat_app'),
  database_oid oid NOT NULL,
  server_address text NOT NULL,
  server_port integer NOT NULL,
  backend_identity text NOT NULL CHECK(length(backend_identity) BETWEEN 1 AND 512),
  valid_from timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK(expires_at > valid_from),
  revoked_at timestamptz,
  CHECK(revoked_at IS NULL OR revoked_at >= valid_from)
);
ALTER TABLE public.worker_runtime_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_runtime_capabilities FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_runtime_lookup_registry ON public.worker_runtime_capabilities TO swat_runtime_lookup USING(true);
CREATE POLICY worker_runtime_migration_registry ON public.worker_runtime_capabilities TO swat_migrator
 USING(public.is_rls_bypassed()) WITH CHECK(public.is_rls_bypassed());
REVOKE ALL ON public.worker_runtime_capabilities FROM PUBLIC,swat_app;
GRANT SELECT ON public.worker_runtime_capabilities TO swat_runtime_lookup;
-- Capabilities remain UNSEEDED. Only reviewed protected writer inserts precise
-- execution/role/host bindings; no wildcard list, queue user grant or env opt-in.

CREATE TABLE public.source_sell_lot_allocations (
 execution_id uuid NOT NULL REFERENCES public.copy_executions(id) ON DELETE RESTRICT,
 lot_id uuid NOT NULL REFERENCES public.copy_position_master_lots(id) ON DELETE RESTRICT,
 ordinal integer NOT NULL CHECK(ordinal >= 0),
 user_id uuid,
 chain text NOT NULL,
 target_account text NOT NULL,
 token_mint text NOT NULL,
 master_wallet_address text NOT NULL,
 execution_mode text NOT NULL CHECK(execution_mode IN('paper','live','shadow')),
 requested_quantity numeric NOT NULL CHECK(requested_quantity > 0 AND requested_quantity <> 'NaN'::numeric),
 acquisition_execution_id uuid NOT NULL REFERENCES public.copy_executions(id) ON DELETE RESTRICT,
 acquisition_evidence_id uuid NOT NULL REFERENCES public.copy_execution_evidence(id) ON DELETE RESTRICT,
 acquisition_source_trade_id uuid NOT NULL REFERENCES public.source_trades(id) ON DELETE RESTRICT,
 PRIMARY KEY(execution_id,lot_id), UNIQUE(execution_id,ordinal)
);
CREATE FUNCTION public.guard_source_sell_lot_allocation() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'source sell allocation immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.copy_executions execution
   JOIN public.source_trades sell ON sell.id = execution.source_trade_id AND sell.direction='sell'
     AND sell.chain=execution.chain AND sell.token_mint=execution.token_mint AND sell.wallet_address=NEW.master_wallet_address
   JOIN public.copy_position_master_lots lot ON lot.id=NEW.lot_id AND lot.user_id IS NOT DISTINCT FROM execution.user_id
     AND lot.chain=execution.chain AND lot.token_mint=execution.token_mint AND lot.master_wallet_address=sell.wallet_address
   JOIN public.copy_positions position ON position.id=lot.position_id AND position.target_account=execution.target_account
     AND position.user_id IS NOT DISTINCT FROM execution.user_id AND position.chain=execution.chain AND position.token_mint=execution.token_mint
   JOIN public.copy_executions acquisition ON acquisition.id=lot.acquisition_execution_id AND acquisition.direction='buy'
     AND acquisition.user_id IS NOT DISTINCT FROM execution.user_id AND acquisition.execution_mode=execution.execution_mode
     AND acquisition.target_account=execution.target_account AND acquisition.chain=execution.chain AND acquisition.token_mint=execution.token_mint
     AND acquisition.source_trade_id=lot.source_trade_id AND acquisition.signal_id IS NOT DISTINCT FROM lot.signal_id
   JOIN public.source_trades buy ON buy.id=lot.source_trade_id AND buy.direction='buy' AND buy.wallet_address=lot.master_wallet_address
     AND buy.chain=execution.chain AND buy.token_mint=execution.token_mint AND buy.confirmation_state IN('confirmed','finalized')
   JOIN public.copy_execution_evidence evidence ON evidence.id=lot.acquisition_evidence_id AND evidence.execution_id=acquisition.id
     AND evidence.confirmation_state IN('confirmed','finalized')
   JOIN public.copy_position_applications application ON application.evidence_id=evidence.id AND application.execution_id=acquisition.id
     AND application.position_id=position.id AND application.active AND application.user_id IS NOT DISTINCT FROM execution.user_id
   JOIN public.copy_execution_policy_snapshots snapshot ON snapshot.execution_id=acquisition.id
     AND snapshot.user_id IS NOT DISTINCT FROM execution.user_id AND snapshot.execution_mode=execution.execution_mode
     AND snapshot.target_account=execution.target_account AND snapshot.chain=execution.chain AND snapshot.token_mint=execution.token_mint
     AND snapshot.master_wallet_address=lot.master_wallet_address
   WHERE execution.id=NEW.execution_id AND execution.user_id IS NOT DISTINCT FROM NEW.user_id
     AND execution.chain=NEW.chain AND execution.target_account=NEW.target_account AND execution.token_mint=NEW.token_mint
     AND execution.execution_mode=NEW.execution_mode AND execution.direction='sell' AND execution.exit_lot_id IS NULL
     AND execution.exit_trigger IS NULL AND execution.source_sell_fraction > 0 AND execution.source_position_before_quantity > 0
     AND execution.state IN('requested','simulated') AND execution.submission_id IS NULL AND execution.submission_attempts=0
     AND execution.confirmed_base_quantity=0 AND lot.remaining_quantity >= NEW.requested_quantity
     AND acquisition.id=NEW.acquisition_execution_id AND evidence.id=NEW.acquisition_evidence_id AND buy.id=NEW.acquisition_source_trade_id
     AND NOT EXISTS(SELECT 1 FROM public.copy_execution_worker_attempts WHERE execution_id=execution.id)
     AND NOT EXISTS(SELECT 1 FROM public.copy_execution_evidence WHERE execution_id=execution.id))
 THEN RAISE EXCEPTION 'source sell allocation scope/provenance unavailable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_sell_allocation_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.source_sell_lot_allocations
 FOR EACH ROW EXECUTE FUNCTION public.guard_source_sell_lot_allocation();
REVOKE ALL ON FUNCTION public.guard_source_sell_lot_allocation() FROM PUBLIC,swat_app;
ALTER TABLE public.source_sell_lot_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_sell_lot_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY source_sell_allocation_tenant ON public.source_sell_lot_allocations TO swat_app
 USING(user_id=public.current_app_user_id()) WITH CHECK(user_id=public.current_app_user_id());
CREATE POLICY source_sell_allocation_migrator ON public.source_sell_lot_allocations TO swat_migrator
 USING(public.is_rls_bypassed()) WITH CHECK(public.is_rls_bypassed());
REVOKE ALL ON public.source_sell_lot_allocations FROM PUBLIC,swat_app;
GRANT SELECT,INSERT ON public.source_sell_lot_allocations TO swat_app;
-- PostgreSQL row locks (FOR SHARE/FOR UPDATE) require UPDATE on at least one
-- column. This privilege permits locking only in practice: the immutable BEFORE
-- UPDATE trigger rejects EVERY mutation, including identity/no-op changes.
GRANT UPDATE (requested_quantity) ON public.source_sell_lot_allocations TO swat_app;

-- Only the NOLOGIN lookup owner can read cross-tenant canonical comparison
-- records. It cannot insert/update effects; direct runtime SELECT stays RLS.
GRANT USAGE ON SCHEMA public TO swat_runtime_lookup;
GRANT SELECT ON public.copy_executions,public.copy_execution_policy_snapshots,
 public.source_fanout_deliveries,public.source_fanout_batches,public.copy_position_master_lots,
 public.copy_position_close_all_claims,public.source_trades,public.signals TO swat_runtime_lookup;
CREATE POLICY runtime_lookup_execution ON public.copy_executions TO swat_runtime_lookup USING(true);
CREATE POLICY runtime_lookup_delivery ON public.source_fanout_deliveries TO swat_runtime_lookup USING(true);
CREATE POLICY runtime_lookup_batch ON public.source_fanout_batches TO swat_runtime_lookup USING(true);
CREATE POLICY runtime_lookup_snapshot ON public.copy_execution_policy_snapshots TO swat_runtime_lookup USING(true);
CREATE POLICY runtime_lookup_lot ON public.copy_position_master_lots TO swat_runtime_lookup USING(true);
CREATE POLICY runtime_lookup_close_claim ON public.copy_position_close_all_claims TO swat_runtime_lookup USING(true);

CREATE FUNCTION public.swat_claim_runtime_capability(requested_execution_id uuid)
 RETURNS TABLE(capability_id uuid,revision text,execution_id uuid,user_id uuid,chain text,token_mint text,
 target_account text,execution_mode text,obligation_kind text,obligation_id text,backend_identity text,
 expires_at timestamptz,observed_at timestamptz)
 LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $$
 SELECT capability.capability_id,capability.revision,execution.id,execution.user_id,execution.chain::text,
 execution.token_mint::text,execution.target_account::text,execution.execution_mode::text,
 CASE WHEN execution.source_trade_id IS NOT NULL THEN 'fanout' ELSE 'lot-exit' END,
 CASE WHEN execution.source_trade_id IS NOT NULL THEN delivery.job_id::text ELSE execution.exit_lot_id::text END,
 capability.backend_identity,capability.expires_at,CURRENT_TIMESTAMP
 FROM public.worker_runtime_capabilities capability
 JOIN public.copy_executions execution ON execution.id=capability.execution_id
 JOIN public.copy_execution_policy_snapshots snapshot ON snapshot.execution_id=execution.id
  AND snapshot.user_id IS NOT DISTINCT FROM execution.user_id AND snapshot.chain=execution.chain
  AND snapshot.target_account=execution.target_account AND snapshot.token_mint=execution.token_mint
  AND snapshot.execution_mode=execution.execution_mode
 LEFT JOIN public.source_fanout_deliveries delivery ON delivery.execution_id=execution.id AND delivery.signal_id=execution.signal_id
  AND delivery.user_id IS NOT DISTINCT FROM execution.user_id AND delivery.target_account=execution.target_account
  AND delivery.execution_mode=execution.execution_mode
 LEFT JOIN public.source_fanout_batches batch ON batch.signal_id=execution.signal_id AND batch.source_trade_id=execution.source_trade_id
 LEFT JOIN public.source_trades source ON source.id=execution.source_trade_id AND source.chain=execution.chain
  AND source.token_mint=execution.token_mint AND source.direction=execution.direction AND source.wallet_address=snapshot.master_wallet_address
 LEFT JOIN public.copy_position_master_lots lot ON lot.id=execution.exit_lot_id
  AND lot.user_id IS NOT DISTINCT FROM execution.user_id AND lot.chain=execution.chain AND lot.token_mint=execution.token_mint
  AND lot.master_wallet_address=snapshot.master_wallet_address
 LEFT JOIN public.copy_executions acquisition ON acquisition.id=lot.acquisition_execution_id
  AND acquisition.user_id IS NOT DISTINCT FROM execution.user_id AND acquisition.target_account=execution.target_account
  AND acquisition.chain=execution.chain AND acquisition.token_mint=execution.token_mint AND acquisition.execution_mode=execution.execution_mode
 WHERE execution.id=requested_execution_id AND capability.runtime_role=session_user AND session_user='swat_app'
  AND capability.revoked_at IS NULL AND capability.valid_from <= CURRENT_TIMESTAMP AND capability.expires_at > CURRENT_TIMESTAMP
  AND capability.database_oid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())
  AND capability.server_address=COALESCE(inet_server_addr()::text,'unix')
  AND capability.server_port=COALESCE(inet_server_port(),0)
  AND capability.backend_identity=concat(current_database(),'|',COALESCE(inet_server_addr()::text,'unix'),'|',COALESCE(inet_server_port(),0),'|',session_user)
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles role WHERE role.rolname=session_user
    AND NOT(role.rolsuper OR role.rolbypassrls OR role.rolinherit OR role.rolcreaterole OR role.rolcreatedb OR role.rolreplication)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=role.oid))
  AND ((execution.source_trade_id IS NOT NULL AND batch.signal_id IS NOT NULL AND source.id IS NOT NULL
    AND delivery.descriptor->'data'->>'copyExecutionId'=execution.id::text
    AND delivery.descriptor->'data'->>'signalId'=execution.signal_id::text
    AND delivery.descriptor->'data'->>'sourceTradeId'=execution.source_trade_id::text
    AND delivery.descriptor->'data'->>'userId' IS NOT DISTINCT FROM execution.user_id::text
    AND delivery.descriptor->'data'->>'chain'=execution.chain
    AND delivery.descriptor->'data'->>'tokenMint'=execution.token_mint
    AND delivery.descriptor->'data'->>'direction'=execution.direction
    AND delivery.descriptor->'data'->>'targetAccount'=execution.target_account
    AND delivery.descriptor->'data'->>'executionMode'=execution.execution_mode
    AND delivery.descriptor->'data'->>'masterWalletAddress'=snapshot.master_wallet_address
    AND delivery.descriptor->'data'->>'requestedBaseQuantity' IS NOT DISTINCT FROM execution.requested_base_quantity::text
    AND delivery.descriptor->'data'->>'requestedQuoteQuantity' IS NOT DISTINCT FROM execution.requested_quote_quantity::text)
   OR (execution.source_trade_id IS NULL AND execution.direction='sell' AND lot.id IS NOT NULL AND acquisition.id IS NOT NULL
    AND execution.requested_base_quantity > 0 AND execution.source_sell_fraction IS NULL AND execution.source_position_before_quantity IS NULL
    AND ((execution.exit_trigger='close-all' AND EXISTS(SELECT 1 FROM public.copy_position_close_all_claims claim
      WHERE claim.execution_id=execution.id AND claim.lot_id=lot.id AND claim.user_id IS NOT DISTINCT FROM execution.user_id
        AND claim.wallet_address=lot.master_wallet_address AND claim.requested_quantity=execution.requested_base_quantity
        AND claim.status IN('claimed','confirmed')))
      OR execution.exit_trigger='stop-loss')))
$$;
ALTER FUNCTION public.swat_claim_runtime_capability(uuid) OWNER TO swat_runtime_lookup;
REVOKE ALL ON FUNCTION public.swat_claim_runtime_capability(uuid) FROM PUBLIC,swat_app;
-- EXECUTE intentionally UNGRANTED: real role/provider acceptance first.

-- Narrow operator rows: GUC selects a comparison ID, protected registry and
-- immutable obligation function independently verify it. No bypass flag.
CREATE FUNCTION public.has_worker_execution_capability(id uuid) RETURNS boolean
 LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.swat_claim_runtime_capability(id) capability
   WHERE capability.user_id IS NULL AND capability.execution_id::text=current_setting('app.worker_execution_id',true))
$$;
ALTER FUNCTION public.has_worker_execution_capability(uuid) OWNER TO swat_runtime_lookup;
REVOKE ALL ON FUNCTION public.has_worker_execution_capability(uuid) FROM PUBLIC,swat_app;
CREATE POLICY runtime_operator_execution ON public.copy_executions TO swat_app
 USING(user_id IS NULL AND public.has_worker_execution_capability(id))
 WITH CHECK(user_id IS NULL AND public.has_worker_execution_capability(id));
CREATE POLICY runtime_operator_snapshot ON public.copy_execution_policy_snapshots TO swat_app
 USING(user_id IS NULL AND public.has_worker_execution_capability(execution_id));
CREATE POLICY runtime_operator_attempt ON public.copy_execution_worker_attempts TO swat_app
 USING(user_id IS NULL AND public.has_worker_execution_capability(execution_id))
 WITH CHECK(user_id IS NULL AND public.has_worker_execution_capability(execution_id));
CREATE POLICY runtime_operator_allocation ON public.source_sell_lot_allocations TO swat_app
 USING(user_id IS NULL AND public.has_worker_execution_capability(execution_id))
 WITH CHECK(user_id IS NULL AND public.has_worker_execution_capability(execution_id));
-- Further position/application/lot/trade/risk/capacity column grants and operator
-- policies must be exact joined obligation scope, independently reviewed before
-- enabling EXECUTE. This proposal intentionally does NOT grant global access.
