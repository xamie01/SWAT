import type { PoolClient } from '../../../packages/db/src/copy-trade-lifecycle-owned.js';
import { ACCEPTED_SOURCE_VERIFICATION_JOINS_SQL, ACCEPTED_SOURCE_VERIFICATION_PREDICATE_SQL }
  from '../../../packages/db/src/source-verification-store.js';
import { workerMoney, workerQuantity } from '../../../packages/db/src/worker-valuation-corrections.js';
import { captureLoadFixture, loadCheck, loadEqual, loadJson, loadScope, type LoadDurableSnapshot,
  type LoadFixture, type LoadScope } from './load-durable-contract.js';

export interface LoadOwnedObserverPorts {
  /** Must supply one separately approved observer backend in an already-owned
   * REPEATABLE READ READ ONLY transaction. Must settle pending work before return.
   * No pool/BEGIN/COMMIT/grant/provisioning or pg runtime import in this graph. */
  transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T>;
  assertObserverWithClient(client: PoolClient, scope: LoadScope): Promise<void>;
  readonly now: () => Date;
}
/** Independent canonical-schema SQL reader. HTTP/protected admission capture is
 * deliberately NOT read from invented tables: those are upstream capture ports.
 * Scan by namespace AND all owned assets, not only supplied execution IDs, so
 * extra jobs/tenants/orphan economics cannot disappear through a narrow join. */
