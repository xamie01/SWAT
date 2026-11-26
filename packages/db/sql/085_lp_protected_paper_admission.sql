-- Wave4 SOURCE-ONLY085 proposal. Not applied; 084 remains deliberately refused.
-- Two-phase external provisioning: default NOLOGIN, externally authorized ephemeral LOGIN for direct sessions.
-- Both phases require isolated restricted nonowning flags; this migration never changes login or credentials.
-- No roles, memberships, ownership changes, bypass policies, credentials or backfill.
DO $$
DECLARE admitter oid;
BEGIN
  IF current_user <> 'swat_migrator' OR session_user <> 'swat_migrator'
     OR current_setting('row_security') <> 'on' THEN
    RAISE EXCEPTION '085 requires direct canonical migrator with row_security on';
  END IF;
  SELECT oid INTO admitter FROM pg_catalog.pg_roles WHERE rolname='swat_lp_admitter'
    AND NOT(rolsuper OR rolbypassrls OR rolinherit OR rolcreaterole OR rolcreatedb OR rolreplication);
  IF admitter IS NULL OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=admitter OR roleid=admitter)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relowner=admitter)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE proowner=admitter)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=admitter)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datdba=admitter)
    OR pg_catalog.has_schema_privilege('swat_lp_admitter','public','CREATE')
    OR pg_catalog.has_database_privilege('swat_lp_admitter',current_database(),'CREATE') THEN
    RAISE EXCEPTION 'externally provisioned isolated nonowning LP admitter required';
  END IF;
END $$;

CREATE TABLE public.lp_protected_quote_admissions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  context_key text NOT NULL CHECK(context_key ~ '^(acquisition|operation):[A-Za-z0-9_-]{1,128}$'),
  intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
  input jsonb NOT NULL, quote jsonb NOT NULL, context jsonb NOT NULL,
  -- This is an independent writer's canonical commitment, NEVER a runtime candidate's authority.
  quote_hash text NOT NULL CHECK(quote_hash ~ '^[a-f0-9]{64}$'),
  -- Writer's exact canonical bytes allow digest checks without PostgreSQL/JS numeric serialization drift.
  quote_canonical text NOT NULL,
  CHECK((quote_canonical::jsonb IS NOT DISTINCT FROM quote) AND
    quote_hash=encode(sha256(convert_to(quote_canonical,'UTF8')),'hex')),
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,id), UNIQUE(user_id,context_key)
);
CREATE UNIQUE INDEX lp_protected_quote_provider_identity ON public.lp_protected_quote_admissions
  (user_id,context_key,(quote->>'providerId'),(quote->>'quoteId'));
