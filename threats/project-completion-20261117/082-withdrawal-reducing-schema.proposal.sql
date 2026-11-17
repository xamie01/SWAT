-- SOURCE-ONLY082 PROPOSAL. Coordinator integrates after review; never applied here.
-- Two separately provisioned NOLOGIN restricted identities. No role creation, credential or seed.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='swat_financial_settler'
  AND NOT(rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit OR rolcreaterole OR rolcreatedb OR rolreplication))
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='swat_financial_receipt_writer'
  AND NOT(rolsuper OR rolbypassrls OR rolinherit OR rolcreaterole OR rolcreatedb OR rolreplication))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r
  ON r.oid=m.member OR r.oid=m.roleid WHERE r.rolname IN('swat_financial_settler','swat_financial_receipt_writer'))
 THEN RAISE EXCEPTION 'restricted financial settler/independent receipt writer not provisioned'; END IF;
END $$;

CREATE TABLE public.withdrawal_reducing_intents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind IN('withdrawal','reducing')), request_key text NOT NULL CHECK(length(request_key) BETWEEN 1 AND 256),
 intent jsonb NOT NULL, intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'), expires_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'awaiting-authorization' CHECK(status IN('awaiting-authorization','queued','prepared','uncertain','partial','settled','failed','cancelled')),
 completed_raw numeric(78,0) NOT NULL DEFAULT 0 CHECK(completed_raw>=0), terminal boolean NOT NULL DEFAULT false,
 cancelled_at timestamptz, cancellation_reason text,
 CHECK((cancelled_at IS NULL AND cancellation_reason IS NULL AND status<>'cancelled') OR
   (cancelled_at IS NOT NULL AND cancellation_reason='expired-before-attempt' AND status='cancelled' AND terminal)),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(), UNIQUE(user_id,kind,request_key), UNIQUE(id,user_id),
 CHECK(intent->>'userId'=user_id::text AND intent->>'kind'=kind AND intent->>'requestKey'=request_key
   AND intent->>'version'='1' AND (intent->>'expiresAt')::timestamptz=expires_at),
 CHECK(intent->>'chain' IN('solana','polygon','robinhood-chain') AND intent->>'mode' IN('paper','live')),
 CHECK((intent->>'assetScale')::integer BETWEEN 0 AND 36 AND length(intent->>'network') BETWEEN 1 AND 256),
 CHECK(intent ? 'assetId' AND intent ? 'maxFeeRaw' AND intent->>'maxFeeRaw' ~ '^(0|[1-9][0-9]{0,77})$'),
 CHECK(length(intent->>'feeAssetId') BETWEEN 1 AND 256 AND (intent->>'feeAssetScale')::integer BETWEEN 0 AND 36
   AND length(intent->>'feeFundingAccountId') BETWEEN 1 AND 256),
 CHECK((kind='withdrawal' AND intent->>'amountRaw' ~ '^[1-9][0-9]{0,77}$' AND intent ? 'destination' AND intent ? 'sourceWalletId')
   OR (kind='reducing' AND intent->>'quantityRaw' ~ '^[1-9][0-9]{0,77}$'
     AND intent->>'venue' IN('spot','polymarket-perps') AND intent ? 'positionId' AND intent ? 'accountId'
     AND ((intent->>'positionSide'='LONG' AND intent->>'side'='SELL') OR
          (intent->>'venue'='polymarket-perps' AND intent->>'positionSide'='SHORT' AND intent->>'side'='BUY'))))
);
CREATE TABLE public.withdrawal_authorizations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, intent_id uuid NOT NULL UNIQUE,
 intent_hash text NOT NULL, digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'), expires_at timestamptz NOT NULL,
 failures integer NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 5),
 delivery_state text NOT NULL DEFAULT 'pending' CHECK(delivery_state IN('pending','sent','failed')),
 consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 FOREIGN KEY(intent_id,user_id) REFERENCES public.withdrawal_reducing_intents(id,user_id) ON DELETE RESTRICT
);
CREATE TABLE public.withdrawal_reducing_reservations (
 intent_id uuid NOT NULL, user_id uuid NOT NULL, budget_key text NOT NULL,
 purpose text NOT NULL CHECK(purpose IN('funding','exposure')), chain text NOT NULL, network text NOT NULL, mode text NOT NULL,
 account_id text NOT NULL, asset_id text NOT NULL, asset_scale integer NOT NULL CHECK(asset_scale BETWEEN 0 AND 36),
 amount_raw numeric(78,0) NOT NULL CHECK(amount_raw>=0), fee_raw numeric(78,0) NOT NULL CHECK(fee_raw>=0),
 reserved_raw numeric(78,0) NOT NULL CHECK(reserved_raw>=0), PRIMARY KEY(intent_id,budget_key),
 FOREIGN KEY(intent_id,user_id) REFERENCES public.withdrawal_reducing_intents(id,user_id) ON DELETE RESTRICT
);
CREATE TABLE public.withdrawal_reducing_cancellations (
 intent_id uuid PRIMARY KEY, user_id uuid NOT NULL, reason text NOT NULL CHECK(reason='expired-before-attempt'),
 cancelled_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 FOREIGN KEY(intent_id,user_id) REFERENCES public.withdrawal_reducing_intents(id,user_id) ON DELETE RESTRICT
);
CREATE TABLE public.withdrawal_reducing_outbox (
 intent_id uuid PRIMARY KEY, user_id uuid NOT NULL, intent_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 FOREIGN KEY(intent_id,user_id) REFERENCES public.withdrawal_reducing_intents(id,user_id) ON DELETE RESTRICT
);
CREATE TABLE public.withdrawal_reducing_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), intent_id uuid NOT NULL UNIQUE, user_id uuid NOT NULL,
 intent_hash text NOT NULL, client_order_id text NOT NULL UNIQUE CHECK(length(client_order_id) BETWEEN 1 AND 64),
 -- Fixed immutable attempt is the fence; no expiring lease may replay an uncertain submit.
 fence bigint NOT NULL DEFAULT 1 CHECK(fence=1), state text NOT NULL DEFAULT 'prepared'
 CHECK(state IN('prepared','uncertain','partial','settled','failed')),
 completed_raw numeric(78,0) NOT NULL DEFAULT 0 CHECK(completed_raw>=0),
 completed_fee_raw numeric(78,0) NOT NULL DEFAULT 0 CHECK(completed_fee_raw>=0), terminal boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(), UNIQUE(id,intent_id,user_id),
 FOREIGN KEY(intent_id,user_id) REFERENCES public.withdrawal_reducing_intents(id,user_id) ON DELETE RESTRICT
);
CREATE TABLE public.withdrawal_reducing_receipts (
 receipt_id text PRIMARY KEY, user_id uuid NOT NULL, intent_id uuid NOT NULL, attempt_id uuid NOT NULL,
 provider_identity text NOT NULL CHECK(length(provider_identity) BETWEEN 1 AND 256), proof text NOT NULL CHECK(length(proof) BETWEEN 1 AND 256),
 receipt jsonb NOT NULL, receipt_hash text NOT NULL CHECK(receipt_hash ~ '^[a-f0-9]{64}$'),
 cumulative_raw numeric(78,0) NOT NULL CHECK(cumulative_raw>=0), fee_raw numeric(78,0) NOT NULL CHECK(fee_raw>=0),
 fee_asset_id text NOT NULL, fee_asset_scale integer NOT NULL CHECK(fee_asset_scale BETWEEN 0 AND 36), fee_funding_account_id text NOT NULL,
 terminal boolean NOT NULL, outcome text NOT NULL CHECK(outcome IN('fill','rejected','absent-final')),
 observed_at timestamptz NOT NULL, admitted_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 FOREIGN KEY(attempt_id,intent_id,user_id) REFERENCES public.withdrawal_reducing_attempts(id,intent_id,user_id) ON DELETE RESTRICT
);
CREATE TABLE public.withdrawal_reducing_applications (
 receipt_id text PRIMARY KEY REFERENCES public.withdrawal_reducing_receipts(receipt_id) ON DELETE RESTRICT,
 user_id uuid NOT NULL, intent_id uuid NOT NULL, attempt_id uuid NOT NULL,
 delta_raw numeric(78,0) NOT NULL CHECK(delta_raw>=0), accounting_reference text NOT NULL,
 applied_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 FOREIGN KEY(attempt_id,intent_id,user_id) REFERENCES public.withdrawal_reducing_attempts(id,intent_id,user_id) ON DELETE RESTRICT
);
-- Canonical perps position application, not a caller-supplied accounting reference or position snapshot.
CREATE TABLE public.reducing_perps_position_applications (
 receipt_id text PRIMARY KEY REFERENCES public.withdrawal_reducing_receipts(receipt_id) ON DELETE RESTRICT,
 user_id uuid NOT NULL, intent_id uuid NOT NULL, position_id uuid NOT NULL REFERENCES public.polymarket_perps_positions(id) ON DELETE RESTRICT,
 position_side text NOT NULL, before_raw numeric(78,0) NOT NULL CHECK(before_raw>=0), after_raw numeric(78,0) NOT NULL CHECK(after_raw>=0),
 accounting_reference text NOT NULL UNIQUE,
 FOREIGN KEY(intent_id,user_id) REFERENCES public.withdrawal_reducing_intents(id,user_id) ON DELETE RESTRICT,
 CHECK(after_raw<=before_raw)
);
-- Independently admitted deployed perps account/position mapping; collateral is NOT public fee denomination.
CREATE TABLE public.reducing_perps_venue_mappings (
 user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 mapping_id text PRIMARY KEY, mapping_hash text NOT NULL CHECK(mapping_hash ~ '^[a-f0-9]{64}$'),
 mapping jsonb NOT NULL, position_id uuid NOT NULL REFERENCES public.polymarket_perps_positions(id) ON DELETE RESTRICT,
 account_id text NOT NULL, chain text NOT NULL, network text NOT NULL, mode text NOT NULL, asset_id text NOT NULL,
 asset_scale integer NOT NULL CHECK(asset_scale BETWEEN 0 AND 8), revision text NOT NULL, proof text NOT NULL,
 collateral_asset_id text NOT NULL, collateral_asset_scale integer NOT NULL CHECK(collateral_asset_scale BETWEEN 0 AND 36),
 collateral_account_id text NOT NULL, observed_at timestamptz NOT NULL, valid_until timestamptz NOT NULL,
 admitted_at timestamptz NOT NULL DEFAULT statement_timestamp(), CHECK(valid_until>observed_at)
);
-- Every perps nonzero fill (and fee-only change) requires exact independent canonical economics admission.
-- Journal records realized PnL/collateral/margin/position economics, not a zero-fee shortcut.
CREATE TABLE public.reducing_perps_economics_admissions (
 receipt_id text PRIMARY KEY REFERENCES public.withdrawal_reducing_receipts(receipt_id) ON DELETE RESTRICT,
 user_id uuid NOT NULL, intent_id uuid NOT NULL, position_id uuid NOT NULL REFERENCES public.polymarket_perps_positions(id) ON DELETE RESTRICT,
 delta_raw numeric(78,0) NOT NULL CHECK(delta_raw>=0), delta_fee_raw numeric(78,0) NOT NULL CHECK(delta_fee_raw>=0),
 economics_reference text NOT NULL UNIQUE, journal jsonb NOT NULL,
 admitted_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 FOREIGN KEY(intent_id,user_id) REFERENCES public.withdrawal_reducing_intents(id,user_id) ON DELETE RESTRICT
);
-- Withdrawal and spot accounting ports must supply a independently written exact canonical journal join.
-- No grants to runtime app; kept UNSEEDED until coordinator joins accepted canonical adapters.
CREATE TABLE public.withdrawal_reducing_accounting_admissions (
 receipt_id text PRIMARY KEY REFERENCES public.withdrawal_reducing_receipts(receipt_id) ON DELETE RESTRICT,
 user_id uuid NOT NULL, intent_id uuid NOT NULL, delta_raw numeric(78,0) NOT NULL CHECK(delta_raw>=0),
 delta_fee_raw numeric(78,0) NOT NULL CHECK(delta_fee_raw>=0), accounting_reference text NOT NULL UNIQUE,
 FOREIGN KEY(intent_id,user_id) REFERENCES public.withdrawal_reducing_intents(id,user_id) ON DELETE RESTRICT
);

