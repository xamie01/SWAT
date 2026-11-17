-- Forward078 proposal; parent owns actual migration integration. SOURCE ONLY.
-- No historical descriptor/claim/policy backfill and no runtime privilege grants.
CREATE FUNCTION public.check_canonical_fanout_execution() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE data jsonb; valid boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.execution_id IS DISTINCT FROM OLD.execution_id THEN
      RAISE EXCEPTION 'canonical fanout execution binding is immutable; no legacy backfill';
    END IF;
    RETURN NEW;
  END IF;
  data := NEW.descriptor->'data';
  IF NEW.execution_id IS NULL OR jsonb_typeof(data) IS DISTINCT FROM 'object'
    OR jsonb_typeof(NEW.descriptor->'options') IS DISTINCT FROM 'object'
    OR NOT (data ?& ARRAY['copyExecutionId','signalId','userId','chain','tokenMint','direction',
      'targetAccount','masterWalletAddress','executionMode','requestedBaseQuantity','requestedQuoteQuantity',
      'sourceTradeId','exitLotId'])
    OR NEW.descriptor->>'name' IS DISTINCT FROM 'signal-trade'
    OR NEW.descriptor->'options'->>'jobId' IS DISTINCT FROM NEW.job_id
    OR data->>'copyExecutionId' IS DISTINCT FROM NEW.execution_id::text
    OR data->>'userId' IS DISTINCT FROM NEW.user_id::text
    OR data->>'executionMode' IS DISTINCT FROM NEW.execution_mode
    OR data->>'targetAccount' IS DISTINCT FROM NEW.target_account
    OR (data ? 'acquisitionExecutionMode' AND data->>'acquisitionExecutionMode' IS DISTINCT FROM NEW.execution_mode)
  THEN RAISE EXCEPTION 'complete canonical fanout descriptor/identity required'; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.copy_executions execution
    JOIN public.source_fanout_batches batch ON batch.signal_id = execution.signal_id
      AND batch.source_trade_id = execution.source_trade_id
    JOIN public.signals signal ON signal.id = execution.signal_id AND signal.source_trade_id = execution.source_trade_id
    JOIN public.source_trades source ON source.id = execution.source_trade_id
      AND source.chain = execution.chain AND source.token_mint = execution.token_mint AND source.direction = execution.direction
    JOIN public.copy_execution_policy_snapshots policy ON policy.execution_id = execution.id
      AND policy.user_id IS NOT DISTINCT FROM execution.user_id AND policy.chain = execution.chain
      AND policy.target_account = execution.target_account AND policy.token_mint = execution.token_mint
      AND policy.master_wallet_address = source.wallet_address AND policy.execution_mode = execution.execution_mode
    JOIN public.source_verification_bindings binding ON binding.source_trade_id = source.id
    JOIN public.source_verification_heads head ON head.source_trade_id = source.id
    JOIN public.source_verified_evidence evidence ON evidence.evidence_id = head.evidence_id
    JOIN public.source_provider_authorities authority ON authority.authority_id = evidence.authority_id
    JOIN public.source_position_applications application ON application.source_trade_id = source.id
    WHERE execution.id = NEW.execution_id AND execution.signal_id = NEW.signal_id
      AND execution.user_id IS NOT DISTINCT FROM NEW.user_id AND execution.target_account = NEW.target_account
      AND execution.execution_mode = NEW.execution_mode
      AND data->>'signalId' IS NOT DISTINCT FROM execution.signal_id::text
      AND data->>'sourceTradeId' IS NOT DISTINCT FROM execution.source_trade_id::text
      AND data->>'chain' IS NOT DISTINCT FROM execution.chain
      AND NEW.descriptor->>'chain' IS NOT DISTINCT FROM execution.chain
      AND NEW.descriptor->>'queue' IS NOT DISTINCT FROM CASE execution.chain
        WHEN 'solana' THEN 'swat-trades-solana' WHEN 'polygon' THEN 'swat-trades-polygon'
        WHEN 'robinhood-chain' THEN 'swat-trades-robinhood' ELSE NULL END
      AND data->>'tokenMint' IS NOT DISTINCT FROM execution.token_mint
      AND data->>'direction' IS NOT DISTINCT FROM execution.direction
      AND data->>'masterWalletAddress' IS NOT DISTINCT FROM source.wallet_address
      AND data->>'requestedBaseQuantity' IS NOT DISTINCT FROM execution.requested_base_quantity::text
      AND data->>'requestedQuoteQuantity' IS NOT DISTINCT FROM execution.requested_quote_quantity::text
      AND data->>'exitLotId' IS NOT DISTINCT FROM execution.exit_lot_id::text
      AND (execution.requested_base_quantity > 0 OR execution.requested_quote_quantity > 0)
      AND source.confirmation_state IN ('confirmed','finalized') AND head.confirmation_state = source.confirmation_state
      AND evidence.source_trade_id = source.id AND evidence.binding_digest = binding.binding_digest
      AND evidence.finality = source.confirmation_state AND application.active
      AND application.wallet_address = source.wallet_address AND application.chain = source.chain
      AND application.token_mint = source.token_mint
      AND authority.enabled AND authority.provider_id = evidence.provider_id
      AND authority.identity_digest = evidence.provider_identity_digest
      AND authority.chain = source.chain AND authority.network = binding.network
      AND authority.verifier_version = evidence.verifier_version
      AND authority.valid_until > CURRENT_TIMESTAMP AND evidence.provider_valid_until > CURRENT_TIMESTAMP
  ) INTO valid;
  IF valid IS NOT TRUE THEN RAISE EXCEPTION 'canonical fanout execution/source/captured-policy binding unavailable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_fanout_canonical_execution BEFORE INSERT OR UPDATE ON public.source_fanout_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.check_canonical_fanout_execution();
REVOKE ALL ON FUNCTION public.check_canonical_fanout_execution() FROM PUBLIC, swat_app, swat_fanout;
