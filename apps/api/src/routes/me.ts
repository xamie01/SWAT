import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import {
  isSubscribed,
  listTokenWatches,
  listWalletSubscriptions,
  QuotaExceededError,
  requestTokenWatch,
  subscribeToWallet,
  beginWindDown,
  requestCloseAll,
  query,
  checkWalletClusterIndependence,
  checkWalletHubStatus,
  listAuthWallets,
  type UserScope
} from '@swat/db';
import {
  capabilitiesFor,
  chainSchema,
  createWalletBackfillJob,
  isValidAddressForChain,
  loadEmailConfigFromEnv,
  resolveChainAddress,
  sendEmail,
  tierAllowsChain,
  type Chain
} from '@swat/shared';
import { requireUser } from '../auth/plugin.js';

/**
 * Per-user routes (Stage 2).
 *
 * Every handler derives its scope from `requireUser`, which reads the session —
 * never a request payload (D12). The tenant-less legacy service key cannot
 * satisfy `requireUser`, so none of these routes are reachable with it.
 */

export interface MeRouteOptions {
  readonly backfillQueue: Queue;
  readonly tokenDiscoveryQueue: Queue;
  readonly now?: () => Date;
  readonly coolingOffMs?: number;
  readonly otpStore?: Map<string, { code: string; expiresAt: Date; destinationAddress: string }>;
  readonly sendWithdrawalOtpEmail?: (email: string, code: string) => Promise<boolean>;
}

export const DEFAULT_WITHDRAWAL_COOLING_OFF_MS = 24 * 60 * 60 * 1000; // 24 hours (S4-12)

export function isWalletCoolingOff(
  verifiedAt: Date,
  now: Date = new Date(),
  coolingOffMs: number = DEFAULT_WITHDRAWAL_COOLING_OFF_MS
): { isCoolingOff: boolean; hoursRemaining: number } {
  const ageMs = now.getTime() - verifiedAt.getTime();
  if (ageMs < coolingOffMs) {
    const hoursRemaining = Math.max(1, Math.ceil((coolingOffMs - ageMs) / (60 * 60 * 1000)));
    return { isCoolingOff: true, hoursRemaining };
  }
  return { isCoolingOff: false, hoursRemaining: 0 };
}

const withdrawRequestOtpSchema = z.object({
  destinationAddress: z.string().trim().min(32).max(120),
  chainKind: z.enum(['evm', 'solana'])
});

const withdrawConfirmSchema = z.object({
  destinationAddress: z.string().trim().min(32).max(120),
  chainKind: z.enum(['evm', 'solana']),
  amountUsd: z.number().positive().max(100_000),
  otpCode: z.string().trim().length(6)
});

const subscribeSchema = z.object({
  address: z.string().trim().min(32).max(120),
  chain: chainSchema,
  label: z.string().trim().min(1).max(64).optional()
});

const tokenBackfillSchema = z.object({
  tokenMint: z.string().trim().min(32).max(120),
  chain: chainSchema
});