CREATE TABLE public.lp_protected_settlement_admissions (
  id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  quote_admission_id uuid NOT NULL, operation_id uuid NOT NULL, position_id uuid NOT NULL,
  position_revision text NOT NULL CHECK(position_revision ~ '^(0|[1-9][0-9]{0,77})$'),
  receipt jsonb NOT NULL, context jsonb NOT NULL,
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,id), UNIQUE(user_id,operation_id),
  FOREIGN KEY(user_id) REFERENCES public.users(id) ON DELETE RESTRICT,
  FOREIGN KEY(user_id,quote_admission_id) REFERENCES public.lp_protected_quote_admissions(user_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(operation_id,user_id,position_id) REFERENCES public.lp_exact_operations(id,user_id,position_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX lp_protected_settlement_provider_identity ON public.lp_protected_settlement_admissions
  (user_id,(receipt->>'providerId'),(receipt->>'receiptId'));
CREATE UNIQUE INDEX lp_protected_settlement_receipt_identity ON public.lp_protected_settlement_admissions
  (user_id,(receipt->>'receiptKey'));

-- Strict validators return true or throw. SQL NULL is never silently accepted by a CHECK/IF.
CREATE FUNCTION public.lp085_fields(j jsonb, keys text[]) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF jsonb_typeof(j) IS DISTINCT FROM 'object' OR (j ?& keys) IS DISTINCT FROM true
    OR EXISTS(SELECT 1 FROM unnest(keys) k WHERE j->k IS NULL OR j->k='null'::jsonb) THEN
    RAISE EXCEPTION 'LP protected complete nonnull JSON fields required';
  END IF;
  RETURN true;
END $$;
CREATE FUNCTION public.lp085_texts(j jsonb, keys text[]) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM public.lp085_fields(j,keys);
  IF EXISTS(SELECT 1 FROM unnest(keys) k WHERE jsonb_typeof(j->k) IS DISTINCT FROM 'string'
    OR length(btrim(j->>k)) NOT BETWEEN 1 AND 256) THEN
    RAISE EXCEPTION 'LP protected canonical text identities required';
  END IF;
  RETURN true;
END $$;
CREATE FUNCTION public.lp085_micro(j jsonb, signed boolean DEFAULT false) RETURNS numeric
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF jsonb_typeof(j) IS DISTINCT FROM 'string' OR
    (j #>> '{}') !~ (CASE WHEN signed THEN '^(0|-?[1-9][0-9]{0,77})$' ELSE '^(0|[1-9][0-9]{0,77})$' END) THEN
    RAISE EXCEPTION 'LP protected canonical exact microdollars required';
  END IF;
  RETURN (j #>> '{}')::numeric;
END $$;
CREATE FUNCTION public.lp085_amount(j jsonb, positive boolean DEFAULT false) RETURNS numeric
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE n numeric;
BEGIN
  PERFORM public.lp085_fields(j,ARRAY['raw','scale']);
  n:=public.lp085_micro(j->'raw');
  IF jsonb_typeof(j->'scale') IS DISTINCT FROM 'number' OR (j->>'scale') !~ '^(0|[1-9][0-9]?)$'
    OR (j->>'scale')::integer NOT BETWEEN 0 AND 30 OR (positive AND n<=0) THEN
    RAISE EXCEPTION 'LP protected rawscale required';
  END IF;
  RETURN n;
END $$;
CREATE FUNCTION public.lp085_time(j jsonb) RETURNS timestamptz
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE t timestamptz;
BEGIN
  IF jsonb_typeof(j) IS DISTINCT FROM 'string' OR (j #>> '{}') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' THEN
    RAISE EXCEPTION 'LP protected UTC chronology required';
  END IF;
  t:=(j #>> '{}')::timestamptz;
  IF to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM (j #>> '{}') THEN
    RAISE EXCEPTION 'LP protected invalid UTC chronology';
  END IF;
  RETURN t;
END $$;
CREATE FUNCTION public.lp085_quote_valid(i jsonb,q jsonb,at_time timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE p jsonb:=q->'pool'; e jsonb:=q->'economics'; value numeric; net numeric; observed timestamptz; expires timestamptz;
BEGIN
  IF at_time IS NULL OR NOT isfinite(at_time) THEN RAISE EXCEPTION 'LP quote chronology parameter required'; END IF;
  PERFORM public.lp085_fields(i,ARRAY['userId','chain','poolAddress','depositAsset','deposit','action','intentHash']);
  IF (i ?& ARRAY['positionId','positionRevision']) IS DISTINCT FROM true THEN RAISE EXCEPTION 'LP position context missing'; END IF;
  PERFORM public.lp085_fields(q,ARRAY['version','providerId','quoteId','userId','intentHash','action','mode','pool','deposit','unitPriceUsd',
    'valueMicroUsd','amountAfter','proceedsMicroUsd','observedAt','expiresAt']);
  IF NOT(q ? 'economics') THEN RAISE EXCEPTION 'LP economics unknown must be explicit null'; END IF;
  PERFORM public.lp085_fields(p,ARRAY['chain','networkId','protocol','poolAddress','depositAsset','depositScale','evidenceId','observedAt','currentPrice']);
  PERFORM public.lp085_texts(i,ARRAY['userId','chain','poolAddress','depositAsset','action','intentHash']);
  PERFORM public.lp085_texts(q,ARRAY['providerId','quoteId','userId','intentHash','action','mode']);
  PERFORM public.lp085_texts(p,ARRAY['chain','networkId','protocol','poolAddress','depositAsset','evidenceId']);
  IF (p ?& ARRAY['binStep','tickSpacing']) IS DISTINCT FROM true THEN RAISE EXCEPTION 'LP protocol context missing'; END IF;
  observed:=public.lp085_time(q->'observedAt'); expires:=public.lp085_time(q->'expiresAt');
  IF q->'version' IS DISTINCT FROM '1'::jsonb OR q->>'mode' IS DISTINCT FROM 'paper'
    OR q->'userId' IS DISTINCT FROM i->'userId' OR q->'intentHash' IS DISTINCT FROM i->'intentHash'
    OR q->'action' IS DISTINCT FROM i->'action' OR q->'deposit' IS DISTINCT FROM i->'deposit'
    OR p->'chain' IS DISTINCT FROM i->'chain' OR p->'poolAddress' IS DISTINCT FROM i->'poolAddress'
    OR p->'depositAsset' IS DISTINCT FROM i->'depositAsset' OR p->'depositScale' IS DISTINCT FROM i->'deposit'->'scale'
    OR q->'amountAfter'->'scale' IS DISTINCT FROM i->'deposit'->'scale'
    OR observed>at_time OR observed<at_time-interval '60 seconds'
    OR public.lp085_time(p->'observedAt')>at_time OR public.lp085_time(p->'observedAt')<at_time-interval '60 seconds'
    OR expires<=at_time OR expires<=observed OR expires>observed+interval '60 seconds'
    OR jsonb_typeof(p->'currentPrice') IS DISTINCT FROM 'number' OR (p->>'currentPrice')::numeric<=0
    OR length(btrim(q->>'providerId')) NOT BETWEEN 1 AND 256 OR length(btrim(q->>'quoteId')) NOT BETWEEN 1 AND 128
    OR length(btrim(p->>'networkId')) NOT BETWEEN 1 AND 256 OR length(btrim(p->>'evidenceId')) NOT BETWEEN 1 AND 256
    OR left(i->>'poolAddress',length(i->>'chain')+1) IS DISTINCT FROM (i->>'chain')||':'
    OR left(i->>'depositAsset',length(i->>'chain')+1) IS DISTINCT FROM (i->>'chain')||':' THEN
    RAISE EXCEPTION 'LP protected quote provider/context/chronology mismatch';
  END IF;
  IF NOT((p->>'chain'='solana' AND p->>'protocol'='meteora-dlmm') OR
    (p->>'chain' IN('robinhood-chain','base','ethereum','bsc') AND p->>'protocol'='uniswap-v3') OR
    (p->>'chain'='bsc' AND p->>'protocol'='pancakeswap-v3')) THEN RAISE EXCEPTION 'LP protected protocol refused'; END IF;
  IF p->>'protocol'='meteora-dlmm' THEN
    IF p->'tickSpacing' IS DISTINCT FROM 'null'::jsonb OR jsonb_typeof(p->'binStep') IS DISTINCT FROM 'number'
      OR (p->>'binStep') !~ '^[1-9][0-9]*$' THEN RAISE EXCEPTION 'LP protected bin context required'; END IF;
  ELSE
    IF p->'binStep' IS DISTINCT FROM 'null'::jsonb OR jsonb_typeof(p->'tickSpacing') IS DISTINCT FROM 'number'
      OR (p->>'tickSpacing') !~ '^[1-9][0-9]*$' THEN RAISE EXCEPTION 'LP protected tick context required'; END IF;
  END IF;
  value:=div(public.lp085_amount(i->'deposit',true)*public.lp085_amount(q->'unitPriceUsd',true)*1000000,
    power(10::numeric,(i->'deposit'->>'scale')::integer+(q->'unitPriceUsd'->>'scale')::integer));
  IF value<=0 OR public.lp085_micro(q->'valueMicroUsd') IS DISTINCT FROM value THEN RAISE EXCEPTION 'LP protected exact valuation mismatch'; END IF;
  PERFORM public.lp085_amount(q->'amountAfter'); PERFORM public.lp085_micro(q->'proceedsMicroUsd');
  IF i->>'action'='acquire' THEN
    IF i->'positionId' IS DISTINCT FROM 'null'::jsonb OR i->'positionRevision' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'LP acquisition cannot bind an existing position'; END IF;
  ELSIF i->>'action' IN('rebalance','close') THEN
    PERFORM public.lp085_fields(i,ARRAY['positionId','positionRevision']); PERFORM public.lp085_micro(i->'positionRevision');
    PERFORM (i->>'positionId')::uuid;
  ELSE RAISE EXCEPTION 'LP protected action refused'; END IF;
  IF i->>'action'='close' THEN
    IF q->'amountAfter'->>'raw' IS DISTINCT FROM '0' THEN RAISE EXCEPTION 'LP close inventory must be zero'; END IF;
  ELSIF q->'amountAfter' IS DISTINCT FROM i->'deposit' OR q->>'proceedsMicroUsd' IS DISTINCT FROM '0' THEN
    RAISE EXCEPTION 'LP protected inventory substitution';
  END IF;
  IF e IS DISTINCT FROM 'null'::jsonb THEN
    PERFORM public.lp085_fields(e,ARRAY['basis','windowStart','windowEnd','extraFeesMicroUsd','inventoryChangeMicroUsd',
      'impermanentLossMicroUsd','gasMicroUsd','repositionMicroUsd']);
    IF e->>'basis' IS DISTINCT FROM 'incremental-rebalance' OR public.lp085_time(e->'windowStart')<observed
      OR public.lp085_time(e->'windowEnd')<=public.lp085_time(e->'windowStart')
      OR public.lp085_time(e->'windowEnd')>public.lp085_time(e->'windowStart')+interval '7 days' THEN
      RAISE EXCEPTION 'LP protected aligned economics required'; END IF;
    net:=public.lp085_micro(e->'extraFeesMicroUsd')+public.lp085_micro(e->'inventoryChangeMicroUsd',true)
      -public.lp085_micro(e->'impermanentLossMicroUsd')-public.lp085_micro(e->'gasMicroUsd')-public.lp085_micro(e->'repositionMicroUsd');
    PERFORM public.lp085_micro(to_jsonb(net::text),true);
    IF i->>'action'='rebalance' AND (net<=0 OR public.lp085_micro(e->'extraFeesMicroUsd')<=0) THEN
      RAISE EXCEPTION 'LP protected rebalance not positive'; END IF;
  ELSIF i->>'action'='rebalance' THEN RAISE EXCEPTION 'LP protected economics unassessed'; END IF;
  RETURN true;
END $$;

-- Canonical projection shared with lpProjectProtectedPosition. Financial fields remain exact JSON;
-- legacy state/auto_rebalance are current overlay fields, not evidence or backfilled admissions.
CREATE FUNCTION public.lp085_project_position(d jsonb, legacy_state text, consent boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR legacy_state IS NULL OR consent IS NULL
    OR legacy_state NOT IN('building','active','near_edge','out_of_range','rebalancing','closed')
    OR (d->>'state'='closed' AND legacy_state IS DISTINCT FROM 'closed') THEN
    RAISE EXCEPTION 'LP canonical projection cannot reopen closed exact inventory'; END IF;
  RETURN d||jsonb_build_object('state',legacy_state,'autoRebalance',consent);
END $$;
CREATE FUNCTION public.lp085_current_position(requested_tenant uuid, requested_position uuid) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT public.lp085_project_position(e.data,b.state,b.auto_rebalance)
  FROM public.lp_exact_positions e JOIN public.lp_positions b ON b.id=e.position_id AND b.user_id=e.user_id
  WHERE e.user_id=requested_tenant AND e.position_id=requested_position
$$;
-- Exact truncation mirrors the legacy compatibility DTO; financial allocations remain rawscale in plan.
CREATE FUNCTION public.lp085_legacy_rungs(plan jsonb, amount jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE rung jsonb; result jsonb:='[]'::jsonb; item jsonb; total numeric;
BEGIN
  total:=public.lp085_amount(amount,true);
  IF jsonb_typeof(plan->'rungs') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'LP legacy rungs require exact plan'; END IF;
  FOR rung IN SELECT value FROM jsonb_array_elements(plan->'rungs') LOOP
    item:=jsonb_build_object('priceLower',rung->'priceLower','priceUpper',rung->'priceUpper',
      'weight',div(public.lp085_amount(rung->'allocation',true)*1000000000000,total)/1000000000000);
    IF rung ? 'binLower' THEN item:=item||jsonb_build_object('binId',rung->'binLower'); END IF;
    IF rung ? 'tickLower' THEN item:=item||jsonb_build_object('tickLower',rung->'tickLower','tickUpper',rung->'tickUpper'); END IF;
    result:=result||jsonb_build_array(item);
  END LOOP;
  RETURN result;
END $$;

CREATE FUNCTION public.lp085_admission_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE q public.lp_protected_quote_admissions; o public.lp_exact_operations; p public.lp_exact_positions;
  r jsonb; c jsonb; now_time timestamptz;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'LP protected admissions are append only'; END IF;
  IF current_user<>'swat_lp_admitter' OR session_user<>'swat_lp_admitter'
    OR current_setting('row_security')<>'on' OR NEW.user_id IS DISTINCT FROM public.current_app_user_id()
    OR COALESCE(current_setting('app.bypass_rls',true),'off')<>'off'
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user
      AND NOT(rolsuper OR rolbypassrls OR rolinherit OR rolcreaterole OR rolcreatedb OR rolreplication))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles a
      ON a.oid=m.member OR a.oid=m.roleid WHERE a.rolname=current_user)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles a ON a.oid=c.relowner WHERE a.rolname=current_user)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc c JOIN pg_catalog.pg_roles a ON a.oid=c.proowner WHERE a.rolname=current_user)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace c JOIN pg_catalog.pg_roles a ON a.oid=c.nspowner WHERE a.rolname=current_user)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_database c JOIN pg_catalog.pg_roles a ON a.oid=c.datdba WHERE a.rolname=current_user)
    OR pg_catalog.has_schema_privilege(current_user,'public','CREATE')
    OR pg_catalog.has_database_privilege(current_user,current_database(),'CREATE') THEN
    RAISE EXCEPTION 'LP admission requires direct isolated restricted current/session admitter';
  END IF;
  now_time:=date_trunc('milliseconds',clock_timestamp()); NEW.admitted_at:=now_time;
  IF TG_TABLE_NAME='lp_protected_quote_admissions' THEN
    PERFORM public.lp085_fields(NEW.context,ARRAY['kind','commit']); c:=NEW.context->'commit';
    PERFORM public.lp085_fields(c,ARRAY['fingerprint','quote']);
    IF NEW.quote IS DISTINCT FROM c->'quote' OR NEW.intent_hash IS DISTINCT FROM c->>'fingerprint'
      OR NEW.context_key IS DISTINCT FROM (NEW.context->>'kind')||':'||(CASE WHEN NEW.context->>'kind'='acquisition'
        THEN c->'request'->>'operationKey' ELSE c->>'operationKey' END)
      OR NEW.input->>'userId' IS DISTINCT FROM NEW.user_id::text OR NEW.input->>'intentHash' IS DISTINCT FROM NEW.intent_hash THEN
      RAISE EXCEPTION 'LP admitted quote full context mismatch'; END IF;
    PERFORM public.lp085_quote_valid(NEW.input,NEW.quote,now_time);
    IF NEW.context->>'kind'='acquisition' THEN
      PERFORM public.lp085_fields(c,ARRAY['request','plan']);
      IF NOT(c ? 'origin') OR NEW.input->>'action' IS DISTINCT FROM 'acquire' OR
        NEW.input IS DISTINCT FROM jsonb_build_object('userId',NEW.user_id::text,'chain',c->'request'->'chain',
          'poolAddress',c->'request'->'poolAddress','depositAsset',c->'request'->'depositAsset','deposit',c->'request'->'deposit',
          'action','acquire','intentHash',NEW.intent_hash,'positionId',NULL,'positionRevision',NULL) THEN
        RAISE EXCEPTION 'LP admitted acquisition context required'; END IF;
    ELSIF NEW.context->>'kind'='operation' THEN
      PERFORM public.lp085_fields(c,ARRAY['position','operationKey','action','receiptKey']);
      IF NOT(c ? 'plan') THEN RAISE EXCEPTION 'LP operation plan context missing'; END IF;
      SELECT * INTO p FROM public.lp_exact_positions WHERE user_id=NEW.user_id AND position_id=(NEW.input->>'positionId')::uuid;
      IF p.position_id IS NULL OR c->'position' IS DISTINCT FROM public.lp085_current_position(p.user_id,p.position_id) OR public.lp085_current_position(p.user_id,p.position_id)->>'mode' IS DISTINCT FROM 'paper'
        OR (public.lp085_current_position(p.user_id,p.position_id)->>'state' IN('active','near_edge','out_of_range')) IS DISTINCT FROM true
        OR NEW.input IS DISTINCT FROM jsonb_build_object('userId',NEW.user_id::text,'chain',public.lp085_current_position(p.user_id,p.position_id)->'chain',
          'poolAddress',public.lp085_current_position(p.user_id,p.position_id)->'poolAddress','depositAsset',public.lp085_current_position(p.user_id,p.position_id)->'depositAsset','deposit',public.lp085_current_position(p.user_id,p.position_id)->'currentAmount',
          'action',c->'action','intentHash',NEW.intent_hash,'positionId',p.position_id::text,'positionRevision',public.lp085_current_position(p.user_id,p.position_id)->'revision')
        OR public.lp085_current_position(p.user_id,p.position_id)->'protocol' IS DISTINCT FROM NEW.quote->'pool'->'protocol'
        OR (c->>'action'='close' AND c->'plan' IS DISTINCT FROM 'null'::jsonb)
        OR (c->>'action'='rebalance' AND jsonb_typeof(c->'plan') IS DISTINCT FROM 'object') THEN
        RAISE EXCEPTION 'LP admitted current position/revision/inventory context required'; END IF;
    ELSE RAISE EXCEPTION 'LP admitted context kind refused'; END IF;
  ELSE
    SELECT * INTO q FROM public.lp_protected_quote_admissions WHERE user_id=NEW.user_id AND id=NEW.quote_admission_id;
    SELECT * INTO o FROM public.lp_exact_operations WHERE user_id=NEW.user_id AND id=NEW.operation_id AND position_id=NEW.position_id;
    SELECT * INTO p FROM public.lp_exact_positions WHERE user_id=NEW.user_id AND position_id=NEW.position_id;
    PERFORM public.lp085_fields(NEW.context,ARRAY['operation','position','operationCreatedAt']);
    IF q.id IS NULL OR o.id IS NULL OR p.position_id IS NULL OR o.status IS DISTINCT FROM 'pending'
      OR q.context_key IS DISTINCT FROM 'operation:'||o.operation_key OR q.intent_hash IS DISTINCT FROM o.data->>'fingerprint'
      OR NEW.context->'operation' IS DISTINCT FROM o.data OR NEW.context->'position' IS DISTINCT FROM public.lp085_current_position(p.user_id,p.position_id)
      OR public.lp085_time(NEW.context->'operationCreatedAt') IS DISTINCT FROM o.created_at
      OR NEW.position_revision IS DISTINCT FROM public.lp085_current_position(p.user_id,p.position_id)->>'revision' OR o.data->>'positionRevision' IS DISTINCT FROM NEW.position_revision
      OR o.data->'amountBefore' IS DISTINCT FROM public.lp085_current_position(p.user_id,p.position_id)->'currentAmount'
      OR (public.lp085_current_position(p.user_id,p.position_id)->>'state' IN('active','near_edge','out_of_range')) IS DISTINCT FROM true
      OR q.quote IS DISTINCT FROM o.data->'quote' OR q.context IS DISTINCT FROM jsonb_build_object('kind','operation','commit',
        jsonb_build_object('position',public.lp085_current_position(p.user_id,p.position_id),'operationKey',o.data->'operationKey','fingerprint',o.data->'fingerprint',
          'action',o.data->'action','quote',o.data->'quote','plan',o.data->'plan','receiptKey',o.data->'receiptKey'))
      OR o.created_at<q.admitted_at OR o.created_at>=public.lp085_time(q.quote->'expiresAt') THEN
      RAISE EXCEPTION 'LP independent settlement full canonical context/chronology mismatch'; END IF;
    PERFORM public.lp085_receipt_valid(NEW.receipt,q,o.data,public.lp085_current_position(p.user_id,p.position_id),o.created_at,now_time);
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.lp085_receipt_valid(r jsonb,q public.lp_protected_quote_admissions,o jsonb,p jsonb,created timestamptz,at_time timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF created IS NULL OR at_time IS NULL OR q.admitted_at IS NULL OR NOT isfinite(created)
    OR NOT isfinite(at_time) OR NOT isfinite(q.admitted_at) OR created<q.admitted_at
    OR created>=public.lp085_time(q.quote->'expiresAt') OR at_time<created THEN
    RAISE EXCEPTION 'LP receipt chronology parameters required'; END IF;
  PERFORM public.lp085_fields(r,ARRAY['version','providerId','receiptId','receiptKey','userId','positionId','positionRevision','mode','action',
    'networkId','chain','protocol','poolAddress','depositAsset','quoteId','quoteHash','amountBefore','amountAfter','proceedsMicroUsd',
    'collectedFeesMicroUsd','executionCostsMicroUsd','settledAt','finality']);
  PERFORM public.lp085_texts(r,ARRAY['providerId','receiptId','receiptKey','userId','positionId','positionRevision','mode','action',
    'networkId','chain','protocol','poolAddress','depositAsset','quoteId','quoteHash','finality']);
  IF r->'version' IS DISTINCT FROM '1'::jsonb OR r->>'mode' IS DISTINCT FROM 'paper' OR r->>'finality' IS DISTINCT FROM 'paper-settled'
    OR r->'providerId' IS DISTINCT FROM q.quote->'providerId' OR r->'quoteId' IS DISTINCT FROM q.quote->'quoteId'
    OR r->>'quoteHash' IS DISTINCT FROM q.quote_hash OR r->'receiptKey' IS DISTINCT FROM o->'receiptKey'
    OR r->'userId' IS DISTINCT FROM o->'userId' OR r->'positionId' IS DISTINCT FROM o->'positionId'
    OR r->'positionRevision' IS DISTINCT FROM o->'positionRevision' OR r->'action' IS DISTINCT FROM o->'action'
    OR r->'chain' IS DISTINCT FROM p->'chain' OR r->'protocol' IS DISTINCT FROM p->'protocol'
    OR r->'poolAddress' IS DISTINCT FROM p->'poolAddress' OR r->'depositAsset' IS DISTINCT FROM p->'depositAsset'
    OR r->'networkId' IS DISTINCT FROM q.quote->'pool'->'networkId' OR r->'amountBefore' IS DISTINCT FROM o->'amountBefore'
    OR r->'amountAfter' IS DISTINCT FROM q.quote->'amountAfter' OR r->'proceedsMicroUsd' IS DISTINCT FROM q.quote->'proceedsMicroUsd'
    OR public.lp085_time(r->'settledAt')<q.admitted_at OR public.lp085_time(r->'settledAt')<created
    OR public.lp085_time(r->'settledAt')>at_time OR length(btrim(r->>'receiptId')) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'LP independent full receipt binding/chronology mismatch'; END IF;
  PERFORM public.lp085_amount(r->'amountBefore',true); PERFORM public.lp085_amount(r->'amountAfter');
  PERFORM public.lp085_micro(r->'proceedsMicroUsd'); PERFORM public.lp085_micro(r->'collectedFeesMicroUsd');
  PERFORM public.lp085_micro(r->'executionCostsMicroUsd');
  RETURN true;
END $$;
CREATE TRIGGER lp085_quote_admission BEFORE INSERT OR UPDATE OR DELETE ON public.lp_protected_quote_admissions
  FOR EACH ROW EXECUTE FUNCTION public.lp085_admission_guard();
CREATE TRIGGER lp085_settlement_admission BEFORE INSERT OR UPDATE OR DELETE ON public.lp_protected_settlement_admissions
  FOR EACH ROW EXECUTE FUNCTION public.lp085_admission_guard();

-- Supplemental invoker triggers leave 083 sealed, but close its source-authority gap.
CREATE FUNCTION public.lp085_runtime_quote_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE q public.lp_protected_quote_admissions; c jsonb; expected jsonb; now_time timestamptz;
BEGIN
  IF TG_TABLE_NAME='lp_positions' THEN
    IF NEW.acquisition_provenance IS DISTINCT FROM 'exact-injected-paper-v2' THEN RETURN NEW; END IF;
    SELECT * INTO q FROM public.lp_protected_quote_admissions WHERE user_id=NEW.user_id AND intent_hash=NEW.acquisition_fingerprint
      AND context_key='acquisition:'||NEW.acquisition_key
      AND quote=NEW.valuation_evidence AND context->>'kind'='acquisition';
    c:=q.context->'commit';
    IF q.id IS NULL OR NEW.acquisition_mode IS DISTINCT FROM 'paper' OR NEW.state IS DISTINCT FROM 'building'
      OR c->'request'->>'operationKey' IS DISTINCT FROM NEW.acquisition_key
      OR c->'request'->>'chain' IS DISTINCT FROM NEW.chain OR c->'request'->>'poolAddress' IS DISTINCT FROM NEW.pool_address
      OR c->'request'->>'depositAsset' IS DISTINCT FROM NEW.deposit_asset OR q.quote->'pool'->>'protocol' IS DISTINCT FROM NEW.protocol
      OR c->'plan' IS DISTINCT FROM NEW.paper_plan
      OR NEW.rung_allocations IS DISTINCT FROM public.lp085_legacy_rungs(c->'plan',c->'request'->'deposit')
      OR public.lp085_amount(c->'request'->'deposit',true)/power(10::numeric,(c->'request'->'deposit'->>'scale')::integer) IS DISTINCT FROM NEW.deposit_amount
      OR public.lp085_micro(q.quote->'valueMicroUsd')/1000000 IS DISTINCT FROM NEW.deposit_value_usd
      OR (c->'request'->'strategy'->>'rangeLower')::numeric IS DISTINCT FROM NEW.range_lower
      OR (c->'request'->'strategy'->>'rangeUpper')::numeric IS DISTINCT FROM NEW.range_upper
      OR c->'request'->'strategy'->>'distribution' IS DISTINCT FROM NEW.strategy_type
      OR COALESCE((c->'request'->>'autoRebalance')::boolean,false) IS DISTINCT FROM NEW.auto_rebalance THEN
      RAISE EXCEPTION 'LP acquisition requires independently admitted complete source'; END IF;
  ELSIF TG_TABLE_NAME='lp_exact_positions' THEN
    SELECT * INTO q FROM public.lp_protected_quote_admissions WHERE user_id=NEW.user_id
      AND intent_hash=NEW.data->>'acquisitionFingerprint' AND context_key='acquisition:'||NEW.acquisition_key
      AND quote=NEW.data->'acquisitionQuote' AND context->>'kind'='acquisition';
    c:=q.context->'commit';
    expected:=jsonb_build_object('id',NEW.position_id::text,'userId',NEW.user_id::text,'chain',c->'request'->'chain',
      'protocol',q.quote->'pool'->'protocol','poolAddress',c->'request'->'poolAddress','depositAsset',c->'request'->'depositAsset',
      'acquisitionKey',c->'request'->'operationKey','acquisitionFingerprint',q.intent_hash,'mode','paper','deposit',c->'request'->'deposit',
      'depositMicroUsd',q.quote->'valueMicroUsd','acquisitionQuote',q.quote,'copyOrigin',c->'origin','currentAmount',c->'request'->'deposit',
      'plan',c->'plan','revision','0','state','active','autoRebalance',COALESCE((c->'request'->>'autoRebalance')::boolean,false),
      'cumulativeFeesMicroUsd','0','cumulativeCostsMicroUsd','0','realizedMicroUsd',NULL,'lastReceiptKey',NULL);
    IF q.id IS NULL OR NEW.data IS DISTINCT FROM expected OR NEW.acquisition_data IS DISTINCT FROM expected
      OR NEW.acquisition_key IS DISTINCT FROM c->'request'->>'operationKey'
      OR NEW.subscription_id::text IS DISTINCT FROM c->'origin'->>'subscriptionId'
      OR NEW.master_event_id IS DISTINCT FROM c->'origin'->>'eventId'
      OR NOT EXISTS(SELECT 1 FROM public.lp_positions b WHERE b.id=NEW.position_id AND b.user_id=NEW.user_id
        AND b.acquisition_provenance='exact-injected-paper-v2' AND b.acquisition_mode='paper' AND b.state='building'
        AND b.chain=expected->>'chain' AND b.protocol=expected->>'protocol' AND b.pool_address=expected->>'poolAddress'
        AND b.deposit_asset=expected->>'depositAsset' AND b.acquisition_key=expected->>'acquisitionKey'
        AND b.acquisition_fingerprint=expected->>'acquisitionFingerprint' AND b.valuation_evidence=q.quote AND b.paper_plan=c->'plan'
        AND b.deposit_value_usd=public.lp085_micro(q.quote->'valueMicroUsd')/1000000
        AND b.deposit_amount=public.lp085_amount(expected->'deposit',true)/power(10::numeric,(expected->'deposit'->>'scale')::integer)) THEN
      RAISE EXCEPTION 'LP exact acquisition complete protected source mismatch'; END IF;
  ELSE
    SELECT * INTO q FROM public.lp_protected_quote_admissions WHERE user_id=NEW.user_id AND intent_hash=NEW.data->>'fingerprint'
      AND context_key='operation:'||NEW.operation_key
      AND quote=NEW.data->'quote' AND context->>'kind'='operation'; c:=q.context->'commit';
    expected:=jsonb_build_object('id',NEW.id::text,'userId',NEW.user_id::text,'positionId',NEW.position_id::text,
      'operationKey',c->'operationKey','fingerprint',c->'fingerprint','action',c->'action','positionRevision',c->'position'->'revision',
      'amountBefore',c->'position'->'currentAmount','quote',q.quote,'plan',c->'plan','receiptKey',c->'receiptKey','status','pending','receipt',NULL);
    IF q.id IS NULL OR NEW.data IS DISTINCT FROM expected OR NEW.status IS DISTINCT FROM 'pending'
      OR NOT EXISTS(SELECT 1 FROM public.lp_exact_positions p WHERE p.user_id=NEW.user_id AND p.position_id=NEW.position_id
        AND public.lp085_current_position(p.user_id,p.position_id)=c->'position' AND public.lp085_current_position(p.user_id,p.position_id)->>'state' IN('active','near_edge','out_of_range')) THEN
      RAISE EXCEPTION 'LP operation requires admitted full current position/revision/context'; END IF;
  END IF;
  now_time:=date_trunc('milliseconds',clock_timestamp());
  IF q.admitted_at>now_time OR now_time>=public.lp085_time(q.quote->'expiresAt') THEN
    RAISE EXCEPTION 'LP protected admission expired before financial write'; END IF;
  IF TG_TABLE_NAME='lp_exact_operations' THEN NEW.created_at:=now_time; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lp085_base_acquisition BEFORE INSERT ON public.lp_positions FOR EACH ROW EXECUTE FUNCTION public.lp085_runtime_quote_guard();
CREATE TRIGGER lp085_exact_acquisition BEFORE INSERT ON public.lp_exact_positions FOR EACH ROW EXECUTE FUNCTION public.lp085_runtime_quote_guard();
CREATE TRIGGER lp085_operation BEFORE INSERT ON public.lp_exact_operations FOR EACH ROW EXECUTE FUNCTION public.lp085_runtime_quote_guard();

CREATE FUNCTION public.lp085_runtime_settlement_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE s public.lp_protected_settlement_admissions; q public.lp_protected_quote_admissions;
  o public.lp_exact_operations; p public.lp_exact_positions; r jsonb; expected jsonb; fees numeric; costs numeric; now_time timestamptz;
BEGIN
  -- Includes UPDATE paths driven by receipts materialized before this migration: no grandfather authority.
  IF TG_TABLE_NAME='lp_exact_receipts' THEN
    SELECT * INTO o FROM public.lp_exact_operations WHERE user_id=NEW.user_id AND id=NEW.operation_id; r:=NEW.data;
  ELSIF TG_TABLE_NAME='lp_exact_operations' THEN
    o:=OLD; r:=NEW.data->'receipt';
  ELSE
    SELECT * INTO o FROM public.lp_exact_operations WHERE user_id=NEW.user_id AND position_id=NEW.position_id
      AND receipt_key=NEW.data->>'lastReceiptKey' AND status='completed'; r:=o.data->'receipt';
  END IF;
  SELECT * INTO s FROM public.lp_protected_settlement_admissions WHERE user_id=NEW.user_id AND operation_id=o.id;
  SELECT * INTO q FROM public.lp_protected_quote_admissions WHERE user_id=NEW.user_id AND id=s.quote_admission_id;
  SELECT * INTO p FROM public.lp_exact_positions WHERE user_id=NEW.user_id AND position_id=o.position_id;
  now_time:=date_trunc('milliseconds',clock_timestamp());
  IF s.id IS NULL OR q.id IS NULL OR o.id IS NULL OR p.position_id IS NULL OR s.receipt IS DISTINCT FROM r
    OR q.context_key IS DISTINCT FROM 'operation:'||o.operation_key OR q.intent_hash IS DISTINCT FROM o.data->>'fingerprint'
    OR s.position_id IS DISTINCT FROM o.position_id OR s.position_revision IS DISTINCT FROM o.data->>'positionRevision'
    OR s.context->'operation' IS DISTINCT FROM (o.data-'status'-'receipt')||jsonb_build_object('status','pending','receipt',NULL)
    OR public.lp085_time(s.context->'operationCreatedAt') IS DISTINCT FROM o.created_at
    OR s.admitted_at>now_time OR q.admitted_at>o.created_at OR o.created_at>=public.lp085_time(q.quote->'expiresAt')
    OR q.quote IS DISTINCT FROM o.data->'quote' OR q.context IS DISTINCT FROM jsonb_build_object('kind','operation','commit',
      jsonb_build_object('position',s.context->'position','operationKey',o.data->'operationKey','fingerprint',o.data->'fingerprint',
        'action',o.data->'action','quote',o.data->'quote','plan',o.data->'plan','receiptKey',o.data->'receiptKey')) THEN
    RAISE EXCEPTION 'LP mutation requires independently admitted FULL settlement, including old receipts'; END IF;
  PERFORM public.lp085_receipt_valid(s.receipt,q,s.context->'operation',s.context->'position',o.created_at,s.admitted_at);
  IF TG_TABLE_NAME='lp_exact_receipts' THEN
    IF o.status IS DISTINCT FROM 'pending' OR s.context->'position' IS DISTINCT FROM public.lp085_current_position(p.user_id,p.position_id)
      OR NEW.position_id IS DISTINCT FROM s.position_id OR NEW.receipt_key IS DISTINCT FROM r->>'receiptKey'
      OR NEW.provider_id IS DISTINCT FROM r->>'providerId' OR NEW.receipt_id IS DISTINCT FROM r->>'receiptId' THEN
      RAISE EXCEPTION 'LP receipt source context mismatch'; END IF;
    NEW.accepted_at:=now_time;
  ELSIF TG_TABLE_NAME='lp_exact_operations' THEN
    IF OLD.status IS DISTINCT FROM 'pending' OR NEW.status IS DISTINCT FROM 'completed'
      OR s.context->'position' IS DISTINCT FROM public.lp085_current_position(p.user_id,p.position_id) OR NOT EXISTS(SELECT 1 FROM public.lp_exact_receipts a
        WHERE a.user_id=NEW.user_id AND a.operation_id=NEW.id AND a.position_id=s.position_id AND a.data=s.receipt
          AND a.accepted_at>=s.admitted_at AND a.accepted_at<=now_time) THEN
      RAISE EXCEPTION 'LP completion requires admitted receipt first'; END IF;
    NEW.completed_at:=now_time;
  ELSE
    IF s.context->'position' IS DISTINCT FROM public.lp085_current_position(OLD.user_id,OLD.position_id) OR o.status IS DISTINCT FROM 'completed'
      OR o.completed_at<s.admitted_at OR o.completed_at>now_time OR NOT EXISTS(SELECT 1 FROM public.lp_exact_receipts a
        WHERE a.user_id=NEW.user_id AND a.operation_id=o.id AND a.position_id=NEW.position_id AND a.data=s.receipt
          AND a.accepted_at>=s.admitted_at AND a.accepted_at<=o.completed_at) THEN
      RAISE EXCEPTION 'LP exact position requires admitted completed receipt chronology'; END IF;
    fees:=public.lp085_micro(OLD.data->'cumulativeFeesMicroUsd')+public.lp085_micro(s.receipt->'collectedFeesMicroUsd');
    costs:=public.lp085_micro(OLD.data->'cumulativeCostsMicroUsd')+public.lp085_micro(s.receipt->'executionCostsMicroUsd');
    PERFORM public.lp085_micro(to_jsonb(fees::text)); PERFORM public.lp085_micro(to_jsonb(costs::text));
    IF o.data->>'action'='close' THEN
      PERFORM public.lp085_micro(to_jsonb((public.lp085_micro(s.receipt->'proceedsMicroUsd')+fees-costs-
        public.lp085_micro(OLD.data->'depositMicroUsd'))::text),true);
    END IF;
    expected:=(s.context->'position')||jsonb_build_object('currentAmount',s.receipt->'amountAfter','revision',
      (public.lp085_micro(OLD.data->'revision')+1)::text,'state',CASE WHEN o.data->>'action'='close' THEN 'closed' ELSE 'active' END,
      'plan',CASE WHEN o.data->>'action'='close' THEN OLD.data->'plan' ELSE o.data->'plan' END,
      'cumulativeFeesMicroUsd',fees::text,'cumulativeCostsMicroUsd',costs::text,'lastReceiptKey',s.receipt->'receiptKey',
      'realizedMicroUsd',CASE WHEN o.data->>'action'='close' THEN to_jsonb((public.lp085_micro(s.receipt->'proceedsMicroUsd')+
        fees-costs-public.lp085_micro(OLD.data->'depositMicroUsd'))::text) ELSE 'null'::jsonb END);
    IF NEW.data IS DISTINCT FROM expected THEN RAISE EXCEPTION 'LP exact numeric economics/state substitution'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lp085_receipt BEFORE INSERT ON public.lp_exact_receipts FOR EACH ROW EXECUTE FUNCTION public.lp085_runtime_settlement_guard();
CREATE TRIGGER lp085_completion BEFORE UPDATE ON public.lp_exact_operations FOR EACH ROW EXECUTE FUNCTION public.lp085_runtime_settlement_guard();
CREATE TRIGGER lp085_exact_position BEFORE UPDATE ON public.lp_exact_positions FOR EACH ROW EXECUTE FUNCTION public.lp085_runtime_settlement_guard();

CREATE FUNCTION public.lp085_legacy_update_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.acquisition_provenance IS DISTINCT FROM 'exact-injected-paper-v2' THEN RETURN NEW; END IF;
  IF (OLD.state='closed' OR EXISTS(SELECT 1 FROM public.lp_exact_positions e WHERE e.user_id=OLD.user_id
    AND e.position_id=OLD.id AND e.data->>'state'='closed')) AND NEW.state IS DISTINCT FROM 'closed' THEN
    RAISE EXCEPTION 'LP closed exact inventory cannot reopen through legacy state'; END IF;
  IF ROW(NEW.id,NEW.user_id,NEW.chain,NEW.protocol,NEW.pool_address,NEW.deposit_asset,NEW.deposit_amount,
       NEW.deposit_value_usd,NEW.acquisition_mode,NEW.acquisition_provenance,NEW.valuation_evidence,
       NEW.acquisition_key,NEW.acquisition_fingerprint)
    IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.chain,OLD.protocol,OLD.pool_address,OLD.deposit_asset,OLD.deposit_amount,
       OLD.deposit_value_usd,OLD.acquisition_mode,OLD.acquisition_provenance,OLD.valuation_evidence,
       OLD.acquisition_key,OLD.acquisition_fingerprint) THEN
    RAISE EXCEPTION 'LP legacy acquisition identity/source immutable'; END IF;
  IF NEW.paper_plan IS DISTINCT FROM OLD.paper_plan OR NEW.rung_allocations IS DISTINCT FROM OLD.rung_allocations OR NEW.range_lower IS DISTINCT FROM OLD.range_lower
    OR NEW.range_upper IS DISTINCT FROM OLD.range_upper OR NEW.strategy_type IS DISTINCT FROM OLD.strategy_type
    OR (NEW.state='closed' AND OLD.state IS DISTINCT FROM 'closed') THEN
    IF NOT EXISTS(SELECT 1 FROM public.lp_exact_positions p
      JOIN public.lp_exact_operations o ON o.user_id=p.user_id AND o.position_id=p.position_id
        AND o.receipt_key=p.data->>'lastReceiptKey' AND o.status='completed'
      JOIN public.lp_protected_settlement_admissions s ON s.user_id=o.user_id AND s.operation_id=o.id
        AND s.position_id=o.position_id AND s.receipt=o.data->'receipt'
      JOIN public.lp_protected_quote_admissions q ON q.user_id=s.user_id AND q.id=s.quote_admission_id AND q.quote=o.data->'quote'
      JOIN public.lp_exact_receipts r ON r.user_id=s.user_id AND r.operation_id=s.operation_id AND r.data=s.receipt
        AND r.accepted_at>=s.admitted_at AND r.accepted_at<=o.completed_at
      WHERE p.user_id=NEW.user_id AND p.position_id=NEW.id AND p.data->>'state'=NEW.state
        AND p.data->'plan'=NEW.paper_plan AND (p.data->'plan'->'strategy'->>'rangeLower')::numeric=NEW.range_lower
        AND (p.data->'plan'->'strategy'->>'rangeUpper')::numeric=NEW.range_upper
        AND p.data->'plan'->'strategy'->>'distribution'=NEW.strategy_type
        AND NEW.rung_allocations=public.lp085_legacy_rungs(p.data->'plan',s.receipt->'amountBefore')
        AND q.context_key='operation:'||o.operation_key AND q.intent_hash=o.data->>'fingerprint'
        AND q.admitted_at<=o.created_at AND o.created_at<public.lp085_time(q.quote->'expiresAt')
        AND s.admitted_at<=o.completed_at AND o.completed_at<=clock_timestamp()) THEN
      RAISE EXCEPTION 'LP legacy financial update requires independent full receipt source, including old materialized receipts';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lp085_legacy_update BEFORE UPDATE ON public.lp_positions
  FOR EACH ROW EXECUTE FUNCTION public.lp085_legacy_update_guard();

DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['lp_protected_quote_admissions','lp_protected_settlement_admissions'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',tbl);
    EXECUTE format('CREATE POLICY lp085_read_tenant ON public.%I FOR SELECT TO swat_app,swat_lp_admitter USING(user_id=public.current_app_user_id())',tbl);
    EXECUTE format('CREATE POLICY lp085_insert_admitter ON public.%I FOR INSERT TO swat_lp_admitter WITH CHECK(user_id=public.current_app_user_id())',tbl);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,swat_app,swat_lp_admitter',tbl);
    EXECUTE format('GRANT SELECT ON public.%I TO swat_app,swat_lp_admitter',tbl);
    EXECUTE format('GRANT INSERT ON public.%I TO swat_lp_admitter',tbl);
  END LOOP;
END $$;
-- Only tenant read access for independent context joins; no UPDATE/INSERT to runtime financial objects.
CREATE POLICY lp085_admitter_position_read ON public.lp_exact_positions FOR SELECT TO swat_lp_admitter USING(user_id=public.current_app_user_id());
CREATE POLICY lp085_admitter_operation_read ON public.lp_exact_operations FOR SELECT TO swat_lp_admitter USING(user_id=public.current_app_user_id());
-- Current legacy state/consent must be visible to the independent context reader; same tenant, SELECT-only.
CREATE POLICY lp085_admitter_base_position_read ON public.lp_positions FOR SELECT TO swat_lp_admitter USING(user_id=public.current_app_user_id());
GRANT SELECT(id,user_id,state,auto_rebalance) ON public.lp_positions TO swat_lp_admitter;
GRANT SELECT ON public.lp_exact_positions,public.lp_exact_operations TO swat_lp_admitter;
GRANT USAGE ON SCHEMA public TO swat_lp_admitter;
GRANT EXECUTE ON FUNCTION public.current_app_user_id() TO swat_lp_admitter;
REVOKE ALL ON FUNCTION public.lp085_fields(jsonb,text[]),public.lp085_texts(jsonb,text[]),public.lp085_micro(jsonb,boolean),public.lp085_amount(jsonb,boolean),
  public.lp085_time(jsonb),public.lp085_quote_valid(jsonb,jsonb,timestamptz),public.lp085_admission_guard(),
  public.lp085_receipt_valid(jsonb,public.lp_protected_quote_admissions,jsonb,jsonb,timestamptz,timestamptz),
  public.lp085_runtime_quote_guard(),public.lp085_runtime_settlement_guard(),public.lp085_legacy_update_guard(),
  public.lp085_project_position(jsonb,text,boolean),public.lp085_current_position(uuid,uuid),public.lp085_legacy_rungs(jsonb,jsonb) FROM PUBLIC;
-- Invoker guards call these pure validators under the caller. No privileged definer or authority minting function.
GRANT EXECUTE ON FUNCTION public.lp085_fields(jsonb,text[]),public.lp085_texts(jsonb,text[]),public.lp085_micro(jsonb,boolean),public.lp085_amount(jsonb,boolean),
  public.lp085_time(jsonb),public.lp085_quote_valid(jsonb,jsonb,timestamptz),
  public.lp085_receipt_valid(jsonb,public.lp_protected_quote_admissions,jsonb,jsonb,timestamptz,timestamptz),
  public.lp085_project_position(jsonb,text,boolean),public.lp085_current_position(uuid,uuid),public.lp085_legacy_rungs(jsonb,jsonb) TO swat_app,swat_lp_admitter;
