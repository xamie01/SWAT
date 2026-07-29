import { resolveChainAddress } from '@swat/shared';
import {
  createTrojanAdapter,
  createTrojanWebhookTransport,
  prepareTrojanOrder,
  reconcileTrojanSubmission,
  type TrojanBalanceSnapshot,
  type TrojanConfirmationEvidence,
  type TrojanOrder,
  type TrojanReconciliationResult,
  type TrojanSubmissionResult,
  type TrojanWebhookCodec
} from './trojan.js';
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
  type RedisHashClient
} from './runtime-codec.js';

const DEFAULT_STORE_KEY = 'swat:trade-executor:pending:trojan:v1';

export type TrojanTerminalResolution =
  | Extract<TrojanReconciliationResult, { status: 'filled' | 'failed' | 'inconsistent' }>
  | { status: 'rejected'; clientOrderId: string; httpStatus: number }
  | { status: 'ambiguous'; clientOrderId: string; reason: string };

export type PendingTrojanSubmission = {
  submission: Extract<TrojanSubmissionResult, { status: 'pending_confirmation' | 'submission_unknown' }>;
  expiresAt: Date;
};

type StoredTrojanState =
  | { state: 'pending'; pending: PendingTrojanSubmission }
  | { state: 'resolved'; resolution: TrojanTerminalResolution };

export interface TrojanPendingStore {
  findPending(clientOrderId: string): Promise<PendingTrojanSubmission | null>;
  findResolution(clientOrderId: string): Promise<TrojanTerminalResolution | null>;
  listPending(): Promise<PendingTrojanSubmission[]>;
  save(pending: PendingTrojanSubmission): Promise<void>;
  resolve(clientOrderId: string, resolution: TrojanTerminalResolution): Promise<void>;
}

export function createRedisTrojanPendingStore(
  redis: RedisHashClient,
  key = DEFAULT_STORE_KEY
): TrojanPendingStore {
  async function read(clientOrderId: string): Promise<StoredTrojanState | null> {
    const encoded = await redis.hget(key, clientOrderId);
    return encoded ? decodeRuntimeValue<StoredTrojanState>(encoded) : null;
  }

  return {
    async findPending(clientOrderId) {
      const stored = await read(clientOrderId);
      return stored?.state === 'pending' ? stored.pending : null;
    },
    async findResolution(clientOrderId) {
      const stored = await read(clientOrderId);
      return stored?.state === 'resolved' ? stored.resolution : null;
    },
    async listPending() {
      const values = await redis.hgetall(key);
      return Object.values(values).flatMap((encoded) => {
        const stored = decodeRuntimeValue<StoredTrojanState>(encoded);
        return stored.state === 'pending' ? [stored.pending] : [];
      });
    },
    async save(pending) {
      await redis.hset(key, pending.submission.clientOrderId, encodeRuntimeValue({
        state: 'pending',
        pending
      } satisfies StoredTrojanState));
    },
    async resolve(clientOrderId, resolution) {
      await redis.hset(key, clientOrderId, encodeRuntimeValue({
        state: 'resolved',
        resolution
      } satisfies StoredTrojanState));
    }
  };
}

type TrojanAdapter = ReturnType<typeof createTrojanAdapter>;

export type TrojanRuntimeSubmission = TrojanSubmissionResult | {
  status: 'already_resolved';
  clientOrderId: string;
  resolution: TrojanTerminalResolution;
};

export type TrojanSubmitInput = {
  signalId: string;
  tokenMint: string;
  direction: 'buy' | 'sell';
  amountLamports?: string;
  sellProportionBps?: number;
  maximumTokenAmountBaseUnits?: string;
  slippageBps: number;
};

