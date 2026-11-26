-- Wave2D 080 PROPOSAL ONLY. Parent integrates after read/review; NOT APPLIED.
-- Immutable fills/fees remain untouched. No production valuation writer, seed,
-- signer/provider/runtime capability is installed by this proposal.
DO $$ BEGIN
 IF current_user <> 'swat_migrator' OR session_user <> 'swat_migrator' THEN
   RAISE EXCEPTION 'financial correction proposal requires separate migrator';
 END IF;
END $$;
CREATE TABLE public.worker_valuation_authorities (
 authority_id text PRIMARY KEY, user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
 chain text NOT NULL, network text NOT NULL, provider_id text NOT NULL, identity_digest text NOT NULL,
 verifier_version text NOT NULL, enabled boolean NOT NULL DEFAULT false, valid_until timestamptz NOT NULL,
 max_quote_usd numeric(38,18) NOT NULL CHECK(max_quote_usd >= 0 AND max_quote_usd <> 'NaN'::numeric),
 max_fee_usd numeric(38,18) NOT NULL CHECK(max_fee_usd >= 0 AND max_fee_usd <> 'NaN'::numeric));
CREATE TABLE public.trusted_worker_valuations (
 valuation_id text PRIMARY KEY, authority_id text NOT NULL REFERENCES public.worker_valuation_authorities(authority_id) ON DELETE RESTRICT,
 original_evidence_id uuid NOT NULL REFERENCES public.copy_execution_evidence(id) ON DELETE RESTRICT,
 execution_id uuid NOT NULL REFERENCES public.copy_executions(id) ON DELETE RESTRICT,
 user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
 source_evidence_id text NOT NULL REFERENCES public.source_verified_evidence(evidence_id) ON DELETE RESTRICT,
 lineage_source_trade_id uuid NOT NULL REFERENCES public.source_trades(id) ON DELETE RESTRICT,
 lineage_acquisition_evidence_id uuid REFERENCES public.copy_execution_evidence(id) ON DELETE RESTRICT,
 lineage_master_wallet_address text NOT NULL,
 original_digest text NOT NULL CHECK(original_digest ~ '^[0-9a-f]{64}$'), provider_id text NOT NULL,
 provider_identity_digest text NOT NULL, verifier_version text NOT NULL,
 revision numeric(38,0) NOT NULL CHECK(revision > 0),
 quote_usd numeric(38,18) CHECK(quote_usd >= 0 AND quote_usd <> 'NaN'::numeric),
 fee_usd numeric(38,18) CHECK(fee_usd >= 0 AND fee_usd <> 'NaN'::numeric), valid_until timestamptz NOT NULL,
 CHECK(quote_usd IS NOT NULL OR fee_usd IS NOT NULL), UNIQUE(original_evidence_id,revision));
CREATE TABLE public.copy_execution_valuation_corrections (
 correction_id text PRIMARY KEY,
 valuation_id text NOT NULL UNIQUE REFERENCES public.trusted_worker_valuations(valuation_id) ON DELETE RESTRICT,
 original_evidence_id uuid NOT NULL REFERENCES public.copy_execution_evidence(id) ON DELETE RESTRICT,
 execution_id uuid NOT NULL REFERENCES public.copy_executions(id) ON DELETE RESTRICT,
 user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
 original_digest text NOT NULL CHECK(original_digest ~ '^[0-9a-f]{64}$'),
 original_snapshot jsonb NOT NULL CHECK(jsonb_typeof(original_snapshot)='object'),
 revision numeric(38,0) NOT NULL CHECK(revision > 0),
 previous_correction_id text REFERENCES public.copy_execution_valuation_corrections(correction_id) ON DELETE RESTRICT,
 effective_quote_usd numeric(38,18) CHECK(effective_quote_usd >= 0 AND effective_quote_usd <> 'NaN'::numeric),
 effective_fee_usd numeric(38,18) CHECK(effective_fee_usd >= 0 AND effective_fee_usd <> 'NaN'::numeric),
 recorded_at timestamptz NOT NULL, accepted_at timestamptz NOT NULL DEFAULT now(),
 lineage_source_trade_id uuid NOT NULL REFERENCES public.source_trades(id) ON DELETE RESTRICT,
 lineage_acquisition_evidence_id uuid REFERENCES public.copy_execution_evidence(id) ON DELETE RESTRICT,
 lineage_master_wallet_address text NOT NULL,
 quote_origin_valuation_id text REFERENCES public.trusted_worker_valuations(valuation_id) ON DELETE RESTRICT,
 fee_origin_valuation_id text REFERENCES public.trusted_worker_valuations(valuation_id) ON DELETE RESTRICT,
 UNIQUE(original_evidence_id,revision));
CREATE VIEW public.worker_effective_execution_evidence WITH(security_invoker=true) AS
 SELECT evidence.*,
 CASE WHEN correction.correction_id IS NULL THEN evidence.quote_quantity ELSE correction.effective_quote_usd END AS effective_quote_usd,
 CASE WHEN correction.correction_id IS NULL THEN evidence.fee_usd ELSE correction.effective_fee_usd END AS effective_fee_usd,
 correction.correction_id AS valuation_correction_id
 FROM public.copy_execution_evidence evidence LEFT JOIN LATERAL (
   SELECT c.* FROM public.copy_execution_valuation_corrections c
   WHERE c.original_evidence_id=evidence.id AND c.execution_id=evidence.execution_id
   ORDER BY c.revision DESC LIMIT 1) correction ON true;
