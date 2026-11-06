import { query } from './client.js';
import { withTransaction } from './transaction.js';
import { normalizeTenantId } from './copy-trade-lifecycle.js';
import { resolveChainAddress, resolveChainValue } from '@swat/shared';
/**
 * Persist an executed (or paper-filled) trade.
 *
 * `token_amount` is stored as a NUMERIC so mark-to-market can later compute
 * `pnl = token_amount * current_price - amount_usd`.
 */
const INSERT_TRADE_SQL = `INSERT INTO trades (
   signal_id,
   wallet_address,
   token_mint,
   chain,
   direction,
   amount_sol,
   amount_usd,
   token_amount,
   price_usd,
   fee_usd,
   slippage_bps,
   signature,
   execution_mode,
   executor,
   status,
   error_message,
   price_impact_pct,
   route_info,
   quote_slot,
   min_token_amount,
   venue_order_id,
   venue_status,
   venue_trade_ids,
   settlement_transaction_hashes,
   shadow_of,
   submitted_at,
   confirmed_at,
   source_trade_id,
   copy_execution_id,
   target_amount_usd,
   user_id
 )
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31)
 ON CONFLICT (copy_execution_id) WHERE copy_execution_id IS NOT NULL
 DO UPDATE SET
   signature = COALESCE(EXCLUDED.signature, trades.signature),
   status = EXCLUDED.status,
   error_message = EXCLUDED.error_message,
   amount_sol = EXCLUDED.amount_sol,
   amount_usd = EXCLUDED.amount_usd,
   token_amount = COALESCE(EXCLUDED.token_amount, trades.token_amount),
   price_usd = COALESCE(EXCLUDED.price_usd, trades.price_usd),
   fee_usd = COALESCE(EXCLUDED.fee_usd, trades.fee_usd),
   slippage_bps = COALESCE(EXCLUDED.slippage_bps, trades.slippage_bps),
   venue_order_id = COALESCE(EXCLUDED.venue_order_id, trades.venue_order_id),
   venue_status = COALESCE(EXCLUDED.venue_status, trades.venue_status),
   venue_trade_ids = EXCLUDED.venue_trade_ids,
   settlement_transaction_hashes = EXCLUDED.settlement_transaction_hashes,
   target_amount_usd = COALESCE(trades.target_amount_usd, EXCLUDED.target_amount_usd),
   -- Tenant order is deliberate: trades.user_id first, so a re-upsert can only
   -- ever FILL IN a missing tenant (an expand-phase operator row) and can never
   -- silently reattribute financial history from one user to another. The
   -- conflict target copy_execution_id is already tenant-scoped, so a differing
   -- EXCLUDED.user_id would mean corruption upstream, not an update.
   -- (No backticks in this comment: the whole statement is a TS template
   -- literal, and a backtick here terminates it.)
   user_id = COALESCE(trades.user_id, EXCLUDED.user_id),
   submitted_at = COALESCE(trades.submitted_at, EXCLUDED.submitted_at),
   confirmed_at = COALESCE(EXCLUDED.confirmed_at, trades.confirmed_at)
 RETURNING id`;
function validatedFeeUsd(input) {
    const feeUsd = input.feeUsd ?? null;
    if (feeUsd !== null && (!Number.isFinite(feeUsd) || feeUsd < 0)) {
        throw new Error('feeUsd must be a finite non-negative number');
    }
    return feeUsd;
}
function getTradeValues(input) {
    const resolvedToken = resolveChainValue(input.tokenMint, input.chain ?? undefined);
    const chain = resolvedToken.chain;
    const tokenMint = resolvedToken.prefixed;
    const feeUsd = validatedFeeUsd(input);
    const walletAddress = input.walletAddress
        ? resolveChainAddress(input.walletAddress, chain).prefixed
        : null;
    return [
        input.signalId ?? null,
        walletAddress,
        tokenMint,
        chain,
        input.direction,
        input.amountSol ?? null,
        input.amountUsd ?? null,
        input.tokenAmount ?? null,
        input.priceUsd ?? null,
        feeUsd,
        input.slippageBps ?? null,
        input.signature ?? null,
        input.executionMode ?? null,
        input.executor ?? null,
        input.status ?? 'filled',
        input.errorMessage ?? null,
        input.priceImpactPct ?? null,
        input.routeInfo ? JSON.stringify(input.routeInfo) : null,
        input.quoteSlot ?? null,
        input.minTokenAmount ?? null,
        input.venueOrderId ?? null,
        input.venueStatus ?? null,
        JSON.stringify(input.venueTradeIds ?? []),
        JSON.stringify(input.settlementTransactionHashes ?? []),
        input.shadowOf ?? null,
        input.submittedAt ?? null,
        input.confirmedAt ?? null,
        input.sourceTradeId ?? null,
        input.copyExecutionId ?? null,
        input.targetAmountUsd ?? null,
        normalizeTenantId(input.userId)
    ];
}
export async function insertTrade(input) {
    const rows = await query(INSERT_TRADE_SQL, getTradeValues(input));
    return rows[0] ?? null;
}
/**
 * Persist a filled trade and mark its signal executed in one transaction.
 * Locking the signal also makes retry recovery idempotent: if a previous
 * attempt committed the trade, a retry only repairs the signal status.
 */
