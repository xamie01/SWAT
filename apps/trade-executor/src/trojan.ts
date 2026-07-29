export const MAX_TROJAN_ATTEMPTS = 3;
export const MAX_TROJAN_TIMEOUT_MS = 60_000;

export type TrojanBalanceSnapshot = {
  walletAddress: string;
  tokenMint: string;
  nativeLamports: string;
  tokenBaseUnits: string;
  observedAt: Date;
  slot?: number;
};

type TrojanOrderBase = {
  signalId: string;
  tokenMint: string;
  slippageBps: number;
  beforeBalance: TrojanBalanceSnapshot;
};

export type TrojanBuyOrder = TrojanOrderBase & {
  side: 'buy';
  amountLamports: string;
};

export type TrojanSellOrder = TrojanOrderBase & {
  side: 'sell';
  /** 1 = 0.01%, 10_000 = the full pre-submit token balance. */
  sellProportionBps: number;
  /** Canonical copied-position cap; the live balance may be larger. */
  maximumTokenAmountBaseUnits?: string;
};

export type TrojanOrder = TrojanBuyOrder | TrojanSellOrder;

export type PreparedTrojanOrder = TrojanOrderBase & {
  clientOrderId: string;
} & (
  | { side: 'buy'; amountLamports: string }
  | {
      side: 'sell';
      sellProportionBps: number;
      tokenAmountBaseUnits: string;
    }
);

export type TrojanTransportReceipt = {
  /** Returned Solana transaction signature/identity; never synthesized by SWAT. */
  transactionIdentity: string;
  providerStatus?: string;
};

export type TrojanTransportContext = {
  attempt: number;
  maxAttempts: number;
  timeoutMs: number;
  idempotencyKey: string;
  signal: AbortSignal;
};

export type TrojanTransport = (
  order: PreparedTrojanOrder,
  context: TrojanTransportContext
) => Promise<TrojanTransportReceipt>;

type SubmissionTiming = {
  firstAttemptAt: Date;
  lastAttemptAt: Date;
  attempts: number;
};

export type TrojanSubmissionResult =
  | (SubmissionTiming & {
      status: 'pending_confirmation';
      clientOrderId: string;
      transactionIdentity: string;
      acknowledgedAt: Date;
      order: PreparedTrojanOrder;
    })
  | (SubmissionTiming & {
      status: 'submission_unknown';
      clientOrderId: string;
      reason: 'timeout-after-submit' | 'transport-error' | 'missing-transaction-identity';
      order: PreparedTrojanOrder;
    })
  | (SubmissionTiming & {
      status: 'rejected';
      clientOrderId: string;
      httpStatus: number;
      order: PreparedTrojanOrder;
    });

export class TrojanRequestRejectedError extends Error {
  constructor(public readonly httpStatus: number) {
    super(`Trojan request rejected with HTTP ${httpStatus}`);
    this.name = 'TrojanRequestRejectedError';
  }
}

export type TrojanAdapterOptions = {
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs?: number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
};

function parseBaseUnits(value: string, label: string): bigint {
  if (!/^[0-9]+$/.test(value)) throw new Error(`${label} must be base-10 base units`);
  const parsed = BigInt(value);
  if (parsed < 0n) throw new Error(`${label} cannot be negative`);
  return parsed;
}

function validateSnapshot(snapshot: TrojanBalanceSnapshot, tokenMint: string): void {
  if (!snapshot.walletAddress) throw new Error('Trojan balance snapshot requires a wallet address');
  if (snapshot.tokenMint !== tokenMint) {
    throw new Error('Trojan balance snapshot token does not match the order token');
  }
  parseBaseUnits(snapshot.nativeLamports, 'nativeLamports');
  parseBaseUnits(snapshot.tokenBaseUnits, 'tokenBaseUnits');
  if (!Number.isFinite(snapshot.observedAt.getTime())) {
    throw new Error('Trojan balance snapshot has an invalid observedAt timestamp');
  }
}