CREATE TABLE public.copy_execution_financial_receipts (
 receipt_id text PRIMARY KEY CHECK(receipt_id ~ '^[0-9a-f]{64}$'),
 execution_id uuid NOT NULL REFERENCES public.copy_executions(id) ON DELETE RESTRICT,
 user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
 trade_id uuid NOT NULL REFERENCES public.trades(id) ON DELETE RESTRICT,
 worker_fence bigint NOT NULL CHECK(worker_fence>0), accounting_complete boolean NOT NULL,
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'), recorded_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.risk_spend_reservations ADD COLUMN valuation_correction_id text
 REFERENCES public.copy_execution_valuation_corrections(correction_id) ON DELETE RESTRICT;

-- Provision only via separately authenticated migrator. Runtime never inherits
-- provisioning authority through a callback, env value or generic bypass GUC.
CREATE FUNCTION public.guard_worker_valuation_authority() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF current_user <> 'swat_migrator' OR session_user <> 'swat_migrator' THEN
   RAISE EXCEPTION 'approved independent valuation provisioning unavailable';
 END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'valuation authority history anchor cannot be deleted'; END IF;
 IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-'enabled') IS DISTINCT FROM (to_jsonb(OLD)-'enabled')
   OR NOT OLD.enabled OR NEW.enabled) THEN
   RAISE EXCEPTION 'authority update permits only one-way explicit revocation';
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION public.guard_trusted_worker_valuation() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'independent trusted valuation immutable'; END IF;
 IF current_user <> 'swat_migrator' OR session_user <> 'swat_migrator' THEN
   RAISE EXCEPTION 'approved independent valuation writer unavailable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER worker_valuation_authority_guard BEFORE INSERT OR UPDATE OR DELETE ON public.worker_valuation_authorities
 FOR EACH ROW EXECUTE FUNCTION public.guard_worker_valuation_authority();
CREATE TRIGGER trusted_worker_valuation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.trusted_worker_valuations
 FOR EACH ROW EXECUTE FUNCTION public.guard_trusted_worker_valuation();

-- Immutable lineage for copied fills and explicit close-all/stop-loss lot exits.
-- No direct source id on exit is invented; acquisition source/receipt/policy and
-- exact lot reduction prove tenant/mode/target/asset/master lineage instead.
CREATE FUNCTION public.worker_correction_lineage(requested_execution uuid, requested_fill uuid)
 RETURNS TABLE(source_trade_id uuid,acquisition_evidence_id uuid,master_wallet_address text)
 LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT s.id,NULL::uuid,s.wallet_address::text FROM public.copy_executions e
 JOIN public.copy_execution_evidence f ON f.execution_id=e.id AND f.id=requested_fill
 JOIN public.source_trades s ON s.id=e.source_trade_id AND s.chain=e.chain AND s.token_mint=e.token_mint AND s.direction=e.direction
 JOIN public.copy_execution_policy_snapshots policy ON policy.execution_id=e.id
   AND policy.user_id IS NOT DISTINCT FROM e.user_id AND policy.chain=e.chain AND policy.token_mint=e.token_mint
   AND policy.target_account=e.target_account AND policy.execution_mode=e.execution_mode AND policy.master_wallet_address=s.wallet_address
 WHERE e.id=requested_execution AND e.source_trade_id IS NOT NULL
 UNION ALL
 SELECT buy.id,receipt.id,lot.master_wallet_address::text FROM public.copy_executions e
 JOIN public.copy_execution_evidence f ON f.execution_id=e.id AND f.id=requested_fill
 JOIN public.copy_position_master_lot_reductions reduction ON reduction.sell_execution_id=e.id AND reduction.sell_evidence_id=f.id
   AND reduction.lot_id=e.exit_lot_id AND reduction.quantity=f.base_quantity
 JOIN public.copy_position_master_lots lot ON lot.id=e.exit_lot_id AND lot.user_id IS NOT DISTINCT FROM e.user_id
   AND lot.chain=e.chain AND lot.token_mint=e.token_mint
 JOIN public.copy_positions position ON position.id=lot.position_id AND position.user_id IS NOT DISTINCT FROM e.user_id
   AND position.target_account=e.target_account AND position.chain=e.chain AND position.token_mint=e.token_mint
 JOIN public.copy_executions acquisition ON acquisition.id=lot.acquisition_execution_id AND acquisition.direction='buy'
   AND acquisition.user_id IS NOT DISTINCT FROM e.user_id AND acquisition.execution_mode=e.execution_mode
   AND acquisition.target_account=e.target_account AND acquisition.chain=e.chain AND acquisition.token_mint=e.token_mint
   AND acquisition.source_trade_id=lot.source_trade_id AND acquisition.signal_id IS NOT DISTINCT FROM lot.signal_id
 JOIN public.source_trades buy ON buy.id=lot.source_trade_id AND buy.direction='buy' AND buy.chain=e.chain
   AND buy.token_mint=e.token_mint AND buy.wallet_address=lot.master_wallet_address
 JOIN public.copy_execution_evidence receipt ON receipt.id=lot.acquisition_evidence_id AND receipt.execution_id=acquisition.id
   AND receipt.confirmation_state IN('confirmed','finalized')
 JOIN public.copy_position_applications app ON app.evidence_id=receipt.id AND app.execution_id=acquisition.id AND app.position_id=position.id
   AND app.active AND app.user_id IS NOT DISTINCT FROM e.user_id AND app.target_account=e.target_account AND app.chain=e.chain AND app.token_mint=e.token_mint
 JOIN public.copy_execution_policy_snapshots policy ON policy.execution_id=acquisition.id AND policy.user_id IS NOT DISTINCT FROM e.user_id
   AND policy.target_account=e.target_account AND policy.chain=e.chain AND policy.token_mint=e.token_mint
   AND policy.execution_mode=e.execution_mode AND policy.master_wallet_address=lot.master_wallet_address
 WHERE e.id=requested_execution AND e.source_trade_id IS NULL AND e.direction='sell'
   AND e.exit_trigger IN('close-all','stop-loss') AND e.requested_base_quantity>0
   AND (e.exit_trigger='stop-loss' OR EXISTS(SELECT 1 FROM public.copy_position_close_all_claims claim
     WHERE claim.execution_id=e.id AND claim.lot_id=lot.id AND claim.user_id IS NOT DISTINCT FROM e.user_id));
