-- 075: durable Jito ownership, exact pre-POST outbox and quantified receipt.
-- Forward only / UNAPPLIED. No signer/provider/readiness seed or runtime bypass.
DO $$ BEGIN
  IF current_user <> 'swat_migrator' OR session_user <> 'swat_migrator' THEN
    RAISE EXCEPTION 'Jito migration requires separate migrator';
  END IF;
END $$;
CREATE TABLE public.jito_execution_pending (
  execution_id uuid PRIMARY KEY REFERENCES public.copy_executions(id) ON DELETE RESTRICT,
  user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  client_order_id varchar(256) NOT NULL UNIQUE,
  execution_identity jsonb NOT NULL CHECK (jsonb_typeof(execution_identity) = 'object'),
  intent jsonb NOT NULL CHECK (jsonb_typeof(intent) = 'object'),
  attempt jsonb NOT NULL CHECK (jsonb_typeof(attempt) = 'object'),
  state varchar(16) NOT NULL DEFAULT 'claimed' CHECK (state IN ('claimed','prepared','submitted','settled')),
  signed_transactions jsonb,
  signatures jsonb,
  bundle_id varchar(256),
  last_valid_block_height bigint CHECK (last_valid_block_height > 0),
  expires_at timestamptz,
  tip_lamports bigint CHECK (tip_lamports > 0),
  resolution jsonb,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  prepared_at timestamptz,
  last_checked_at timestamptz,
  settled_at timestamptz,
  CHECK (state = 'claimed' OR (signed_transactions IS NOT NULL AND signatures IS NOT NULL
    AND jsonb_typeof(signed_transactions) = 'array'
    AND jsonb_array_length(signed_transactions) = 2 AND jsonb_typeof(signatures) = 'array'
    AND jsonb_array_length(signatures) = 2 AND last_valid_block_height IS NOT NULL
    AND expires_at IS NOT NULL AND tip_lamports IS NOT NULL AND prepared_at IS NOT NULL)),
  CHECK (state NOT IN ('submitted') OR bundle_id IS NOT NULL),
  CHECK (state <> 'settled' OR (resolution IS NOT NULL AND settled_at IS NOT NULL))
);
CREATE INDEX jito_pending_check_rotation ON public.jito_execution_pending
  (last_checked_at NULLS FIRST, prepared_at, execution_id) WHERE state IN ('prepared','submitted');