CREATE FUNCTION public.w3_financial_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'financial append-only record'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION public.w3_guard_independent_accounting_admission() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP<>'INSERT' OR current_user<>'swat_financial_receipt_writer'
  OR NOT EXISTS(SELECT 1 FROM public.withdrawal_reducing_receipts r WHERE r.receipt_id=NEW.receipt_id
    AND r.intent_id=NEW.intent_id AND r.user_id=NEW.user_id)
 THEN RAISE EXCEPTION 'independent canonical accounting admission required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER w3_accounting_admission_guard BEFORE INSERT ON public.withdrawal_reducing_accounting_admissions
 FOR EACH ROW EXECUTE FUNCTION public.w3_guard_independent_accounting_admission();
REVOKE ALL ON FUNCTION public.w3_guard_independent_accounting_admission() FROM PUBLIC,swat_app;

CREATE FUNCTION public.w3_guard_intent() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'financial intent immutable'; END IF;
 IF TG_OP='INSERT' THEN
  NEW.created_at:=statement_timestamp();
  IF NEW.intent->>'userId' IS NULL OR NEW.intent->>'kind' IS NULL OR NEW.intent->>'requestKey' IS NULL
   OR NEW.intent->>'version' IS NULL OR NEW.intent->>'expiresAt' IS NULL OR NEW.intent->>'chain' IS NULL
   OR NEW.intent->>'mode' IS NULL OR NEW.intent->>'assetScale' IS NULL OR NEW.intent->>'network' IS NULL
   OR NEW.intent->>'assetId' IS NULL OR NEW.intent->>'maxFeeRaw' IS NULL
   OR NEW.intent->>'feeAssetId' IS NULL OR NEW.intent->>'feeAssetScale' IS NULL OR NEW.intent->>'feeFundingAccountId' IS NULL
   OR (NEW.kind='withdrawal' AND (NEW.intent->>'amountRaw' IS NULL OR NEW.intent->>'destination' IS NULL OR NEW.intent->>'sourceWalletId' IS NULL))
   OR (NEW.kind='reducing' AND (NEW.intent->>'quantityRaw' IS NULL OR NEW.intent->>'venue' IS NULL
     OR NEW.intent->>'positionId' IS NULL OR NEW.intent->>'accountId' IS NULL OR NEW.intent->>'positionSide' IS NULL
     OR NEW.intent->>'side' IS NULL OR NEW.intent->>'expectedRevision' IS NULL OR NEW.intent->>'limitPriceExact' IS NULL))
  THEN RAISE EXCEPTION 'financial exact intent fields missing'; END IF;
  IF NEW.status<>'awaiting-authorization' OR NEW.completed_raw<>0 OR NEW.terminal
    OR NEW.expires_at<=NEW.created_at OR NEW.expires_at>NEW.created_at+interval '15 minutes'
  THEN RAISE EXCEPTION 'invalid financial intent initial state'; END IF;
  RETURN NEW;
 END IF;
 IF ROW(NEW.id,NEW.user_id,NEW.kind,NEW.request_key,NEW.intent,NEW.intent_hash,NEW.expires_at,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.kind,OLD.request_key,OLD.intent,OLD.intent_hash,OLD.expires_at,OLD.created_at)
 THEN RAISE EXCEPTION 'financial exact intent immutable'; END IF;
 IF current_user='swat_financial_settler' THEN RETURN NEW; END IF;
 IF NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at OR NEW.cancellation_reason IS DISTINCT FROM OLD.cancellation_reason
 THEN RAISE EXCEPTION 'cancellation requires audited no-attempt function'; END IF;
 IF NEW.completed_raw IS DISTINCT FROM OLD.completed_raw OR NEW.terminal IS DISTINCT FROM OLD.terminal THEN
   RAISE EXCEPTION 'settlement requires independently admitted receipt'; END IF;
 IF NEW.status=OLD.status THEN RETURN NEW; END IF;
 IF (OLD.status='awaiting-authorization' AND NEW.status='queued' AND EXISTS(
    SELECT 1 FROM public.withdrawal_reducing_outbox WHERE intent_id=NEW.id AND user_id=NEW.user_id AND intent_hash=NEW.intent_hash))
 OR (OLD.status='queued' AND NEW.status='prepared' AND EXISTS(
    SELECT 1 FROM public.withdrawal_reducing_attempts WHERE intent_id=NEW.id AND state='prepared'))
 OR (OLD.status='prepared' AND NEW.status='uncertain' AND EXISTS(
    SELECT 1 FROM public.withdrawal_reducing_attempts WHERE intent_id=NEW.id AND state='uncertain'))
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'invalid financial intent transition';
END $$;
CREATE TRIGGER w3_intent_guard BEFORE INSERT OR UPDATE OR DELETE ON public.withdrawal_reducing_intents
 FOR EACH ROW EXECUTE FUNCTION public.w3_guard_intent();