$$;

-- Durable acceptance is independent of wall-clock expiry after admission.
-- Explicit authority revocation/source reorg still invalidates history and
-- requires reconciliation, never silently resets accepted dollars to zero.
CREATE FUNCTION public.worker_correction_authorized(correction text) RETURNS boolean
 LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 WITH RECURSIVE chain AS (
   SELECT c.*,ARRAY[c.correction_id] AS visited FROM public.copy_execution_valuation_corrections c WHERE c.correction_id=correction
   UNION ALL SELECT prev.*,chain.visited||prev.correction_id FROM chain
     JOIN public.copy_execution_valuation_corrections prev ON prev.correction_id=chain.previous_correction_id
     WHERE NOT prev.correction_id=ANY(chain.visited)
 ), checked AS (
 SELECT c.correction_id,
   (v.valuation_id IS NOT NULL AND a.authority_id IS NOT NULL AND lineage.source_trade_id IS NOT NULL
    AND c.user_id IS NOT DISTINCT FROM e.user_id AND v.user_id IS NOT DISTINCT FROM e.user_id AND a.user_id IS NOT DISTINCT FROM e.user_id
    AND v.execution_id=e.id AND v.original_evidence_id=f.id AND v.original_digest=c.original_digest AND v.revision=c.revision
    AND a.enabled AND a.valid_until>c.accepted_at AND v.valid_until>c.accepted_at AND v.valid_until<=a.valid_until
    AND a.chain=e.chain AND a.network=b.network AND a.provider_id=v.provider_id AND a.identity_digest=v.provider_identity_digest
    AND a.verifier_version=v.verifier_version AND (v.quote_usd IS NULL OR v.quote_usd<=a.max_quote_usd)
    AND (v.fee_usd IS NULL OR v.fee_usd<=a.max_fee_usd)
    AND c.lineage_source_trade_id=lineage.source_trade_id AND v.lineage_source_trade_id=lineage.source_trade_id
    AND c.lineage_acquisition_evidence_id IS NOT DISTINCT FROM lineage.acquisition_evidence_id
    AND v.lineage_acquisition_evidence_id IS NOT DISTINCT FROM lineage.acquisition_evidence_id
    AND c.lineage_master_wallet_address=lineage.master_wallet_address AND v.lineage_master_wallet_address=lineage.master_wallet_address
    AND f.confirmation_state IN('confirmed','finalized') AND app.active AND app.user_id IS NOT DISTINCT FROM e.user_id
    AND app.target_account=e.target_account AND app.chain=e.chain AND app.token_mint=e.token_mint
    AND s.confirmation_state IN('confirmed','finalized') AND h.confirmation_state=s.confirmation_state AND sp.active
    AND sp.wallet_address=s.wallet_address AND sp.chain=s.chain AND sp.token_mint=s.token_mint
    AND proof.source_trade_id=s.id AND proof.binding_digest=b.binding_digest AND proof.finality IN('confirmed','finalized')
    AND p.enabled AND p.valid_until>c.accepted_at AND proof.provider_valid_until>c.accepted_at
    AND p.provider_id=proof.provider_id AND p.identity_digest=proof.provider_identity_digest AND p.chain=s.chain
    AND p.network=b.network AND p.verifier_version=proof.verifier_version
    AND (c.previous_correction_id IS NULL OR (prev.correction_id IS NOT NULL AND prev.original_evidence_id=c.original_evidence_id
      AND prev.execution_id=c.execution_id AND prev.user_id IS NOT DISTINCT FROM c.user_id AND prev.revision<c.revision))
    AND c.effective_quote_usd IS NOT DISTINCT FROM COALESCE(v.quote_usd,CASE WHEN prev.correction_id IS NULL THEN f.quote_quantity ELSE prev.effective_quote_usd END)
    AND c.effective_fee_usd IS NOT DISTINCT FROM COALESCE(v.fee_usd,CASE WHEN prev.correction_id IS NULL THEN f.fee_usd ELSE prev.effective_fee_usd END)
    AND c.quote_origin_valuation_id IS NOT DISTINCT FROM CASE WHEN v.quote_usd IS NOT NULL THEN v.valuation_id ELSE prev.quote_origin_valuation_id END
    AND c.fee_origin_valuation_id IS NOT DISTINCT FROM CASE WHEN v.fee_usd IS NOT NULL THEN v.valuation_id ELSE prev.fee_origin_valuation_id END) AS valid
 FROM chain c LEFT JOIN public.trusted_worker_valuations v ON v.valuation_id=c.valuation_id
 LEFT JOIN public.worker_valuation_authorities a ON a.authority_id=v.authority_id
 LEFT JOIN public.copy_executions e ON e.id=c.execution_id
 LEFT JOIN public.copy_execution_evidence f ON f.id=c.original_evidence_id AND f.execution_id=e.id
 LEFT JOIN LATERAL public.worker_correction_lineage(e.id,f.id) lineage ON true
 LEFT JOIN public.copy_position_applications app ON app.evidence_id=f.id AND app.execution_id=e.id
 LEFT JOIN public.copy_execution_valuation_corrections prev ON prev.correction_id=c.previous_correction_id
 LEFT JOIN public.source_trades s ON s.id=lineage.source_trade_id
 LEFT JOIN public.source_verification_bindings b ON b.source_trade_id=s.id
 LEFT JOIN public.source_verification_heads h ON h.source_trade_id=s.id
 LEFT JOIN public.source_verified_evidence proof ON proof.evidence_id=v.source_evidence_id
 LEFT JOIN public.source_provider_authorities p ON p.authority_id=proof.authority_id
 LEFT JOIN public.source_position_applications sp ON sp.source_trade_id=s.id
 ) SELECT EXISTS(SELECT 1 FROM checked) AND NOT EXISTS(SELECT 1 FROM checked WHERE valid IS DISTINCT FROM true);
