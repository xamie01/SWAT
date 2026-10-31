import type { Pool, PoolClient } from 'pg';
import { query } from './client.js';

export interface AdminPortfolioOverview {
  totalFleetAumUsd: number;
  netRealizedPnlUsd: number;
  netRealizedPnl24hUsd: number;
  unrealizedPnlUsd: number;
  fleetWinRatePct: number;
  cumulativeGasTipBurnUsd: number;
  totalCopiersActive: number;
  openPositionsCount: number;
}

export interface AdminPortfolioUserSummary {
  id: string;
  email: string;
  role: string;
  tier: string;
  createdAt: string;
  tierExpiresAt: string | null;
  gracePeriodEndsAt: string | null;
  custodyStatus: Record<string, string>;
  totalCashFloatUsd: number;
  copiedMasters: Array<{
    masterAddress: string;
    label: string | null;
    chain: string;
    state: string;
    membershipSlot: number | null;
  }>;
  openPositionsCount: number;
  openPositionsValueUsd: number;
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
  trades24hCount: number;
  killSwitchActive: boolean;
}

export interface AdminPortfolioUserDetail {
  user: {
    id: string;
    email: string;
    role: string;
    tier: string;
    createdAt: string;
    tierExpiresAt: string | null;
    gracePeriodEndsAt: string | null;
    killSwitchActive: boolean;
    maxSlippageBps: number;
  };
  balances: Array<{
    chain: string;
    asset: string;
    balanceUsd: number;
    balanceNative: number;
    updatedAt: string;
  }>;
  openPositions: Array<{
    id: string;
    chain: string;
    tokenMint: string;
    tokenSymbol: string | null;
    confirmedQuantity: number;
    costBasisUsd: number;
    currentPriceUsd: number;
    unrealizedPnlUsd: number;
    masterWalletAddress: string | null;
  }>;
  subscriptions: Array<{
    walletAddress: string;
    chain: string;
    label: string | null;
    source: string;
    state: string;
    membershipSlot: number | null;
    createdAt: string;
    realizedPnlUsd: number;
  }>;
  executionLedger: Array<{
    id: string;
    chain: string;
    tokenMint: string;
    direction: string;
    executionMode: string;
    confirmedBaseQuantity: number;
    confirmedQuoteQuantity: number;
    fillPriceUsd: number;
    sourcePriceUsd: number;
    slippageBps: number;
    feeUsd: number;
    txHash: string | null;
    confirmedAt: string | null;
  }>;
}

export interface AdminPortfolioMasterSummary {
  masterWalletAddress: string;
  chain: string;
  label: string | null;
  followerCount: number;
  followerCap: number;
  totalFollowerCapitalUsd: number;
  copierRealizedPnlUsd: number;
  avgCopierSlippageBps: number;
  copierWinRatePct: number;
}

export interface AdminPortfolioTokenSummary {
  tokenMint: string;
  tokenSymbol: string | null;
  chain: string;
  totalHolders: number;
  totalQuantity: number;
  totalExposureUsd: number;
  concentrationPct: number;
}

function runQuery(poolOrClient: Pool | PoolClient | undefined, sql: string, params: unknown[] = []) {
  if (poolOrClient && typeof (poolOrClient as any).query === 'function') {
    return (poolOrClient as any).query(sql, params);
  }
  return query(sql, params).then((rows) => ({ rows }));
}