export function prepareTrojanOrder(order: TrojanOrder): PreparedTrojanOrder {
  if (!order.signalId || order.signalId.length > 200) {
    throw new Error('Trojan order requires a stable signal ID of at most 200 characters');
  }
  if (!order.tokenMint) throw new Error('Trojan order requires a token mint');
  if (!Number.isInteger(order.slippageBps) || order.slippageBps < 0 || order.slippageBps > 10_000) {
    throw new Error('Trojan slippage must be between 0 and 10,000 basis points');
  }
  validateSnapshot(order.beforeBalance, order.tokenMint);

  const base = {
    signalId: order.signalId,
    clientOrderId: order.signalId,
    tokenMint: order.tokenMint,
    slippageBps: order.slippageBps,
    beforeBalance: order.beforeBalance
  };

  if (order.side === 'buy') {
    const amountLamports = parseBaseUnits(order.amountLamports, 'amountLamports');
    if (amountLamports === 0n) throw new Error('Trojan BUY amount must be greater than zero');
    return { ...base, side: 'buy', amountLamports: amountLamports.toString() };
  }

  if (
    !Number.isInteger(order.sellProportionBps)
    || order.sellProportionBps < 1
    || order.sellProportionBps > 10_000
  ) {
    throw new Error('Trojan SELL proportion must be between 1 and 10,000 basis points');
  }
  const available = parseBaseUnits(order.beforeBalance.tokenBaseUnits, 'tokenBaseUnits');
  const proportionalAmount = (available * BigInt(order.sellProportionBps)) / 10_000n;
  const canonicalCap = order.maximumTokenAmountBaseUnits === undefined
    ? proportionalAmount
    : parseBaseUnits(order.maximumTokenAmountBaseUnits, 'maximumTokenAmountBaseUnits');
  const tokenAmount = canonicalCap < proportionalAmount ? canonicalCap : proportionalAmount;
  if (tokenAmount === 0n) {
    throw new Error('Trojan SELL proportion rounds to zero token base units');
  }

  return {
    ...base,
    side: 'sell',
    sellProportionBps: order.sellProportionBps,
    tokenAmountBaseUnits: tokenAmount.toString()
  };
}

type AttemptResult =
  | { kind: 'receipt'; receipt: TrojanTransportReceipt }
  | { kind: 'rejected'; error: TrojanRequestRejectedError }
  | { kind: 'transport-error' }
  | { kind: 'timeout' };