export function createTrojanRuntime(options: {
  adapter: TrojanAdapter;
  pendingStore: TrojanPendingStore;
  readBalance: (tokenMint: string) => Promise<TrojanBalanceSnapshot>;
  readConfirmation?: (transactionIdentity: string) => Promise<TrojanConfirmationEvidence>;
  pendingTtlMs: number;
  now?: () => Date;
}) {
  if (!Number.isInteger(options.pendingTtlMs) || options.pendingTtlMs < 60_000) {
    throw new Error('Trojan pending TTL must be at least 60 seconds');
  }
  const now = options.now ?? (() => new Date());

  return {
    async submit(input: TrojanSubmitInput): Promise<TrojanRuntimeSubmission> {
      const existing = await options.pendingStore.findPending(input.signalId);
      if (existing) return existing.submission;
      const resolution = await options.pendingStore.findResolution(input.signalId);
      if (resolution) {
        return { status: 'already_resolved', clientOrderId: input.signalId, resolution };
      }

      const beforeBalance = await options.readBalance(input.tokenMint);
      const order: TrojanOrder = input.direction === 'buy'
        ? {
            side: 'buy',
            signalId: input.signalId,
            tokenMint: input.tokenMint,
            amountLamports: input.amountLamports ?? '',
            slippageBps: input.slippageBps,
            beforeBalance
          }
        : {
            side: 'sell',
            signalId: input.signalId,
            tokenMint: input.tokenMint,
            sellProportionBps: input.sellProportionBps ?? 10_000,
            maximumTokenAmountBaseUnits: input.maximumTokenAmountBaseUnits,
            slippageBps: input.slippageBps,
            beforeBalance
          };
      const prepared = prepareTrojanOrder(order);
      const startedAt = now();
      const expiresAt = new Date(startedAt.getTime() + options.pendingTtlMs);

      // Persist an ambiguous intent before the network call. A process crash can
      // therefore never turn an unknown submission into an automatic resubmit.
      await options.pendingStore.save({
        submission: {
          status: 'submission_unknown',
          clientOrderId: prepared.clientOrderId,
          reason: 'transport-error',
          order: prepared,
          firstAttemptAt: startedAt,
          lastAttemptAt: startedAt,
          attempts: 0
        },
        expiresAt
      });

      const submission = await options.adapter.submit(order);
      if (submission.status === 'rejected') {
        await options.pendingStore.resolve(submission.clientOrderId, {
          status: 'rejected',
          clientOrderId: submission.clientOrderId,
          httpStatus: submission.httpStatus
        });
        return submission;
      }
      await options.pendingStore.save({ submission, expiresAt });
      return submission;
    },
    async reconcile(nowAt = now()) {
      if (!options.readConfirmation) {
        throw new Error('Trojan confirmation reader is not configured');
      }
      return reconcileTrojanPending({
        pendingStore: options.pendingStore,
        readConfirmation: options.readConfirmation,
        readBalance: options.readBalance,
        now: nowAt
      });
    }
  };
}

export async function reconcileTrojanPending(input: {
  pendingStore: TrojanPendingStore;
  readConfirmation: (transactionIdentity: string) => Promise<TrojanConfirmationEvidence>;
  readBalance: (tokenMint: string) => Promise<TrojanBalanceSnapshot>;
  now?: Date;
}): Promise<TrojanReconciliationResult[] | Array<TrojanReconciliationResult | TrojanTerminalResolution>> {
  const now = input.now ?? new Date();
  const results: Array<TrojanReconciliationResult | TrojanTerminalResolution> = [];
  for (const pending of await input.pendingStore.listPending()) {
    const submission = pending.submission;
    if (submission.status === 'submission_unknown') {
      if (now >= pending.expiresAt) {
        const result: TrojanTerminalResolution = {
          status: 'ambiguous',
          clientOrderId: submission.clientOrderId,
          reason: 'submission identity remained unknown until the reconciliation deadline'
        };
        await input.pendingStore.resolve(submission.clientOrderId, result);
        results.push(result);
      } else {
        results.push({ status: 'submission_unknown', clientOrderId: submission.clientOrderId });
      }
      continue;
    }

    let confirmation: TrojanConfirmationEvidence;
    try {
      confirmation = await input.readConfirmation(submission.transactionIdentity);
    } catch {
      results.push({
        status: 'pending_confirmation',
        transactionIdentity: submission.transactionIdentity
      });
      continue;
    }
    if (confirmation.status === 'not-found' && now >= pending.expiresAt) {
      const result: TrojanTerminalResolution = {
        status: 'ambiguous',
        clientOrderId: submission.clientOrderId,
        reason: 'transaction identity was not found before the reconciliation deadline'
      };
      await input.pendingStore.resolve(submission.clientOrderId, result);
      results.push(result);
      continue;
    }

    let afterBalance: TrojanBalanceSnapshot | undefined;
    if (confirmation.status === 'confirmed') {
      try {
        afterBalance = await input.readBalance(submission.order.tokenMint);
      } catch {
        results.push({
          status: 'pending_reconciliation',
          transactionIdentity: submission.transactionIdentity
        });
        continue;
      }
    }
    const result = reconcileTrojanSubmission({ submission, confirmation, afterBalance });
    results.push(result);
    if (result.status === 'filled' || result.status === 'failed' || result.status === 'inconsistent') {
      await input.pendingStore.resolve(submission.clientOrderId, result);
    }
  }
  return results;
}