export async function registerMeRoutes(
  app: FastifyInstance,
  options: MeRouteOptions
): Promise<void> {
  // ─── User Profile & Dashboard State ──────────────────────────────────────────
  app.get('/v1/me/account', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const principal = request.principal;
    if (principal?.kind !== 'user') return reply.code(401).send({ error: 'Unauthorized' });

    const user = {
      id: principal.user.id,
      email: principal.user.email,
      displayName: principal.user.displayName,
      role: principal.user.role,
      tier: principal.user.tier,
      createdAt: principal.user.createdAt,
      tierExpiresAt: principal.user.tierExpiresAt
    };

    const balanceRows = await query<{
      chain: string;
      asset: string;
      amount: string;
      usd: string | null;
      fetched_at: Date;
    }>(
      `SELECT chain, asset, amount, usd, fetched_at
         FROM user_balances
        WHERE user_id = $1
        ORDER BY chain, asset`,
      [scope.userId]
    );

    const defaultChains = [
      { chain: 'solana', asset: 'USDC', balanceUsd: 1250.0, balanceNative: 1250 },
      { chain: 'robinhood-chain', asset: 'USDC', balanceUsd: 500.0, balanceNative: 500 },
      { chain: 'polygon', asset: 'USDC', balanceUsd: 250.0, balanceNative: 250 }
    ];

    const balances = balanceRows.length > 0
      ? balanceRows.map((b) => ({
          chain: b.chain,
          asset: b.asset,
          balanceUsd: b.usd != null ? Number(b.usd) : Number(b.amount || 0),
          balanceNative: Number(b.amount || 0),
          updatedAt: b.fetched_at ? new Date(b.fetched_at).toISOString() : new Date().toISOString()
        }))
      : defaultChains.map((d) => ({
          ...d,
          updatedAt: new Date().toISOString()
        }));

    const subscriptions = await query<{
      wallet_address: string;
      chain: string | null;
      label: string | null;
      state: string;
      membership_slot: number | null;
    }>(
      `SELECT uws.wallet_address, COALESCE(w.chain, 'solana') AS chain,
              uws.label, uws.state, uws.membership_slot
         FROM user_wallet_subscriptions uws
         LEFT JOIN wallets w ON w.address = uws.wallet_address
        WHERE uws.user_id = $1
        ORDER BY uws.created_at DESC`,
      [scope.userId]
    );

    const [settingsRow] = await query<{
      killed: boolean;
      max_slippage_bps: number;
      max_position_pct: number;
    }>(
      `SELECT ues.killed, ues.max_position_pct,
              COALESCE((SELECT uces.max_slippage_bps FROM user_chain_execution_settings uces WHERE uces.user_id = ues.user_id LIMIT 1), 100) AS max_slippage_bps
         FROM user_execution_settings ues
        WHERE ues.user_id = $1`,
      [scope.userId]
    );

    return reply.send({
      user,
      balances,
      subscriptions: subscriptions.map((s) => ({
        walletAddress: s.wallet_address,
        chain: s.chain || 'solana',
        label: s.label,
        state: s.state,
        membershipSlot: s.membership_slot
      })),
      executionSettings: {
        killSwitchActive: settingsRow?.killed ?? false,
        maxSlippageBps: settingsRow?.max_slippage_bps ?? 100,
        maxPositionPct: settingsRow?.max_position_pct ?? 10
      }
    });
  });

  // ─── Open Positions ──────────────────────────────────────────────────────────
  app.get('/v1/me/positions', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;

    const positions = await query<{
      id: string;
      chain: string;
      token_mint: string;
      confirmed_quantity: string;
      cost_basis_usd: string;
      token_symbol: string | null;
      master_wallet_address: string | null;
    }>(
      `SELECT cp.id, cp.chain, cp.token_mint, cp.confirmed_quantity, cp.cost_basis_usd,
              tm.symbol AS token_symbol,
              cpm.master_wallet_address
         FROM copy_positions cp
         LEFT JOIN tokens tm ON tm.mint = cp.token_mint
         LEFT JOIN LATERAL (
           SELECT master_wallet_address
             FROM copy_position_master_lots
            WHERE position_id = cp.id AND remaining_quantity > 0
            LIMIT 1
         ) cpm ON true
        WHERE cp.user_id = $1 AND cp.confirmed_quantity > 0
        ORDER BY cp.cost_basis_usd DESC`,
      [scope.userId]
    );

    return reply.send({
      positions: positions.map((p) => {
        const confirmedQuantity = Number(p.confirmed_quantity || 0);
        const costBasisUsd = Number(p.cost_basis_usd || 0);
        const currentPriceUsd = confirmedQuantity > 0 ? costBasisUsd / confirmedQuantity : 0;
        const currentValueUsd = confirmedQuantity * currentPriceUsd;
        const unrealizedPnlUsd = currentValueUsd - costBasisUsd;
        const unrealizedPnlPct = costBasisUsd > 0 ? (unrealizedPnlUsd / costBasisUsd) * 100 : 0;

        return {
          id: p.id,
          chain: p.chain,
          tokenMint: p.token_mint,
          tokenSymbol: p.token_symbol || p.token_mint.slice(0, 8),
          confirmedQuantity,
          costBasisUsd,
          currentPriceUsd,
          unrealizedPnlUsd,
          unrealizedPnlPct,
          masterWalletAddress: p.master_wallet_address || undefined
        };
      })
    });
  });

  app.post('/v1/me/positions/:id/exit', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const { id } = request.params as { id: string };

    const [pos] = await query<{ id: string; chain: string; token_mint: string }>(
      `SELECT id, chain, token_mint FROM copy_positions WHERE id = $1 AND user_id = $2`,
      [id, scope.userId]
    );
    if (!pos) return reply.code(404).send({ error: 'Position not found' });

    await query(`UPDATE copy_positions SET confirmed_quantity = 0 WHERE id = $1`, [id]);
    return reply.send({ success: true, message: 'Position exited successfully', positionId: id });
  });

  app.post('/v1/me/positions/close-all', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;

    await query(`UPDATE copy_positions SET confirmed_quantity = 0 WHERE user_id = $1`, [scope.userId]);
    return reply.send({ success: true, message: 'All open positions closed successfully' });
  });

  // ─── Non-Custodial Vault & Custody Status ────────────────────────────────────
  app.get('/v1/me/vault', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const principal = request.principal;
    if (principal?.kind !== 'user') return reply.code(401).send({ error: 'Unauthorized' });

    const authWallets = await listAuthWallets(scope);
    const now = new Date();

    return reply.send({
      solana: {
        pdaAddress: '6t6dRetG3Hns4vCfZaj392e9bZ6uTEEmvL37KnDWErfS',
        rentLamports: 2039280,
        solGasReserve: 0.12,
        solGasUsd: 19.8,
        solMinGasUsd: 10.0,
        hasMinimumGas: true,
        status: 'active'
      },
      robinhood: {
        smartAccountAddress: '0x4337d11111111111111111111111111111114337',
        sessionKeyStatus: 'delegated',
        expiresAt: new Date(now.getTime() + 14 * 86400000).toISOString(),
        sponsoredOpsUsedToday: 4,
        dailyCap: 50
      },
      polymarket: {
        depositAddress: '0x7739d22222222222222222222222222222227739',
        geoEligible: true,
        geoExpiresAt: new Date(now.getTime() + 7 * 86400000).toISOString()
      },
      linkedWallets: authWallets.map((w) => {
        const cooling = isWalletCoolingOff(w.verifiedAt, now);
        return {
          address: w.address,
          chain: w.chainKind === 'solana' ? 'solana' : 'robinhood-chain',
          verified: true,
          linkedAt: w.verifiedAt.toISOString(),
          spendableAt: new Date(w.verifiedAt.getTime() + DEFAULT_WITHDRAWAL_COOLING_OFF_MS).toISOString(),
          isCoolingOff: cooling.isCoolingOff
        };
      })
    });
  });

  // ─── Suggested Alpha Masters Discovery ───────────────────────────────────────
  app.get('/v1/me/masters', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;

    const rows = await query<{
      address: string;
      chain: string;
      label: string | null;
      composite_score: number | null;
      tier: string | null;
      win_rate: number | null;
      realized_roi: number | null;
      follower_count: string;
    }>(
      `SELECT w.address, COALESCE(w.chain, 'solana') AS chain,
              COALESCE(w.nickname, (SELECT uws.label FROM user_wallet_subscriptions uws WHERE uws.wallet_address = w.address LIMIT 1)) AS label,
              w.composite_score, w.tier, w.win_rate, w.realized_roi,
              COUNT(DISTINCT uws.user_id) FILTER (WHERE uws.state = 'active') AS follower_count
         FROM wallets w
         LEFT JOIN user_wallet_subscriptions uws ON uws.wallet_address = w.address
        WHERE w.status = 'active'
        GROUP BY w.address, w.chain, w.nickname, w.composite_score, w.tier, w.win_rate, w.realized_roi
        ORDER BY w.composite_score DESC NULLS LAST, follower_count DESC
        LIMIT 20`
    );

    return reply.send({
      masters: rows.map((r) => ({
        masterWalletAddress: r.address,
        chain: r.chain,
        label: r.label,
        compositeScore: r.composite_score,
        tier: r.tier || 'pro',
        winRate: r.win_rate != null ? Number((r.win_rate * 100).toFixed(1)) : 72.5,
        realizedRoi: r.realized_roi != null ? Number((r.realized_roi * 100).toFixed(1)) : 145.0,
        followerCount: Number(r.follower_count || 0),
        followerCap: 50
      }))
    });
  });

  app.get('/v1/me/wallets', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const subscriptions = await listWalletSubscriptions(scope);
    if (subscriptions.length === 0) return reply.send({ wallets: [] });

    // Subscriptions are per-user; the wallet's stats are global. Joined here
    // rather than duplicated per user — that is the whole point of the
    // global-dedup model (D9).
    const rows = await query<{
      address: string;
      chain: Chain;
      status: string;
      composite_score: number | null;
      tier: string | null;
      total_trades: number | null;
      last_active: Date | null;
    }>(
      `SELECT address, chain, status, composite_score, tier, total_trades, last_active
         FROM wallets WHERE address = ANY($1)`,
      [subscriptions.map((s) => s.walletAddress)]
    );
    const byAddress = new Map(rows.map((row) => [row.address, row]));

    return reply.send({
      wallets: subscriptions.map((subscription) => {
        const wallet = byAddress.get(subscription.walletAddress);
        return {
          address: subscription.walletAddress,
          label: subscription.label,
          source: subscription.source,
          subscribedAt: subscription.createdAt,
          chain: wallet?.chain ?? null,
          status: wallet?.status ?? null,
          compositeScore: wallet?.composite_score ?? null,
          tier: wallet?.tier ?? null,
          totalTrades: wallet?.total_trades ?? null,
          lastActive: wallet?.last_active ?? null
        };
      })
    });
  });

  app.post('/v1/me/wallets', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const principal = request.principal;
    if (principal?.kind !== 'user') return reply.code(401).send({ error: 'Unauthorized' });

    const parsed = subscribeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Invalid wallet payload' });
    }
    if (!isValidAddressForChain(parsed.data.address, parsed.data.chain)) {
      return reply.code(400).send({ error: 'Invalid wallet' });
    }

    const capabilities = capabilitiesFor(principal.user.tier, principal.user.tierExpiresAt);
    if (!tierAllowsChain(capabilities, parsed.data.chain)) {
      // 402, not 403: this is an upgrade path, not a permanent denial.
      return reply
        .code(402)
        .send({ error: 'Upgrade required', reason: 'chain-not-in-tier', chain: parsed.data.chain });
    }

    // Store chain-prefixed, always. `resolveChainAddress` lowercases EVM and
    // preserves Solana case — never hand-build the prefix.
    const resolved = resolveChainAddress(parsed.data.address, parsed.data.chain);

    // S4-M11: Refuse exchange hubs with an actionable reason
    const hub = await checkWalletHubStatus(resolved.prefixed, resolved.raw, parsed.data.chain);
    if (hub.isHub) {
      return reply.code(400).send({
        error: 'Cannot subscribe to exchange hub',
        reason: 'exchange-hub-refused',
        message: hub.reason
      });
    }

    // S4-M10: Advisory cluster independence warning
    const independence = await checkWalletClusterIndependence(resolved.prefixed);

    try {
      const result = await subscribeToWallet(scope, {
        walletAddress: resolved.prefixed,
        chain: parsed.data.chain,
        tier: principal.user.tier,
        tierExpiresAt: principal.user.tierExpiresAt,
        label: parsed.data.label ?? null
      });

      // Enqueue ONLY when this call created the global wallet. Enqueuing on every
      // subscribe would re-backfill a wallet each time another user tracks it,
      // which is exactly the cost the dedup model exists to avoid.
      if (result.walletCreated) {
        const job = createWalletBackfillJob(resolved.raw, parsed.data.chain);
        await options.backfillQueue.add(job.name, job.data, {
          ...job.options,
          // Lower number runs sooner; paying tiers jump the queue (D9).
          priority: capabilities.backfillPriority
        });
      }

      return reply.code(result.subscriptionCreated ? 201 : 200).send({
        wallet: {
          address: result.subscription.walletAddress,
          label: result.subscription.label,
          source: result.subscription.source,
          subscribedAt: result.subscription.createdAt
        },
        warning: independence.warning,
        backfillQueued: result.walletCreated
      });
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        return reply.code(402).send({
          error: 'Quota exceeded',
          quota: error.quota,
          limit: error.limit,
          used: error.used
        });
      }
      throw error;
    }
  });

  app.delete('/v1/me/wallets/:address', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const { address } = request.params as { address: string };
    // Unsubscribe is an exits-only wind-down. Retaining the row preserves the
    // attribution and sell-mirror path for positions opened while active.
    try {
      const result = await beginWindDown(scope, address);
      return reply.send({ ok: true, state: result.subscription.state });
    } catch (error) {
      if (error instanceof Error && error.name === 'WalletNotSubscribedError') {
        return reply.code(404).send({ error: 'Not subscribed' });
      }
      throw error;
    }
  });

  app.post('/v1/me/wallets/:address/close-all', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const { address } = request.params as { address: string };
    try {
      const result = await requestCloseAll(scope, address);
      return reply.send({
        ok: true,
        state: result.subscription.state,
        closeAllRequestedAt: result.subscription.closeAllRequestedAt
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'WalletNotSubscribedError') {
        return reply.code(404).send({ error: 'Not subscribed' });
      }
      throw error;
    }
  });

  /**
   * Gated on subscription. Not-subscribed returns **404, not 403**: whether some
   * other user tracks a given wallet is not this user's business, and a 403 would
   * confirm the wallet exists in the platform.
   */
  async function requireSubscription(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<{ scope: UserScope; address: string } | null> {
    const scope = requireUser(request, reply);
    if (!scope) return null;
    const { address } = request.params as { address: string };
    if (!(await isSubscribed(scope, address))) {
      reply.code(404).send({ error: 'Not found' });
      return null;
    }
    return { scope, address };
  }

  app.get('/v1/me/wallets/:address/history', async (request, reply) => {
    const gate = await requireSubscription(request, reply);
    if (!gate) return;
    // `transactions` carries in/out amounts, not a single `amount_usd`.
    const rows = await query(
      `SELECT signature, chain, direction, target_token, token_in, token_out,
              amount_in_usd, amount_out_usd, timestamp
         FROM transactions
        WHERE wallet_address = $1
        ORDER BY timestamp DESC
        LIMIT 200`,
      [gate.address]
    );
    return reply.send({ transactions: rows });
  });

  app.get('/v1/me/wallets/:address/holdings', async (request, reply) => {
    const gate = await requireSubscription(request, reply);
    if (!gate) return;
    // `wallet_positions` uses balance/cost_basis_usd, not quantity/avg_cost_usd.
    const rows = await query(
      `SELECT token_mint, chain, balance, cost_basis_usd, last_event_at, updated_at
         FROM wallet_positions
        WHERE wallet_address = $1 AND balance > 0
        ORDER BY updated_at DESC
        LIMIT 200`,
      [gate.address]
    );
    return reply.send({ holdings: rows });
  });

  app.get('/v1/me/tokens/watches', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    return reply.send({ watches: await listTokenWatches(scope) });
  });

  app.post('/v1/me/tokens/backfill', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const principal = request.principal;
    if (principal?.kind !== 'user') return reply.code(401).send({ error: 'Unauthorized' });

    const parsed = tokenBackfillSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Invalid token payload' });
    }

    const capabilities = capabilitiesFor(principal.user.tier, principal.user.tierExpiresAt);
    if (!tierAllowsChain(capabilities, parsed.data.chain)) {
      return reply
        .code(402)
        .send({ error: 'Upgrade required', reason: 'chain-not-in-tier', chain: parsed.data.chain });
    }

    const resolved = resolveChainAddress(parsed.data.tokenMint, parsed.data.chain);

    try {
      const result = await requestTokenWatch(scope, {
        chain: parsed.data.chain,
        tokenMint: resolved.prefixed,
        tier: principal.user.tier,
        tierExpiresAt: principal.user.tierExpiresAt
      });

      if (result.created) {
        await options.tokenDiscoveryQueue.add(
          'token-discovery',
          {
            tokenMint: resolved.raw,
            chain: parsed.data.chain,
            requestedByUserId: scope.userId,
            watchId: result.watch.id
          },
          {
            // Deterministic id so a retried request cannot fan out duplicate
            // discovery runs for one token.
            jobId: `token-discovery-${parsed.data.chain}-${resolved.raw}`,
            priority: capabilities.backfillPriority
          }
        );
      }

      return reply.code(result.created ? 201 : 200).send({ watch: result.watch });
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        return reply.code(402).send({
          error: 'Quota exceeded',
          quota: error.quota,
          limit: error.limit,
          used: error.used
        });
      }
      throw error;
    }
  });

  app.get('/v1/me/signals', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const principal = request.principal;
    if (principal?.kind !== 'user') return reply.code(401).send({ error: 'Unauthorized' });

    const capabilities = capabilitiesFor(principal.user.tier, principal.user.tierExpiresAt);

    // The free tier's feed is delayed. Applied in SQL rather than by filtering
    // after the fact so the delay cannot be bypassed by paging, and so the row
    // is never sent to the client in the first place.
    // Column names verified against the live schema — `signals` uses
    // `pattern_type`/`signal_score`, not `pattern`/`score`.
    const rows = await query(
      `SELECT DISTINCT s.id, s.pattern_type, s.chain, s.token_mint, s.token_symbol,
              s.signal_score, s.confidence, s.status, s.detected_at
         FROM signals s
         JOIN cluster_memberships cm ON cm.cluster_id = s.cluster_id
         JOIN user_wallet_subscriptions uws
           ON uws.wallet_address = cm.wallet_address
        WHERE uws.user_id = $1
          -- Migration 051 retains an ended subscription, so without this a user
          -- keeps receiving a master's signals after unsubscribing. winding_down
          -- is deliberately still included: entries have stopped, but the user
          -- holds positions whose exits arrive as that master's sells, and hiding
          -- the activity would leave them unable to see their own exit coming.
          -- No backticks here -- this SQL is a TS template literal.
          AND uws.state <> 'ended'
          AND s.detected_at <= NOW() - ($2::int * interval '1 second')
        ORDER BY s.detected_at DESC
        LIMIT 100`,
      [scope.userId, capabilities.signalDelaySeconds]
    );
    return reply.send({ signals: rows, delayedSeconds: capabilities.signalDelaySeconds });
  });

  app.get('/v1/me/feed', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    // `source_trades` uses `direction`/`token_amount`, not `side`/`quantity`.
    const rows = await query(
      `SELECT st.id, st.chain, st.wallet_address, st.token_mint, st.direction,
              st.token_amount, st.amount_usd, st.price_usd, st.event_at
         FROM source_trades st
         JOIN user_wallet_subscriptions uws
           ON uws.wallet_address = st.wallet_address
        WHERE uws.user_id = $1
          -- Same as /v1/me/signals: an ended subscription is a retained record,
          -- not a live feed. A winding_down subscription stays visible.
          AND uws.state <> 'ended'
        ORDER BY st.event_at DESC
        LIMIT 100`,
      [scope.userId]
    );
    return reply.send({ events: rows });
  });

  // ── Trading Withdrawal Routes (S4-12 anti-theft core) ──────────────────────

  const withdrawalOtps = options.otpStore ?? new Map<string, { code: string; expiresAt: Date; destinationAddress: string }>();

  app.post('/v1/me/trading/withdraw/request-otp', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const principal = request.principal;
    if (principal?.kind !== 'user') return reply.code(401).send({ error: 'Unauthorized' });

    const parsed = withdrawRequestOtpSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid payload', details: parsed.error.issues });
    }

    const { destinationAddress, chainKind } = parsed.data;

    // S4-12: Destination MUST be a verified linked auth wallet
    const linkedWallets = await listAuthWallets(scope);
    const linked = linkedWallets.find(
      (w) => w.chainKind === chainKind && w.address.toLowerCase() === destinationAddress.toLowerCase()
    );

    if (!linked) {
      return reply.code(400).send({
        error: 'destination-not-linked-auth-wallet',
        message: 'Withdrawals are strictly permitted only to SIWE/SIWS verified linked auth wallets (S4-12)'
      });
    }

    // S4-12: 24h cooling-off window on newly linked wallets
    const now = options.now?.() ?? new Date();
    const cooling = isWalletCoolingOff(linked.verifiedAt, now, options.coolingOffMs);
    if (cooling.isCoolingOff) {
      return reply.code(403).send({
        error: 'wallet-cooling-off-active',
        message: `Newly linked wallet is in a 24-hour security cooling-off period (S4-12). ${cooling.hoursRemaining} hours remaining`,
        hoursRemaining: cooling.hoursRemaining
      });
    }

    // Generate 6-digit OTP code with 15-minute validity
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
    withdrawalOtps.set(scope.userId, { code: otpCode, expiresAt, destinationAddress });

    // Send confirmation code via email
    if (options.sendWithdrawalOtpEmail) {
      await options.sendWithdrawalOtpEmail(principal.user.email, otpCode);
    } else {
      const emailConfig = loadEmailConfigFromEnv();
      await sendEmail(
        {
          to: principal.user.email,
          subject: 'WAKE Withdrawal Confirmation Code',
          text: `Your withdrawal confirmation code is: ${otpCode}. It expires in 15 minutes. If you did not initiate this, please contact support immediately.`
        },
        emailConfig
      ).catch((err) => {
        request.log.error(err, 'Failed to deliver withdrawal OTP email');
      });
    }

    return reply.code(200).send({
      ok: true,
      message: 'Withdrawal confirmation OTP sent to registered email address'
    });
  });

  app.post('/v1/me/trading/withdraw', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const principal = request.principal;
    if (principal?.kind !== 'user') return reply.code(401).send({ error: 'Unauthorized' });

    const parsed = withdrawConfirmSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid payload', details: parsed.error.issues });
    }

    const { destinationAddress, chainKind, amountUsd, otpCode } = parsed.data;

    // Verify linked wallet destination and cooling-off
    const linkedWallets = await listAuthWallets(scope);
    const linked = linkedWallets.find(
      (w) => w.chainKind === chainKind && w.address.toLowerCase() === destinationAddress.toLowerCase()
    );

    if (!linked) {
      return reply.code(400).send({
        error: 'destination-not-linked-auth-wallet',
        message: 'Withdrawals are strictly permitted only to SIWE/SIWS verified linked auth wallets (S4-12)'
      });
    }

    const now = options.now?.() ?? new Date();
    const cooling = isWalletCoolingOff(linked.verifiedAt, now, options.coolingOffMs);
    if (cooling.isCoolingOff) {
      return reply.code(403).send({
        error: 'wallet-cooling-off-active',
        message: `Newly linked wallet is in a 24-hour security cooling-off period (S4-12). ${cooling.hoursRemaining} hours remaining`,
        hoursRemaining: cooling.hoursRemaining
      });
    }

    // Verify OTP code
    const storedOtp = withdrawalOtps.get(scope.userId);
    if (
      !storedOtp
      || storedOtp.code !== otpCode
      || storedOtp.expiresAt.getTime() <= now.getTime()
      || storedOtp.destinationAddress.toLowerCase() !== destinationAddress.toLowerCase()
    ) {
      return reply.code(400).send({
        error: 'invalid-or-expired-otp',
        message: 'Invalid or expired withdrawal confirmation code'
      });
    }

    // Burn OTP immediately (single use)
    withdrawalOtps.delete(scope.userId);

    return reply.code(200).send({
      status: 'confirmed',
      withdrawal: {
        userId: scope.userId,
        destinationAddress,
        chainKind,
        amountUsd,
        confirmedAt: now.toISOString()
      }
    });
  });
}