$$;
CREATE FUNCTION public.guard_worker_correction() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE v public.trusted_worker_valuations%ROWTYPE; a public.worker_valuation_authorities%ROWTYPE;
 f public.copy_execution_evidence%ROWTYPE; e public.copy_executions%ROWTYPE;
 prev public.copy_execution_valuation_corrections%ROWTYPE; expected_quote numeric; expected_fee numeric; lineage record;
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'valuation corrections append-only'; END IF;
 NEW.accepted_at:=statement_timestamp();
 SELECT * INTO e FROM public.copy_executions WHERE id=NEW.execution_id FOR UPDATE;
 SELECT * INTO f FROM public.copy_execution_evidence WHERE id=NEW.original_evidence_id AND execution_id=e.id FOR SHARE;
 SELECT * INTO v FROM public.trusted_worker_valuations WHERE valuation_id=NEW.valuation_id FOR SHARE;
 SELECT * INTO a FROM public.worker_valuation_authorities WHERE authority_id=v.authority_id FOR SHARE;
 SELECT * INTO lineage FROM public.worker_correction_lineage(e.id,f.id);
 IF lineage.source_trade_id IS NULL OR NEW.lineage_source_trade_id IS DISTINCT FROM lineage.source_trade_id
 OR v.lineage_source_trade_id IS DISTINCT FROM lineage.source_trade_id
 OR NEW.lineage_acquisition_evidence_id IS DISTINCT FROM lineage.acquisition_evidence_id
 OR v.lineage_acquisition_evidence_id IS DISTINCT FROM lineage.acquisition_evidence_id
 OR NEW.lineage_master_wallet_address IS DISTINCT FROM lineage.master_wallet_address
 OR v.lineage_master_wallet_address IS DISTINCT FROM lineage.master_wallet_address
 THEN RAISE EXCEPTION 'correction exact source/acquisition lineage mismatch'; END IF;
 IF e.id IS NULL OR f.id IS NULL OR v.valuation_id IS NULL OR a.authority_id IS NULL
 OR NEW.user_id IS DISTINCT FROM e.user_id OR v.user_id IS DISTINCT FROM e.user_id
 OR a.user_id IS DISTINCT FROM e.user_id OR v.original_evidence_id<>f.id OR v.execution_id<>e.id
 OR NEW.original_digest<>v.original_digest OR NEW.revision<>v.revision
 OR NOT a.enabled OR a.valid_until<=NEW.accepted_at OR v.valid_until<=NEW.accepted_at OR v.valid_until>a.valid_until
 OR a.chain<>e.chain OR a.provider_id<>v.provider_id OR a.identity_digest<>v.provider_identity_digest
 OR a.verifier_version<>v.verifier_version OR (v.quote_usd IS NOT NULL AND v.quote_usd>a.max_quote_usd)
 OR (v.fee_usd IS NOT NULL AND v.fee_usd>a.max_fee_usd)
 OR f.confirmation_state NOT IN('confirmed','finalized')
 THEN RAISE EXCEPTION 'persisted correction authorization mismatch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.copy_position_applications app
 WHERE app.evidence_id=f.id AND app.execution_id=e.id AND app.active
 AND app.user_id IS NOT DISTINCT FROM e.user_id AND app.target_account=e.target_account
 AND app.chain=e.chain AND app.token_mint=e.token_mint)
 OR NOT EXISTS(SELECT 1 FROM public.source_trades s
 JOIN public.source_verification_bindings b ON b.source_trade_id=s.id
 JOIN public.source_verification_heads h ON h.source_trade_id=s.id
 JOIN public.source_verified_evidence proof ON proof.evidence_id=h.evidence_id
 JOIN public.source_provider_authorities p ON p.authority_id=proof.authority_id
 JOIN public.source_position_applications sp ON sp.source_trade_id=s.id
 WHERE s.id=lineage.source_trade_id AND s.confirmation_state IN('confirmed','finalized')
 AND h.confirmation_state=s.confirmation_state AND proof.source_trade_id=s.id
 AND proof.binding_digest=b.binding_digest AND proof.finality=s.confirmation_state AND sp.active
 AND sp.wallet_address=s.wallet_address AND sp.chain=s.chain AND sp.token_mint=s.token_mint
 AND p.enabled AND p.valid_until>NEW.accepted_at AND proof.provider_valid_until>NEW.accepted_at
 AND p.provider_id=proof.provider_id AND p.identity_digest=proof.provider_identity_digest
 AND p.chain=s.chain AND p.network=b.network AND p.verifier_version=proof.verifier_version
 AND v.source_evidence_id=h.evidence_id AND a.network=b.network)
 THEN RAISE EXCEPTION 'correction source verified authorization unavailable'; END IF;
 SELECT * INTO prev FROM public.copy_execution_valuation_corrections
 WHERE original_evidence_id=f.id ORDER BY revision DESC LIMIT 1;
 IF NEW.previous_correction_id IS DISTINCT FROM prev.correction_id
 OR (prev.correction_id IS NOT NULL AND NEW.revision<=prev.revision)
 THEN RAISE EXCEPTION 'correction predecessor conflict'; END IF;
 IF prev.correction_id IS NOT NULL AND NOT public.worker_correction_authorized(prev.correction_id)
 THEN RAISE EXCEPTION 'carried quote/fee predecessor acceptance invalidated'; END IF;
 IF NEW.quote_origin_valuation_id IS DISTINCT FROM (CASE WHEN v.quote_usd IS NOT NULL THEN v.valuation_id ELSE prev.quote_origin_valuation_id END)
 OR NEW.fee_origin_valuation_id IS DISTINCT FROM (CASE WHEN v.fee_usd IS NOT NULL THEN v.valuation_id ELSE prev.fee_origin_valuation_id END)
 THEN RAISE EXCEPTION 'carried quote/fee field provenance mismatch'; END IF;
 expected_quote:=COALESCE(v.quote_usd,CASE WHEN prev.correction_id IS NOT NULL THEN prev.effective_quote_usd ELSE f.quote_quantity END);
 expected_fee:=COALESCE(v.fee_usd,CASE WHEN prev.correction_id IS NOT NULL THEN prev.effective_fee_usd ELSE f.fee_usd END);
 IF NEW.effective_quote_usd IS DISTINCT FROM expected_quote OR NEW.effective_fee_usd IS DISTINCT FROM expected_fee
 OR NEW.original_snapshot->>'executionId' IS DISTINCT FROM e.id::text
 OR NEW.original_snapshot->>'id' IS DISTINCT FROM f.id::text
 OR NEW.original_snapshot->>'userId' IS DISTINCT FROM e.user_id::text
 OR NEW.original_snapshot->>'sourceTradeId' IS DISTINCT FROM e.source_trade_id::text
 OR NEW.original_snapshot->>'evidenceType' IS DISTINCT FROM f.evidence_type
 OR NEW.original_snapshot->>'evidenceId' IS DISTINCT FROM f.evidence_id
 OR NEW.original_snapshot->>'quoteCurrency' IS DISTINCT FROM f.quote_currency
 OR (NEW.original_snapshot->>'baseQuantity')::numeric IS DISTINCT FROM f.base_quantity
 OR (NEW.original_snapshot->>'quoteQuantity')::numeric IS DISTINCT FROM f.quote_quantity
 OR (NEW.original_snapshot->>'quoteNativeQuantity')::numeric IS DISTINCT FROM f.quote_native_quantity
 OR (NEW.original_snapshot->>'quoteNativeUsdPrice')::numeric IS DISTINCT FROM f.quote_native_usd_price
 OR (NEW.original_snapshot->>'priceUsd')::numeric IS DISTINCT FROM f.price_usd
 OR (NEW.original_snapshot->>'feeUsd')::numeric IS DISTINCT FROM f.fee_usd
 OR (NEW.original_snapshot->>'occurredAt')::timestamptz IS DISTINCT FROM f.occurred_at
 OR (NEW.original_snapshot->>'completesExecution')::boolean IS DISTINCT FROM f.completes_execution
 THEN RAISE EXCEPTION 'correction original snapshot/effective value mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER worker_correction_guard BEFORE INSERT OR UPDATE OR DELETE ON public.copy_execution_valuation_corrections
 FOR EACH ROW EXECUTE FUNCTION public.guard_worker_correction();