CREATE TABLE public.jito_execution_receipts (
  execution_id uuid PRIMARY KEY REFERENCES public.jito_execution_pending(execution_id) ON DELETE RESTRICT,
  user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  signature varchar(256) NOT NULL UNIQUE,
  slot bigint NOT NULL CHECK (slot >= 0),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  settled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CHECK (NOT settled OR settled_at IS NOT NULL)
);
CREATE FUNCTION public.guard_jito_pending() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Jito durable ownership cannot be deleted'; END IF;
  IF TG_OP = 'INSERT' AND (NEW.state <> 'claimed' OR NOT EXISTS (
    SELECT 1 FROM public.copy_executions e JOIN public.copy_execution_worker_attempts a ON a.execution_id = e.id
    WHERE e.id = NEW.execution_id AND e.user_id IS NOT DISTINCT FROM NEW.user_id
      AND e.chain = 'solana' AND e.execution_mode = 'live' AND e.client_order_id = NEW.client_order_id
      AND e.target_account = NEW.execution_identity->>'targetAccount'
      AND NEW.execution_identity->>'executionId' = e.id::text
      AND NEW.execution_identity->>'clientOrderId' = e.client_order_id
      AND NEW.execution_identity->>'chain' = 'solana'
      AND NEW.execution_identity->>'userId' IS NOT DISTINCT FROM e.user_id::text
      AND NEW.attempt->>'executionId' = e.id::text AND NEW.attempt->>'userId' IS NOT DISTINCT FROM e.user_id::text
      AND NEW.attempt->>'fence' = a.fence::text AND NEW.attempt->>'policyRevision' = a.policy_revision
      AND NEW.attempt->>'riskEpoch' IS NOT DISTINCT FROM a.risk_epoch::text AND a.state = 'dispatched'
  )) THEN RAISE EXCEPTION 'Jito claim canonical identity/fence mismatch'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.execution_id IS DISTINCT FROM OLD.execution_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.client_order_id IS DISTINCT FROM OLD.client_order_id OR NEW.execution_identity IS DISTINCT FROM OLD.execution_identity
      OR NEW.intent IS DISTINCT FROM OLD.intent OR NEW.attempt IS DISTINCT FROM OLD.attempt
      OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
      OR (NEW.last_checked_at IS DISTINCT FROM OLD.last_checked_at AND
        (NEW.last_checked_at IS NULL OR OLD.state NOT IN ('prepared','submitted') OR NEW.state <> OLD.state
          OR (OLD.last_checked_at IS NOT NULL AND NEW.last_checked_at < OLD.last_checked_at)))
      OR (OLD.state <> 'claimed' AND (NEW.signed_transactions IS DISTINCT FROM OLD.signed_transactions
        OR NEW.signatures IS DISTINCT FROM OLD.signatures OR NEW.last_valid_block_height IS DISTINCT FROM OLD.last_valid_block_height
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.tip_lamports IS DISTINCT FROM OLD.tip_lamports
        OR NEW.prepared_at IS DISTINCT FROM OLD.prepared_at))
      OR (OLD.bundle_id IS NOT NULL AND NEW.bundle_id IS DISTINCT FROM OLD.bundle_id)
      OR (OLD.state = 'claimed' AND NEW.state <> 'prepared')
      OR (OLD.state IN ('prepared','submitted') AND NEW.state NOT IN (OLD.state,'submitted','settled'))
      OR (OLD.state = 'settled' AND NEW IS DISTINCT FROM OLD) THEN
      RAISE EXCEPTION 'Jito exact prewrite/ownership is immutable';
    END IF;
    IF NEW.state = 'settled' AND NOT EXISTS (SELECT 1 FROM public.jito_execution_receipts r
      WHERE r.execution_id = NEW.execution_id AND r.settled AND r.receipt = NEW.resolution->'receipt') THEN
      RAISE EXCEPTION 'Jito acknowledgement requires committed financial receipt';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.guard_jito_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Jito receipt cannot be deleted'; END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM public.jito_execution_pending p
    WHERE p.execution_id = NEW.execution_id AND p.user_id IS NOT DISTINCT FROM NEW.user_id
      AND p.state IN ('prepared','submitted') AND p.signatures->>0 = NEW.signature
      AND NEW.receipt->'execution' = p.execution_identity AND NEW.receipt->>'signature' = NEW.signature
      AND NEW.receipt->>'slot' = NEW.slot::text) THEN RAISE EXCEPTION 'Jito receipt durable identity mismatch'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.execution_id IS DISTINCT FROM OLD.execution_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.signature IS DISTINCT FROM OLD.signature OR NEW.slot IS DISTINCT FROM OLD.slot OR NEW.receipt IS DISTINCT FROM OLD.receipt
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR (OLD.settled AND NEW IS DISTINCT FROM OLD)) THEN
    RAISE EXCEPTION 'Jito receipt immutable';
  END IF;
  IF NEW.settled AND NOT EXISTS (
    SELECT 1 FROM public.copy_executions e
    JOIN public.copy_execution_evidence ev ON ev.execution_id = e.id
    JOIN public.trades t ON t.copy_execution_id = e.id AND t.user_id IS NOT DISTINCT FROM e.user_id
    WHERE e.id = NEW.execution_id AND e.user_id IS NOT DISTINCT FROM NEW.user_id AND e.state = 'confirmed'
      AND ev.evidence_type = 'chain_receipt' AND ev.evidence_id = NEW.signature
      AND ev.confirmation_state IN ('confirmed','finalized')
      AND ev.base_quantity = (NEW.receipt->>'baseQuantity')::numeric
      AND ev.quote_quantity = (NEW.receipt->>'quoteUsd')::numeric
      AND ev.fee_usd = (NEW.receipt->>'feeUsd')::numeric
      AND t.status = 'filled' AND t.fee_usd IS NOT NULL AND t.amount_usd IS NOT NULL
  ) THEN RAISE EXCEPTION 'Jito receipt marker requires canonical financial settlement'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jito_pending_guard BEFORE INSERT OR UPDATE OR DELETE ON public.jito_execution_pending
  FOR EACH ROW EXECUTE FUNCTION public.guard_jito_pending();
CREATE TRIGGER jito_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON public.jito_execution_receipts
  FOR EACH ROW EXECUTE FUNCTION public.guard_jito_receipt();
ALTER TABLE public.jito_execution_pending ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jito_execution_pending FORCE ROW LEVEL SECURITY;
ALTER TABLE public.jito_execution_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jito_execution_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY jito_pending_tenant ON public.jito_execution_pending TO swat_app
  USING (user_id = public.current_app_user_id()) WITH CHECK (user_id = public.current_app_user_id());
CREATE POLICY jito_receipt_tenant ON public.jito_execution_receipts TO swat_app
  USING (user_id = public.current_app_user_id()) WITH CHECK (user_id = public.current_app_user_id());
CREATE POLICY jito_pending_migration ON public.jito_execution_pending TO swat_migrator
  USING (public.is_rls_bypassed()) WITH CHECK (public.is_rls_bypassed());
CREATE POLICY jito_receipt_migration ON public.jito_execution_receipts TO swat_migrator
  USING (public.is_rls_bypassed()) WITH CHECK (public.is_rls_bypassed());
REVOKE ALL ON public.jito_execution_pending,public.jito_execution_receipts FROM PUBLIC,swat_app;
GRANT SELECT,INSERT ON public.jito_execution_pending,public.jito_execution_receipts TO swat_app;
GRANT UPDATE (state,signed_transactions,signatures,bundle_id,last_valid_block_height,expires_at,tip_lamports,prepared_at,last_checked_at,resolution,settled_at)
  ON public.jito_execution_pending TO swat_app;
GRANT UPDATE (settled,settled_at) ON public.jito_execution_receipts TO swat_app;
REVOKE ALL ON FUNCTION public.guard_jito_pending(),public.guard_jito_receipt() FROM PUBLIC,swat_app;
-- Cross-tenant/operator runtime scope and core reconciliation grants remain
-- separately unavailable. Never run runtime with a migrator identity.
