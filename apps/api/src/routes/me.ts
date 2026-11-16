import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Queue } from 'bullmq';
import { timingSafeEqual } from 'node:crypto';
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
  getWalletScoringReadiness,
  checkWalletClusterIndependence,
  checkWalletHubStatus,
  listAuthWallets,
  getPerpsInstruments,
  getPerpsAccount,
  getUserPerpsPositions,
  closePerpsPosition,
  PerpsCloseUnavailableError,
  type UserScope
} from '@swat/db';
import {
  buildClobAuthTypedData,
  deriveWakeVaultAddress,
  capabilitiesFor,
  chainSchema,
  createWalletBackfillJob,
  isValidAddressForChain,
  resolveChainAddress,
  tierAllowsChain,
  type Chain
} from '@swat/shared';
import { requireUser } from '../auth/plugin.js';
const perpsReducingCapability = () => ({
  state: 'blocked-on-external-capability', supported: false,
  unavailableReasons: ['authorized-reducing-execution-unavailable', 'provider-receipt-reconciliation-unavailable']
});

/**
 * Per-user routes (Stage 2).
 *
 * Every handler derives its scope from `requireUser`, which reads the session —
 * never a request payload (D12). The tenant-less legacy service key cannot
 * satisfy `requireUser`, so none of these routes are reachable with it.
 */

export interface StoredWithdrawalOtp {
  code: string;
  expiresAt: Date;
  destinationAddress: string;
  chainKind: string;
  amountUsd?: number;
  attempts: number;
}

export interface MeRouteOptions {
  readonly backfillQueue: Queue;
  readonly tokenDiscoveryQueue: Queue;
  readonly now?: () => Date;
  readonly coolingOffMs?: number;
  readonly otpStore?: Map<string, StoredWithdrawalOtp>;
  readonly sendWithdrawalOtpEmail?: (email: string, code: string) => Promise<boolean>;
}

export const DEFAULT_WITHDRAWAL_COOLING_OFF_MS = 24 * 60 * 60 * 1000; // 24 hours (S4-12)

