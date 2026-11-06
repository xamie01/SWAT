import { query } from './client.js';
function toSubscription(row) {
    return {
        id: row.id,
        userId: row.user_id,
        masterWalletAddress: row.master_wallet_address,
        chain: row.chain,
        venue: row.venue,
        allocatedBudgetUsd: Number(row.allocated_budget_usd),
        maxCapitalPerPositionUsd: Number(row.max_capital_per_position_usd),
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}
function toExecution(row) {
    return {
        id: row.id,
        subscriptionId: row.subscription_id,
        userId: row.user_id,
        masterPositionId: row.master_position_id,
        followerPositionId: row.follower_position_id,
        chain: row.chain,
        action: row.action,
        masterDepositUsd: Number(row.master_deposit_usd),
        followerDepositUsd: Number(row.follower_deposit_usd),
        scaleRatio: Number(row.scale_ratio),
        status: row.status,
        errorMessage: row.error_message,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}
export async function createLpCopySubscription(scope, input) {
    if (input.allocatedBudgetUsd <= 0 || input.maxCapitalPerPositionUsd <= 0) {
        throw new Error('Budget and max capital per position must be strictly positive');
    }
    const rows = await query(`INSERT INTO lp_copy_subscriptions (
       user_id, master_wallet_address, chain, venue, allocated_budget_usd, max_capital_per_position_usd, status
     )
     VALUES ($1, $2, $3, $4, $5, $6, 'active')
     ON CONFLICT (user_id, master_wallet_address, chain, venue)
     DO UPDATE SET
       allocated_budget_usd = EXCLUDED.allocated_budget_usd,
       max_capital_per_position_usd = EXCLUDED.max_capital_per_position_usd,
       status = 'active',
       updated_at = NOW()
     RETURNING *`, [
        scope.userId,
        input.masterWalletAddress,
        input.chain,
        input.venue,
        input.allocatedBudgetUsd,
        input.maxCapitalPerPositionUsd
    ]);
    return toSubscription(rows[0]);
}
export async function getLpCopySubscription(scope, id) {
    const rows = await query(`SELECT * FROM lp_copy_subscriptions WHERE id = $1 AND user_id = $2`, [id, scope.userId]);
    return rows[0] ? toSubscription(rows[0]) : null;
}
export async function listLpCopySubscriptions(scope, status) {
    const params = [scope.userId];
    let sql = `SELECT * FROM lp_copy_subscriptions WHERE user_id = $1`;
    if (status) {
        params.push(status);
        sql += ` AND status = $2`;
    }
    sql += ` ORDER BY created_at DESC`;
    const rows = await query(sql, params);
    return rows.map(toSubscription);
}
export async function listActiveFollowersForMaster(masterWalletAddress, chain, venue) {
    const rows = await query(`SELECT * FROM lp_copy_subscriptions
     WHERE master_wallet_address = $1 AND chain = $2 AND venue = $3 AND status = 'active'
     ORDER BY created_at ASC`, [masterWalletAddress, chain, venue]);
    return rows.map(toSubscription);
}
export async function updateLpCopySubscriptionStatus(scope, id, status) {
    const rows = await query(`UPDATE lp_copy_subscriptions
     SET status = $1, updated_at = NOW()
     WHERE id = $2 AND user_id = $3
     RETURNING *`, [status, id, scope.userId]);
    return rows[0] ? toSubscription(rows[0]) : null;
}
export async function createLpCopyExecution(input) {
    const rows = await query(`INSERT INTO lp_copy_executions (
       subscription_id, user_id, master_position_id, follower_position_id, chain,
       action, master_deposit_usd, follower_deposit_usd, scale_ratio, status, error_message
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`, [
        input.subscriptionId,
        input.userId,
        input.masterPositionId,
        input.followerPositionId ?? null,
        input.chain,
        input.action,
        input.masterDepositUsd ?? 0,
        input.followerDepositUsd ?? 0,
        input.scaleRatio ?? 1.0,
        input.status ?? 'pending',
        input.errorMessage ?? null
    ]);
    return toExecution(rows[0]);
}
export async function updateLpCopyExecutionStatus(id, status, errorMessage) {
    const result = await query(`UPDATE lp_copy_executions
     SET status = $1, error_message = $2, updated_at = NOW()
     WHERE id = $3`, [status, errorMessage ?? null, id]);
    return result.rowCount ? result.rowCount > 0 : true;
}
export async function listLpCopyExecutions(scope, subscriptionId) {
    const params = [scope.userId];
    let sql = `SELECT * FROM lp_copy_executions WHERE user_id = $1`;
    if (subscriptionId) {
        params.push(subscriptionId);
        sql += ` AND subscription_id = $2`;
    }
    sql += ` ORDER BY created_at DESC LIMIT 100`;
    const rows = await query(sql, params);
    return rows.map(toExecution);
}
//# sourceMappingURL=lp-copy-trading.js.map