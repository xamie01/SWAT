import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  BILLING_PLANS,
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
  listUserCryptoPayments,
  recordCryptoPaymentAndGrantTier,
  runTierDowngradeSweep,
  UnderpaidPaymentError,
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
        const { createPublicClient, http, parseAbiItem } = await import('viem');
        const { polygon } = await import('viem/chains');

        const client = createPublicClient({
          chain: polygon,
          transport: http(rpcUrl)
        });

        const receipt = await client.getTransactionReceipt({ hash: input.txHash as `0x${string}` });
        if (receipt.status !== 'success') {
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
            // Topics: [0] = signature, [1] = from, [2] = to
            if (log.topics[2]) {
              const toAddress = `0x${log.topics[2].slice(26)}`.toLowerCase();
              if (toAddress === treasuryLower) {
                const rawAmount = BigInt(log.data);
                const amountUsdc = Number(rawAmount) / 1e6;
                const fromAddress = log.topics[1] ? `0x${log.topics[1].slice(26)}` : null;

                if (amountUsdc >= input.expectedUsdc) {
                  return { verified: true, payerAddress: fromAddress, amountUsdc };
                }
              }
            }
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
              { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }
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

        if (!tx || tx.meta?.err) {
          return { verified: false, payerAddress: null, amountUsdc: 0 };
        }

        const targetMint = USDC_MINTS.solana;
        let foundAmountUsdc = 0;
        let payer: string | null = null;

        const preBalances = tx.meta?.preTokenBalances || [];
        const postBalances = tx.meta?.postTokenBalances || [];

        for (const post of postBalances) {
          if (post.mint === targetMint && post.owner === input.treasuryAddress) {
            const pre = preBalances.find((p: SolanaParsedTokenBalance) => p.accountIndex === post.accountIndex);
            const preAmount = pre?.uiTokenAmount.uiAmount || 0;
            const postAmount = post.uiTokenAmount.uiAmount || 0;
            const diff = postAmount - preAmount;
            if (diff > 0) {
              foundAmountUsdc += diff;
            }
          }
        }

        const accountKeys = tx.transaction?.message?.accountKeys || [];
        const signerAccount = accountKeys.find((k: SolanaAccountKey) => k.signer);
        if (signerAccount) {
          payer = signerAccount.pubkey;
        }

        if (foundAmountUsdc >= input.expectedUsdc) {
          return { verified: true, payerAddress: payer, amountUsdc: foundAmountUsdc };
        }

        return { verified: false, payerAddress: null, amountUsdc: foundAmountUsdc };
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
  verifyOnChainPayment: defaultVerifier
};

const intentBodySchema = z.object({
  planId: z.enum(['operator_monthly', 'ultra_monthly', 'lifetime'])
});

const verifyBodySchema = z.object({
  chain: z.enum(['solana', 'polygon']),
  txHash: z.string().min(10).max(128),
  planId: z.enum(['operator_monthly', 'ultra_monthly', 'lifetime']),
  memo: z.string().optional()
});

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
        message: error instanceof Error ? error.message : 'Failed to create payment intent'
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

    const { chain, txHash, planId, memo } = parsed.data;
    const plan = resolveBillingPlan(planId);
    if (!plan) {
      return reply.code(400).send({ error: 'Bad Request', message: `Unknown plan: ${planId}` });
    }

    const treasury = DEFAULT_TREASURY_ADDRESSES[chain];

    // 1. Verify on-chain transfer
    const verification = await deps.verifyOnChainPayment({
      chain,
      txHash,
      expectedUsdc: plan.priceUsdc,
      treasuryAddress: treasury,
      memo
    });

    if (!verification.verified) {
      return reply.code(422).send({
        error: 'Unprocessable Entity',
        message: `Transaction ${txHash} on ${chain} could not be verified as a valid payment of ${plan.priceUsdc} USDC to treasury.`
      });
    }

    // 2. Record payment and upgrade tier atomically
    try {
      const result = await deps.recordCryptoPaymentAndGrantTier({
        scope,
        chain,
        txHash,
        amountUsdc: verification.amountUsdc,
        planId,
        payerAddress: verification.payerAddress,
        treasuryAddress: treasury,
        memo
      });

      return reply.code(200).send({
        success: true,
        paymentId: result.payment.id,
        tier: result.updatedTier,
        tierExpiresAt: result.updatedExpiresAt?.toISOString() ?? null,
        txHash: result.payment.txHash,
        amountUsdc: result.payment.amountUsdc
      });
    } catch (error) {
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
    return reply.send({
      success: true,
      downgradedCount: result.downgradedCount,
      downgradedUserIds: result.downgradedUserIds
    });
  });
}