CREATE FUNCTION public.w3_guard_authorization() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE parent public.withdrawal_reducing_intents;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'one-use authorization immutable'; END IF;
 SELECT * INTO parent FROM public.withdrawal_reducing_intents WHERE id=NEW.intent_id AND user_id=NEW.user_id;
 IF parent.id IS NULL OR parent.kind<>'withdrawal' OR parent.intent_hash<>NEW.intent_hash THEN RAISE EXCEPTION 'authorization scope mismatch'; END IF;
 IF TG_OP='INSERT' THEN
  NEW.created_at:=statement_timestamp();
  IF NEW.expires_at>parent.expires_at OR NEW.expires_at<=NEW.created_at OR NEW.failures<>0 OR NEW.delivery_state<>'pending' OR NEW.consumed_at IS NOT NULL
    THEN RAISE EXCEPTION 'invalid one-use authorization'; END IF;
  RETURN NEW;
 END IF;
 IF ROW(NEW.id,NEW.user_id,NEW.intent_id,NEW.intent_hash,NEW.digest,NEW.expires_at,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.intent_id,OLD.intent_hash,OLD.digest,OLD.expires_at,OLD.created_at)
  OR OLD.consumed_at IS NOT NULL OR NEW.failures<OLD.failures OR NEW.failures>OLD.failures+1
  OR (OLD.delivery_state<>'pending' AND NEW.delivery_state<>OLD.delivery_state)
 THEN RAISE EXCEPTION 'one-use authorization mutation'; END IF;
 IF NEW.consumed_at IS NOT NULL THEN
  NEW.consumed_at:=statement_timestamp();
  IF OLD.delivery_state<>'sent' OR OLD.failures>=5 OR OLD.expires_at<=NEW.consumed_at OR parent.expires_at<=NEW.consumed_at
    OR parent.status<>'awaiting-authorization' OR NOT EXISTS(SELECT 1 FROM public.withdrawal_reducing_reservations
       WHERE intent_id=parent.id AND user_id=parent.user_id AND amount_raw=(parent.intent->>'amountRaw')::numeric)
    OR NOT EXISTS(SELECT 1 FROM public.withdrawal_reducing_reservations
       WHERE intent_id=parent.id AND user_id=parent.user_id AND fee_raw=(parent.intent->>'maxFeeRaw')::numeric
        AND account_id=parent.intent->>'feeFundingAccountId' AND asset_id=parent.intent->>'feeAssetId'
        AND asset_scale=(parent.intent->>'feeAssetScale')::integer AND purpose='funding')
  THEN RAISE EXCEPTION 'one-use authorization cannot be consumed'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER w3_authorization_guard BEFORE INSERT OR UPDATE OR DELETE ON public.withdrawal_authorizations
 FOR EACH ROW EXECUTE FUNCTION public.w3_guard_authorization();
-- Deferred constraint prevents consumed authorization without atomically durable request/outbox.
CREATE FUNCTION public.w3_authorization_atomic_request() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.consumed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.withdrawal_reducing_outbox
   WHERE intent_id=NEW.intent_id AND user_id=NEW.user_id AND intent_hash=NEW.intent_hash)
 THEN RAISE EXCEPTION 'authorization consumption requires atomic durable request'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER w3_authorization_request AFTER UPDATE ON public.withdrawal_authorizations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.w3_authorization_atomic_request();
CREATE FUNCTION public.w3_guard_outbox() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE parent public.withdrawal_reducing_intents;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'outbox immutable'; END IF;
 SELECT * INTO parent FROM public.withdrawal_reducing_intents WHERE id=NEW.intent_id AND user_id=NEW.user_id;
 IF parent.id IS NULL OR parent.intent_hash<>NEW.intent_hash OR parent.status<>'awaiting-authorization'
  OR parent.expires_at<=statement_timestamp() OR NOT EXISTS(SELECT 1 FROM public.withdrawal_reducing_reservations
       WHERE intent_id=parent.id AND user_id=parent.user_id AND amount_raw=CASE WHEN parent.kind='withdrawal'
         THEN (parent.intent->>'amountRaw')::numeric ELSE (parent.intent->>'quantityRaw')::numeric END)
  OR NOT EXISTS(SELECT 1 FROM public.withdrawal_reducing_reservations WHERE intent_id=parent.id AND user_id=parent.user_id
       AND fee_raw=(parent.intent->>'maxFeeRaw')::numeric AND purpose='funding' AND account_id=parent.intent->>'feeFundingAccountId'
       AND asset_id=parent.intent->>'feeAssetId' AND asset_scale=(parent.intent->>'feeAssetScale')::integer)
  OR (parent.kind='reducing' AND parent.intent->>'venue'='polymarket-perps' AND NOT EXISTS(
    SELECT 1 FROM public.reducing_perps_venue_mappings WHERE position_id=(parent.intent->>'positionId')::uuid AND user_id=parent.user_id
      AND account_id=parent.intent->>'accountId' AND chain=parent.intent->>'chain' AND network=parent.intent->>'network'
      AND mode=parent.intent->>'mode' AND asset_id=parent.intent->>'assetId' AND asset_scale=(parent.intent->>'assetScale')::integer
      AND valid_until>statement_timestamp()))
  OR (parent.kind='withdrawal' AND NOT EXISTS(SELECT 1 FROM public.withdrawal_authorizations
      WHERE intent_id=parent.id AND user_id=parent.user_id AND consumed_at IS NOT NULL AND intent_hash=parent.intent_hash))
 THEN RAISE EXCEPTION 'durable request authorization/reservation unavailable'; END IF;
 NEW.created_at:=statement_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER w3_outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON public.withdrawal_reducing_outbox
 FOR EACH ROW EXECUTE FUNCTION public.w3_guard_outbox();
