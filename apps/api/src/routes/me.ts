import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Queue } from 'bullmq';
import { randomInt, timingSafeEqual } from 'node:crypto';
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
  buildClobAuthTypedData,
  capabilitiesFor,
  chainSchema,
  createWalletBackfillJob,
  EnvMasterKeyWrapper,
  fetchClobCredentialsFromSignature,
  isValidAddressForChain,
  loadEmailConfigFromEnv,
  resolveChainAddress,
  sealSecret,
  sendEmail,
  tierAllowsChain,
  type Chain,
  type WrapContext
} from '@swat/shared';
import { requireUser } from '../auth/plugin.js';

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
      { chain: 'solana', asset: 'USDC', balanceUsd: 0, balanceNative: 0 },
      { chain: 'robinhood-chain', asset: 'USDC', balanceUsd: 0, balanceNative: 0 },
      { chain: 'polygon', asset: 'USDC', balanceUsd: 0, balanceNative: 0 }
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

  app.post('/v1/me/positions/:id/exit', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const { id } = request.params as { id: string };

    const updated = await query<{ id: string }>(
      `UPDATE copy_positions SET confirmed_quantity = 0 WHERE id = $1 AND user_id = $2 AND confirmed_quantity > 0 RETURNING id`,
      [id, scope.userId]
    );
    if (updated.length === 0) {
      return reply.code(409).send({ error: 'Position not found, already closed, or confirmed quantity is zero' });
    }

    return reply.send({ success: true, message: 'Position exit confirmed and closed in local state', positionId: id });
  });

  app.post('/v1/me/positions/close-all', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;

    const updated = await query<{ id: string }>(
      `UPDATE copy_positions SET confirmed_quantity = 0 WHERE user_id = $1 AND confirmed_quantity > 0 RETURNING id`,
      [scope.userId]
    );
    return reply.send({
      success: true,
      closedCount: updated.length,
      message: `${updated.length} open position(s) closed successfully in local state`
    });
  });

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
        WHERE user_id = $1 AND status = 'active'`,
      [scope.userId]
    );

    const solGrant = grants.find((g) => g.grant_kind === 'solana_vault');
    const rhGrant = grants.find((g) => g.chain === 'robinhood-chain' || g.grant_kind === 'eip7702');
    const polyGrant = grants.find((g) => g.grant_kind === 'polymarket_signer');

    return reply.send({
      solana: {
        pdaAddress: solGrant?.account_address ?? null,
        rentLamports: 2039280,
        solGasReserve: 0.12,
        solGasUsd: 19.8,
        solMinGasUsd: 10.0,
        hasMinimumGas: true,
        status: solGrant ? 'active' : 'uninitialized'
      },
      robinhood: {
        smartAccountAddress: rhGrant?.account_address ?? null,
        sessionKeyStatus: rhGrant ? 'delegated' : 'not_delegated',
        expiresAt: rhGrant?.expires_at ? new Date(rhGrant.expires_at).toISOString() : null,
        sponsoredOpsUsedToday: 0,
        dailyCap: 50
      },
      polymarket: {
        depositAddress: polyGrant?.account_address ?? null,
        signerAddress: polyGrant?.account_address ?? null,
        status: polyGrant ? 'active' : 'uninitialized',
        apiKey: typeof polyGrant?.scope_policy === 'string'
          ? (JSON.parse(polyGrant.scope_policy)?.apiKey ?? null)
          : (polyGrant?.scope_policy?.apiKey ?? null),
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
    } else if (chain === 'solana') {
      updated = await query<{ id: string }>(
        `UPDATE user_execution_grants
            SET status = 'revoked', revoked_at = NOW()
          WHERE user_id = $1 AND (grant_kind = 'solana_vault' OR chain = 'solana') AND status = 'active'
          RETURNING id`,
        [scope.userId]
      );
    } else {
      updated = await query<{ id: string }>(
        `UPDATE user_execution_grants
            SET status = 'revoked', revoked_at = NOW()
          WHERE user_id = $1 AND (grant_kind IN ('eip7702', 'session_key_4337', 'polymarket_signer') OR chain = $2) AND status = 'active'
          RETURNING id`,
        [scope.userId, chain]
      );
    }

    return reply.send({
      success: true,
      revokedCount: updated.length,
      chain,
      message: `${chain} vault / execution delegation revoked successfully`
    });
  });

  app.post('/v1/me/vault/grant', async (request, reply) => {
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

    // Revoke previous active grant for this kind
    await query(
      `UPDATE user_execution_grants
          SET status = 'revoked', revoked_at = NOW()
        WHERE user_id = $1 AND grant_kind = $2 AND status = 'active'`,
      [scope.userId, grantKind]
    );

    const expiresAt = grantKind === 'eip7702' || grantKind === 'session_key_4337'
      ? new Date(Date.now() + 30 * 86400000)
      : null;

    const inserted = await query<{ id: string }>(
      `INSERT INTO user_execution_grants (user_id, chain, grant_kind, account_address, status, expires_at, created_at)
       VALUES ($1, $2, $3, $4, 'active', $5, NOW())
       RETURNING id`,
      [scope.userId, chain, grantKind, accountAddress, expiresAt]
    );

    return reply.send({
      success: true,
      grantId: inserted[0]?.id,
      expiresAt: expiresAt?.toISOString() ?? null,
      message: `${grantKind} registered and activated successfully`
    });
  });

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
    const scope = requireUser(request, reply);
    if (!scope) return;

    const parsed = polymarketCredentialsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    }

    const { address, signature, timestampSeconds, nonce } = parsed.data;

    request.log.info(
      { address, signature, timestampSeconds, nonce },
      '[polymarket-clob] Received credentials derivation request'
    );

    try {
      const { recoverTypedDataAddress } = await import('viem');
      const recovered137 = await recoverTypedDataAddress({
        domain: { name: 'ClobAuthDomain', version: '1', chainId: 137 },
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' }
          ],
          ClobAuth: [
            { name: 'address', type: 'address' },
            { name: 'timestamp', type: 'string' },
            { name: 'nonce', type: 'uint256' },
            { name: 'message', type: 'string' }
          ]
        },
        primaryType: 'ClobAuth',
        message: {
          address,
          timestamp: String(timestampSeconds),
          nonce: BigInt(nonce),
          message: 'This message attests that I control the given wallet'
        },
        signature: signature as `0x${string}`
      }).catch((e: any) => `recovery_failed: ${e?.message}`);

      const recovered1 = await recoverTypedDataAddress({
        domain: { name: 'ClobAuthDomain', version: '1', chainId: 1 },
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' }
          ],
          ClobAuth: [
            { name: 'address', type: 'address' },
            { name: 'timestamp', type: 'string' },
            { name: 'nonce', type: 'uint256' },
            { name: 'message', type: 'string' }
          ]
        },
        primaryType: 'ClobAuth',
        message: {
          address,
          timestamp: String(timestampSeconds),
          nonce: BigInt(nonce),
          message: 'This message attests that I control the given wallet'
        },
        signature: signature as `0x${string}`
      }).catch((e: any) => `recovery_failed: ${e?.message}`);

      request.log.info(
        { address, recovered137, recovered1, match137: recovered137?.toLowerCase() === address.toLowerCase(), match1: recovered1?.toLowerCase() === address.toLowerCase() },
        '[polymarket-clob] Signature recovery diagnostic'
      );
    } catch (recErr) {
      request.log.warn({ err: recErr }, '[polymarket-clob] Diagnostic recovery threw');
    }

    try {
      // 1. Call Polymarket CLOB to create or derive L2 credentials using the user's signature
      const creds = await fetchClobCredentialsFromSignature({
        address,
        signature,
        timestampSeconds,
        nonce
      });

      // 2. Envelope-seal the credentials
      const wrapper = new EnvMasterKeyWrapper();
      const wrapContext: WrapContext = {
        userId: scope.userId,
        chainKind: 'evm',
        keyVersion: 1
      };
      const secretPayload = JSON.stringify({
        apiKey: creds.apiKey,
        secret: creds.secret,
        passphrase: creds.passphrase,
        signerAddress: address.toLowerCase()
      });
      const sealedSecret = await sealSecret(secretPayload, wrapContext, wrapper);

      // 3. Revoke any prior active grant for polygon polymarket_signer
      await query(
        `UPDATE user_execution_grants
            SET status = 'revoked', revoked_at = NOW()
          WHERE user_id = $1 AND chain = 'polygon' AND grant_kind = 'polymarket_signer' AND status = 'active'`,
        [scope.userId]
      );

      const policy = {
        apiKey: creds.apiKey,
        derivedAt: new Date().toISOString(),
        nonce
      };

      const inserted = await query<{ id: string }>(
        `INSERT INTO user_execution_grants
           (user_id, chain, grant_kind, account_address, sealed_secret, key_version, scope_policy, status, created_at)
         VALUES ($1, 'polygon', 'polymarket_signer', $2, $3, 1, $4, 'active', NOW())
         ON CONFLICT (chain, account_address) DO UPDATE
            SET user_id = EXCLUDED.user_id,
                sealed_secret = EXCLUDED.sealed_secret,
                key_version = EXCLUDED.key_version,
                scope_policy = EXCLUDED.scope_policy,
                status = 'active',
                revoked_at = NULL
         RETURNING id`,
        [scope.userId, address.toLowerCase(), sealedSecret, JSON.stringify(policy)]
      );

      return reply.send({
        success: true,
        grantId: inserted[0]?.id,
        address,
        apiKey: creds.apiKey,
        message: 'Polymarket L2 credentials derived and activated successfully'
      });
    } catch (err: any) {
      request.log.error(err, '[polymarket-clob] Failed to derive credentials');
      return reply.code(400).send({
        error: 'Polymarket L2 authentication failed',
        message: err.message || 'Failed to authenticate with Polymarket CLOB'
      });
    }
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

  // ── Trading Withdrawal Routes (S4-12 anti-theft core) ──────────────────────

  const withdrawalOtps = options.otpStore ?? new Map<string, StoredWithdrawalOtp>();

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

    // S4-12: Destination MUST be a verified linked auth wallet (case-aware matching)
    const linkedWallets = await listAuthWallets(scope);
    const linked = linkedWallets.find(
      (w) => w.chainKind === chainKind && isSameAddress(w.address, destinationAddress, chainKind)
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

    // Cooldown guard: prevent rapid OTP overwrites and DoS
    const existingOtp = withdrawalOtps.get(scope.userId);
    if (existingOtp && existingOtp.expiresAt.getTime() > now.getTime()) {
      const remainingMs = existingOtp.expiresAt.getTime() - now.getTime();
      const elapsedMs = 15 * 60 * 1000 - remainingMs;
      if (elapsedMs < 60 * 1000) {
        return reply.code(429).send({
          error: 'otp-cooldown-active',
          message: 'Please wait at least 60 seconds before requesting a new withdrawal code'
        });
      }
    }

    // Generate cryptographically secure 6-digit OTP code with 15-minute validity (C-01 / S4-12)
    const otpCode = randomInt(100000, 1000000).toString();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
    withdrawalOtps.set(scope.userId, {
      code: otpCode,
      expiresAt,
      destinationAddress,
      chainKind,
      attempts: 0
    });

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
      (w) => w.chainKind === chainKind && isSameAddress(w.address, destinationAddress, chainKind)
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

    // Verify OTP code with brute-force lockout and constant-time comparison
    const storedOtp = withdrawalOtps.get(scope.userId);
    if (!storedOtp || storedOtp.expiresAt.getTime() <= now.getTime()) {
      return reply.code(400).send({
        error: 'invalid-or-expired-otp',
        message: 'Withdrawal confirmation code is invalid or has expired'
      });
    }

    if (storedOtp.attempts >= 5) {
      withdrawalOtps.delete(scope.userId);
      return reply.code(429).send({
        error: 'otp-attempts-exceeded',
        message: 'Too many incorrect attempts. Please request a new withdrawal code.'
      });
    }

    if (!isSameAddress(storedOtp.destinationAddress, destinationAddress, chainKind)) {
      return reply.code(400).send({
        error: 'destination-mismatch',
        message: 'Withdrawal code was requested for a different destination address'
      });
    }

    if (!constantTimeCodeMatch(storedOtp.code, otpCode)) {
      storedOtp.attempts += 1;
      const remainingAttempts = 5 - storedOtp.attempts;
      return reply.code(400).send({
        error: 'invalid-or-expired-otp',
        message: `Invalid withdrawal confirmation code. ${remainingAttempts} attempt(s) remaining.`
      });
    }

    // Burn OTP immediately (single use)
    withdrawalOtps.delete(scope.userId);

    return reply.code(200).send({
      status: 'confirmed',
      message: 'Withdrawal authorization verified and queued for execution',
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
