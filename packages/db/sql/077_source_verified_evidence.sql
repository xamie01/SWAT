-- Proposed forward migration 077; SOURCE ONLY, not applied/privilege acceptance.
-- No provider row, registration function, runtime grant, credential or fallback.
CREATE TABLE public.source_provider_authorities (
  authority_id text PRIMARY KEY,
  provider_id text NOT NULL,
  chain text NOT NULL CHECK (chain IN ('solana', 'polygon', 'robinhood-chain')),
  network text NOT NULL,
  verifier_version text NOT NULL,
  identity_digest text NOT NULL CHECK (identity_digest ~ '^[0-9a-f]{64}$'),
  valid_until timestamptz NOT NULL,
  enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE public.source_verification_bindings (
  source_trade_id uuid PRIMARY KEY REFERENCES public.source_trades(id) ON DELETE RESTRICT,
  binding jsonb NOT NULL,
  binding_digest text NOT NULL CHECK (binding_digest ~ '^[0-9a-f]{64}$'),
  network text NOT NULL,
  raw_quantity text NOT NULL CHECK (raw_quantity ~ '^[1-9][0-9]{0,77}$'),
  quantity_scale smallint NOT NULL CHECK (quantity_scale BETWEEN 0 AND 255),
  CHECK (jsonb_typeof(binding) = 'object'
    AND jsonb_typeof(binding->'network') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof(binding->'rawQuantity') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof(binding->'quantityScale') IS NOT DISTINCT FROM 'number'
    AND (binding->>'network') IS NOT DISTINCT FROM network
    AND (binding->>'rawQuantity') IS NOT DISTINCT FROM raw_quantity
    AND (binding->>'quantityScale')::smallint IS NOT DISTINCT FROM quantity_scale)
);
CREATE TABLE public.source_verified_evidence (
  evidence_id text PRIMARY KEY,
  source_trade_id uuid NOT NULL REFERENCES public.source_verification_bindings(source_trade_id) ON DELETE RESTRICT,
  binding_digest text NOT NULL CHECK (binding_digest ~ '^[0-9a-f]{64}$'),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  provider_id text NOT NULL,
  authority_id text NOT NULL REFERENCES public.source_provider_authorities(authority_id) ON DELETE RESTRICT,
  provider_identity_digest text NOT NULL CHECK (provider_identity_digest ~ '^[0-9a-f]{64}$'),
  provider_valid_until timestamptz NOT NULL,
  verifier_version text NOT NULL,
  finality text NOT NULL CHECK (finality IN ('confirmed', 'finalized', 'reversed')),
  revision numeric(78,0) NOT NULL CHECK (revision >= 0),
  reverses_evidence_id text REFERENCES public.source_verified_evidence(evidence_id) ON DELETE RESTRICT,
  evidence jsonb NOT NULL,
  CHECK ((finality = 'reversed') = (reverses_evidence_id IS NOT NULL)),
  UNIQUE (source_trade_id, authority_id, revision)
);
CREATE TABLE public.source_verification_heads (
  source_trade_id uuid PRIMARY KEY REFERENCES public.source_verification_bindings(source_trade_id) ON DELETE RESTRICT,
  evidence_id text NOT NULL UNIQUE REFERENCES public.source_verified_evidence(evidence_id) ON DELETE RESTRICT,
  revision numeric(78,0) NOT NULL,
  confirmation_state text NOT NULL CHECK (confirmation_state IN ('confirmed', 'finalized', 'reversed'))
);
CREATE TABLE public.source_verification_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_trade_id uuid NOT NULL REFERENCES public.source_trades(id) ON DELETE RESTRICT,
  evidence_id text NOT NULL UNIQUE REFERENCES public.source_verified_evidence(evidence_id) ON DELETE RESTRICT,
  from_state text NOT NULL CHECK (from_state IN ('observed', 'confirmed', 'finalized')),
  to_state text NOT NULL CHECK (to_state IN ('confirmed', 'finalized', 'reversed')),
  applied boolean NOT NULL,
  recorded_at timestamptz NOT NULL,
  CHECK (applied = (to_state <> 'reversed'))
);
CREATE TABLE public.source_verified_position_scopes (
  wallet_address varchar(128) NOT NULL,
  chain varchar(64) NOT NULL,
  token_mint varchar(128) NOT NULL,
  network text NOT NULL,
  quantity_scale smallint NOT NULL CHECK (quantity_scale BETWEEN 0 AND 255),
  unvalued_acquisition_count bigint NOT NULL DEFAULT 0 CHECK (unvalued_acquisition_count >= 0),
  PRIMARY KEY (wallet_address, chain, token_mint)
);
CREATE TABLE public.source_position_economic_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_trade_id uuid NOT NULL REFERENCES public.source_trades(id) ON DELETE RESTRICT,
  evidence_id text NOT NULL UNIQUE REFERENCES public.source_verified_evidence(evidence_id) ON DELETE RESTRICT,
  snapshot jsonb NOT NULL,
  recorded_at timestamptz NOT NULL
);
CREATE FUNCTION public.reject_verified_source_history_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$ BEGIN RAISE EXCEPTION 'verified source binding/evidence/history is immutable'; END $$;
CREATE TRIGGER immutable_source_binding BEFORE UPDATE OR DELETE ON public.source_verification_bindings
  FOR EACH ROW EXECUTE FUNCTION public.reject_verified_source_history_mutation();