export function isSameAddress(a: string, b: string, chainKind: string): boolean {
  if (chainKind === 'solana') {
    return a.trim() === b.trim();
  }
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function constantTimeCodeMatch(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

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

    const balances = balanceRows.map((b) => ({
      chain: b.chain,
      asset: b.asset,
      balanceUsd: b.usd != null ? Number(b.usd) : null,
      valuationAssessment: b.usd != null ? 'observed-runtime-unverified' : 'unassessed',
      balanceNative: Number(b.amount),
      updatedAt: b.fetched_at ? new Date(b.fetched_at).toISOString() : null
    }));

    const subscriptions = await query<{
      wallet_address: string;
      chain: string | null;
      label: string | null;
      state: string;
      membership_slot: number | null;
      composite_score: number | null;
      tier: string | null;
      win_rate: number | null;
      realized_roi: number | null;
      total_trades: number | null;
    }>(
      `SELECT uws.wallet_address, COALESCE(w.chain, 'solana') AS chain,
              uws.label, uws.state, uws.membership_slot,
              w.composite_score, w.tier, w.win_rate, w.realized_roi, w.total_trades
         FROM user_wallet_subscriptions uws
         LEFT JOIN wallets w ON w.address = uws.wallet_address
        WHERE uws.user_id = $1 AND uws.state = 'active'
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
        membershipSlot: s.membership_slot,
        compositeScore: s.composite_score != null ? Number(s.composite_score) : null,
        tier: s.tier || 'speculative',
        winRate: s.win_rate != null ? Number((Number(s.win_rate) * 100).toFixed(1)) : null,
        realizedRoi: s.realized_roi != null ? Number((Number(s.realized_roi) * 100).toFixed(1)) : null,
        totalTrades: s.total_trades != null ? Number(s.total_trades) : 0
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
      latest_price_usd: string | null;
    }>(
      `SELECT cp.id, cp.chain, cp.token_mint, cp.confirmed_quantity, cp.cost_basis_usd,
              tm.symbol AS token_symbol,
              cpm.master_wallet_address,
              ps.price_usd AS latest_price_usd
         FROM copy_positions cp
         LEFT JOIN tokens tm ON tm.mint = cp.token_mint
         LEFT JOIN LATERAL (
           SELECT master_wallet_address
             FROM copy_position_master_lots
            WHERE position_id = cp.id AND remaining_quantity > 0
            LIMIT 1
         ) cpm ON true
         LEFT JOIN LATERAL (
           SELECT price_usd
             FROM price_snapshots
            WHERE token_mint = cp.token_mint AND chain = cp.chain
            ORDER BY snapshot_at DESC
            LIMIT 1
         ) ps ON true
        WHERE cp.user_id = $1 AND cp.confirmed_quantity > 0
        ORDER BY cp.cost_basis_usd DESC`,
      [scope.userId]
    );

    return reply.send({
      positions: positions.map((p) => {
        const confirmedQuantity = Number(p.confirmed_quantity || 0);
        const costBasisUsd = Number(p.cost_basis_usd || 0);
        const entryPriceUsd = confirmedQuantity > 0 ? costBasisUsd / confirmedQuantity : 0;
        const currentPriceUsd = p.latest_price_usd != null ? Number(p.latest_price_usd) : null;
        const currentValueUsd = currentPriceUsd != null ? confirmedQuantity * currentPriceUsd : costBasisUsd;
        const unrealizedPnlUsd = currentPriceUsd != null ? currentValueUsd - costBasisUsd : null;
        const unrealizedPnlPct = (currentPriceUsd != null && costBasisUsd > 0)
          ? ((unrealizedPnlUsd! / costBasisUsd) * 100)
          : null;

        return {
          id: p.id,
          chain: p.chain,
          tokenMint: p.token_mint,
          tokenSymbol: p.token_symbol || p.token_mint.slice(0, 8),
          confirmedQuantity,
          costBasisUsd,
          entryPriceUsd,
          currentPriceUsd,
          unrealizedPnlUsd,
          unrealizedPnlPct,
          masterWalletAddress: p.master_wallet_address || undefined
        };
      })
    });
  });

  // A local quantity update is not a financial exit. No authorized canonical
  // reducing handoff and receipt settlement is available at these entry points.
  const unavailablePositionExit = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    if (!requireUser(request, reply)) return;
    return reply.code(503).send({
      code: 'POSITION_EXIT_UNAVAILABLE', supported: false,
      unavailableReasons: ['authorized-reducing-handoff-unavailable', 'provider-receipt-reconciliation-unavailable'],
      message: 'Financial exit is unavailable here. Exposure was not changed and no order was queued.'
    });
  };
  app.post('/v1/me/positions/:id/exit', unavailablePositionExit);
  app.post('/v1/me/positions/close-all', unavailablePositionExit);

  // ─── Non-Custodial Vault & Custody Status ────────────────────────────────────
  app.get('/v1/me/vault', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const principal = request.principal;
    if (principal?.kind !== 'user') return reply.code(401).send({ error: 'Unauthorized' });

    const authWallets = await listAuthWallets(scope);
    const now = new Date();

    const grants = await query<{
      chain: string;
      grant_kind: string;
      account_address: string;
      status: string;
      expires_at: Date | null;
      scope_policy: any;
    }>(
      `SELECT chain, grant_kind, account_address, status, expires_at, scope_policy
         FROM user_execution_grants
        WHERE user_id = $1 AND status = 'active'
          AND (expires_at IS NULL OR expires_at > NOW())`,
      [scope.userId]
    );

    const polyGrant = grants.find((g) => g.grant_kind === 'polymarket_signer');

    return reply.send({
      solana: {
        pdaAddress: null, rentLamports: null, solGasReserve: null, solGasUsd: null,
        solMinGasUsd: null, hasMinimumGas: false, status: 'unsupported', executionSupported: false,
        capabilityState: 'blocked-on-external-capability',
        unavailableReasons: ['deployed-authority-verification-unavailable', 'authorized-live-executor-unavailable']
      },
      robinhood: {
        smartAccountAddress: null,
        accountAddress: authWallets.find((w) => w.chainKind === 'evm')?.address ?? null,
        sessionKeyStatus: 'unsupported', executionSupported: false,
        capabilityState: 'intentionally-unavailable',
        unavailableReasons: ['deployed-delegation-implementation-unavailable', 'authorized-live-executor-unavailable'],
        expiresAt: null, sponsoredOpsUsedToday: 0, dailyCap: 0
      },
      polymarket: {
        depositAddress: null,
        signerAddress: polyGrant?.account_address ?? null,
        status: polyGrant ? 'credentials_recorded' : 'uninitialized',
        executionSupported: false,
        credentialsRecorded: !!polyGrant,
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

  app.post('/v1/me/vault/revoke', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const bodySchema = z.object({
      chain: z.enum(['solana', 'robinhood-chain', 'polygon', 'all'])
    });
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Invalid revoke payload' });
    }

    const { chain } = parsed.data;
    let updated;
    if (chain === 'all') {
      updated = await query<{ id: string }>(
        `UPDATE user_execution_grants
            SET status = 'revoked', revoked_at = NOW()
          WHERE user_id = $1 AND status = 'active'
          RETURNING id`,
        [scope.userId]
      );
    } else {
      updated = await query<{ id: string }>(
        `UPDATE user_execution_grants SET status = 'revoked', revoked_at = NOW()
          WHERE user_id = $1 AND chain = $2 AND status = 'active' RETURNING id`,
        [scope.userId, chain]
      );
    }

    return reply.send({
      success: true,
      revokedCount: updated.length, affectedGrantIds: updated.map(g => g.id),
      localOnly: true, onChainRevoked: false,
      chain,
      message: `${chain} local grants disabled. No on-chain authority was revoked, vault closed, or rent refunded.`
    });
  });

  app.post('/v1/me/vault/grant', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const scope = requireUser(request, reply);
    if (!scope) return;
    const bodySchema = z.object({
      chain: z.enum(['solana', 'robinhood-chain', 'polygon']),
      grantKind: z.enum(['solana_vault', 'eip7702', 'session_key_4337', 'polymarket_signer']),
      accountAddress: z.string().min(10).max(100)
    });
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Invalid grant payload' });
    }
    const { chain, grantKind, accountAddress } = parsed.data;
    const validPair = grantKind === 'solana_vault' ? chain === 'solana'
      : grantKind === 'polymarket_signer' ? chain === 'polygon' : chain === 'robinhood-chain';
    if (!validPair) return reply.code(400).send({ error: 'invalid-chain-grant-pair' });
    if (grantKind !== 'solana_vault') return reply.code(501).send({ error: 'grant-registration-unsupported', status: 'unsupported', executionSupported: false });
    const body = request.body as { ownerAddress?: string; cluster?: string };
    if (body.cluster !== 'mainnet-beta') return reply.code(501).send({ error: 'vault-network-unsupported' });
    const wallets = await listAuthWallets(scope);
    const owner = wallets.find(w => w.chainKind === 'solana' && w.address === body.ownerAddress);
    if (!owner) return reply.code(403).send({ error: 'vault-owner-not-linked' });
    try {
      if (deriveWakeVaultAddress(owner.address) !== accountAddress.trim()) return reply.code(400).send({ error: 'vault-pda-mismatch' });
    } catch { return reply.code(400).send({ error: 'invalid-vault-address' }); }
    return reply.code(501).send({ error: 'vault-deployment-verification-unsupported', status: 'unsupported', executionSupported: false,
      message: 'The PDA derivation matches, but deployed ownership and execution authority cannot be verified. No grant was created. Do not fund this as a usable vault.' });
  });

  // No deployed EIP-7702 account implementation or user-live executor exists.
  // Off-chain signatures must never become wallet links or spend authority.
  for (const [method, url] of [
    ['GET', '/v1/me/vault/robinhood/challenge'],
    ['POST', '/v1/me/vault/robinhood/delegation']
  ] as const) {
    app.route({ method, url, handler: async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!requireUser(request, reply)) return;
      return reply.code(501).send({
        error: 'robinhood-delegation-unsupported', status: 'unsupported',
        executionSupported: false,
        message: 'Robinhood delegation is unavailable. Link your wallet using SIWE; no delegation or spend authority will be created.'
      });
    } });
  }

  // ─── Polymarket CLOB L2 Authentication ──────────────────────────────────────
  app.get('/v1/me/vault/polymarket/challenge', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;

    const q = request.query as { address?: string };
    const address = q.address?.trim();
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Valid EVM address query param required (0x followed by 40 hex characters)'
      });
    }

    const timestampSeconds = Math.floor(Date.now() / 1000);
    const nonce = 0;
    const typedData = buildClobAuthTypedData({
      signerAddress: address,
      timestampSeconds,
      nonce
    });

    return reply.send({
      address,
      timestampSeconds,
      nonce,
      typedData
    });
  });

  const polymarketCredentialsSchema = z.object({
    address: z.string().trim().regex(/^0x[0-9a-fA-F]{40}$/),
    signature: z.string().trim().regex(/^0x[0-9a-fA-F]+$/),
    timestampSeconds: z.number().int().positive(),
    nonce: z.number().int().nonnegative().default(0)
  });

  app.post('/v1/me/vault/polymarket/credentials', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const scope = requireUser(request, reply);
    if (!scope) return;

    const parsed = polymarketCredentialsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    }

    const { address, signature, timestampSeconds, nonce } = parsed.data;

    const linked = await listAuthWallets(scope);
    if (!linked.some(w => w.chainKind === 'evm' && w.address.toLowerCase() === address.toLowerCase())) return reply.code(403).send({ error: 'signer-not-linked' });
    const age = Math.floor(Date.now() / 1000) - timestampSeconds;
    if (age < 0 || age > 300) return reply.code(400).send({ error: 'expired-signature-challenge' });
    try {
      const { recoverTypedDataAddress } = await import('viem');
      const typedData = buildClobAuthTypedData({ signerAddress: address, timestampSeconds, nonce });
      const recovered = await recoverTypedDataAddress({
        ...typedData,
        types: { ClobAuth: typedData.types.ClobAuth },
        message: { ...typedData.message, nonce: BigInt(nonce) },
        signature: signature as `0x${string}`
      });
      if (recovered.toLowerCase() !== address.toLowerCase()) return reply.code(403).send({ error: 'invalid-signer-proof' });
    } catch { return reply.code(403).send({ error: 'invalid-signer-proof' }); }

    // No separately authorized wrap-only service or durable resource-context
    // writer exists. Do not acquire external credentials that cannot be safely
    // recorded, or reconstruct a symmetric wrapper in this API process.
    return reply.code(503).send({
      error: 'credential-sealing-unavailable',
      code: 'CREDENTIAL_SEALING_UNAVAILABLE',
      credentialsRecorded: false,
      executionSupported: false,
      message: 'Credential enrollment is unavailable: separately authorized wrapping and durable resource binding are not configured.'
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
              COALESCE((SELECT uws.label FROM user_wallet_subscriptions uws WHERE uws.wallet_address = w.address AND uws.user_id = $1 LIMIT 1), w.nickname) AS label,
              w.composite_score, w.tier, w.win_rate, w.realized_roi,
              COUNT(DISTINCT uws.user_id) FILTER (WHERE uws.state = 'active') AS follower_count
         FROM wallets w
         LEFT JOIN user_wallet_subscriptions uws ON uws.wallet_address = w.address
        WHERE w.status = 'active'
        GROUP BY w.address, w.chain, w.nickname, w.composite_score, w.tier, w.win_rate, w.realized_roi
        ORDER BY w.composite_score DESC NULLS LAST, follower_count DESC
        LIMIT 20`,
      [scope.userId]
    );

    return reply.send({
      masters: rows.map((r) => ({
        masterWalletAddress: r.address,
        chain: r.chain,
        label: r.label,
        compositeScore: r.composite_score,
        tier: r.tier || 'pro',
        winRate: r.win_rate != null ? Number((r.win_rate * 100).toFixed(1)) : null,
        realizedRoi: r.realized_roi != null ? Number((r.realized_roi * 100).toFixed(1)) : null,
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
      win_rate: number | null;
      realized_roi: number | null;
      total_trades: number | null;
      last_active: Date | null;
    }>(
      `SELECT address, chain, status, composite_score, tier, win_rate, realized_roi, total_trades, last_active
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
          compositeScore: wallet?.composite_score != null ? Number(wallet.composite_score) : null,
          tier: wallet?.tier ?? null,
          winRate: wallet?.win_rate != null ? Number((Number(wallet.win_rate) * 100).toFixed(1)) : null,
          realizedRoi: wallet?.realized_roi != null ? Number((Number(wallet.realized_roi) * 100).toFixed(1)) : null,
          totalTrades: wallet?.total_trades != null ? Number(wallet.total_trades) : null,
          lastActive: wallet?.last_active ?? null
        };
      })
    });
  });

  app.get('/v1/me/wallets/inspect', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const q = request.query as { address?: string; chain?: string };
    if (!q.address) {
      return reply.code(400).send({ error: 'Missing address parameter' });
    }
    const resolved = resolveChainAddress(q.address, (q.chain as Chain) || 'solana');
    const rows = await query<{
      address: string;
      chain: Chain;
      status: string;
      composite_score: number | null;
      tier: string | null;
      win_rate: number | null;
      realized_roi: number | null;
      total_trades: number | null;
      last_active: Date | null;
    }>(
      `SELECT address, chain, status, composite_score, tier, win_rate, realized_roi, total_trades, last_active
         FROM wallets WHERE address = $1`,
      [resolved.prefixed]
    );
    if (rows.length === 0) {
      return reply.send({ status: 'not_found', metrics: null });
    }
    const w = rows[0];
    const isReady = w.composite_score != null || (w.total_trades != null && w.total_trades > 0);
    return reply.send({
      status: isReady ? 'ready' : 'indexing',
      metrics: {
        address: w.address,
        chain: w.chain,
        compositeScore: w.composite_score != null ? Number(w.composite_score) : null,
        tier: w.tier || 'speculative',
        winRate: w.win_rate != null ? Number((Number(w.win_rate) * 100).toFixed(1)) : null,
        realizedRoi: w.realized_roi != null ? Number((Number(w.realized_roi) * 100).toFixed(1)) : null,
        totalTrades: w.total_trades != null ? Number(w.total_trades) : 0,
        lastActive: w.last_active
      }
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
    const q = request.query as { chain?: string };

    let candidate = address;
    if (!candidate.includes(':') && q.chain) {
      candidate = `${q.chain}:${address}`;
    }

    // Unsubscribe is an exits-only wind-down. Retaining the row preserves the
    // attribution and sell-mirror path for positions opened while active.
    try {
      let result;
      try {
        result = await beginWindDown(scope, candidate);
      } catch (err) {
        if (candidate !== address) {
          result = await beginWindDown(scope, address);
        } else {
          throw err;
        }
      }
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
    const q = request.query as { chain?: string };

    let candidate = address;
    if (!candidate.includes(':') && q.chain) {
      candidate = `${q.chain}:${address}`;
    }

    try {
      let result;
      try {
        result = await requestCloseAll(scope, candidate);
      } catch (err) {
        if (candidate !== address) {
          result = await requestCloseAll(scope, address);
        } else {
          throw err;
        }
      }
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

  // No durable exact-intent store or authorized withdrawal executor is wired.
  // Refuse both entry points rather than issue an unusable approval or burn a code.
  const unsupportedWithdrawal = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    const scope = requireUser(request, reply);
    if (!scope) return;
    if (request.principal?.kind !== 'user') return reply.code(401).send({ error: 'Unauthorized' });
    return reply.code(501).send({
      error: 'withdrawal-unsupported',
      supported: false,
      message: 'Withdrawals are unavailable: durable exact intents and an authorized execution handoff are not implemented. No code was sent, authorization recorded, or transfer queued.'
    });
  };
  app.post('/v1/me/trading/withdraw/request-otp', unsupportedWithdrawal);
  app.post('/v1/me/trading/withdraw', unsupportedWithdrawal);

  // --- Polymarket Perpetual Futures (Perps) Endpoints ---

  app.get('/v1/me/perps/instruments', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const instruments = await getPerpsInstruments(true);
    return reply.send({ instruments });
  });

  app.get('/v1/me/perps/portfolio', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const [account, positions] = await Promise.all([
      getPerpsAccount(scope.userId),
      getUserPerpsPositions(scope.userId, 'open')
    ]);
    return reply.send({
      account,
      accountAssessment: account ? 'observed-runtime-unverified' : 'unassessed',
      reducingExecution: perpsReducingCapability(),
      positions
    });
  });

  app.post('/v1/me/perps/positions/:id/close', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const { id } = request.params as { id: string };
    try {
      await closePerpsPosition(id, scope.userId);
      return reply.code(404).send({ error: 'Position not found or already closed' });
    } catch (error) {
      if (!(error instanceof PerpsCloseUnavailableError)) throw error;
      return reply.code(503).send({
        code: error.code,
        supported: false,
        reducingExecution: perpsReducingCapability(),
        message: error.message
      });
    }
  });
}