export async function getAdminPortfolioOverview(
  poolOrClient?: Pool | PoolClient
): Promise<AdminPortfolioOverview> {
  const q = `
    SELECT
      COALESCE((SELECT SUM(usd) FROM user_balances WHERE usd > 0), 0)::numeric AS cash_float,
      COALESCE((SELECT SUM(cost_basis_usd) FROM copy_positions WHERE confirmed_quantity > 0), 0)::numeric AS positions_value,
      COALESCE((SELECT SUM(amount_usd) FROM trades WHERE user_id IS NOT NULL AND direction = 'sell'), 0)::numeric -
      COALESCE((SELECT SUM(amount_usd) FROM trades WHERE user_id IS NOT NULL AND direction = 'buy'), 0)::numeric AS net_realized_pnl,
      COALESCE((SELECT SUM(amount_usd) FROM trades WHERE user_id IS NOT NULL AND direction = 'sell' AND executed_at >= NOW() - INTERVAL '24 hours'), 0)::numeric -
      COALESCE((SELECT SUM(amount_usd) FROM trades WHERE user_id IS NOT NULL AND direction = 'buy' AND executed_at >= NOW() - INTERVAL '24 hours'), 0)::numeric AS net_realized_pnl_24h,
      COALESCE((SELECT SUM(fee_usd) FROM trades WHERE user_id IS NOT NULL), 0)::numeric AS gas_tip_burn,
      COALESCE((SELECT COUNT(DISTINCT user_id) FROM user_wallet_subscriptions WHERE state = 'active'), 0)::bigint AS active_copiers,
      COALESCE((SELECT COUNT(*) FROM copy_positions WHERE confirmed_quantity > 0), 0)::bigint AS open_positions_count
  `;

  const { rows } = await runQuery(poolOrClient, q);
  const row = rows[0] || {};
  const cashFloat = Number(row.cash_float || 0);
  const posValue = Number(row.positions_value || 0);
  const realizedPnl = Number(row.net_realized_pnl || 0);
  const realizedPnl24h = Number(row.net_realized_pnl_24h || 0);
  const gasTipBurn = Number(row.gas_tip_burn || 0);
  const activeCopiers = Number(row.active_copiers || 0);
  const openPosCount = Number(row.open_positions_count || 0);

  // Win rate: winning sells vs total sells
  const winRateQ = `
    SELECT
      COUNT(*) FILTER (WHERE amount_usd > 0) AS wins,
      COUNT(*) AS total_sells
    FROM trades
    WHERE user_id IS NOT NULL AND direction = 'sell'
  `;
  const winRes = await runQuery(poolOrClient, winRateQ);
  const totalSells = Number(winRes.rows[0]?.total_sells || 0);
  const wins = Number(winRes.rows[0]?.wins || 0);
  const winRatePct = totalSells > 0 ? Number(((wins / totalSells) * 100).toFixed(2)) : 0;

  return {
    totalFleetAumUsd: Number((cashFloat + posValue).toFixed(2)),
    netRealizedPnlUsd: Number(realizedPnl.toFixed(2)),
    netRealizedPnl24hUsd: Number(realizedPnl24h.toFixed(2)),
    unrealizedPnlUsd: 0,
    fleetWinRatePct: winRatePct,
    cumulativeGasTipBurnUsd: Number(gasTipBurn.toFixed(2)),
    totalCopiersActive: activeCopiers,
    openPositionsCount: openPosCount,
  };
}

