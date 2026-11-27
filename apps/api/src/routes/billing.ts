import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  BILLING_PLANS,
  canonicalPaymentHash,
  USDC_MINTS,
  executeWithRpcFailover,
  resolveBillingPlan,
  type BillingChain,
  type BillingPlanId,
  type UserTier
} from '@swat/shared';
import {
  createPaymentIntent,
  DuplicatePaymentTransactionError,
  getUserBillingStatus,
  listAuthWallets,
  listUserCryptoPayments,
  recordCryptoPaymentAndGrantTier,
  runTierDowngradeSweep,
  UnderpaidPaymentError,
  query,
  type CryptoPaymentRecord,
  type PaymentIntentRecord,
  type UserBillingStatus
} from '@swat/db';
import { forUser, type UserScope } from '@swat/db';
import { requireRole, requireUser } from '../auth/plugin.js';

export interface BillingDependencies {
  readonly createPaymentIntent: (scope: UserScope, planId: BillingPlanId) => Promise<PaymentIntentRecord>;
  readonly recordCryptoPaymentAndGrantTier: (input: {
    scope: UserScope;
    chain: BillingChain;
    txHash: string;
    amountUsdc: number;
    planId: BillingPlanId;
    payerAddress?: string | null;
    treasuryAddress: string;
    memo?: string | null;
  }) => Promise<{
    payment: CryptoPaymentRecord;
    updatedTier: UserTier;
    updatedExpiresAt: Date | null;
  }>;
  readonly getUserBillingStatus: (scope: UserScope) => Promise<UserBillingStatus>;
  readonly listUserCryptoPayments: (scope: UserScope) => Promise<CryptoPaymentRecord[]>;
  readonly runTierDowngradeSweep: () => Promise<{ downgradedCount: number; downgradedUserIds: string[] }>;
  readonly verifyOnChainPayment: (input: {
    chain: BillingChain;
    txHash: string;
    expectedUsdc: number;
    treasuryAddress: string;
    memo?: string | null;
  }) => Promise<{ verified: boolean; payerAddress: string | null; amountUsdc: number }>;
  readonly findPaymentIntentByMemo?: (memo: string) => Promise<{ userId: string; status: string; planId?: string; expiresAt?: Date } | null>;
  readonly listAuthWallets?: (scope: UserScope) => Promise<Array<{ address: string; chainKind: string }>>;
  readonly onUserTierUpdated?: (userId: string) => Promise<void> | void;
  readonly onUsersDowngraded?: (userIds: readonly string[]) => Promise<void> | void;
}

export const DEFAULT_TREASURY_ADDRESSES = {
  solana: process.env.TREASURY_SOLANA_ADDRESS || 'WAKETreasurySolana1111111111111111111111111',
  polygon: process.env.TREASURY_POLYGON_ADDRESS || '0xWAKETreasuryPolygon00000000000000000000000'
} as const;

/**
 * On-chain EVM / Polygon USDC verification using viem.
 */
export async function verifyPolygonUsdcTransferOnChain(input: {
  txHash: string;
  expectedUsdc: number;
  treasuryAddress: string;
}): Promise<{ verified: boolean; payerAddress: string | null; amountUsdc: number }> {
  try {
    return await executeWithRpcFailover({
      chain: 'polygon',
      action: async (rpcUrl) => {
        const { createPublicClient, http, parseAbiItem, decodeEventLog } = await import('viem');
        const { polygon } = await import('viem/chains');

        const client = createPublicClient({
          chain: polygon,
          transport: http(rpcUrl)
        });

        const receipt = await client.getTransactionReceipt({ hash: input.txHash as `0x${string}` });
        const finalized = await client.getBlock({ blockTag: 'finalized' });
        if (receipt.status !== 'success' || receipt.blockNumber == null || finalized.number == null || receipt.blockNumber > finalized.number) {
          return { verified: false, payerAddress: null, amountUsdc: 0 };
        }

        const transferEventAbi = parseAbiItem(
          'event Transfer(address indexed from, address indexed to, uint256 value)'
        );

        const usdcContract = USDC_MINTS.polygon.toLowerCase();
        const treasuryLower = input.treasuryAddress.toLowerCase();

        // Scan logs for ERC-20 Transfer to treasury
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== usdcContract) continue;
          try {
            if (log.topics.length !== 3 || !/^0x[0-9a-fA-F]{64}$/.test(log.data)
                || !log.topics.slice(1).every((t) => /^0x0{24}[0-9a-fA-F]{40}$/.test(t))) continue;
            const decoded = decodeEventLog({ abi: [transferEventAbi], eventName: 'Transfer',
              topics: log.topics, data: log.data, strict: true });
            const { from, to, value } = decoded.args;
            if (to.toLowerCase() !== treasuryLower || from === '0x0000000000000000000000000000000000000000'
                || from.toLowerCase() === treasuryLower || value > BigInt(Number.MAX_SAFE_INTEGER)) continue;
            const amountUsdc = Number(value) / 1e6;
            if (amountUsdc >= input.expectedUsdc) return { verified: true, payerAddress: from.toLowerCase(), amountUsdc };
          } catch {
            // Ignore unparseable log
          }
        }

        return { verified: false, payerAddress: null, amountUsdc: 0 };
      }
    });
  } catch (error) {
    console.error('[billing] Polygon USDC verification failed:', error);
    return { verified: false, payerAddress: null, amountUsdc: 0 };
  }
}