export async function insertTradeAndMarkSignalExecuted(input) {
    const status = input.status ?? 'filled';
    if (status !== 'filled' && status !== 'partial') {
        throw new Error(`Cannot mark signal executed from unconfirmed trade status: ${status}`);
    }
    if (input.executionMode === 'shadow') {
        throw new Error('Shadow trades cannot mark signals executed');
    }
    validatedFeeUsd(input);
    return withTransaction(async (client) => {
        const signal = await client.query(`SELECT id FROM signals WHERE id = $1 FOR UPDATE`, [input.signalId]);
        if (signal.rowCount !== 1) {
            throw new Error(`Signal ${input.signalId} does not exist`);
        }
        // Tenant-scoped. A signal is a shared detection that more than one tenant
        // may copy, so without `user_id` here tenant B's fill would find tenant A's
        // trade, skip its own insert, and return A's trade id — B's position would
        // never be recorded and A's P&L would absorb it. `IS NOT DISTINCT FROM`
        // because operator rows carry `user_id NULL` and `= NULL` never matches
        // (S4-10, migration 050_copy_tenancy.sql).
        const existing = await client.query(`SELECT id
         FROM trades
        WHERE signal_id = $1
          AND direction = $2
          AND status IN ('filled', 'partial')
          AND (execution_mode IS NULL OR execution_mode != 'shadow')
          AND user_id IS NOT DISTINCT FROM $3
        ORDER BY executed_at DESC
        LIMIT 1`, [input.signalId, input.direction, normalizeTenantId(input.userId)]);
        let trade = existing.rows[0] ?? null;
        if (!trade) {
            const inserted = await client.query(INSERT_TRADE_SQL, getTradeValues({ ...input, status }));
            trade = inserted.rows[0] ?? null;
        }
        await client.query(`UPDATE signals
          SET status = 'executed',
              executed_at = NOW()
        WHERE id = $1`, [input.signalId]);
        return trade;
    });
}
/** Persist a terminal non-fill attempt and release its execution claim atomically. */
export async function insertTradeAndReleaseSignalClaim(input) {
    if (input.status === 'filled' || input.status === 'partial') {
        throw new Error('Confirmed trade quantities must execute their signal instead of releasing its claim');
    }
    if (input.executionMode === 'shadow') {
        throw new Error('Shadow trades do not own signal claims');
    }
    validatedFeeUsd(input);
    return withTransaction(async (client) => {
        const signal = await client.query(`SELECT id FROM signals WHERE id = $1 FOR UPDATE`, [input.signalId]);
        if (signal.rowCount !== 1) {
            throw new Error(`Signal ${input.signalId} does not exist`);
        }
        const inserted = await client.query(INSERT_TRADE_SQL, getTradeValues(input));
        await client.query(`UPDATE signals
          SET status = 'pending'
        WHERE id = $1
          AND status = 'executing'`, [input.signalId]);
        return inserted.rows[0] ?? null;
    });
}
/**
 * Advance a signal's lifecycle status (e.g. to 'executed' once a trade fills).
 */
export async function markSignalExecuted(signalId) {
    await query(`UPDATE signals
       SET status = 'executed',
           executed_at = NOW()
     WHERE id = $1`, [signalId]);
}
/**
 * Atomically claim a signal for execution. Sets status to 'executing' only if
 * it is pending, and returns true if THIS caller won the
 * claim. This is the idempotency guard that prevents a duplicate/re-delivered
 * signal from triggering a second (live) trade — it must be called BEFORE the
 * trade is placed. Returns false if the signal was already claimed/executed.
 */