CREATE FUNCTION public.w3_guard_attempt() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE parent public.withdrawal_reducing_intents;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'fixed attempt immutable'; END IF;
 IF TG_OP='INSERT' THEN
  -- Parent row lock serializes direct app INSERT with cancellation; expiry is evaluated AFTER any lock wait.
  SELECT * INTO parent FROM public.withdrawal_reducing_intents WHERE id=NEW.intent_id AND user_id=NEW.user_id FOR UPDATE;
  IF parent.id IS NULL OR parent.status<>'queued' OR parent.terminal OR parent.cancelled_at IS NOT NULL OR parent.intent_hash<>NEW.intent_hash
   OR parent.expires_at<=statement_timestamp() OR NEW.state<>'prepared' OR NEW.completed_raw<>0 OR NEW.completed_fee_raw<>0 OR NEW.terminal
   OR NOT EXISTS(SELECT 1 FROM public.withdrawal_reducing_outbox WHERE intent_id=parent.id AND intent_hash=parent.intent_hash)
  THEN RAISE EXCEPTION 'attempt must derive from durable queued intent'; END IF;
  NEW.created_at:=statement_timestamp(); RETURN NEW;
 END IF;
 IF ROW(NEW.id,NEW.intent_id,NEW.user_id,NEW.intent_hash,NEW.client_order_id,NEW.fence,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.intent_id,OLD.user_id,OLD.intent_hash,OLD.client_order_id,OLD.fence,OLD.created_at)
 THEN RAISE EXCEPTION 'fixed attempt fence immutable'; END IF;
 IF current_user='swat_financial_settler' THEN RETURN NEW; END IF;
 IF NEW.completed_raw<>OLD.completed_raw OR NEW.completed_fee_raw<>OLD.completed_fee_raw OR NEW.terminal<>OLD.terminal
  OR NOT(OLD.state='prepared' AND NEW.state='uncertain' AND NOT OLD.terminal)
 THEN RAISE EXCEPTION 'attempt state requires receipt/fixed dispatch fence'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER w3_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON public.withdrawal_reducing_attempts
 FOR EACH ROW EXECUTE FUNCTION public.w3_guard_attempt();
CREATE FUNCTION public.w3_guard_receipt() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE parent public.withdrawal_reducing_intents; attempt public.withdrawal_reducing_attempts; maximum numeric;
BEGIN
 IF TG_OP<>'INSERT' OR current_user<>'swat_financial_receipt_writer' THEN RAISE EXCEPTION 'independent receipt writer required'; END IF;
 IF NEW.receipt->>'intentId' IS NULL OR NEW.receipt->>'intentHash' IS NULL OR NEW.receipt->>'attemptId' IS NULL
  OR NEW.receipt->>'clientOrderId' IS NULL OR NEW.receipt->>'receiptId' IS NULL OR NEW.receipt->>'providerIdentity' IS NULL
  OR NEW.receipt->>'proof' IS NULL OR NEW.receipt->>'cumulativeRaw' IS NULL OR NEW.receipt->>'feeRaw' IS NULL
  OR NEW.receipt->>'feeAssetId' IS NULL OR NEW.receipt->>'feeAssetScale' IS NULL OR NEW.receipt->>'feeFundingAccountId' IS NULL
  OR NEW.receipt->>'terminal' IS NULL OR NEW.receipt->>'outcome' IS NULL OR NEW.receipt->>'observedAt' IS NULL
 THEN RAISE EXCEPTION 'receipt exact binding fields missing'; END IF;
 SELECT * INTO parent FROM public.withdrawal_reducing_intents WHERE id=NEW.intent_id AND user_id=NEW.user_id;
 SELECT * INTO attempt FROM public.withdrawal_reducing_attempts WHERE id=NEW.attempt_id AND intent_id=NEW.intent_id AND user_id=NEW.user_id;
 maximum:=CASE WHEN parent.kind='withdrawal' THEN (parent.intent->>'amountRaw')::numeric ELSE (parent.intent->>'quantityRaw')::numeric END;
 IF parent.id IS NULL OR attempt.id IS NULL OR NEW.receipt->>'intentId'<>parent.id::text OR NEW.receipt->>'intentHash'<>parent.intent_hash
  OR NEW.receipt->>'attemptId'<>attempt.id::text OR NEW.receipt->>'clientOrderId'<>attempt.client_order_id
  OR NEW.receipt->>'receiptId'<>NEW.receipt_id OR NEW.receipt->>'providerIdentity'<>NEW.provider_identity OR NEW.receipt->>'proof'<>NEW.proof
  OR (NEW.receipt->>'cumulativeRaw')::numeric<>NEW.cumulative_raw OR (NEW.receipt->>'feeRaw')::numeric<>NEW.fee_raw
  OR NEW.receipt->>'feeAssetId'<>NEW.fee_asset_id OR (NEW.receipt->>'feeAssetScale')::integer<>NEW.fee_asset_scale
  OR NEW.receipt->>'feeFundingAccountId'<>NEW.fee_funding_account_id OR NEW.fee_asset_id<>parent.intent->>'feeAssetId'
  OR NEW.fee_asset_scale<>(parent.intent->>'feeAssetScale')::integer OR NEW.fee_funding_account_id<>parent.intent->>'feeFundingAccountId'
  OR (NEW.receipt->>'terminal')::boolean<>NEW.terminal OR NEW.receipt->>'outcome'<>NEW.outcome
  OR (NEW.receipt->>'observedAt')::timestamptz<>NEW.observed_at OR NEW.observed_at>statement_timestamp()
  OR NEW.cumulative_raw>maximum OR NEW.fee_raw>(parent.intent->>'maxFeeRaw')::numeric
  OR (NEW.outcome<>'fill' AND (NOT NEW.terminal OR NEW.cumulative_raw<>0))
 THEN RAISE EXCEPTION 'receipt exact binding/quantity/finality mismatch'; END IF;
 IF NEW.terminal AND NEW.cumulative_raw=0 THEN
  IF NEW.receipt->'noFutureAcceptance' IS NULL
   OR NEW.receipt->'noFutureAcceptance'->>'guarantee' IS DISTINCT FROM 'permanent-no-future-acceptance'
   OR NEW.receipt->'noFutureAcceptance'->>'intentId' IS DISTINCT FROM parent.id::text
   OR NEW.receipt->'noFutureAcceptance'->>'intentHash' IS DISTINCT FROM parent.intent_hash
   OR NEW.receipt->'noFutureAcceptance'->>'attemptId' IS DISTINCT FROM attempt.id::text
   OR NEW.receipt->'noFutureAcceptance'->>'clientOrderId' IS DISTINCT FROM attempt.client_order_id
   OR NEW.receipt->'noFutureAcceptance'->>'providerIdentity' IS DISTINCT FROM NEW.provider_identity
   OR length(COALESCE(NEW.receipt->'noFutureAcceptance'->>'tombstoneId',''))=0
   OR length(COALESCE(NEW.receipt->'noFutureAcceptance'->>'proof',''))=0
   OR NEW.receipt->'noFutureAcceptance'->>'effectiveAt' IS NULL
   OR (NEW.receipt->'noFutureAcceptance'->>'effectiveAt')::timestamptz>NEW.observed_at
  THEN RAISE EXCEPTION 'permanent provider no-future-acceptance tombstone required'; END IF;
 END IF;
 NEW.admitted_at:=statement_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER w3_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON public.withdrawal_reducing_receipts
 FOR EACH ROW EXECUTE FUNCTION public.w3_guard_receipt();