async function runAttempt(
  transport: TrojanTransport,
  order: PreparedTrojanOrder,
  context: Omit<TrojanTransportContext, 'signal'>
): Promise<AttemptResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<AttemptResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: 'timeout' });
      controller.abort();
    }, context.timeoutMs);
  });
  const request = transport(order, { ...context, signal: controller.signal })
    .then((receipt): AttemptResult => ({ kind: 'receipt', receipt }))
    .catch((error: unknown): AttemptResult => (
      error instanceof TrojanRequestRejectedError
        ? { kind: 'rejected', error }
        : { kind: 'transport-error' }
    ));

  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createTrojanAdapter(
  transport: TrojanTransport,
  options: TrojanAdapterOptions
) {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAX_TROJAN_TIMEOUT_MS) {
    throw new Error(`Trojan timeout must be between 1 and ${MAX_TROJAN_TIMEOUT_MS} milliseconds`);
  }
  if (
    !Number.isInteger(options.maxAttempts)
    || options.maxAttempts < 1
    || options.maxAttempts > MAX_TROJAN_ATTEMPTS
  ) {
    throw new Error(`Trojan attempts must be between 1 and ${MAX_TROJAN_ATTEMPTS}`);
  }
  const retryDelayMs = options.retryDelayMs ?? 0;
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 10_000) {
    throw new Error('Trojan retry delay must be between 0 and 10,000 milliseconds');
  }
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((milliseconds: number) => (
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
  ));

  return {
    async submit(orderInput: TrojanOrder): Promise<TrojanSubmissionResult> {
      const order = prepareTrojanOrder(orderInput);
      const firstAttemptAt = now();
      let lastAttemptAt = firstAttemptAt;
      let lastFailure: AttemptResult['kind'] = 'transport-error';

      for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
        lastAttemptAt = now();
        const result = await runAttempt(transport, order, {
          attempt,
          maxAttempts: options.maxAttempts,
          timeoutMs: options.timeoutMs,
          idempotencyKey: order.clientOrderId
        });

        if (result.kind === 'receipt') {
          if (
            typeof result.receipt.transactionIdentity === 'string'
            && result.receipt.transactionIdentity.length > 0
          ) {
            return {
              status: 'pending_confirmation',
              clientOrderId: order.clientOrderId,
              transactionIdentity: result.receipt.transactionIdentity,
              order,
              firstAttemptAt,
              lastAttemptAt,
              acknowledgedAt: now(),
              attempts: attempt
            };
          }
          lastFailure = 'receipt';
        } else if (result.kind === 'rejected') {
          return {
            status: 'rejected',
            clientOrderId: order.clientOrderId,
            httpStatus: result.error.httpStatus,
            order,
            firstAttemptAt,
            lastAttemptAt,
            attempts: attempt
          };
        } else {
          lastFailure = result.kind;
        }

        if (attempt < options.maxAttempts && retryDelayMs > 0) {
          await sleep(retryDelayMs);
        }
      }

      return {
        status: 'submission_unknown',
        clientOrderId: order.clientOrderId,
        reason: lastFailure === 'timeout'
          ? 'timeout-after-submit'
          : lastFailure === 'receipt'
            ? 'missing-transaction-identity'
            : 'transport-error',
        order,
        firstAttemptAt,
        lastAttemptAt,
        attempts: options.maxAttempts
      };
    }
  };
}

export type TrojanWebhookCodec = {
  encode(order: PreparedTrojanOrder): unknown;
  decode(responseBody: unknown): TrojanTransportReceipt;
};

export type TrojanWebhookTransportOptions = {
  url: string;
  apiKey?: string;
  codec: TrojanWebhookCodec;
  fetchImpl?: typeof fetch;
};

/**
 * HTTP transport for a reviewed Trojan webhook codec. Payload fields are not
 * guessed here: live wiring must provide a codec matching the configured bot.
 */
export function createTrojanWebhookTransport(
  options: TrojanWebhookTransportOptions
): TrojanTransport {
  if (!options.url) throw new Error('Trojan webhook URL is required');
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (order, context) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'Idempotency-Key': context.idempotencyKey
    };
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;

    const response = await fetchImpl(options.url, {
      method: 'POST',
      headers,
      signal: context.signal,
      body: JSON.stringify(options.codec.encode(order))
    });
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
        throw new TrojanRequestRejectedError(response.status);
      }
      throw new Error(`Trojan webhook returned retryable HTTP ${response.status}`);
    }

    return options.codec.decode(await response.json());
  };
}

export type TrojanConfirmationEvidence = {
  transactionIdentity: string;
  status: 'confirmed' | 'failed' | 'not-found';
  observedAt: Date;
  slot?: number;
};

export type TrojanReconciliationResult =
  | { status: 'pending_confirmation'; transactionIdentity: string }
  | { status: 'submission_unknown'; clientOrderId: string }
  | { status: 'pending_reconciliation'; transactionIdentity: string }
  | { status: 'failed'; transactionIdentity: string }
  | { status: 'inconsistent'; transactionIdentity: string; reason: string }
  | {
      status: 'filled';
      transactionIdentity: string;
      fillKind: 'entry' | 'partial-exit' | 'full-exit';
      nativeLamportsDelta: string;
      tokenBaseUnitsDelta: string;
      confirmedAt: Date;
      slot?: number;
    };

