-- G083 PROPOSAL ONLY. Coordinator integration/review required; never applied by G.
-- No live provider authority is granted. Keyless injected paper records only.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lp_position_tenant ON lp_positions(id,user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lp_subscription_tenant ON lp_copy_subscriptions(id,user_id);

CREATE TABLE lp_exact_positions (
  position_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  acquisition_key TEXT NOT NULL CHECK(acquisition_key ~ '^[A-Za-z0-9_-]{1,128}$'),
  subscription_id UUID,
  master_event_id TEXT,
  acquisition_data JSONB NOT NULL CHECK(jsonb_typeof(acquisition_data)='object'),
  data JSONB NOT NULL CHECK(data ?& ARRAY['id','userId','chain','protocol','poolAddress','depositAsset','acquisitionKey','acquisitionFingerprint',
    'mode','deposit','depositMicroUsd','acquisitionQuote','copyOrigin','currentAmount','plan','revision','state','autoRebalance',
    'cumulativeFeesMicroUsd','cumulativeCostsMicroUsd','realizedMicroUsd','lastReceiptKey']),
  FOREIGN KEY(position_id,user_id) REFERENCES lp_positions(id,user_id) ON DELETE RESTRICT,
  FOREIGN KEY(subscription_id,user_id) REFERENCES lp_copy_subscriptions(id,user_id) ON DELETE RESTRICT,
  UNIQUE(position_id,user_id), UNIQUE(user_id,acquisition_key), UNIQUE(user_id,subscription_id,master_event_id),
  CHECK((subscription_id IS NULL)=(master_event_id IS NULL)),
  CHECK(data->>'id'=position_id::text AND data->>'userId'=user_id::text AND data->>'mode'='paper'),
  CHECK(data->>'acquisitionKey'=acquisition_key),
  CHECK(data->'deposit'->>'raw' ~ '^[1-9][0-9]{0,77}$' AND (data->'deposit'->>'scale')::integer BETWEEN 0 AND 30),
  CHECK(data->>'depositMicroUsd' ~ '^[1-9][0-9]{0,77}$'),
  CHECK(data->'currentAmount'->>'raw' ~ '^(0|[1-9][0-9]{0,77})$'),
  CHECK(data->'currentAmount'->>'scale'=data->'deposit'->>'scale'),
  CHECK(data->>'revision' ~ '^(0|[1-9][0-9]{0,77})$'),
  CHECK(data->>'cumulativeFeesMicroUsd' ~ '^(0|[1-9][0-9]{0,77})$'),
  CHECK(data->>'cumulativeCostsMicroUsd' ~ '^(0|[1-9][0-9]{0,77})$'),
  CHECK(data->>'state' <> 'closed' OR (data->'currentAmount'->>'raw'='0' AND data->>'lastReceiptKey' IS NOT NULL)),
  CHECK(data->>'realizedMicroUsd' IS NULL OR data->>'realizedMicroUsd' ~ '^(0|-?[1-9][0-9]{0,77})$')
);
CREATE FUNCTION lp_exact_acquisition_snapshot_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.acquisition_data IS DISTINCT FROM NEW.data OR NEW.data->>'state' IS DISTINCT FROM 'active'
     OR NEW.data->>'revision' IS DISTINCT FROM '0' OR NEW.data->'currentAmount' IS DISTINCT FROM NEW.data->'deposit'
     OR NEW.data->>'cumulativeFeesMicroUsd' IS DISTINCT FROM '0' OR NEW.data->>'cumulativeCostsMicroUsd' IS DISTINCT FROM '0'
     OR NEW.data->'realizedMicroUsd' IS DISTINCT FROM 'null'::jsonb OR NEW.data->'lastReceiptKey' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'LP acquisition retry snapshot must equal initial committed position';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_lp_exact_acquisition_snapshot BEFORE INSERT ON lp_exact_positions
  FOR EACH ROW EXECUTE FUNCTION lp_exact_acquisition_snapshot_guard();
CREATE TABLE lp_exact_operations (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  position_id UUID NOT NULL,
  operation_key TEXT NOT NULL CHECK(operation_key ~ '^[A-Za-z0-9_-]{1,128}$'),
  receipt_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','completed')),
  data JSONB NOT NULL CHECK(data ?& ARRAY['id','userId','positionId','operationKey','receiptKey','status','action','positionRevision',
    'amountBefore','quote','plan','fingerprint','receipt']),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  completed_at TIMESTAMPTZ,
  FOREIGN KEY(position_id,user_id) REFERENCES lp_exact_positions(position_id,user_id) ON DELETE RESTRICT,
  UNIQUE(id,user_id,position_id), UNIQUE(user_id,operation_key), UNIQUE(user_id,receipt_key),
  CHECK((status='completed')=(completed_at IS NOT NULL)),
  CHECK(data->>'id'=id::text AND data->>'userId'=user_id::text AND data->>'positionId'=position_id::text
    AND data->>'operationKey'=operation_key AND data->>'receiptKey'=receipt_key AND data->>'status'=status),
  CHECK(data->>'action' IN ('rebalance','close')),
  CHECK(data->>'positionRevision' ~ '^(0|[1-9][0-9]{0,77})$'),
  CHECK(data->'quote'->>'mode'='paper' AND data->'quote'->>'userId'=user_id::text),
  CHECK(status<>'completed' OR data->'receipt'->>'receiptKey'=receipt_key)
);
CREATE UNIQUE INDEX uq_lp_exact_pending_position ON lp_exact_operations(position_id) WHERE status='pending';
CREATE INDEX idx_lp_exact_pending_recovery ON lp_exact_operations(user_id,created_at,id) WHERE status='pending';
CREATE TABLE lp_exact_receipts (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation_id UUID NOT NULL,
  position_id UUID NOT NULL,
  receipt_key TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  receipt_hash TEXT NOT NULL CHECK(receipt_hash ~ '^[0-9a-f]{64}$'),
  data JSONB NOT NULL CHECK(data ?& ARRAY['version','providerId','receiptId','receiptKey','userId','positionId','positionRevision','mode','action',
    'networkId','chain','protocol','poolAddress','depositAsset','quoteId','quoteHash','amountBefore','amountAfter','proceedsMicroUsd',
    'collectedFeesMicroUsd','executionCostsMicroUsd','settledAt','finality']),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY(user_id,receipt_key), UNIQUE(provider_id,receipt_id), UNIQUE(operation_id),
  FOREIGN KEY(operation_id,user_id,position_id) REFERENCES lp_exact_operations(id,user_id,position_id) ON DELETE RESTRICT,
  CHECK(data->>'userId'=user_id::text AND data->>'positionId'=position_id::text AND data->>'receiptKey'=receipt_key
    AND data->>'providerId'=provider_id AND data->>'receiptId'=receipt_id AND data->>'mode'='paper'
    AND data->>'finality'='paper-settled')
);
CREATE FUNCTION lp_exact_immutable_receipt() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'LP exact receipts are append only'; END $$;
CREATE TRIGGER trg_lp_exact_receipt_immutable BEFORE UPDATE OR DELETE ON lp_exact_receipts
  FOR EACH ROW EXECUTE FUNCTION lp_exact_immutable_receipt();
CREATE FUNCTION lp_exact_operation_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'LP operation intent is immutable'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'pending' OR NEW.completed_at IS NOT NULL
       OR NEW.data->'receipt' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'LP operation admission requires pending state without receipt';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id OR NEW.position_id<>OLD.position_id OR NEW.operation_key<>OLD.operation_key
     OR NEW.receipt_key<>OLD.receipt_key OR NEW.created_at<>OLD.created_at
     OR (NEW.data-'status'-'receipt') IS DISTINCT FROM (OLD.data-'status'-'receipt') THEN
    RAISE EXCEPTION 'LP operation identity, quote and plan are immutable';
  END IF;
  IF OLD.status='completed' OR NEW.status<>'completed' OR NOT EXISTS(
    SELECT 1 FROM lp_exact_receipts r WHERE r.operation_id=NEW.id AND r.user_id=NEW.user_id
      AND r.receipt_key=NEW.receipt_key AND r.data=NEW.data->'receipt') THEN
    RAISE EXCEPTION 'LP completion requires immutable durable receipt';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_lp_exact_operation_guard BEFORE INSERT OR UPDATE OR DELETE ON lp_exact_operations
  FOR EACH ROW EXECUTE FUNCTION lp_exact_operation_guard();
CREATE FUNCTION lp_exact_position_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE op lp_exact_operations%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'LP exact acquisition immutable'; END IF;
  IF NEW.acquisition_data IS DISTINCT FROM OLD.acquisition_data OR ROW(NEW.position_id,NEW.user_id,NEW.acquisition_key,NEW.subscription_id,NEW.master_event_id)
      IS DISTINCT FROM ROW(OLD.position_id,OLD.user_id,OLD.acquisition_key,OLD.subscription_id,OLD.master_event_id)
     OR (NEW.data-'currentAmount'-'plan'-'revision'-'state'-'autoRebalance'-'cumulativeFeesMicroUsd'-'cumulativeCostsMicroUsd'-'realizedMicroUsd'-'lastReceiptKey')
        IS DISTINCT FROM (OLD.data-'currentAmount'-'plan'-'revision'-'state'-'autoRebalance'-'cumulativeFeesMicroUsd'-'cumulativeCostsMicroUsd'-'realizedMicroUsd'-'lastReceiptKey') THEN
    RAISE EXCEPTION 'LP exact acquisition evidence immutable';
  END IF;
  SELECT * INTO op FROM lp_exact_operations WHERE user_id=NEW.user_id AND position_id=NEW.position_id
    AND receipt_key=NEW.data->>'lastReceiptKey' AND status='completed';
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM lp_exact_receipts r
       WHERE r.operation_id=op.id AND r.user_id=op.user_id AND r.position_id=op.position_id
         AND r.receipt_key=op.receipt_key AND r.data=op.data->'receipt')
     OR op.data->>'positionRevision' <> OLD.data->>'revision'
     OR (NEW.data->>'revision')::numeric <> (OLD.data->>'revision')::numeric+1
     OR op.data->'amountBefore' IS DISTINCT FROM OLD.data->'currentAmount'
     OR NEW.data->'currentAmount' IS DISTINCT FROM op.data->'receipt'->'amountAfter'
     OR NEW.data->'currentAmount'->>'scale' <> OLD.data->'deposit'->>'scale'
     OR (NEW.data->>'cumulativeFeesMicroUsd')::numeric <> (OLD.data->>'cumulativeFeesMicroUsd')::numeric+(op.data->'receipt'->>'collectedFeesMicroUsd')::numeric
     OR (NEW.data->>'cumulativeCostsMicroUsd')::numeric <> (OLD.data->>'cumulativeCostsMicroUsd')::numeric+(op.data->'receipt'->>'executionCostsMicroUsd')::numeric
     OR (op.data->>'action'='close' AND (NEW.data->>'state'<>'closed' OR NEW.data->'currentAmount'->>'raw'<>'0'
       OR NEW.data->'plan' IS DISTINCT FROM OLD.data->'plan'
       OR (NEW.data->>'realizedMicroUsd')::numeric IS DISTINCT FROM
         (op.data->'receipt'->>'proceedsMicroUsd')::numeric+(NEW.data->>'cumulativeFeesMicroUsd')::numeric
           -(NEW.data->>'cumulativeCostsMicroUsd')::numeric-(NEW.data->>'depositMicroUsd')::numeric))
     OR (op.data->>'action'='rebalance' AND (NEW.data->>'state'<>'active' OR NEW.data->'plan' IS DISTINCT FROM op.data->'plan'
       OR NEW.data->>'realizedMicroUsd' IS NOT NULL)) THEN
    RAISE EXCEPTION 'LP position update requires completed revision-bound receipt';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_lp_exact_position_guard BEFORE UPDATE OR DELETE ON lp_exact_positions
  FOR EACH ROW EXECUTE FUNCTION lp_exact_position_guard();