CREATE TRIGGER immutable_source_evidence BEFORE UPDATE OR DELETE ON public.source_verified_evidence
  FOR EACH ROW EXECUTE FUNCTION public.reject_verified_source_history_mutation();
CREATE TRIGGER immutable_source_history BEFORE UPDATE OR DELETE ON public.source_verification_history
  FOR EACH ROW EXECUTE FUNCTION public.reject_verified_source_history_mutation();
CREATE TRIGGER immutable_source_economics BEFORE UPDATE OR DELETE ON public.source_position_economic_history
  FOR EACH ROW EXECUTE FUNCTION public.reject_verified_source_history_mutation();
CREATE FUNCTION public.check_verified_source_binding() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE source public.source_trades%ROWTYPE;
BEGIN
  SELECT * INTO STRICT source FROM public.source_trades WHERE id = NEW.source_trade_id FOR SHARE;
  IF NEW.binding->>'chain' IS DISTINCT FROM source.chain
    OR NEW.binding->>'sourceEventType' IS DISTINCT FROM source.source_event_type
    OR NEW.binding->>'sourceEventId' IS DISTINCT FROM source.source_event_id
    OR NEW.binding->>'sourceEventIndex' IS DISTINCT FROM source.source_event_index
    OR NEW.binding->>'transactionHash' IS DISTINCT FROM source.transaction_hash
    OR NEW.binding->>'walletAddress' IS DISTINCT FROM source.wallet_address
    OR NEW.binding->>'tokenMint' IS DISTINCT FROM source.token_mint
    OR NEW.binding->>'side' IS DISTINCT FROM source.direction
    OR (NEW.binding->>'eventAt')::timestamptz IS DISTINCT FROM source.event_at
    OR NEW.raw_quantity::numeric / power(10::numeric, NEW.quantity_scale) IS DISTINCT FROM source.token_amount
    OR (NEW.binding->>'amountUsd')::numeric IS DISTINCT FROM source.amount_usd
    OR (NEW.binding->>'priceUsd')::numeric IS DISTINCT FROM source.price_usd
    OR (NEW.binding->>'feeUsd')::numeric IS DISTINCT FROM source.fee_usd
    OR source.confirmation_state <> 'observed'
    OR jsonb_typeof(NEW.binding) IS DISTINCT FROM 'object'
    OR NOT NEW.binding ?& ARRAY['chain','network','sourceEventType','sourceEventId','sourceEventIndex',
      'transactionHash','walletAddress','tokenMint','side','rawQuantity','quantityScale','eventAt','amountUsd','priceUsd','feeUsd']
  THEN RAISE EXCEPTION 'source verification binding does not match immutable observation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_source_binding BEFORE INSERT ON public.source_verification_bindings
  FOR EACH ROW EXECUTE FUNCTION public.check_verified_source_binding();
CREATE FUNCTION public.check_verified_source_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE authority public.source_provider_authorities%ROWTYPE;
  binding public.source_verification_bindings%ROWTYPE;
  previous public.source_verified_evidence%ROWTYPE;
BEGIN
  SELECT * INTO STRICT authority FROM public.source_provider_authorities WHERE authority_id = NEW.authority_id FOR SHARE;
  SELECT * INTO STRICT binding FROM public.source_verification_bindings WHERE source_trade_id = NEW.source_trade_id FOR SHARE;
  IF NOT authority.enabled OR authority.valid_until <= statement_timestamp()
    OR NEW.provider_valid_until <= statement_timestamp() OR NEW.provider_valid_until > authority.valid_until
    OR NEW.provider_id <> authority.provider_id OR NEW.provider_identity_digest <> authority.identity_digest
    OR NEW.verifier_version <> authority.verifier_version OR authority.chain IS DISTINCT FROM binding.binding->>'chain'
    OR authority.network <> binding.network OR NEW.binding_digest <> binding.binding_digest
    OR jsonb_typeof(NEW.evidence) IS DISTINCT FROM 'object'
    OR NOT NEW.evidence ?& ARRAY['evidenceId','binding','finality','blockHash','blockHeight','revision',
      'reversesEvidenceId','observedAt','provenance','content','contentDigest']
    OR NEW.evidence->>'evidenceId' IS DISTINCT FROM NEW.evidence_id
    OR NEW.evidence->'binding' IS DISTINCT FROM binding.binding
    OR NEW.evidence->>'finality' IS DISTINCT FROM NEW.finality
    OR NEW.evidence->>'revision' IS DISTINCT FROM NEW.revision::text
    OR NEW.evidence->>'reversesEvidenceId' IS DISTINCT FROM NEW.reverses_evidence_id
    OR NEW.evidence->'provenance'->>'providerId' IS DISTINCT FROM NEW.provider_id
    OR NEW.evidence->'provenance'->>'authorityId' IS DISTINCT FROM NEW.authority_id
    OR NEW.evidence->'provenance'->>'verifierVersion' IS DISTINCT FROM NEW.verifier_version
    OR binding.binding->>'sourceEventIndex' LIKE 'ambiguous-data-api-wallet-v1:%'
  THEN RAISE EXCEPTION 'verified source evidence authority/binding mismatch'; END IF;
  IF NEW.reverses_evidence_id IS NOT NULL THEN
    SELECT * INTO STRICT previous FROM public.source_verified_evidence WHERE evidence_id = NEW.reverses_evidence_id FOR SHARE;
    IF previous.source_trade_id <> NEW.source_trade_id OR previous.authority_id <> NEW.authority_id
      OR previous.finality NOT IN ('confirmed','finalized') OR previous.revision >= NEW.revision THEN
      RAISE EXCEPTION 'source reversal reference mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_source_evidence BEFORE INSERT ON public.source_verified_evidence
  FOR EACH ROW EXECUTE FUNCTION public.check_verified_source_evidence();