-- Only an explicit newly referenced, currently authorized persisted correction
-- relaxes the old monetary monotonic/terminal rule. All original identity,
-- retained nonterminal liability, no-resubmit and released immutability remain.
CREATE OR REPLACE FUNCTION public.guard_risk_reservation() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE authorized boolean := false; totals record;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'risk liability cannot be deleted'; END IF;
 IF TG_OP='UPDATE' THEN
   authorized:=NEW.valuation_correction_id IS NOT NULL
     AND NEW.valuation_correction_id IS DISTINCT FROM OLD.valuation_correction_id
     AND OLD.state<>'released' AND NEW.state IN('unknown','partial','confirmed')
     AND public.worker_correction_authorized(NEW.valuation_correction_id)
     AND EXISTS(SELECT 1 FROM public.copy_execution_valuation_corrections c
       WHERE c.correction_id=NEW.valuation_correction_id AND c.execution_id=NEW.execution_id);
   IF NEW.account IS DISTINCT FROM OLD.account OR NEW.chain IS DISTINCT FROM OLD.chain
     OR NEW.execution_mode IS DISTINCT FROM OLD.execution_mode OR NEW.execution_id IS DISTINCT FROM OLD.execution_id
     OR NEW.policy_epoch IS DISTINCT FROM OLD.policy_epoch OR NEW.requested_usd IS DISTINCT FROM OLD.requested_usd
     OR NEW.reserved_at IS DISTINCT FROM OLD.reserved_at
     OR (NEW.confirmed_usd<OLD.confirmed_usd AND NOT authorized)
     OR (OLD.state IN('confirmed','released') AND NEW IS DISTINCT FROM OLD AND NOT authorized)
     OR (OLD.state<>'reserved' AND NEW.state IN('reserved','released'))
     OR (NEW.state NOT IN('confirmed','released') AND NEW.liability_usd<OLD.liability_usd)
     OR (NEW.valuation_correction_id IS DISTINCT FROM OLD.valuation_correction_id AND NOT authorized)
   THEN RAISE EXCEPTION 'risk immutable terms/terminal state/retained liability violated'; END IF;
 ELSIF NEW.valuation_correction_id IS NOT NULL THEN
   RAISE EXCEPTION 'new reservation cannot invent correction accounting';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.copy_executions e WHERE e.id=NEW.execution_id
   AND COALESCE(e.user_id::text,'operator')=NEW.account AND e.chain=NEW.chain
   AND e.execution_mode=NEW.execution_mode AND e.direction='buy')
 THEN RAISE EXCEPTION 'risk reservation canonical execution scope mismatch'; END IF;
 IF authorized THEN
   SELECT SUM(COALESCE(effective_quote_usd,0)+COALESCE(effective_fee_usd,0)) AS debit,
     COUNT(*) FILTER(WHERE effective_quote_usd IS NULL OR effective_fee_usd IS NULL) AS unknown,
     COALESCE(BOOL_OR(completes_execution),false) AS completes INTO totals
   FROM public.worker_effective_execution_evidence WHERE execution_id=NEW.execution_id
     AND confirmation_state IN('confirmed','finalized');
   IF NEW.confirmed_usd IS DISTINCT FROM totals.debit
     OR (NEW.state='confirmed' AND (totals.unknown<>0 OR NOT totals.completes OR NOT EXISTS(
       SELECT 1 FROM public.copy_executions e WHERE e.id=NEW.execution_id AND e.state='confirmed')))
   THEN RAISE EXCEPTION 'authorized risk correction must match complete cumulative economics'; END IF;
 END IF;
 RETURN NEW;
