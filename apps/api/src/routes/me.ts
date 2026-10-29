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
  type UserScope
} from '@swat/db';
import {
  capabilitiesFor,
  chainSchema,
  createWalletBackfillJob,
  isValidAddressForChain,
  resolveChainAddress,
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
}

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
}