type RpcError = { message?: unknown };

async function rpcRequest<T>(options: {
  url: string;
  method: string;
  params: unknown[];
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetchImpl(options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: `swat-${options.method}`, method: options.method, params: options.params })
    });
    if (!response.ok) throw new Error(`Helius RPC ${options.method} returned HTTP ${response.status}`);
    const body = await response.json() as { result?: T; error?: RpcError };
    if (body.error || body.result === undefined) {
      throw new Error(`Helius RPC ${options.method} failed: ${String(body.error?.message ?? 'missing result')}`);
    }
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

export function createHeliusTrojanRuntimeClient(options: {
  walletAddress: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}) {
  const walletAddress = resolveChainAddress(options.walletAddress, 'solana').raw;
  if (!options.apiKey) throw new Error('HELIUS_API_KEY is required for Trojan reconciliation');
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error('Helius runtime timeout must be a positive integer');
  }
  const url = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(options.apiKey)}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());

  return {
    async readBalance(tokenMint: string): Promise<TrojanBalanceSnapshot> {
      const [native, tokens] = await Promise.all([
        rpcRequest<{ context?: { slot?: number }; value?: unknown }>({
          url,
          method: 'getBalance',
          params: [walletAddress, { commitment: 'confirmed' }],
          timeoutMs: options.timeoutMs,
          fetchImpl
        }),
        rpcRequest<{ context?: { slot?: number }; value?: unknown }>({
          url,
          method: 'getTokenAccountsByOwner',
          params: [walletAddress, { mint: tokenMint }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
          timeoutMs: options.timeoutMs,
          fetchImpl
        })
      ]);
      if (typeof native.value !== 'number' || !Number.isSafeInteger(native.value) || native.value < 0) {
        throw new Error('Helius returned an invalid native lamport balance');
      }
      if (!Array.isArray(tokens.value)) throw new Error('Helius returned invalid token accounts');
      let tokenBaseUnits = 0n;
      for (const account of tokens.value) {
        const amount = (account as {
          account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: unknown } } } } };
        }).account?.data?.parsed?.info?.tokenAmount?.amount;
        if (typeof amount !== 'string' || !/^\d+$/.test(amount)) {
          throw new Error('Helius returned an invalid token account balance');
        }
        tokenBaseUnits += BigInt(amount);
      }
      return {
        walletAddress,
        tokenMint,
        nativeLamports: native.value.toString(),
        tokenBaseUnits: tokenBaseUnits.toString(),
        observedAt: now(),
        slot: Math.max(native.context?.slot ?? 0, tokens.context?.slot ?? 0) || undefined
      };
    },
    async readConfirmation(transactionIdentity: string): Promise<TrojanConfirmationEvidence> {
      const result = await rpcRequest<{ value?: unknown }>({
        url,
        method: 'getSignatureStatuses',
        params: [[transactionIdentity], { searchTransactionHistory: true }],
        timeoutMs: options.timeoutMs,
        fetchImpl
      });
      if (!Array.isArray(result.value) || result.value.length !== 1) {
        throw new Error('Helius returned invalid signature status evidence');
      }
      const status = result.value[0] as {
        err?: unknown;
        slot?: unknown;
        confirmationStatus?: unknown;
      } | null;
      const observedAt = now();
      if (!status || (status.confirmationStatus !== 'confirmed' && status.confirmationStatus !== 'finalized')) {
        return { transactionIdentity, status: 'not-found', observedAt };
      }
      return {
        transactionIdentity,
        status: status.err === null || status.err === undefined ? 'confirmed' : 'failed',
        observedAt,
        ...(typeof status.slot === 'number' && Number.isSafeInteger(status.slot) ? { slot: status.slot } : {})
      };
    }
  };
}