END $$;

-- Correction-only economic completion. Cannot add base evidence/application or
-- release inventory; all quantity must already be applied under lifecycle.
CREATE FUNCTION public.finalize_worker_correction(correction text) RETURNS boolean
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE e public.copy_executions%ROWTYPE; totals record;
BEGIN
 IF NOT public.worker_correction_authorized(correction) THEN RAISE EXCEPTION 'correction completion authorization unavailable'; END IF;
 SELECT execution.* INTO e FROM public.copy_executions execution
 JOIN public.copy_execution_valuation_corrections c ON c.execution_id=execution.id
 WHERE c.correction_id=correction FOR UPDATE OF execution;
 IF e.id IS NULL OR e.state NOT IN('reconciliation_required','partially_filled','confirmed')
 THEN RAISE EXCEPTION 'correction cannot complete unsupported lifecycle state'; END IF;
 SELECT COALESCE(SUM(base_quantity),0) AS base,
 COUNT(*) FILTER(WHERE effective_quote_usd IS NULL OR effective_fee_usd IS NULL) AS unknown,
 COALESCE(BOOL_OR(completes_execution),false) AS completes INTO totals
 FROM public.worker_effective_execution_evidence WHERE execution_id=e.id AND confirmation_state IN('confirmed','finalized');
 IF totals.base<=0 OR e.confirmed_base_quantity<>totals.base OR totals.unknown<>0 OR NOT totals.completes
 OR EXISTS(SELECT 1 FROM public.copy_execution_evidence f WHERE f.execution_id=e.id
   AND f.confirmation_state IN('confirmed','finalized') AND NOT EXISTS(
     SELECT 1 FROM public.copy_position_applications app WHERE app.evidence_id=f.id AND app.execution_id=e.id
     AND app.active AND app.user_id IS NOT DISTINCT FROM e.user_id AND app.target_account=e.target_account
     AND app.chain=e.chain AND app.token_mint=e.token_mint))
 OR EXISTS(SELECT 1 FROM public.worker_effective_execution_evidence f WHERE f.execution_id=e.id
   AND f.valuation_correction_id IS NOT NULL AND NOT public.worker_correction_authorized(f.valuation_correction_id))
 THEN RAISE EXCEPTION 'correction requires complete already-applied base and economics'; END IF;
 IF e.state<>'confirmed' THEN
   UPDATE public.copy_executions SET state='confirmed',next_reconciliation_at=NULL,
     reconciliation_claim_id=NULL,reconciliation_claimed_at=NULL,updated_at=now() WHERE id=e.id;
   INSERT INTO public.copy_execution_state_history(execution_id,from_state,to_state,reason)
     VALUES(e.id,e.state,'confirmed','Immutable valuation correction:'||correction);
 END IF;
 RETURN true;
END $$;