export async function claimSignalForExecution(signalId) {
    const rows = await query(`UPDATE signals
       SET status = 'executing'
     WHERE id = $1
       AND status = 'pending'
     RETURNING id`, [signalId]);
    return rows.length > 0;
}
/** Revert a claim back to pending when execution fails, so it can be retried. */
export async function releaseSignalClaim(signalId) {
    await query(`UPDATE signals SET status = 'pending' WHERE id = $1 AND status = 'executing'`, [signalId]);
}
/**
 * Whether a filled buy for this token was placed within the last N minutes.
 * Used by the executor to suppress re-buying a token the system just bought
 * (a held position keeps re-triggering snipe signals after the dedupe window).
 *
 * Deliberately NOT tenant-scoped, and this is a known gap rather than an
 * oversight: with more than one tenant, user A's buy currently suppresses
 * user B's legitimate entry into the same token. Scoping it by `user_id` is a
 * change to a live risk/dedupe control, not a tenancy plumbing change, so
 * S4-10 leaves the semantics exactly as they are. Whoever owns the per-user
 * risk limits decides whether the window is per tenant, global, or both.
 */
export async function hasRecentBuy(tokenMint, withinMinutes) {
    const rows = await query(`SELECT EXISTS(
       SELECT 1 FROM trades
       WHERE token_mint = $1
         AND direction = 'buy'
         AND status IN ('filled', 'partial')
         AND (execution_mode IS NULL OR execution_mode != 'shadow')
         AND executed_at > NOW() - make_interval(mins => $2)
     ) AS exists`, [tokenMint, withinMinutes]);
    return rows[0]?.exists === true;
}
/**
 * USD bought on one chain by ONE tenant in the last 24 hours.
 *
 * ## Why this gained a parameter (`S4-M47`)
 *
 * It used to be `getRollingExposureUsd(chain)` with `WHERE chain = $1` alone, and the
 * comment above it argued the global sum was deliberately conservative. That argument
 * held while there was exactly one tenant. Under fan-out it inverts: **one user's
 * spending charges every other user's daily allowance**, so the first user to trade
 * hard silently caps the entire cohort, and the users who lose their allowance did
 * nothing and get no explanation. "Conservative" stops being a safety property when it
 * is another tenant's money being refused.
 *
 * This is the third of the checklist's §1 exceptions: there was no `account` argument
 * to substitute a user key into, so it is a signature change rather than a value
 * substitution.
 *
 * ## `account` here is the TENANCY COLUMN, not the risk-policy account label
 *
 * The executor has two `'operator'`-valued constants that must not be collapsed:
 * `RISK_POLICY_ACCOUNT` (a tenancy key that becomes the user id) and
 * `RECONCILIATION_ACCOUNT` (an escalation label that stays `'operator'`). This
 * parameter is a THIRD thing and belongs to neither: it is compared against
 * `trades.user_id`, a `users(id)` foreign key. So the call site passes the raw
 * `userId` -- **not** `riskPolicyAccountForUser(userId)`, which returns the literal
 * `'operator'` for the operator path and would be rejected here by
 * `normalizeTenantId` rather than quietly matching nothing.
 *
 * ## Scoped, not global-plus-scoped
 *
 * A per-tenant sum plus a separate platform-wide sum is a defensible design, but it is
 * a **risk-policy decision** (two limits, two thresholds, two alerts) and not this
 * change. `userDailyExposureCapUsd` in the executor pairs a per-user cap with this
 * per-user figure; a platform-wide ceiling on top of it is a distinct cap that should
 * be named and configured as one rather than smuggled in as a side effect of this sum.
 */
export async function getRollingExposureUsd(account, chain) {
    // `normalizeTenantId('')` returns `null`, i.e. the operator. That coercion is right
    // for a write path reading an optional column off a payload, and wrong here: an empty
    // string reaching a risk query means the caller *thought* it had a user, and answering
    // with the operator's rolling exposure would size a user's trade against somebody
    // else's ledger. Same reasoning as `riskPolicyAccountForUser`, which throws on `''`
    // rather than falling back to the operator key.
    if (account !== null && account.trim() === '') {
        throw new Error('getRollingExposureUsd requires a non-empty user id or null');
    }
    const userId = normalizeTenantId(account);
    const rows = await query(`SELECT SUM(amount_usd) AS total_usd
     FROM trades
     WHERE user_id IS NOT DISTINCT FROM $1
       AND chain = $2
       AND direction = 'buy'
       AND status IN ('filled', 'partial')
       AND (execution_mode IS NULL OR execution_mode != 'shadow')
       AND executed_at > NOW() - INTERVAL '24 hours'`, [userId, chain]);
    return parseFloat(rows[0]?.total_usd || '0');
}
//# sourceMappingURL=trades.js.map