interface SolanaParsedTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: {
    uiAmount: number | null;
    amount?: string;
    decimals?: number;
  };
}

interface SolanaAccountKey {
  pubkey: string;
  signer: boolean;
}

interface SolanaRpcTransactionResult {
  meta?: {
    err: unknown | null;
    preTokenBalances?: SolanaParsedTokenBalance[];
    postTokenBalances?: SolanaParsedTokenBalance[];
  } | null;
  transaction?: {
    message?: {
      accountKeys?: SolanaAccountKey[];
    };
  };
}

/**
 * On-chain Solana SPL USDC verification using standard JSON-RPC.
 */
export async function verifySolanaUsdcTransferOnChain(input: {
  txHash: string;
  expectedUsdc: number;
  treasuryAddress: string;
  memo?: string | null;
}): Promise<{ verified: boolean; payerAddress: string | null; amountUsdc: number }> {
  try {
    return await executeWithRpcFailover({
      chain: 'solana',
      action: async (rpcUrl) => {
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'billing-verify',
            method: 'getTransaction',
            params: [
              input.txHash,
              { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }
            ]
          })
        });

        if (!response.ok) {
          throw new Error(`Solana RPC HTTP ${response.status}: ${response.statusText}`);
        }

        const payload = (await response.json()) as {
          result?: SolanaRpcTransactionResult;
          error?: { message: string };
        };
        if (payload.error) {
          throw new Error(`Solana RPC error: ${payload.error.message}`);
        }
        const tx = payload.result;

        if (!tx?.meta || tx.meta.err !== null) {
          return { verified: false, payerAddress: null, amountUsdc: 0 };
        }

        // Never attribute a token transfer to the fee payer. Require a single
        // debited token owner who signed, with an equal treasury increase.
        const pre = tx.meta.preTokenBalances ?? [];
        const post = tx.meta.postTokenBalances ?? [];
        const keys = tx.transaction?.message?.accountKeys ?? [];
        const deltas = new Map<string, bigint>();
        const indexes = new Set([...pre, ...post].filter(b => b.mint === USDC_MINTS.solana).map(b => b.accountIndex));
        for (const index of indexes) {
          const before = pre.find(b => b.accountIndex === index);
          const after = post.find(b => b.accountIndex === index);
          const owner = after?.owner ?? before?.owner;
          if (!owner || (before && after && (before.owner !== after.owner || before.mint !== after.mint))) return { verified: false, payerAddress: null, amountUsdc: 0 };
          for (const balance of [before, after]) {
            if (balance && (balance.mint !== USDC_MINTS.solana || balance.uiTokenAmount.decimals !== 6 || !/^\d+$/.test(balance.uiTokenAmount.amount ?? ''))) return { verified: false, payerAddress: null, amountUsdc: 0 };
          }
          const delta = BigInt(after?.uiTokenAmount.amount ?? '0') - BigInt(before?.uiTokenAmount.amount ?? '0');
          deltas.set(owner, (deltas.get(owner) ?? 0n) + delta);
        }
        const received = deltas.get(input.treasuryAddress) ?? 0n;
        const debits = [...deltas].filter(([owner, delta]) => owner !== input.treasuryAddress && delta < 0n);
        const [payer, debit] = debits[0] ?? [null, 0n];
        const amountUsdc = Number(received) / 1e6;
        if (debits.length !== 1 || !payer || -debit !== received || received <= 0n || received > BigInt(Number.MAX_SAFE_INTEGER)
            || !keys.some(k => k.pubkey === payer && k.signer) || amountUsdc < input.expectedUsdc) return { verified: false, payerAddress: null, amountUsdc: 0 };
        return { verified: true, payerAddress: payer, amountUsdc };
      }
    });
  } catch (error) {
    console.error('[billing] Solana USDC verification failed:', error);
    return { verified: false, payerAddress: null, amountUsdc: 0 };
  }
}