-- Prevent old receiptless financial UPDATE paths from bypassing the exact domain.
CREATE FUNCTION lp_exact_legacy_financial_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.acquisition_provenance='exact-injected-paper-v2' AND OLD.state='closed' AND NEW.state<>'closed' THEN
    RAISE EXCEPTION 'LP exact closed inventory cannot be reopened by legacy state';
  END IF;
  IF OLD.acquisition_provenance='exact-injected-paper-v2' AND
     (NEW.state='closed' AND OLD.state<>'closed' OR NEW.paper_plan IS DISTINCT FROM OLD.paper_plan
       OR ROW(NEW.range_lower,NEW.range_upper,NEW.strategy_type) IS DISTINCT FROM ROW(OLD.range_lower,OLD.range_upper,OLD.strategy_type)) THEN
    IF NOT EXISTS(SELECT 1 FROM lp_exact_positions e JOIN lp_exact_operations o
      ON o.position_id=e.position_id AND o.user_id=e.user_id AND o.receipt_key=e.data->>'lastReceiptKey'
      WHERE e.position_id=NEW.id AND e.user_id=NEW.user_id AND o.status='completed'
        AND e.data->>'state'=NEW.state AND e.data->'plan'=NEW.paper_plan
        AND (e.data->'plan'->'strategy'->>'rangeLower')::numeric=NEW.range_lower
        AND (e.data->'plan'->'strategy'->>'rangeUpper')::numeric=NEW.range_upper
        AND e.data->'plan'->'strategy'->>'distribution'=NEW.strategy_type) THEN
      RAISE EXCEPTION 'LP financial mutation requires exact completed receipt';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_lp_exact_legacy_guard BEFORE UPDATE ON lp_positions FOR EACH ROW EXECUTE FUNCTION lp_exact_legacy_financial_guard();