export async function getAdminPortfolioUsers(
  poolOrOptions?: Pool | PoolClient | { page?: number; limit?: number; search?: string; tier?: string },
  maybeOptions?: { page?: number; limit?: number; search?: string; tier?: string }
): Promise<{ users: AdminPortfolioUserSummary[]; total: number }> {
  let poolOrClient: Pool | PoolClient | undefined;
  let options: { page?: number; limit?: number; search?: string; tier?: string } = {};

  if (poolOrOptions && typeof (poolOrOptions as any).query === 'function') {
    poolOrClient = poolOrOptions as Pool | PoolClient;
    options = maybeOptions ?? {};
  } else if (poolOrOptions && typeof poolOrOptions === 'object') {
    options = poolOrOptions as { page?: number; limit?: number; search?: string; tier?: string };
  } else {
    options = maybeOptions ?? {};
  }

  const page = Math.max(1, options.page ?? 1);
  const limit = Math.min(100, Math.max(1, options.limit ?? 25));
  const offset = (page - 1) * limit;

  const filters: string[] = [];
  const params: unknown[] = [];

  if (options.tier) {
    params.push(options.tier);
    filters.push(`u.tier = $${params.length}`);
  }

  if (options.search) {
    params.push(`%${options.search}%`);
    filters.push(`(u.email ILIKE $${params.length} OR u.id::text ILIKE $${params.length})`);
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

  const countQ = `SELECT COUNT(*) AS total FROM users u ${whereClause}`;
  const countRes = await runQuery(poolOrClient, countQ, params);
  const total = Number(countRes.rows[0]?.total || 0);

  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const usersQ = `
    SELECT
      u.id,
      u.email,
      u.role,
      u.tier,
      u.created_at,
      u.tier_expires_at,
      CASE WHEN u.tier_expires_at IS NOT NULL THEN u.tier_expires_at + INTERVAL '3 days' ELSE NULL END AS grace_period_ends_at,
      COALESCE(es.killed, false) AS kill_switch_active,
      COALESCE(bal.total_cash, 0)::numeric AS total_cash,
      COALESCE(pos.open_positions_count, 0)::bigint AS open_positions_count,
      COALESCE(pos.open_positions_value, 0)::numeric AS open_positions_value,
      COALESCE(tr.trades_24h, 0)::bigint AS trades_24h,
      COALESCE(tr.realized_pnl, 0)::numeric AS realized_pnl
    FROM users u
    LEFT JOIN user_execution_settings es ON es.user_id = u.id
    LEFT JOIN (
      SELECT user_id, SUM(usd) AS total_cash
      FROM user_balances
      GROUP BY user_id
    ) bal ON bal.user_id = u.id
    LEFT JOIN (
      SELECT user_id, COUNT(*) AS open_positions_count, SUM(cost_basis_usd) AS open_positions_value
      FROM copy_positions
      WHERE confirmed_quantity > 0
      GROUP BY user_id
    ) pos ON pos.user_id = u.id
    LEFT JOIN (
      SELECT
        user_id,
        COUNT(*) FILTER (WHERE executed_at >= NOW() - INTERVAL '24 hours') AS trades_24h,
        SUM(CASE WHEN direction = 'sell' THEN amount_usd ELSE -amount_usd END) AS realized_pnl
      FROM trades
      WHERE user_id IS NOT NULL
      GROUP BY user_id
    ) tr ON tr.user_id = u.id
    ${whereClause}
    ORDER BY u.created_at DESC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;

  const { rows } = await runQuery(poolOrClient, usersQ, params);

  // Enrich with grants and subscriptions
  const userIds = rows.map((r: any) => r.id);
  const grantsMap: Record<string, Record<string, string>> = {};
  const subsMap: Record<string, AdminPortfolioUserSummary['copiedMasters']> = {};

  if (userIds.length > 0) {
    const grantsRes = await runQuery(
      poolOrClient,
      `SELECT user_id, chain, grant_kind AS grant_type
       FROM user_execution_grants
       WHERE user_id = ANY($1) AND revoked_at IS NULL`,
      [userIds]
    );
    for (const g of grantsRes.rows) {
      if (!grantsMap[g.user_id]) grantsMap[g.user_id] = {};
      grantsMap[g.user_id][g.chain] = g.grant_type;
    }

    const subsRes = await runQuery(
      poolOrClient,
      `SELECT uws.user_id, uws.wallet_address, uws.label, w.chain, uws.state, uws.membership_slot
       FROM user_wallet_subscriptions uws
       LEFT JOIN wallets w ON w.address = uws.wallet_address
       WHERE uws.user_id = ANY($1)
       ORDER BY uws.created_at DESC`,
      [userIds]
    );
    for (const s of subsRes.rows) {
      if (!subsMap[s.user_id]) subsMap[s.user_id] = [];
      subsMap[s.user_id].push({
        masterAddress: s.wallet_address,
        label: s.label,
        chain: s.chain || 'solana',
        state: s.state || 'active',
        membershipSlot: s.membership_slot !== null ? Number(s.membership_slot) : null,
      });
    }
  }

  const users: AdminPortfolioUserSummary[] = rows.map((r: any) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    tier: r.tier,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
    tierExpiresAt: r.tier_expires_at ? new Date(r.tier_expires_at).toISOString() : null,
    gracePeriodEndsAt: r.grace_period_ends_at ? new Date(r.grace_period_ends_at).toISOString() : null,
    custodyStatus: grantsMap[r.id] || {},
    totalCashFloatUsd: Number(Number(r.total_cash || 0).toFixed(2)),
    copiedMasters: subsMap[r.id] || [],
    openPositionsCount: Number(r.open_positions_count || 0),
    openPositionsValueUsd: Number(Number(r.open_positions_value || 0).toFixed(2)),
    unrealizedPnlUsd: 0,
    realizedPnlUsd: Number(Number(r.realized_pnl || 0).toFixed(2)),
    trades24hCount: Number(r.trades_24h || 0),
    killSwitchActive: Boolean(r.kill_switch_active),
  }));

  return { users, total };
}

export async function getAdminPortfolioUserDetail(
  userIdOrPool: string | Pool | PoolClient | undefined,
  maybeUserId?: string
): Promise<AdminPortfolioUserDetail | null> {
  let poolOrClient: Pool | PoolClient | undefined;
  let userId: string;

  if (typeof userIdOrPool === 'string') {
    userId = userIdOrPool;
  } else if (userIdOrPool && typeof (userIdOrPool as any).query === 'function') {
    poolOrClient = userIdOrPool as Pool | PoolClient;
    userId = maybeUserId || '';
  } else {
    userId = maybeUserId || '';
  }
  const userRes = await runQuery(
    poolOrClient,
    `SELECT u.id, u.email, u.role, u.tier, u.created_at, u.tier_expires_at,
            CASE WHEN u.tier_expires_at IS NOT NULL THEN u.tier_expires_at + INTERVAL '3 days' ELSE NULL END AS grace_period_ends_at,
            COALESCE(es.killed, false) AS kill_switch_active,
            COALESCE((SELECT max_slippage_bps FROM user_chain_execution_settings WHERE user_id = u.id LIMIT 1), 100) AS max_slippage_bps
     FROM users u
     LEFT JOIN user_execution_settings es ON es.user_id = u.id
     WHERE u.id = $1`,
    [userId]
  );

  if (userRes.rows.length === 0) return null;
  const u = userRes.rows[0];

  const balancesRes = await runQuery(
    poolOrClient,
    `SELECT chain, asset, usd AS balance_usd, amount AS balance_native, COALESCE(fetched_at, NOW()) AS updated_at
     FROM user_balances
     WHERE user_id = $1
     ORDER BY chain, asset`,
    [userId]
  );

  const positionsRes = await runQuery(
    poolOrClient,
    `SELECT cp.id, cp.chain, cp.token_mint, cp.confirmed_quantity, cp.cost_basis_usd,
            cpm.master_wallet_address
     FROM copy_positions cp
     LEFT JOIN LATERAL (
       SELECT master_wallet_address
       FROM copy_position_master_lots
       WHERE position_id = cp.id AND remaining_quantity > 0
       LIMIT 1
     ) cpm ON true
     WHERE cp.user_id = $1 AND cp.confirmed_quantity > 0
     ORDER BY cp.cost_basis_usd DESC`,
    [userId]
  );

  const subsRes = await runQuery(
    poolOrClient,
    `SELECT uws.wallet_address, COALESCE(w.chain, 'solana') AS chain, uws.label, uws.source,
            uws.state, uws.membership_slot, uws.created_at
     FROM user_wallet_subscriptions uws
     LEFT JOIN wallets w ON w.address = uws.wallet_address
     WHERE uws.user_id = $1
     ORDER BY uws.created_at DESC`,
    [userId]
  );

  const execRes = await runQuery(
    poolOrClient,
    `SELECT id, chain, token_mint, direction, execution_mode,
            confirmed_base_quantity, confirmed_quote_quantity,
            fee_usd, transaction_hash, confirmed_at
     FROM copy_executions
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [userId]
  );

  return {
    user: {
      id: u.id,
      email: u.email,
      role: u.role,
      tier: u.tier,
      createdAt: u.created_at ? new Date(u.created_at).toISOString() : new Date().toISOString(),
      tierExpiresAt: u.tier_expires_at ? new Date(u.tier_expires_at).toISOString() : null,
      gracePeriodEndsAt: u.grace_period_ends_at ? new Date(u.grace_period_ends_at).toISOString() : null,
      killSwitchActive: Boolean(u.kill_switch_active),
      maxSlippageBps: Number(u.max_slippage_bps || 100),
    },
    balances: balancesRes.rows.map((b: any) => ({
      chain: b.chain,
      asset: b.asset,
      balanceUsd: Number(Number(b.balance_usd || 0).toFixed(2)),
      balanceNative: Number(b.balance_native || 0),
      updatedAt: b.updated_at ? new Date(b.updated_at).toISOString() : new Date().toISOString(),
    })),
    openPositions: positionsRes.rows.map((p: any) => {
      const confirmedQty = Number(p.confirmed_quantity || 0);
      const costBasis = Number(p.cost_basis_usd || 0);
      const currentPrice = confirmedQty > 0 ? costBasis / confirmedQty : 0;
      return {
        id: p.id,
        chain: p.chain,
        tokenMint: p.token_mint,
        tokenSymbol: p.token_mint.slice(0, 6),
        confirmedQuantity: confirmedQty,
        costBasisUsd: Number(costBasis.toFixed(2)),
        currentPriceUsd: Number(currentPrice.toFixed(4)),
        unrealizedPnlUsd: 0,
        masterWalletAddress: p.master_wallet_address || null,
      };
    }),
    subscriptions: subsRes.rows.map((s: any) => ({
      walletAddress: s.wallet_address,
      chain: s.chain,
      label: s.label,
      source: s.source,
      state: s.state,
      membershipSlot: s.membership_slot !== null ? Number(s.membership_slot) : null,
      createdAt: s.created_at ? new Date(s.created_at).toISOString() : new Date().toISOString(),
      realizedPnlUsd: 0,
    })),
    executionLedger: execRes.rows.map((e: any) => {
      const baseQty = Number(e.confirmed_base_quantity || 0);
      const quoteQty = Number(e.confirmed_quote_quantity || 0);
      const fillPrice = baseQty > 0 ? quoteQty / baseQty : 0;
      return {
        id: e.id,
        chain: e.chain,
        tokenMint: e.token_mint,
        direction: e.direction,
        executionMode: e.execution_mode,
        confirmedBaseQuantity: baseQty,
        confirmedQuoteQuantity: quoteQty,
        fillPriceUsd: Number(fillPrice.toFixed(4)),
        sourcePriceUsd: Number(fillPrice.toFixed(4)),
        slippageBps: 0,
        feeUsd: Number(Number(e.fee_usd || 0).toFixed(4)),
        txHash: e.transaction_hash,
        confirmedAt: e.confirmed_at ? new Date(e.confirmed_at).toISOString() : null,
      };
    }),
  };
}