CREATE FUNCTION public.swat_apply_perps_reducing_receipt(requested_intent uuid, requested_receipt text)
 RETURNS TABLE(accounting_reference text,position_id uuid,position_side text,before_raw text,after_raw text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE parent public.withdrawal_reducing_intents; attempt public.withdrawal_reducing_attempts;
 receipt public.withdrawal_reducing_receipts; position public.polymarket_perps_positions;
 previous public.reducing_perps_position_applications; scale integer; factor numeric; before_quantity numeric; after_quantity numeric; delta numeric;
BEGIN
 SELECT * INTO parent FROM public.withdrawal_reducing_intents
  WHERE id=requested_intent AND user_id=public.current_app_user_id() FOR UPDATE;
 IF parent.id IS NULL OR parent.kind<>'reducing' OR parent.intent->>'venue'<>'polymarket-perps'
   OR parent.intent->>'chain'<>'polygon' THEN RAISE EXCEPTION 'owned perps intent unavailable'; END IF;
 SELECT * INTO attempt FROM public.withdrawal_reducing_attempts WHERE intent_id=parent.id AND user_id=parent.user_id FOR UPDATE;
 SELECT * INTO receipt FROM public.withdrawal_reducing_receipts
  WHERE receipt_id=requested_receipt AND intent_id=parent.id AND user_id=parent.user_id AND attempt_id=attempt.id;
 IF receipt.receipt_id IS NULL THEN RAISE EXCEPTION 'independent receipt admission unavailable'; END IF;
 SELECT * INTO previous FROM public.reducing_perps_position_applications WHERE receipt_id=requested_receipt;
 IF previous.receipt_id IS NOT NULL THEN
  RETURN QUERY SELECT previous.accounting_reference,previous.position_id,previous.position_side,previous.before_raw::text,previous.after_raw::text; RETURN;
 END IF;
 IF attempt.terminal OR receipt.cumulative_raw<attempt.completed_raw OR receipt.fee_raw<attempt.completed_fee_raw
 THEN RAISE EXCEPTION 'perps terminal/regression accounting unavailable'; END IF;
 delta:=receipt.cumulative_raw-attempt.completed_raw;
 IF NOT EXISTS(SELECT 1 FROM public.reducing_perps_economics_admissions e WHERE e.receipt_id=receipt.receipt_id
  AND e.intent_id=parent.id AND e.user_id=parent.user_id AND e.position_id=(parent.intent->>'positionId')::uuid
  AND e.delta_raw=delta AND e.delta_fee_raw=receipt.fee_raw-attempt.completed_fee_raw)
 THEN RAISE EXCEPTION 'perps EVERY fill economics admission unavailable'; END IF;
 scale:=(parent.intent->>'assetScale')::integer;
 IF scale>8 THEN RAISE EXCEPTION 'perps storage scale unavailable'; END IF;
 factor:=power(10::numeric,scale);
 SELECT * INTO position FROM public.polymarket_perps_positions
  WHERE id=(parent.intent->>'positionId')::uuid AND user_id=parent.user_id FOR UPDATE;
 IF position.id IS NULL OR position.side<>parent.intent->>'positionSide' OR position.instrument_id::text<>parent.intent->>'assetId'
  OR NOT((position.side='LONG' AND parent.intent->>'side'='SELL') OR(position.side='SHORT' AND parent.intent->>'side'='BUY'))
 THEN RAISE EXCEPTION 'perps owned exposure mismatch'; END IF;
 before_quantity:=position.size*factor;
 IF before_quantity<>trunc(before_quantity) OR before_quantity<delta OR delta<0 THEN RAISE EXCEPTION 'perps reduction cross zero or scale loss'; END IF;
 after_quantity:=before_quantity-delta;
 IF position.status='closed' THEN
  -- Fee-only settlement after this SAME intent already closed exposure: no reopening or quantity mutation.
  IF delta<>0 OR before_quantity<>0 OR after_quantity<>0 OR NOT EXISTS(
    SELECT 1 FROM public.reducing_perps_position_applications p
      JOIN public.withdrawal_reducing_applications a ON a.receipt_id=p.receipt_id AND a.intent_id=p.intent_id AND a.user_id=p.user_id
      JOIN public.withdrawal_reducing_receipts r ON r.receipt_id=p.receipt_id AND r.attempt_id=attempt.id
    WHERE p.position_id=position.id AND p.intent_id=parent.id AND p.user_id=parent.user_id AND p.position_side=position.side
      AND p.after_raw=0 AND r.cumulative_raw=attempt.completed_raw)
  THEN RAISE EXCEPTION 'closed perps fee-only requires exact prior receipt journal'; END IF;
 ELSIF position.status IN('open','closing') THEN
  UPDATE public.polymarket_perps_positions SET size=after_quantity/factor,
    status=CASE WHEN after_quantity=0 THEN 'closed' ELSE 'open' END,updated_at=statement_timestamp()
    WHERE id=position.id AND user_id=parent.user_id;
 ELSE RAISE EXCEPTION 'perps status not eligible for receipt accounting'; END IF;
 INSERT INTO public.reducing_perps_position_applications(receipt_id,user_id,intent_id,position_id,position_side,before_raw,after_raw,accounting_reference)
 VALUES(requested_receipt,parent.user_id,parent.id,position.id,position.side,before_quantity,after_quantity,'perps-position:'||position.id::text||':'||requested_receipt)
 RETURNING * INTO previous;
 RETURN QUERY SELECT previous.accounting_reference,previous.position_id,previous.position_side,previous.before_raw::text,previous.after_raw::text;
END $$;
ALTER FUNCTION public.swat_apply_perps_reducing_receipt(uuid,text) OWNER TO swat_financial_settler;
REVOKE ALL ON FUNCTION public.swat_apply_perps_reducing_receipt(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.swat_apply_perps_reducing_receipt(uuid,text) TO swat_app;

CREATE FUNCTION public.w3_apply_financial_receipt() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE parent public.withdrawal_reducing_intents; attempt public.withdrawal_reducing_attempts;
 receipt public.withdrawal_reducing_receipts; next_state text; maximum numeric; delta_fee numeric;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'financial receipt application immutable'; END IF;
 IF NEW.user_id IS DISTINCT FROM public.current_app_user_id() THEN RAISE EXCEPTION 'financial application tenant mismatch'; END IF;
 SELECT * INTO parent FROM public.withdrawal_reducing_intents WHERE id=NEW.intent_id AND user_id=NEW.user_id FOR UPDATE;
 SELECT * INTO attempt FROM public.withdrawal_reducing_attempts WHERE id=NEW.attempt_id AND intent_id=parent.id AND user_id=NEW.user_id FOR UPDATE;
 SELECT * INTO receipt FROM public.withdrawal_reducing_receipts WHERE receipt_id=NEW.receipt_id AND intent_id=parent.id AND attempt_id=attempt.id AND user_id=NEW.user_id;
 IF parent.id IS NULL OR receipt.receipt_id IS NULL OR attempt.id IS NULL OR attempt.terminal
  OR receipt.cumulative_raw<attempt.completed_raw OR receipt.fee_raw<attempt.completed_fee_raw
  OR NEW.delta_raw<>receipt.cumulative_raw-attempt.completed_raw THEN RAISE EXCEPTION 'financial receipt application scope/delta mismatch'; END IF;
 delta_fee:=receipt.fee_raw-attempt.completed_fee_raw;
 IF NEW.delta_raw>0 OR delta_fee>0 THEN
  IF parent.kind='reducing' AND parent.intent->>'venue'='polymarket-perps' THEN
   IF NOT EXISTS(SELECT 1 FROM public.reducing_perps_position_applications p
     WHERE p.receipt_id=receipt.receipt_id AND p.intent_id=parent.id AND p.user_id=parent.user_id
      AND p.before_raw-p.after_raw=NEW.delta_raw AND p.accounting_reference=NEW.accounting_reference)
   THEN RAISE EXCEPTION 'canonical perps position application unavailable'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.reducing_perps_economics_admissions e WHERE e.receipt_id=receipt.receipt_id
    AND e.intent_id=parent.id AND e.user_id=parent.user_id AND e.delta_raw=NEW.delta_raw AND e.delta_fee_raw=delta_fee)
   THEN RAISE EXCEPTION 'perps EVERY fill economics admission unavailable'; END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM public.withdrawal_reducing_accounting_admissions a WHERE a.receipt_id=receipt.receipt_id
    AND a.intent_id=parent.id AND a.user_id=parent.user_id AND a.delta_raw=NEW.delta_raw AND a.delta_fee_raw=delta_fee
    AND a.accounting_reference=NEW.accounting_reference)
  THEN RAISE EXCEPTION 'canonical withdrawal/spot accounting admission unavailable'; END IF;
 END IF;
 maximum:=CASE WHEN parent.kind='withdrawal' THEN (parent.intent->>'amountRaw')::numeric ELSE (parent.intent->>'quantityRaw')::numeric END;
 next_state:=CASE WHEN receipt.terminal AND receipt.cumulative_raw=maximum THEN 'settled'
   WHEN receipt.terminal AND receipt.cumulative_raw=0 THEN 'failed'
   WHEN receipt.cumulative_raw>0 THEN 'partial' ELSE 'uncertain' END;
 UPDATE public.withdrawal_reducing_attempts SET completed_raw=receipt.cumulative_raw,completed_fee_raw=receipt.fee_raw,
   terminal=receipt.terminal,state=next_state WHERE id=attempt.id;
 UPDATE public.withdrawal_reducing_intents SET completed_raw=receipt.cumulative_raw,terminal=receipt.terminal,status=next_state WHERE id=parent.id;
 -- Every denomination's outstanding amount AND paid fee derive atomically from the authenticated cumulative receipt.
 UPDATE public.withdrawal_reducing_reservations SET reserved_raw=CASE WHEN receipt.terminal THEN 0 ELSE
   amount_raw+fee_raw-CASE WHEN amount_raw>0 THEN receipt.cumulative_raw ELSE 0 END
     -CASE WHEN fee_raw>0 THEN receipt.fee_raw ELSE 0 END END WHERE intent_id=parent.id AND user_id=parent.user_id;
 NEW.applied_at:=statement_timestamp(); RETURN NEW;