ALTER TABLE lp_exact_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE lp_exact_positions FORCE ROW LEVEL SECURITY;
ALTER TABLE lp_exact_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE lp_exact_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE lp_exact_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE lp_exact_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY lp_exact_position_tenant ON lp_exact_positions TO swat_app
 USING(user_id=public.current_app_user_id()) WITH CHECK(user_id=public.current_app_user_id());
CREATE POLICY lp_exact_operation_tenant ON lp_exact_operations TO swat_app
 USING(user_id=public.current_app_user_id()) WITH CHECK(user_id=public.current_app_user_id());
CREATE POLICY lp_exact_receipt_tenant ON lp_exact_receipts TO swat_app
 USING(user_id=public.current_app_user_id()) WITH CHECK(user_id=public.current_app_user_id());
REVOKE ALL ON lp_exact_positions,lp_exact_operations,lp_exact_receipts FROM PUBLIC;
-- Explicit local-paper privileges only; no provider authority, secret or signing permission.
GRANT SELECT,INSERT,UPDATE ON lp_exact_positions,lp_exact_operations TO swat_app;
GRANT SELECT,INSERT ON lp_exact_receipts TO swat_app;
-- FORCE RLS/base LP policies and role provisioning must be independently qualified before real runtime use.
-- Tenant policy is explicit for preexisting LP financial tables too; no unscoped or wildcard operator grants.
ALTER TABLE lp_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE lp_positions FORCE ROW LEVEL SECURITY;
ALTER TABLE lp_guardrail_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE lp_guardrail_configs FORCE ROW LEVEL SECURITY;
ALTER TABLE lp_copy_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE lp_copy_subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE lp_copy_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE lp_copy_executions FORCE ROW LEVEL SECURITY;
ALTER TABLE lp_paper_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE lp_paper_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE lp_position_state_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE lp_position_state_history FORCE ROW LEVEL SECURITY;
CREATE POLICY lp_position_tenant_083 ON lp_positions TO swat_app
 USING(user_id=public.current_app_user_id()) WITH CHECK(user_id=public.current_app_user_id());
CREATE POLICY lp_guardrail_tenant_083 ON lp_guardrail_configs TO swat_app
 USING(user_id=public.current_app_user_id()) WITH CHECK(user_id=public.current_app_user_id());
CREATE POLICY lp_subscription_tenant_083 ON lp_copy_subscriptions TO swat_app
 USING(user_id=public.current_app_user_id()) WITH CHECK(user_id=public.current_app_user_id());
CREATE POLICY lp_copy_execution_tenant_083 ON lp_copy_executions TO swat_app
 USING(user_id=public.current_app_user_id()) WITH CHECK(user_id=public.current_app_user_id());
CREATE POLICY lp_legacy_operation_tenant_083 ON lp_paper_operations TO swat_app
 USING(user_id=public.current_app_user_id()) WITH CHECK(user_id=public.current_app_user_id());
CREATE POLICY lp_history_tenant_083 ON lp_position_state_history TO swat_app
 USING(EXISTS(SELECT 1 FROM lp_positions p WHERE p.id=position_id AND p.user_id=public.current_app_user_id()))
 WITH CHECK(EXISTS(SELECT 1 FROM lp_positions p WHERE p.id=position_id AND p.user_id=public.current_app_user_id()));