CREATE FUNCTION public.guard_worker_financial_receipt() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE e public.copy_executions%ROWTYPE; t public.trades%ROWTYPE; total record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'financial receipt append-only'; END IF;
 SELECT * INTO e FROM public.copy_executions WHERE id=NEW.execution_id FOR SHARE;
 SELECT * INTO t FROM public.trades WHERE id=NEW.trade_id AND copy_execution_id=e.id FOR SHARE;
 IF e.id IS NULL OR t.id IS NULL OR NEW.user_id IS DISTINCT FROM e.user_id
 OR t.user_id IS DISTINCT FROM e.user_id OR t.signal_id IS DISTINCT FROM e.signal_id
 OR t.source_trade_id IS DISTINCT FROM e.source_trade_id OR t.exit_lot_id IS DISTINCT FROM e.exit_lot_id
 OR t.chain<>e.chain OR t.token_mint<>e.token_mint OR t.direction<>e.direction OR t.execution_mode<>e.execution_mode
 OR NOT EXISTS(SELECT 1 FROM public.copy_execution_worker_attempts w
   WHERE w.execution_id=e.id AND w.user_id IS NOT DISTINCT FROM e.user_id AND w.fence=NEW.worker_fence)
 THEN RAISE EXCEPTION 'financial receipt identity mismatch'; END IF;
 SELECT COALESCE(SUM(base_quantity),0) AS base,SUM(effective_quote_usd) AS quote,SUM(effective_fee_usd) AS fee,
 SUM(COALESCE(effective_quote_usd,0)+COALESCE(effective_fee_usd,0)) AS debit,
 COUNT(*) FILTER(WHERE effective_quote_usd IS NULL OR effective_fee_usd IS NULL) AS unknown,
 COUNT(*) FILTER(WHERE effective_quote_usd IS NULL) AS quote_unknown,
 COALESCE(BOOL_OR(completes_execution),false) AS completes,COUNT(*) AS evidence_count INTO total
 FROM public.worker_effective_execution_evidence WHERE execution_id=e.id AND confirmation_state IN('confirmed','finalized');
 IF NEW.snapshot->>'executionId' IS DISTINCT FROM e.id::text
 OR NEW.snapshot->>'userId' IS DISTINCT FROM e.user_id::text OR NEW.snapshot->>'tradeId' IS DISTINCT FROM t.id::text
 OR (NEW.snapshot->>'fence')::bigint IS DISTINCT FROM NEW.worker_fence
 OR (NEW.snapshot->>'accountingComplete')::boolean IS DISTINCT FROM NEW.accounting_complete
 OR (NEW.snapshot->'totals'->>'base')::numeric IS DISTINCT FROM total.base
 OR (NEW.snapshot->'totals'->>'quote')::numeric IS DISTINCT FROM total.quote
 OR (NEW.snapshot->'totals'->>'fee')::numeric IS DISTINCT FROM total.fee
 OR (NEW.snapshot->'totals'->>'debit')::numeric IS DISTINCT FROM total.debit
 OR (NEW.snapshot->'totals'->>'unknown')::bigint IS DISTINCT FROM total.unknown
 OR (NEW.snapshot->'totals'->>'quoteUnknown')::bigint IS DISTINCT FROM total.quote_unknown
 OR (NEW.snapshot->'totals'->>'completes')::boolean IS DISTINCT FROM total.completes
 OR (NEW.snapshot->'totals'->>'evidenceCount')::bigint IS DISTINCT FROM total.evidence_count
 OR t.token_amount IS DISTINCT FROM total.base
 OR t.amount_usd IS DISTINCT FROM (CASE WHEN total.quote_unknown=0 THEN total.quote ELSE NULL END)
 OR t.fee_usd IS DISTINCT FROM (CASE WHEN total.unknown=0 THEN total.fee ELSE NULL END)
 OR (NEW.accounting_complete AND (total.evidence_count=0 OR total.unknown<>0 OR NOT total.completes
 OR e.state<>'confirmed' OR t.status<>'filled'
 OR EXISTS(SELECT 1 FROM public.copy_execution_evidence f WHERE f.execution_id=e.id
   AND f.confirmation_state IN('confirmed','finalized') AND NOT EXISTS(
     SELECT 1 FROM public.copy_position_applications app WHERE app.evidence_id=f.id AND app.execution_id=e.id
       AND app.active AND app.user_id IS NOT DISTINCT FROM e.user_id AND app.target_account=e.target_account
       AND app.chain=e.chain AND app.token_mint=e.token_mint))
 OR (e.direction='buy' AND NOT EXISTS(SELECT 1 FROM public.risk_spend_reservations r
   WHERE r.execution_id=e.id AND r.state='confirmed' AND r.confirmed_usd=total.debit AND r.liability_usd=total.debit
     AND r.account=COALESCE(e.user_id::text,'operator') AND r.chain=e.chain AND r.execution_mode=e.execution_mode))
 OR EXISTS(SELECT 1 FROM public.worker_effective_execution_evidence corrected
   WHERE corrected.execution_id=e.id AND corrected.valuation_correction_id IS NOT NULL
     AND corrected.confirmation_state IN('confirmed','finalized')
     AND NOT public.worker_correction_authorized(corrected.valuation_correction_id))))
 THEN RAISE EXCEPTION 'financial receipt incomplete or totals mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER worker_financial_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON public.copy_execution_financial_receipts
 FOR EACH ROW EXECUTE FUNCTION public.guard_worker_financial_receipt();