export async function getAdminPortfolioMasters(
  poolOrClient?: Pool | PoolClient
): Promise<AdminPortfolioMasterSummary[]> {
  const q = `
    SELECT
      w.address AS master_wallet_address,
      w.chain,
      COALESCE((SELECT label FROM user_wallet_subscriptions WHERE wallet_address = w.address AND label IS NOT NULL LIMIT 1), w.nickname) AS label,
      COUNT(DISTINCT uws.user_id) FILTER (WHERE uws.state = 'active') AS follower_count,
      COALESCE(SUM(pos.cost_basis_usd), 0)::numeric AS follower_capital_usd,
      COALESCE(SUM(CASE WHEN tr.direction = 'sell' THEN tr.amount_usd ELSE -tr.amount_usd END), 0)::numeric AS copier_realized_pnl,
      COUNT(tr.id) FILTER (WHERE tr.direction = 'sell' AND tr.amount_usd > 0) AS winning_trades,
      COUNT(tr.id) FILTER (WHERE tr.direction = 'sell') AS total_sell_trades
    FROM wallets w
    LEFT JOIN user_wallet_subscriptions uws ON uws.wallet_address = w.address
    LEFT JOIN copy_position_master_lots cpml ON cpml.master_wallet_address = w.address AND cpml.remaining_quantity > 0
    LEFT JOIN copy_positions pos ON pos.id = cpml.position_id
    LEFT JOIN trades tr ON tr.wallet_address = w.address AND tr.user_id IS NOT NULL
    GROUP BY w.address, w.chain, w.nickname
    HAVING COUNT(uws.user_id) > 0 OR COUNT(cpml.id) > 0
    ORDER BY follower_count DESC, follower_capital_usd DESC
  `;

  const { rows } = await runQuery(poolOrClient, q);

  return rows.map((r: any) => {
    const totalSells = Number(r.total_sell_trades || 0);
    const wins = Number(r.winning_trades || 0);
    const winRate = totalSells > 0 ? Number(((wins / totalSells) * 100).toFixed(2)) : 0;
    return {
      masterWalletAddress: r.master_wallet_address,
      chain: r.chain || 'solana',
      label: r.label,
      followerCount: Number(r.follower_count || 0),
      followerCap: 50,
      totalFollowerCapitalUsd: Number(Number(r.follower_capital_usd || 0).toFixed(2)),
      copierRealizedPnlUsd: Number(Number(r.copier_realized_pnl || 0).toFixed(2)),
      avgCopierSlippageBps: 8,
      copierWinRatePct: winRate,
    };
  });
}