export function createLoadDurableSqlObserver(ports: LoadOwnedObserverPorts) {
  loadCheck(ports && typeof ports.transaction === 'function' && typeof ports.assertObserverWithClient === 'function'
    && typeof ports.now === 'function', 'separately approved owned observer required');
  return async (input: { readonly scope: LoadScope; readonly fixtures: readonly LoadFixture[] }): Promise<LoadDurableSnapshot> => {
    const scope = loadScope(input.scope), fixtures = input.fixtures.map(captureLoadFixture);
    loadCheck(fixtures.length > 0 && fixtures.length <= 10_000, 'bounded observer fixture plan required');
    for (const fixture of fixtures) loadEqual(fixture.scope, scope, 'observer foreign fixture scope');
    const tokens = [...new Set(fixtures.map(f => f.tokenMint))];
    return ports.transaction(async client => {
      await ports.assertObserverWithClient(client, scope);
      const identity = await client.query(`SELECT current_user AS role,session_user AS session,
        r.rolsuper,r.rolbypassrls,current_setting('row_security') AS row_security,
        current_setting('transaction_read_only') AS read_only,
        current_setting('transaction_isolation') AS isolation,
        COALESCE(current_setting('app.bypass_rls',true),'off') AS bypass
        FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
      const identityRow = identity.rows[0];
      loadCheck(identity.rows.length === 1 && identityRow.role === identityRow.session
        && identityRow.rolsuper === false && identityRow.rolbypassrls === false && identityRow.row_security === 'on'
        && identityRow.read_only === 'on' && identityRow.isolation === 'repeatable read' && identityRow.bypass === 'off',
      'direct non-bypass independent read-only repeatable-read observer required');
      const now = ports.now(); loadCheck(now instanceof Date && Number.isFinite(now.getTime()), 'observer clock required');
      async function read<K extends keyof Omit<LoadDurableSnapshot, 'scope'>>(key: K, sql: string, values: unknown[],
        decimals: readonly string[] = [], monies: readonly string[] = []): Promise<LoadDurableSnapshot[K]> {
        // Limit+one detects overflow; never silently truncate an economic scan.
        const { rows } = await client.query(`${sql} LIMIT 10001`, values);
        loadCheck(rows.length <= 10_000, `observer ${key} scan overflow`);
        const result = rows.map(row => {
          const output = { ...row };
          for (const column of decimals) if (output[column] !== null) output[column] = workerQuantity(output[column]);
          for (const column of monies) if (output[column] !== null) output[column] = workerMoney(output[column]);
          loadJson(output); return output;
        });
        return result as unknown as LoadDurableSnapshot[K];
      }
      const sources = await read('sources', `SELECT source.id,binding.binding,binding.binding_digest AS "bindingDigest",
        head.evidence_id AS "evidenceId",head.confirmation_state AS finality,application.active AS "applicationActive",
        EXISTS(SELECT 1 FROM public.source_trades source ${ACCEPTED_SOURCE_VERIFICATION_JOINS_SQL}
          WHERE source.id=outer_source.id AND ${ACCEPTED_SOURCE_VERIFICATION_PREDICATE_SQL}) AS accepted
        FROM public.source_trades outer_source
        JOIN public.source_trades source ON source.id=outer_source.id
        LEFT JOIN public.source_verification_bindings binding ON binding.source_trade_id=source.id
        LEFT JOIN public.source_verification_heads head ON head.source_trade_id=source.id
        LEFT JOIN public.source_position_applications application ON application.source_trade_id=source.id
        WHERE source.source_event_id LIKE $1 OR source.token_mint=ANY($3::text[]) ORDER BY source.id`,
      [`${scope.namespace}/%`, now, tokens]);
      const executions = await read('executions', `SELECT id,signal_id AS "signalId",source_trade_id AS "sourceTradeId",
        user_id AS "userId",target_account AS "targetAccount",chain,token_mint AS "tokenMint",direction,
        execution_mode AS "executionMode",state,requested_base_quantity::text AS "requestedBase",
        requested_quote_quantity::text AS "requestedQuote",confirmed_base_quantity::text AS "confirmedBase",
        confirmed_quote_quantity::text AS "confirmedQuote",quote_unassessed_fill_count::text AS "quoteUnknown"
        FROM public.copy_executions WHERE token_mint=ANY($1::text[]) OR source_trade_id=ANY($2::uuid[]) ORDER BY id`,
      [tokens, sources.map(s => s.id)], ['requestedBase', 'confirmedBase'], ['requestedQuote', 'confirmedQuote']);
      const ids = executions.map(e => e.id), signals = executions.map(e => e.signalId);
      const deliveries = await read('deliveries', `SELECT delivery.execution_id AS "executionId",delivery.signal_id AS "signalId",
        delivery.user_id AS "userId",delivery.target_account AS "targetAccount",delivery.execution_mode AS "executionMode",
        delivery.job_id AS "jobId",delivery.state,delivery.fence::text,delivery.descriptor
        FROM public.source_fanout_deliveries delivery WHERE delivery.execution_id=ANY($1::uuid[])
          OR delivery.signal_id=ANY($2::uuid[]) OR delivery.descriptor->'data'->>'tokenMint'=ANY($3::text[])
        ORDER BY delivery.job_id`, [ids, signals, tokens]);
      const workerAttempts = await read('workerAttempts', `SELECT execution_id AS "executionId",user_id AS "userId",fence::text,
        policy_revision AS "policyRevision",risk_epoch::text AS "riskEpoch",state FROM public.copy_execution_worker_attempts
        WHERE execution_id=ANY($1::uuid[]) ORDER BY execution_id`, [ids]);
      const evidence = await read('evidence', `SELECT evidence.id,evidence.execution_id AS "executionId",execution.user_id AS "userId",
        execution.source_trade_id AS "sourceTradeId",evidence.evidence_id AS "evidenceId",evidence.evidence_type AS "evidenceType",
        evidence.confirmation_state AS "confirmationState",evidence.completes_execution AS completes,
        evidence.base_quantity::text AS base,evidence.quote_quantity::text AS quote,evidence.fee_usd::text AS fee,
        evidence.quote_currency AS "quoteCurrency",evidence.quote_native_quantity::text AS "nativeQuote",
        evidence.quote_native_usd_price::text AS "nativePrice",evidence.effective_quote_usd::text AS "effectiveQuote",
        evidence.effective_fee_usd::text AS "effectiveFee",evidence.valuation_correction_id AS "correctionId",
        application.active AS "applicationActive" FROM public.worker_effective_execution_evidence evidence
        JOIN public.copy_executions execution ON execution.id=evidence.execution_id
        LEFT JOIN public.copy_position_applications application ON application.evidence_id=evidence.id
        WHERE evidence.execution_id=ANY($1::uuid[]) ORDER BY evidence.id`, [ids], ['base', 'nativeQuote'],
      ['quote', 'fee', 'nativePrice', 'effectiveQuote', 'effectiveFee']);
      const trades = await read('trades', `SELECT id,copy_execution_id AS "executionId",user_id AS "userId",signal_id AS "signalId",
        source_trade_id AS "sourceTradeId",token_mint AS "tokenMint",chain,direction,execution_mode AS "executionMode",
        token_amount::text AS base,amount_usd::text AS quote,fee_usd::text AS fee,status FROM public.trades
        WHERE copy_execution_id=ANY($1::uuid[]) OR token_mint=ANY($2::text[]) ORDER BY id`, [ids, tokens], ['base'], ['quote', 'fee']);
      const receiptRows = await client.query(`SELECT receipt_id,execution_id,user_id,trade_id,worker_fence::text,
        accounting_complete,snapshot FROM public.copy_execution_financial_receipts
        WHERE execution_id=ANY($1::uuid[]) ORDER BY receipt_id LIMIT 10001`, [ids]);
      loadCheck(receiptRows.rows.length <= 10_000, 'financial receipt observer scan overflow');
      const receipts: LoadDurableSnapshot['receipts'] = receiptRows.rows.map(r => {
        loadJson(r.snapshot); const s = r.snapshot;
        loadCheck(s?.executionId === r.execution_id && s.userId === r.user_id && s.tradeId === r.trade_id
          && s.fence === r.worker_fence && s.accountingComplete === r.accounting_complete,
        'stored financial receipt columns disagree with immutable snapshot');
        return { receiptId: r.receipt_id, snapshot: s };
      });
      const applications = await read('applications', `SELECT application.evidence_id AS "evidenceId",
        application.execution_id AS "executionId",application.position_id AS "positionId",application.user_id AS "userId",
        application.target_account AS "targetAccount",application.token_mint AS "tokenMint",application.chain,application.active
        FROM public.copy_position_applications application WHERE application.execution_id=ANY($1::uuid[])
          OR application.token_mint=ANY($2::text[]) ORDER BY application.evidence_id`, [ids, tokens]);
      const positions = await read('positions', `SELECT id,user_id AS "userId",target_account AS "targetAccount",token_mint AS "tokenMint",
        chain,confirmed_quantity::text AS base,cost_basis_usd::text AS basis FROM public.copy_positions
        WHERE token_mint=ANY($1::text[]) ORDER BY id`, [tokens], ['base'], ['basis']);
      const lots = await read('lots', `SELECT lot.id,lot.position_id AS "positionId",lot.user_id AS "userId",lot.token_mint AS "tokenMint",
        lot.chain,lot.master_wallet_address AS "masterWalletAddress",lot.acquisition_execution_id AS "acquisitionExecutionId",
        lot.acquisition_evidence_id AS "acquisitionEvidenceId",lot.source_trade_id AS "acquisitionSourceTradeId",
        execution.execution_mode AS "acquisitionMode",lot.acquired_quantity::text AS "acquiredBase",
        lot.remaining_quantity::text AS "remainingBase",lot.acquired_cost_basis_usd::text AS "acquiredBasis",
        lot.remaining_cost_basis_usd::text AS "remainingBasis" FROM public.copy_position_master_lots lot
        JOIN public.copy_executions execution ON execution.id=lot.acquisition_execution_id
        WHERE lot.token_mint=ANY($1::text[]) OR lot.acquisition_execution_id=ANY($2::uuid[]) ORDER BY lot.id`,
      [tokens, ids], ['acquiredBase', 'remainingBase'], ['acquiredBasis', 'remainingBasis']);
      const risk = await read('risk', `SELECT execution_id AS "executionId",account,policy_epoch::text AS epoch,
        state,confirmed_usd::text AS debit,liability_usd::text AS liability,chain,execution_mode AS "executionMode"
        FROM public.risk_spend_reservations WHERE execution_id=ANY($1::uuid[])
        ORDER BY execution_id`, [ids], [], ['debit', 'liability']);
      const capacity = await read('capacity', `SELECT source_trade_id AS "sourceTradeId",execution_mode AS "executionMode",
        notional_usd::text AS notional,chain,token_mint AS "tokenMint",master_wallet_address AS "masterWalletAddress"
        FROM public.master_capacity_ledger WHERE source_trade_id=ANY($1::uuid[])
          OR token_mint=ANY($2::text[]) ORDER BY source_trade_id,execution_mode`, [sources.map(s => s.id), tokens], [], ['notional']);
      const corrections = await read('corrections', `SELECT execution_id AS "executionId",correction_id AS "correctionId"
        FROM public.copy_execution_valuation_corrections WHERE execution_id=ANY($1::uuid[]) ORDER BY correction_id`, [ids]);
      const reductions = await read('reductions', `SELECT sell_execution_id AS "executionId",sell_evidence_id AS "evidenceId",lot_id AS "lotId"
        FROM public.copy_position_master_lot_reductions WHERE sell_execution_id=ANY($1::uuid[])
          OR lot_id=ANY($2::uuid[]) ORDER BY id`, [ids, lots.map(l => l.id)]);
      return { scope, sources, executions, deliveries, workerAttempts, evidence, trades, receipts, applications,
        positions, lots, risk, capacity, corrections, reductions };
    });
  };
}