export function reconcileTrojanSubmission(input: {
  submission: Extract<TrojanSubmissionResult, { status: 'pending_confirmation' | 'submission_unknown' }>;
  confirmation?: TrojanConfirmationEvidence;
  afterBalance?: TrojanBalanceSnapshot;
}): TrojanReconciliationResult {
  const { submission, confirmation, afterBalance } = input;
  if (!confirmation || confirmation.status === 'not-found') {
    return submission.status === 'submission_unknown'
      ? { status: 'submission_unknown', clientOrderId: submission.clientOrderId }
      : { status: 'pending_confirmation', transactionIdentity: submission.transactionIdentity };
  }

  if (
    submission.status === 'pending_confirmation'
    && confirmation.transactionIdentity !== submission.transactionIdentity
  ) {
    return {
      status: 'inconsistent',
      transactionIdentity: confirmation.transactionIdentity,
      reason: 'Confirmation identity does not match the submitted transaction identity'
    };
  }
  if (confirmation.status === 'failed') {
    return { status: 'failed', transactionIdentity: confirmation.transactionIdentity };
  }
  if (!afterBalance) {
    return {
      status: 'pending_reconciliation',
      transactionIdentity: confirmation.transactionIdentity
    };
  }

  if (
    confirmation.slot !== undefined
    && afterBalance.slot !== undefined
    && afterBalance.slot < confirmation.slot
  ) {
    return {
      status: 'pending_reconciliation',
      transactionIdentity: confirmation.transactionIdentity
    };
  }

  try {
    validateSnapshot(afterBalance, submission.order.tokenMint);
  } catch (error) {
    return {
      status: 'inconsistent',
      transactionIdentity: confirmation.transactionIdentity,
      reason: error instanceof Error ? error.message : 'Invalid post-submit balance snapshot'
    };
  }
  if (afterBalance.walletAddress !== submission.order.beforeBalance.walletAddress) {
    return {
      status: 'inconsistent',
      transactionIdentity: confirmation.transactionIdentity,
      reason: 'Post-submit wallet does not match the pre-submit wallet'
    };
  }

  const beforeNative = parseBaseUnits(submission.order.beforeBalance.nativeLamports, 'nativeLamports');
  const afterNative = parseBaseUnits(afterBalance.nativeLamports, 'nativeLamports');
  const beforeToken = parseBaseUnits(submission.order.beforeBalance.tokenBaseUnits, 'tokenBaseUnits');
  const afterToken = parseBaseUnits(afterBalance.tokenBaseUnits, 'tokenBaseUnits');
  const nativeDelta = afterNative - beforeNative;
  const tokenDelta = afterToken - beforeToken;

  if (submission.order.side === 'buy' && (nativeDelta >= 0n || tokenDelta <= 0n)) {
    return {
      status: 'inconsistent',
      transactionIdentity: confirmation.transactionIdentity,
      reason: 'Confirmed BUY lacks the required native decrease and token increase'
    };
  }
  if (submission.order.side === 'sell' && (nativeDelta <= 0n || tokenDelta >= 0n)) {
    return {
      status: 'inconsistent',
      transactionIdentity: confirmation.transactionIdentity,
      reason: 'Confirmed SELL lacks the required token decrease and native increase'
    };
  }

  return {
    status: 'filled',
    transactionIdentity: confirmation.transactionIdentity,
    fillKind: submission.order.side === 'buy'
      ? 'entry'
      : afterToken === 0n
        ? 'full-exit'
        : 'partial-exit',
    nativeLamportsDelta: nativeDelta.toString(),
    tokenBaseUnitsDelta: tokenDelta.toString(),
    confirmedAt: confirmation.observedAt,
    ...(confirmation.slot === undefined ? {} : { slot: confirmation.slot })
  };
}