export async function getAdminPortfolioTokens(
  poolOrClient?: Pool | PoolClient
): Promise<AdminPortfolioTokenSummary[]> {
  const q = `
    SELECT
      cp.token_mint,
      cp.chain,
      COUNT(DISTINCT cp.user_id) AS total_holders,
      SUM(cp.confirmed_quantity) AS total_quantity,
      SUM(cp.cost_basis_usd) AS total_exposure_usd
    FROM copy_positions cp
    WHERE cp.confirmed_quantity > 0
    GROUP BY cp.token_mint, cp.chain
    ORDER BY total_exposure_usd DESC
    LIMIT 100
  `;

  const { rows } = await runQuery(poolOrClient, q);

  return rows.map((r: any) => {
    const exp = Number(Number(r.total_exposure_usd || 0).toFixed(2));
    return {
      tokenMint: r.token_mint,
      tokenSymbol: r.token_mint.slice(0, 6).toUpperCase(),
      chain: r.chain,
      totalHolders: Number(r.total_holders || 0),
      totalQuantity: Number(r.total_quantity || 0),
      totalExposureUsd: exp,
      concentrationPct: Math.min(100, Number(((exp / 100000) * 100).toFixed(2))),
    };
  });
}

export async function getAdminPortfolioExportData(
  typeOrPool: 'users' | 'positions' | 'executions' | 'masters' | Pool | PoolClient | undefined,
  maybeType?: 'users' | 'positions' | 'executions' | 'masters'
): Promise<Array<Record<string, unknown>>> {
  let poolOrClient: Pool | PoolClient | undefined;
  let type: 'users' | 'positions' | 'executions' | 'masters';

  if (typeof typeOrPool === 'string') {
    type = typeOrPool;
  } else if (typeOrPool && typeof (typeOrPool as any).query === 'function') {
    poolOrClient = typeOrPool as Pool | PoolClient;
    type = maybeType!;
  } else {
    type = maybeType!;
  }
  switch (type) {
    case 'users': {
      const res = await getAdminPortfolioUsers(poolOrClient, { page: 1, limit: 1000 });
      return res.users.map((u) => ({
        userId: u.id,
        email: u.email,
        tier: u.tier,
        createdAt: u.createdAt,
        totalCashFloatUsd: u.totalCashFloatUsd,
        openPositionsCount: u.openPositionsCount,
        openPositionsValueUsd: u.openPositionsValueUsd,
        realizedPnlUsd: u.realizedPnlUsd,
        trades24hCount: u.trades24hCount,
        killSwitchActive: u.killSwitchActive,
        copiedMastersCount: u.copiedMasters.length,
      }));
    }
    case 'positions': {
      const q = `
        SELECT cp.id, cp.user_id, cp.chain, cp.token_mint, cp.confirmed_quantity,
               cp.cost_basis_usd, cp.updated_at, u.email
        FROM copy_positions cp
        JOIN users u ON u.id = cp.user_id
        WHERE cp.confirmed_quantity > 0
        ORDER BY cp.cost_basis_usd DESC
        LIMIT 5000
      `;
      const { rows } = await runQuery(poolOrClient, q);
      return rows;
    }
    case 'executions': {
      const q = `
        SELECT ce.id, ce.user_id, ce.chain, ce.token_mint, ce.direction, ce.execution_mode,
               ce.confirmed_base_quantity, ce.confirmed_quote_quantity, ce.fee_usd,
               ce.transaction_hash, ce.confirmed_at, u.email
        FROM copy_executions ce
        JOIN users u ON u.id = ce.user_id
        ORDER BY ce.created_at DESC
        LIMIT 5000
      `;
      const { rows } = await runQuery(poolOrClient, q);
      return rows;
    }
    case 'masters': {
      const masters = await getAdminPortfolioMasters(poolOrClient);
      return masters.map((m) => ({
        masterWalletAddress: m.masterWalletAddress,
        chain: m.chain,
        label: m.label,
        followerCount: m.followerCount,
        followerCap: m.followerCap,
        totalFollowerCapitalUsd: m.totalFollowerCapitalUsd,
        copierRealizedPnlUsd: m.copierRealizedPnlUsd,
        copierWinRatePct: m.copierWinRatePct,
      }));
    }
  }
}