END $$;
ALTER FUNCTION public.w3_apply_financial_receipt() OWNER TO swat_financial_settler;
CREATE TRIGGER w3_receipt_application BEFORE INSERT OR UPDATE OR DELETE ON public.withdrawal_reducing_applications
 FOR EACH ROW EXECUTE FUNCTION public.w3_apply_financial_receipt();
CREATE FUNCTION public.w3_perps_accounting_requires_application() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.withdrawal_reducing_applications a WHERE a.receipt_id=NEW.receipt_id
  AND a.intent_id=NEW.intent_id AND a.user_id=NEW.user_id AND a.accounting_reference=NEW.accounting_reference
  AND a.delta_raw=NEW.before_raw-NEW.after_raw)
 THEN RAISE EXCEPTION 'perps position accounting requires atomic receipt application'; END IF;
 RETURN NULL;
END $$;
ALTER FUNCTION public.w3_perps_accounting_requires_application() OWNER TO swat_financial_settler;
CREATE CONSTRAINT TRIGGER w3_perps_accounting_atomic AFTER INSERT ON public.reducing_perps_position_applications
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.w3_perps_accounting_requires_application();
REVOKE ALL ON FUNCTION public.w3_perps_accounting_requires_application() FROM PUBLIC,swat_app;

CREATE FUNCTION public.w3_guard_reservation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE parent public.withdrawal_reducing_intents; amount numeric:=0; fee numeric:=0;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'financial reservation retained'; END IF;
 SELECT * INTO parent FROM public.withdrawal_reducing_intents WHERE id=NEW.intent_id AND user_id=NEW.user_id;
 IF parent.id IS NULL OR NEW.chain<>parent.intent->>'chain' OR NEW.network<>parent.intent->>'network' OR NEW.mode<>parent.intent->>'mode'
 THEN RAISE EXCEPTION 'reservation scope unavailable'; END IF;
 IF parent.kind='withdrawal' AND NEW.purpose='funding' AND NEW.account_id=parent.intent->>'sourceWalletId'
   AND NEW.asset_id=parent.intent->>'assetId' AND NEW.asset_scale=(parent.intent->>'assetScale')::integer
 THEN amount:=(parent.intent->>'amountRaw')::numeric;
 ELSIF parent.kind='reducing' AND NEW.purpose='exposure' AND NEW.account_id=parent.intent->>'accountId'
   AND NEW.asset_id=parent.intent->>'assetId' AND NEW.asset_scale=(parent.intent->>'assetScale')::integer
 THEN amount:=(parent.intent->>'quantityRaw')::numeric; END IF;
 IF NEW.purpose='funding' AND NEW.account_id=parent.intent->>'feeFundingAccountId' AND NEW.asset_id=parent.intent->>'feeAssetId'
   AND NEW.asset_scale=(parent.intent->>'feeAssetScale')::integer THEN fee:=(parent.intent->>'maxFeeRaw')::numeric; END IF;
 IF NEW.budget_key IS DISTINCT FROM concat('[',to_json(NEW.purpose)::text,',',to_json(NEW.chain)::text,',',to_json(NEW.network)::text,',',
   to_json(NEW.account_id)::text,',',to_json(NEW.asset_id)::text,',',NEW.asset_scale::text,',',to_json(NEW.mode)::text,']')
 THEN RAISE EXCEPTION 'canonical reservation budget key mismatch'; END IF;
 IF NEW.amount_raw<>amount OR NEW.fee_raw<>fee OR (amount=0 AND fee=0 AND NOT(NEW.purpose='funding'
   AND NEW.account_id=parent.intent->>'feeFundingAccountId' AND NEW.asset_id=parent.intent->>'feeAssetId'
   AND NEW.asset_scale=(parent.intent->>'feeAssetScale')::integer)) THEN RAISE EXCEPTION 'reservation exact denomination mismatch'; END IF;
 IF TG_OP='INSERT' THEN
  IF parent.status<>'awaiting-authorization' OR NEW.reserved_raw<>amount+fee THEN RAISE EXCEPTION 'exact initial reservation mismatch'; END IF;
 ELSE
  IF current_user<>'swat_financial_settler' OR ROW(NEW.intent_id,NEW.user_id,NEW.budget_key,NEW.purpose,NEW.chain,NEW.network,NEW.mode,
    NEW.account_id,NEW.asset_id,NEW.asset_scale,NEW.amount_raw,NEW.fee_raw) IS DISTINCT FROM
    ROW(OLD.intent_id,OLD.user_id,OLD.budget_key,OLD.purpose,OLD.chain,OLD.network,OLD.mode,OLD.account_id,OLD.asset_id,OLD.asset_scale,OLD.amount_raw,OLD.fee_raw)
  THEN RAISE EXCEPTION 'reservation release requires receipt or audited cancellation'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER w3_reservation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.withdrawal_reducing_reservations
 FOR EACH ROW EXECUTE FUNCTION public.w3_guard_reservation();