CREATE FUNCTION public.protect_source_provider_identity() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'source provider authority is retained for history'; END IF;
  IF NEW.authority_id <> OLD.authority_id OR NEW.provider_id <> OLD.provider_id OR NEW.chain <> OLD.chain
    OR NEW.network <> OLD.network OR NEW.verifier_version <> OLD.verifier_version OR NEW.identity_digest <> OLD.identity_digest
    OR NEW.valid_until <> OLD.valid_until OR (NOT OLD.enabled AND NEW.enabled) THEN
    RAISE EXCEPTION 'source authority identity is immutable; only one-way revocation permitted'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_source_provider_identity BEFORE UPDATE OR DELETE ON public.source_provider_authorities
  FOR EACH ROW EXECUTE FUNCTION public.protect_source_provider_identity();
CREATE FUNCTION public.check_verified_source_head() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE evidence public.source_verified_evidence%ROWTYPE;
BEGIN
  SELECT * INTO STRICT evidence FROM public.source_verified_evidence WHERE evidence_id = NEW.evidence_id FOR SHARE;
  IF evidence.source_trade_id <> NEW.source_trade_id OR evidence.revision <> NEW.revision
    OR evidence.finality <> NEW.confirmation_state THEN RAISE EXCEPTION 'source verified head evidence mismatch'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.source_provider_authorities authority
    JOIN public.source_verification_bindings binding ON binding.source_trade_id = NEW.source_trade_id
    WHERE authority.authority_id = evidence.authority_id AND authority.enabled
      AND authority.identity_digest = evidence.provider_identity_digest AND authority.network = binding.network
      AND authority.valid_until > statement_timestamp() AND evidence.provider_valid_until > statement_timestamp()) THEN
    RAISE EXCEPTION 'source head provider authority unavailable'; END IF;
  IF TG_OP = 'INSERT' AND (evidence.finality = 'reversed' OR NOT EXISTS (
    SELECT 1 FROM public.source_trades source WHERE source.id = NEW.source_trade_id
      AND source.confirmation_state = evidence.finality)) THEN RAISE EXCEPTION 'initial source head state mismatch'; END IF;
  IF TG_OP = 'UPDATE' AND (evidence.authority_id IS DISTINCT FROM (
    SELECT previous.authority_id FROM public.source_verified_evidence previous WHERE previous.evidence_id = OLD.evidence_id)
    OR (NEW.confirmation_state = 'reversed' AND evidence.reverses_evidence_id IS DISTINCT FROM OLD.evidence_id)) THEN
    RAISE EXCEPTION 'source head reversal/authority mismatch'; END IF;
  IF TG_OP = 'UPDATE' AND (OLD.source_trade_id <> NEW.source_trade_id OR OLD.confirmation_state = 'reversed'
    OR NEW.revision <= OLD.revision OR NOT ((OLD.confirmation_state = 'confirmed' AND NEW.confirmation_state IN ('finalized', 'reversed'))
       OR (OLD.confirmation_state = 'finalized' AND NEW.confirmation_state = 'reversed'))) THEN
    RAISE EXCEPTION 'source verified head transition rejected'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_source_head BEFORE INSERT OR UPDATE ON public.source_verification_heads
  FOR EACH ROW EXECUTE FUNCTION public.check_verified_source_head();
REVOKE ALL ON public.source_provider_authorities, public.source_verification_bindings,
  public.source_verified_evidence, public.source_verification_heads, public.source_verification_history,
  public.source_verified_position_scopes, public.source_position_economic_history FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_verified_source_history_mutation(), public.check_verified_source_binding(),
  public.check_verified_source_evidence(), public.protect_source_provider_identity(), public.check_verified_source_head() FROM PUBLIC;
-- Deliberately no role grants here. Restricted trusted verifier writer/operator
-- provisioning and authenticated provider enrollment require separate approval.