const defaultVerifier: BillingDependencies['verifyOnChainPayment'] = async (input) => {
  if (input.chain === 'polygon') {
    return verifyPolygonUsdcTransferOnChain({
      txHash: input.txHash,
      expectedUsdc: input.expectedUsdc,
      treasuryAddress: input.treasuryAddress
    });
  }
  return verifySolanaUsdcTransferOnChain({
    txHash: input.txHash,
    expectedUsdc: input.expectedUsdc,
    treasuryAddress: input.treasuryAddress,
    memo: input.memo
  });
};

const defaultDependencies: BillingDependencies = {
  createPaymentIntent,
  recordCryptoPaymentAndGrantTier,
  getUserBillingStatus,
  listUserCryptoPayments,
  runTierDowngradeSweep,
  verifyOnChainPayment: defaultVerifier,
  listAuthWallets,
  findPaymentIntentByMemo: async (memo: string) => {
    try {
      const rows = await query<{ user_id: string; status: string; plan_id: string; expires_at: Date }>(
        `SELECT user_id, status, plan_id, expires_at FROM user_payment_intents WHERE reference_memo = $1`,
        [memo]
      );
      return rows[0]
        ? {
            userId: rows[0].user_id,
            status: rows[0].status,
            planId: rows[0].plan_id,
            expiresAt: rows[0].expires_at
          }
        : null;
    } catch {
      return null;
    }
  }
};

const intentBodySchema = z.object({
  planId: z.enum(['operator_monthly', 'ultra_monthly', 'lifetime'])
});

const verifyBodySchema = z
  .object({
    chain: z.enum(['solana', 'polygon']),
    txHash: z.string().min(10).max(128),
    planId: z.enum(['operator_monthly', 'ultra_monthly', 'lifetime']),
    memo: z.string().optional(),
    referenceMemo: z.string().optional()
  })
  .transform((data) => ({
    chain: data.chain,
    txHash: data.chain === 'polygon' ? data.txHash.trim().toLowerCase() : data.txHash.trim(),
    planId: data.planId,
    memo: data.memo || data.referenceMemo
  }));

export const defaultBillingDependencies: BillingDependencies = defaultDependencies;