ALTER TABLE public.worker_valuation_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_valuation_authorities FORCE ROW LEVEL SECURITY;
ALTER TABLE public.trusted_worker_valuations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trusted_worker_valuations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.copy_execution_valuation_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.copy_execution_valuation_corrections FORCE ROW LEVEL SECURITY;
ALTER TABLE public.copy_execution_financial_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.copy_execution_financial_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY valuation_authority_tenant ON public.worker_valuation_authorities TO swat_app
 USING(user_id=public.current_app_user_id()) WITH CHECK(user_id=public.current_app_user_id());
CREATE POLICY trusted_valuation_tenant ON public.trusted_worker_valuations TO swat_app
 USING(user_id=public.current_app_user_id()) WITH CHECK(user_id=public.current_app_user_id());
CREATE POLICY valuation_correction_tenant ON public.copy_execution_valuation_corrections TO swat_app
 USING(user_id=public.current_app_user_id()) WITH CHECK(user_id=public.current_app_user_id());
CREATE POLICY financial_receipt_tenant ON public.copy_execution_financial_receipts TO swat_app
 USING(user_id=public.current_app_user_id()) WITH CHECK(user_id=public.current_app_user_id());
CREATE POLICY valuation_authority_provision ON public.worker_valuation_authorities TO swat_migrator
 USING(current_user='swat_migrator' AND session_user='swat_migrator')
 WITH CHECK(current_user='swat_migrator' AND session_user='swat_migrator');
CREATE POLICY trusted_valuation_provision ON public.trusted_worker_valuations TO swat_migrator
 USING(current_user='swat_migrator' AND session_user='swat_migrator')
 WITH CHECK(current_user='swat_migrator' AND session_user='swat_migrator');
CREATE POLICY valuation_correction_provision ON public.copy_execution_valuation_corrections TO swat_migrator
 USING(current_user='swat_migrator' AND session_user='swat_migrator')
 WITH CHECK(current_user='swat_migrator' AND session_user='swat_migrator');
CREATE POLICY financial_receipt_provision ON public.copy_execution_financial_receipts TO swat_migrator
 USING(current_user='swat_migrator' AND session_user='swat_migrator')
 WITH CHECK(current_user='swat_migrator' AND session_user='swat_migrator');
-- C079 precise protected execution capability is still UNGRANTED to runtime.
-- These policies do not confer capability by queue identity or GUC alone.
CREATE POLICY trusted_valuation_operator ON public.trusted_worker_valuations TO swat_app
 USING(user_id IS NULL AND public.has_worker_execution_capability(execution_id));
CREATE POLICY valuation_authority_operator ON public.worker_valuation_authorities TO swat_app
 USING(user_id IS NULL AND EXISTS(SELECT 1 FROM public.trusted_worker_valuations v
   WHERE v.authority_id=worker_valuation_authorities.authority_id AND v.user_id IS NULL
     AND public.has_worker_execution_capability(v.execution_id)));
CREATE POLICY valuation_correction_operator ON public.copy_execution_valuation_corrections TO swat_app
 USING(user_id IS NULL AND public.has_worker_execution_capability(execution_id))
 WITH CHECK(user_id IS NULL AND public.has_worker_execution_capability(execution_id));
CREATE POLICY financial_receipt_operator ON public.copy_execution_financial_receipts TO swat_app
 USING(user_id IS NULL AND public.has_worker_execution_capability(execution_id))
 WITH CHECK(user_id IS NULL AND public.has_worker_execution_capability(execution_id));
REVOKE ALL ON public.worker_valuation_authorities,public.trusted_worker_valuations,
 public.copy_execution_valuation_corrections,public.copy_execution_financial_receipts,
 public.worker_effective_execution_evidence FROM PUBLIC,swat_app;
GRANT SELECT ON public.worker_valuation_authorities,public.trusted_worker_valuations,
 public.copy_execution_valuation_corrections,public.copy_execution_financial_receipts,
 public.worker_effective_execution_evidence TO swat_app;
-- Lock-only UPDATE privileges required by FOR SHARE. Triggers reject all app changes.
GRANT UPDATE(enabled) ON public.worker_valuation_authorities TO swat_app;
GRANT UPDATE(revision) ON public.trusted_worker_valuations TO swat_app;
GRANT UPDATE(original_digest) ON public.copy_execution_valuation_corrections TO swat_app;
GRANT UPDATE(snapshot) ON public.copy_execution_financial_receipts TO swat_app;
GRANT INSERT ON public.copy_execution_valuation_corrections,public.copy_execution_financial_receipts TO swat_app;
GRANT UPDATE(valuation_correction_id) ON public.risk_spend_reservations TO swat_app;
REVOKE ALL ON FUNCTION public.guard_worker_valuation_authority(),public.guard_trusted_worker_valuation(),
 public.guard_worker_correction(),public.guard_worker_financial_receipt(),public.worker_correction_authorized(text),
 public.guard_risk_reservation(),public.finalize_worker_correction(text),public.worker_correction_lineage(uuid,uuid) FROM PUBLIC,swat_app;
GRANT EXECUTE ON FUNCTION public.worker_correction_authorized(text),public.finalize_worker_correction(text),public.worker_correction_lineage(uuid,uuid) TO swat_app;
-- No authority/trusted valuation INSERT or enabling writer grant to runtime.
-- No original fill/fee mutation, no application/reduction quantity duplication.
-- DB/RLS/concurrency/provider/restart capability acceptance remains externally blocked.