CREATE FUNCTION public.swat_cancel_expired_financial_intent(requested_intent uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE parent public.withdrawal_reducing_intents; budget record;
BEGIN
 SELECT * INTO parent FROM public.withdrawal_reducing_intents WHERE id=requested_intent
   AND user_id=public.current_app_user_id() FOR UPDATE;
 IF parent.id IS NULL THEN RAISE EXCEPTION 'owned expired intent unavailable'; END IF;
 IF parent.status='cancelled' THEN RETURN true; END IF;
 IF parent.status<>'queued' OR parent.terminal OR parent.expires_at>statement_timestamp()
  OR EXISTS(SELECT 1 FROM public.withdrawal_reducing_attempts WHERE intent_id=parent.id)
 THEN RAISE EXCEPTION 'only expired queued no-attempt intent can cancel'; END IF;
 FOR budget IN SELECT budget_key FROM public.withdrawal_reducing_reservations WHERE intent_id=parent.id ORDER BY budget_key LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(concat('[',to_json(parent.user_id::text)::text,',',to_json(budget.budget_key)::text,']'),0));
 END LOOP;
 UPDATE public.withdrawal_reducing_intents SET status='cancelled',terminal=true,cancelled_at=statement_timestamp(),
   cancellation_reason='expired-before-attempt' WHERE id=parent.id;
 UPDATE public.withdrawal_reducing_reservations SET reserved_raw=0 WHERE intent_id=parent.id AND user_id=parent.user_id;
 INSERT INTO public.withdrawal_reducing_cancellations(intent_id,user_id,reason) VALUES(parent.id,parent.user_id,'expired-before-attempt');
 RETURN true;
END $$;
ALTER FUNCTION public.swat_cancel_expired_financial_intent(uuid) OWNER TO swat_financial_settler;
REVOKE ALL ON FUNCTION public.swat_cancel_expired_financial_intent(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.swat_cancel_expired_financial_intent(uuid) TO swat_app;

CREATE FUNCTION public.w3_guard_perps_venue_mapping() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP<>'INSERT' OR current_user<>'swat_financial_receipt_writer' THEN RAISE EXCEPTION 'independent deployed venue mapping writer required'; END IF;
 -- Provider writer independently resolves mapping before request admission. No FK to an uncommitted runtime intent.
 IF NOT EXISTS(SELECT 1 FROM public.polymarket_perps_positions p WHERE p.id=NEW.position_id AND p.user_id=NEW.user_id
   AND p.instrument_id::text=NEW.asset_id) OR NEW.chain<>'polygon' OR NEW.mode NOT IN('paper','live')
  OR NEW.mapping->>'mappingId' IS DISTINCT FROM NEW.mapping_id OR NEW.mapping->>'userId' IS DISTINCT FROM NEW.user_id::text
  OR NEW.mapping->>'positionId' IS DISTINCT FROM NEW.position_id::text OR NEW.mapping->>'accountId' IS DISTINCT FROM NEW.account_id
  OR NEW.mapping->>'venue' IS DISTINCT FROM 'polymarket-perps' OR NEW.mapping->>'chain' IS DISTINCT FROM NEW.chain
  OR NEW.mapping->>'network' IS DISTINCT FROM NEW.network OR NEW.mapping->>'mode' IS DISTINCT FROM NEW.mode
  OR NEW.mapping->>'assetId' IS DISTINCT FROM NEW.asset_id OR (NEW.mapping->>'assetScale')::integer IS DISTINCT FROM NEW.asset_scale
  OR NEW.mapping->>'revision' IS DISTINCT FROM NEW.revision OR NEW.mapping->>'proof' IS DISTINCT FROM NEW.proof
  OR NEW.mapping->>'collateralAssetId' IS DISTINCT FROM NEW.collateral_asset_id
  OR (NEW.mapping->>'collateralAssetScale')::integer IS DISTINCT FROM NEW.collateral_asset_scale
  OR NEW.mapping->>'collateralAccountId' IS DISTINCT FROM NEW.collateral_account_id
  OR (NEW.mapping->>'observedAt')::timestamptz IS DISTINCT FROM NEW.observed_at
  OR (NEW.mapping->>'validUntil')::timestamptz IS DISTINCT FROM NEW.valid_until
  OR NEW.observed_at>statement_timestamp() OR NEW.valid_until<=statement_timestamp()
  OR length(NEW.proof)=0 OR length(NEW.collateral_asset_id)=0 OR length(NEW.collateral_account_id)=0
 THEN RAISE EXCEPTION 'perps independent collateral mapping scope mismatch'; END IF;
 NEW.admitted_at:=statement_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER w3_perps_mapping_guard BEFORE INSERT OR UPDATE OR DELETE ON public.reducing_perps_venue_mappings
 FOR EACH ROW EXECUTE FUNCTION public.w3_guard_perps_venue_mapping();
REVOKE ALL ON FUNCTION public.w3_guard_perps_venue_mapping() FROM PUBLIC,swat_app;

CREATE FUNCTION public.w3_guard_perps_economics_admission() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE parent public.withdrawal_reducing_intents; mapping public.reducing_perps_venue_mappings;
BEGIN
 IF TG_OP<>'INSERT' OR current_user<>'swat_financial_receipt_writer' THEN RAISE EXCEPTION 'independent perps economics writer required'; END IF;
 SELECT * INTO parent FROM public.withdrawal_reducing_intents WHERE id=NEW.intent_id AND user_id=NEW.user_id;
 SELECT * INTO mapping FROM public.reducing_perps_venue_mappings WHERE mapping_id=NEW.journal->>'venueMappingId'
  AND position_id=NEW.position_id AND user_id=NEW.user_id AND account_id=parent.intent->>'accountId'
  AND chain=parent.intent->>'chain' AND network=parent.intent->>'network' AND mode=parent.intent->>'mode'
  AND asset_id=parent.intent->>'assetId' AND asset_scale=(parent.intent->>'assetScale')::integer;
 IF mapping.mapping_id IS NULL OR parent.id IS NULL OR parent.kind<>'reducing' OR parent.intent->>'venue'<>'polymarket-perps'
  OR NEW.position_id IS DISTINCT FROM (parent.intent->>'positionId')::uuid
  OR NOT EXISTS(SELECT 1 FROM public.withdrawal_reducing_receipts r WHERE r.receipt_id=NEW.receipt_id AND r.intent_id=NEW.intent_id AND r.user_id=NEW.user_id)
  OR NEW.journal->>'receiptId' IS DISTINCT FROM NEW.receipt_id OR NEW.journal->>'intentId' IS DISTINCT FROM NEW.intent_id::text
  OR NEW.journal->>'economicsReference' IS DISTINCT FROM NEW.economics_reference
  OR NOT(NEW.journal ?& ARRAY['realizedPnlExact','collateralAssetId','collateralAssetScale','collateralAccountId','venueMappingId','collateralDeltaExact',
      'initialMarginBeforeExact','initialMarginAfterExact','maintenanceMarginBeforeExact','maintenanceMarginAfterExact',
      'entryPriceExact','executionPriceExact','positionEconomicsReference','accountJournalReference'])
  OR EXISTS(SELECT 1 FROM jsonb_each(NEW.journal) field WHERE field.value='null'::jsonb)
  OR NEW.journal->>'collateralAssetId' IS DISTINCT FROM mapping.collateral_asset_id
  OR (NEW.journal->>'collateralAssetScale')::integer IS DISTINCT FROM mapping.collateral_asset_scale
  OR NEW.journal->>'collateralAccountId' IS DISTINCT FROM mapping.collateral_account_id
  OR NEW.journal->>'venueMappingId' IS DISTINCT FROM mapping.mapping_id
  OR NEW.journal->>'realizedPnlExact' !~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$'
  OR NEW.journal->>'collateralDeltaExact' !~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$'
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['initialMarginBeforeExact','initialMarginAfterExact','maintenanceMarginBeforeExact',
       'maintenanceMarginAfterExact','entryPriceExact','executionPriceExact']) AS keys(key)
     WHERE NEW.journal->>key !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$')
 THEN RAISE EXCEPTION 'perps every-fill canonical economics journal unavailable'; END IF;
 NEW.admitted_at:=statement_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER w3_perps_economics_guard BEFORE INSERT OR UPDATE OR DELETE ON public.reducing_perps_economics_admissions
 FOR EACH ROW EXECUTE FUNCTION public.w3_guard_perps_economics_admission();