export async function registerBillingRoutes(
  app: FastifyInstance,
  deps: BillingDependencies = defaultDependencies
): Promise<void> {
  /**
   * GET /v1/billing/plans
   * Public / Authenticated catalog of available plans and payment addresses.
   */
  app.get('/v1/billing/plans', async (_req, reply: FastifyReply) => {
    return reply.send({
      plans: Object.values(BILLING_PLANS),
      acceptedCurrencies: ['USDC'],
      usdcMints: USDC_MINTS,
      treasuryAddresses: DEFAULT_TREASURY_ADDRESSES
    });
  });

  /**
   * GET /v1/billing/status
   * User-scoped: returns current tier, expiration, and active grace-period status.
   */
  app.get('/v1/billing/status', async (request, reply: FastifyReply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const status = await deps.getUserBillingStatus(scope);
    return reply.send(status);
  });

  /**
   * GET /v1/billing/history
   * User-scoped: returns payment history receipts.
   */
  app.get('/v1/billing/history', async (request, reply: FastifyReply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const payments = await deps.listUserCryptoPayments(scope);
    return reply.send({ payments });
  });

  /**
   * POST /v1/billing/crypto/intent
   * User-scoped: generates a unique reference memo for external / exchange deposit.
   */
  app.post('/v1/billing/crypto/intent', async (request, reply: FastifyReply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const parsed = intentBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Invalid planId. Must be operator_monthly, ultra_monthly, or lifetime'
      });
    }

    try {
      const intent = await deps.createPaymentIntent(scope, parsed.data.planId);
      return reply.code(201).send({
        intent,
        treasuryAddresses: DEFAULT_TREASURY_ADDRESSES
      });
    } catch (error) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Failed to create payment intent', requestId: request.id
      });
    }
  });

  /**
   * POST /v1/billing/crypto/verify
   * User-scoped: verifies on-chain transaction hash and unlocks the subscription immediately.
   */
  app.post('/v1/billing/crypto/verify', async (request, reply: FastifyReply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const parsed = verifyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: parsed.error.issues[0]?.message || 'Invalid verification payload'
      });
    }

    const { chain, planId, memo } = parsed.data;
    let txHash: string;
    try { txHash = canonicalPaymentHash(chain, parsed.data.txHash); }
    catch { return reply.code(400).send({ error: 'invalid-transaction-hash' }); }
    const plan = resolveBillingPlan(planId);
    if (!plan) {
      return reply.code(400).send({ error: 'Bad Request', message: `Unknown plan: ${planId}` });
    }

    // API-01 / OWA-03: Prevent payment hijacking by binding payment to user intent or linked wallet
    const effectiveMemo = memo?.trim();
    if (effectiveMemo) {
      if (!deps.findPaymentIntentByMemo) return reply.code(503).send({ error: 'payment-intent-verification-unavailable' });
      {
        const intent = await deps.findPaymentIntentByMemo(effectiveMemo);
        if (!intent || intent.userId !== scope.userId) {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'This payment reference memo belongs to a different user account or does not exist.'
          });
        }
        if (intent.status !== 'pending') {
          return reply.code(400).send({
            error: 'Bad Request',
            message: `This payment intent has already been processed (status: ${intent.status}).`
          });
        }
        if (intent.planId !== planId) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: `Payment intent plan (${intent.planId}) does not match requested plan (${planId}).`
          });
        }
        if (!intent.expiresAt || !(new Date(intent.expiresAt).getTime() > Date.now())) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'This payment intent has expired.'
          });
        }
      }
    }

    const treasury = DEFAULT_TREASURY_ADDRESSES[chain];

    // 1. Verify on-chain transfer
    const verification = await deps.verifyOnChainPayment({
      chain,
      txHash,
      expectedUsdc: plan.priceUsdc,
      treasuryAddress: treasury,
      memo: effectiveMemo
    });

    if (!verification.verified) {
      return reply.code(422).send({
        error: 'Unprocessable Entity',
        message: `Transaction ${txHash} on ${chain} could not be verified as a valid payment of ${plan.priceUsdc} USDC to treasury.`
      });
    }

    // A user-supplied memo is not chain evidence. Exchange-originated deposits
    // need a separately implemented ownership/reference verifier; never credit them here.
    const linkedWallets = deps.listAuthWallets ? await deps.listAuthWallets(scope) : [];
    const payer = verification.payerAddress;
    const isLinkedPayer = payer && linkedWallets.some(w =>
      w.chainKind === (chain === 'solana' ? 'solana' : 'evm') &&
      (chain === 'solana' ? w.address === payer : w.address.toLowerCase() === payer.toLowerCase()));
    if (!isLinkedPayer) return reply.code(422).send({
      error: 'payment-attribution-unsupported', status: 'manual-review-required',
      message: 'No verified linked payer matches this transfer. Exchange or third-party deposits cannot be credited automatically; request manual review. A reference memo alone does not prove ownership.'
    });

    // 2. Record payment and upgrade tier atomically
    try {
      reply.header('Cache-Control', 'no-store');
      const result = await deps.recordCryptoPaymentAndGrantTier({
        scope,
        chain,
        txHash,
        amountUsdc: verification.amountUsdc,
        planId,
        payerAddress: verification.payerAddress,
        treasuryAddress: treasury,
        memo: effectiveMemo
      });
      await deps.onUserTierUpdated?.(scope.userId);

      return reply.code(200).send({
        success: true,
        paymentId: result.payment.id,
        tier: result.updatedTier,
        tierExpiresAt: result.updatedExpiresAt?.toISOString() ?? null,
        txHash: result.payment.txHash,
        amountUsdc: result.payment.amountUsdc
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'PaymentClaimRejectedError') return reply.code(409).send({ error: 'payment-claim-no-longer-eligible', message: 'Payment intent or linked payer changed. No payment was credited.' });
      if (error instanceof DuplicatePaymentTransactionError) {
        return reply.code(409).send({
          error: 'Conflict',
          message: error.message
        });
      }
      if (error instanceof UnderpaidPaymentError) {
        return reply.code(422).send({
          error: 'Unprocessable Entity',
          message: error.message
        });
      }
      request.log.error(error);
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to record payment'
      });
    }
  });

  /**
   * POST /v1/admin/billing/sweep
   * Admin-scoped: triggers the automated tier downgrade sweep.
   */
  app.post('/v1/admin/billing/sweep', async (request, reply: FastifyReply) => {
    if (!requireRole(request, reply, 'admin')) return;
    const result = await deps.runTierDowngradeSweep();
    if (result.downgradedUserIds.length > 0) {
      await deps.onUsersDowngraded?.(result.downgradedUserIds);
    }
    return reply.send({
      success: true,
      downgradedCount: result.downgradedCount,
      downgradedUserIds: result.downgradedUserIds
    });
  });
}