export function createSwatTrojanWebhookCodec(): TrojanWebhookCodec {
  return {
    encode(order) {
      const common = {
        action: order.side,
        token: order.tokenMint,
        slippage_bps: order.slippageBps,
        mev_protection: true,
        source: 'SWAT_ENGINE',
        signal_id: order.signalId,
        client_order_id: order.clientOrderId,
        wallet_address: order.beforeBalance.walletAddress
      };
      return order.side === 'buy'
        ? { ...common, amount_lamports: order.amountLamports }
        : {
            ...common,
            token_amount_base_units: order.tokenAmountBaseUnits,
            sell_proportion_bps: order.sellProportionBps
          };
    },
    decode(body) {
      const value = body as { signature?: unknown; transactionIdentity?: unknown } | null;
      const identity = value?.transactionIdentity ?? value?.signature;
      if (typeof identity !== 'string' || identity.length === 0) {
        return { transactionIdentity: '' };
      }
      return { transactionIdentity: identity };
    }
  };
}

export type TrojanRuntime = ReturnType<typeof createTrojanRuntime>;

let configuredRuntime: TrojanRuntime | null = null;
let runtimeReadiness = { ready: false, reason: 'runtime_not_configured' };

export function configureTrojanRuntime(runtime: TrojanRuntime): void {
  configuredRuntime = runtime;
  runtimeReadiness = { ready: true, reason: 'runtime_configured' };
}

export function setTrojanRuntimeUnavailable(reason: string): void {
  configuredRuntime = null;
  runtimeReadiness = { ready: false, reason };
}

export function getTrojanLiveReadiness(): { ready: boolean; reason: string } {
  return { ...runtimeReadiness };
}

export function getConfiguredTrojanRuntime(): TrojanRuntime | null {
  return configuredRuntime;
}

export function createTrojanRuntimeFromEnvironment(redis: RedisHashClient): TrojanRuntime {
  const url = process.env.TROJAN_WEBHOOK_URL?.trim();
  const walletAddress = process.env.TROJAN_WALLET_ADDRESS?.trim();
  const apiKey = process.env.HELIUS_API_KEY?.trim();
  if (!url) throw new Error('TROJAN_WEBHOOK_URL is required for Solana live execution');
  if (!walletAddress) throw new Error('TROJAN_WALLET_ADDRESS is required for Solana live execution');
  if (!apiKey) throw new Error('HELIUS_API_KEY is required for Solana live execution');
  const timeoutMs = Number(process.env.TROJAN_TIMEOUT_MS ?? 15_000);
  const rpcTimeoutMs = Number(process.env.HELIUS_RPC_TIMEOUT_MS ?? 15_000);
  const pendingTtlMs = Number(process.env.TROJAN_PENDING_TTL_MS ?? 600_000);
  const maxAttempts = Number(process.env.TROJAN_MAX_ATTEMPTS ?? 1);
  const rpc = createHeliusTrojanRuntimeClient({ walletAddress, apiKey, timeoutMs: rpcTimeoutMs });
  const adapter = createTrojanAdapter(createTrojanWebhookTransport({
    url,
    apiKey: process.env.TROJAN_API_KEY,
    codec: createSwatTrojanWebhookCodec()
  }), {
    timeoutMs,
    maxAttempts,
    retryDelayMs: Number(process.env.TROJAN_RETRY_DELAY_MS ?? 0)
  });
  return createTrojanRuntime({
    adapter,
    pendingStore: createRedisTrojanPendingStore(redis),
    readBalance: rpc.readBalance,
    readConfirmation: rpc.readConfirmation,
    pendingTtlMs
  });
}

export async function triggerTrojan(params: {
  signalId: string;
  tokenMint: string;
  amountSol: number;
  slippageBps?: number;
  direction?: 'buy' | 'sell';
  sellProportionBps?: number;
  maximumTokenAmountBaseUnits?: string;
}): Promise<TrojanRuntimeSubmission> {
  if (!configuredRuntime) throw new Error(`Trojan live runtime is unavailable: ${runtimeReadiness.reason}`);
  const direction = params.direction ?? 'buy';
  const amountLamports = Math.round(params.amountSol * 1_000_000_000);
  if (direction === 'buy' && (!Number.isSafeInteger(amountLamports) || amountLamports <= 0)) {
    throw new Error('Trojan BUY amount must resolve to positive safe lamports');
  }
  return configuredRuntime.submit({
    signalId: params.signalId,
    tokenMint: params.tokenMint,
    direction,
    ...(direction === 'buy' ? { amountLamports: amountLamports.toString() } : {}),
    sellProportionBps: params.sellProportionBps,
    maximumTokenAmountBaseUnits: params.maximumTokenAmountBaseUnits,
    slippageBps: params.slippageBps ?? 1500
  });
}