REVOKE ALL ON FUNCTION public.w3_guard_perps_economics_admission() FROM PUBLIC,swat_app;

DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['withdrawal_reducing_intents','withdrawal_authorizations','withdrawal_reducing_reservations',
  'withdrawal_reducing_outbox','withdrawal_reducing_attempts','withdrawal_reducing_receipts','withdrawal_reducing_applications',
  'reducing_perps_position_applications','withdrawal_reducing_accounting_admissions','withdrawal_reducing_cancellations','reducing_perps_economics_admissions',
  'reducing_perps_venue_mappings'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',tbl);
  EXECUTE format('CREATE POLICY w3_financial_tenant ON public.%I TO swat_app,swat_financial_settler,swat_financial_receipt_writer
   USING(user_id=public.current_app_user_id()) WITH CHECK(user_id=public.current_app_user_id())',tbl);
  EXECUTE format('CREATE POLICY w3_financial_migrator ON public.%I TO swat_migrator
   USING(public.is_rls_bypassed()) WITH CHECK(public.is_rls_bypassed())',tbl);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,swat_app,swat_financial_settler,swat_financial_receipt_writer',tbl);
  EXECUTE format('GRANT SELECT ON public.%I TO swat_app,swat_financial_settler,swat_financial_receipt_writer',tbl);
 END LOOP;
 FOREACH tbl IN ARRAY ARRAY['withdrawal_reducing_outbox','reducing_perps_position_applications','withdrawal_reducing_accounting_admissions','withdrawal_reducing_cancellations'] LOOP
  -- Outbox has its stricter scope guard instead.
  IF tbl<>'withdrawal_reducing_outbox' THEN
   EXECUTE format('CREATE TRIGGER w3_append_only BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.w3_financial_immutable()',tbl);
  END IF;
 END LOOP;
END $$;
GRANT USAGE ON SCHEMA public TO swat_financial_settler,swat_financial_receipt_writer;
-- Exact helpers required by FORCE RLS and the existing065 perps policy. No broad EXECUTE or role membership.
GRANT EXECUTE ON FUNCTION public.current_app_user_id(),public.is_rls_bypassed() TO swat_financial_settler,swat_financial_receipt_writer;
GRANT INSERT ON public.withdrawal_reducing_intents,public.withdrawal_authorizations,public.withdrawal_reducing_reservations,
 public.withdrawal_reducing_outbox,public.withdrawal_reducing_attempts,public.withdrawal_reducing_applications TO swat_app;
GRANT UPDATE(status) ON public.withdrawal_reducing_intents TO swat_app;
-- FOR UPDATE requires one column UPDATE; guards reject all mutation/no-op attempts unless restricted receipt/cancel writer.
GRANT UPDATE(reserved_raw) ON public.withdrawal_reducing_reservations TO swat_app;
GRANT UPDATE(failures,delivery_state,consumed_at) ON public.withdrawal_authorizations TO swat_app;
GRANT UPDATE(reserved_raw) ON public.withdrawal_reducing_reservations TO swat_financial_settler;
GRANT INSERT ON public.withdrawal_reducing_cancellations TO swat_financial_settler;
GRANT INSERT ON public.reducing_perps_economics_admissions,public.reducing_perps_venue_mappings TO swat_financial_receipt_writer;
GRANT UPDATE(state) ON public.withdrawal_reducing_attempts TO swat_app;
GRANT INSERT ON public.withdrawal_reducing_receipts TO swat_financial_receipt_writer;
-- Independent canonical accounting writer remains externally reviewed/unseeded; never app write access.
GRANT INSERT ON public.withdrawal_reducing_accounting_admissions TO swat_financial_receipt_writer;
GRANT UPDATE(status,completed_raw,terminal,cancelled_at,cancellation_reason) ON public.withdrawal_reducing_intents TO swat_financial_settler;
GRANT UPDATE(state,completed_raw,completed_fee_raw,terminal) ON public.withdrawal_reducing_attempts TO swat_financial_settler;
GRANT INSERT ON public.reducing_perps_position_applications TO swat_financial_settler;
GRANT SELECT ON public.polymarket_perps_positions TO swat_financial_settler,swat_financial_receipt_writer;
CREATE POLICY w3_perps_mapping_writer_tenant ON public.polymarket_perps_positions TO swat_financial_receipt_writer
 USING(user_id=public.current_app_user_id());
GRANT UPDATE(size,status,updated_at) ON public.polymarket_perps_positions TO swat_financial_settler;
CREATE POLICY w3_perps_settler_tenant ON public.polymarket_perps_positions TO swat_financial_settler
 USING(user_id=public.current_app_user_id()) WITH CHECK(user_id=public.current_app_user_id());
-- Revoke app arbitrary size/closed-state writes, including inherited historical table-level grants.
REVOKE UPDATE ON public.polymarket_perps_positions FROM swat_app;
-- Legacy INSERT also cannot self-certify a zero/closed exposure without independent receipt.
CREATE FUNCTION public.w3_guard_perps_position_mutation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id=OLD.id AND NEW.user_id=OLD.user_id AND NEW.side=OLD.side AND EXISTS(
  SELECT 1 FROM public.reducing_perps_position_applications p WHERE p.position_id=OLD.id AND p.user_id=OLD.user_id
   AND p.after_raw=NEW.size*power(10::numeric,(SELECT (i.intent->>'assetScale')::integer
      FROM public.withdrawal_reducing_intents i WHERE i.id=p.intent_id))) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'perps exposure mutation requires canonical receipt application';
END $$;
ALTER FUNCTION public.w3_guard_perps_position_mutation() OWNER TO swat_financial_settler;
CREATE CONSTRAINT TRIGGER w3_perps_position_receipt AFTER UPDATE ON public.polymarket_perps_positions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.w3_guard_perps_position_mutation();
REVOKE ALL ON FUNCTION public.w3_guard_perps_position_mutation() FROM PUBLIC,swat_app;

CREATE FUNCTION public.w3_guard_perps_initial_exposure() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF current_user='swat_app' AND (NEW.status<>'open' OR NEW.size<=0 OR NEW.size='NaN'::numeric)
 THEN RAISE EXCEPTION 'perps initial exposure cannot self-certify closure'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER w3_perps_initial_exposure BEFORE INSERT ON public.polymarket_perps_positions
 FOR EACH ROW EXECUTE FUNCTION public.w3_guard_perps_initial_exposure();
REVOKE ALL ON FUNCTION public.w3_guard_perps_initial_exposure() FROM PUBLIC,swat_app;
-- This intentionally prevents the legacy non-durable writer from being a settlement authority.
-- Function execute is never PUBLIC, even trigger functions; role ownership stays separately reviewed.
REVOKE ALL ON FUNCTION public.w3_financial_immutable(),public.w3_guard_intent(),public.w3_guard_authorization(),
 public.w3_authorization_atomic_request(),public.w3_guard_outbox(),public.w3_guard_attempt(),public.w3_guard_receipt(),
 public.w3_apply_financial_receipt(),public.w3_guard_reservation() FROM PUBLIC,swat_app;
