import {
  buildJupiterSwap,
  getJitoBundleStatus,
  getJitoTipAccounts,
  getJitoTipFloor,
  selectJitoTip,
  selectTipAccount,
  submitJitoBundle,
  type JitoClientOptions,
  type JupiterQuote
} from '@swat/shared';
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
  type RedisHashClient
} from './runtime-codec.js';
import type { SolanaSimulationGate } from './solana-simulation.js';

/**
 * Solana execution over Jupiter + Jito bundles (DG-1, checklist S3-1…S3-5).
 *
 * Replaces the Trojan webhook path. The state machine deliberately mirrors
 * `trojan-runtime.ts` — `pending_confirmation` handed to the existing sweeper,
 * terminal resolutions cached by client order id — so the executor's
 * reconciliation semantics carry over unchanged and only the transport differs.
 *
 * **Bundles, never public RPC.** A swap broadcast to the public mempool is
 * visible to searchers before it lands, which is the window a sandwich needs.
 * Bundles go straight to block builders and land atomically, so there is also no
 * partial-fill state to reconcile.
 */

const DEFAULT_STORE_KEY = 'swat:trade-executor:pending:jupiter-jito:v1';

/**
 * Wrapped SOL. The tip is paid in lamports; `feeUsd` needs a USD price for them.
 *
 * Duplicated rather than imported from `solana-dispatch.ts`, which already exports
 * the same constant — that module imports *this* one, so importing back would
 * close an import cycle.
 */
const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

export interface JupiterJitoExecutionIdentity {
  readonly executionId: string;
  readonly clientOrderId: string;
  readonly userId: string | null;
  readonly chain: 'solana';
  readonly targetAccount: string;
}

export interface JupiterJitoIntent {
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inputAmountRaw: string;
  readonly slippageBps: number;
  readonly recipient: string;
}

export interface JupiterJitoReceipt {
  readonly execution: JupiterJitoExecutionIdentity;
  readonly signature: string;
  readonly slot: number;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inputAmountRaw: string;
  readonly outputAmountRaw: string;
  readonly feeLamports: string;
  /** Canonical exact decimal fiat valuation supplied by the receipt accounting adapter. */
  readonly feeUsd: string;
}

export interface JupiterJitoSubmitInput {
  /** Stable idempotency key. Must be `(signalId, target_account)`-derived. */
  readonly clientOrderId: string;
  readonly quote: JupiterQuote;
  readonly signerPublicKey: string;
  /** Missing legacy identities cannot authorize a new submission. */
  readonly execution?: JupiterJitoExecutionIdentity;
  readonly intent?: JupiterJitoIntent;
}

export type JupiterJitoSubmission =
  | { readonly status: 'submitted'; readonly clientOrderId: string; readonly bundleId: string; readonly lastValidBlockHeight: number }
  | { readonly status: 'pending_confirmation'; readonly clientOrderId: string; readonly bundleId: string; readonly lastValidBlockHeight: number }
  | {
      readonly status: 'rejected';
      readonly clientOrderId: string;
      readonly reason: string;
      /**
       * Stable machine-readable code, when the rejection has one.
       *
       * Optional and additive so existing consumers that only read `reason` keep
       * working; `S4-M24` reads this to render an actionable skip reason instead
       * of parsing prose.
       */
      readonly code?: string;
    }
  | { readonly status: 'submission_unknown'; readonly clientOrderId: string; readonly reason: string }
  | { readonly status: 'already_resolved'; readonly clientOrderId: string; readonly resolution: JupiterJitoResolution };

/**
 * Terminal outcomes.
 *
 * **Only `filled` carries a tip** (checklist S4-P18). Jito bundles are atomic and
 * all-or-nothing, so a bundle that never landed was never charged a tip, and
 * booking one against a `failed` or `ambiguous` outcome would fabricate a cost
 * against a position that does not exist. Keeping the fields off the non-landed
 * variants makes that a type-level guarantee rather than a convention a future
 * call site can forget.
 *
 * `ambiguous` is the case worth being explicit about: it covers a confirmation
 * timeout and a bundle that landed without an observable signature. Neither is a
 * *free* outcome — the second one almost certainly did pay a tip — but neither is
 * an observed one either, and there is no position to attribute a cost to. The
 * cost of an ambiguous outcome is settled by an operator reading the chain, not
 * guessed here.
 */
export type JupiterJitoResolution =
  | {
      readonly status: 'filled';
      readonly clientOrderId: string;
      readonly signature: string;
      readonly slot: number | null;
      /** Quantified chain receipt, required before accounting acknowledgement. */
      readonly receipt?: JupiterJitoReceipt;
      /** Tip actually paid by the landed bundle. Absent on records written before S4-P18. */
      readonly tipLamports?: number | null;
      /**
       * The tip in USD, for `persistTrade`'s `feeUsd`.
       *
       * `null` when the SOL price was unavailable: a missing fee is visibly
       * absent, a guessed one silently misstates P&L.
       */
      readonly feeUsd?: number | null;
    }
  | { readonly status: 'failed'; readonly clientOrderId: string; readonly reason: string }
  | { readonly status: 'ambiguous'; readonly clientOrderId: string; readonly reason: string };

export interface PendingJupiterJitoSubmission {
  readonly clientOrderId: string;
  readonly bundleId: string | null;
  readonly execution?: JupiterJitoExecutionIdentity;
  readonly intent?: JupiterJitoIntent;
  readonly signedTransactions?: readonly string[];
  readonly signatures?: readonly string[];
  /** Expiry prevents future inclusion, not proof of an earlier non-fill. */
  readonly lastValidBlockHeight: number;
  readonly expiresAt: Date;
  /**
   * Tip carried by the submitted bundle, in lamports.
   *
   * Optional because records already in Redis when this shipped do not have it,
   * and an in-flight bundle must reconcile normally rather than crash the sweep.
   * A missing value resolves to no fee rather than to a guessed one.
   */
  readonly tipLamports?: number | null;
}

type StoredState =
  | { state: 'pending'; pending: PendingJupiterJitoSubmission }
  | { state: 'resolved'; resolution: JupiterJitoResolution };

export interface JupiterJitoPendingStore {
  findPending(clientOrderId: string): Promise<PendingJupiterJitoSubmission | null>;
  findResolution(clientOrderId: string): Promise<JupiterJitoResolution | null>;
  listPending(): Promise<PendingJupiterJitoSubmission[]>;
  save(pending: PendingJupiterJitoSubmission): Promise<void>;
  resolve(clientOrderId: string, resolution: JupiterJitoResolution): Promise<void>;
  /** Atomic durable ownership, including the canonical execution reservation. */
  claim?(execution: JupiterJitoExecutionIdentity): Promise<boolean>;
  /** Commit exact signed identity and potentially-submitted canonical state before POST. */
  prepare?(pending: PendingJupiterJitoSubmission): Promise<void>;
}

export function createRedisJupiterJitoStore(
  redis: RedisHashClient,
  key = DEFAULT_STORE_KEY
): JupiterJitoPendingStore {
  async function read(clientOrderId: string): Promise<StoredState | null> {
    const encoded = await redis.hget(key, clientOrderId);
    return encoded ? decodeRuntimeValue<StoredState>(encoded) : null;
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
        const stored = decodeRuntimeValue<StoredState>(encoded);
        return stored.state === 'pending' ? [stored.pending] : [];
      });
    },
    async save(pending) {
      await redis.hset(
        key,
        pending.clientOrderId,
        encodeRuntimeValue({ state: 'pending', pending } satisfies StoredState)
      );
    },
    async resolve(clientOrderId, resolution) {
      await redis.hset(
        key,
        clientOrderId,
        encodeRuntimeValue({ state: 'resolved', resolution } satisfies StoredState)
      );
    }
  };
}

export interface JupiterJitoRuntimeOptions {
  readonly pendingStore: JupiterJitoPendingStore;
  readonly jito: JitoClientOptions;
  /**
   * Signs a base64 transaction and returns it base64-encoded.
   *
   * A **parameter**, not a module-level key (Standing Rule 2): the operator
   * wallet today, a per-user custodial key at Stage 4, with no call-site change.
   */
  readonly signTransaction: (transactionBase64: string) => Promise<string>;
  /** Builds the base64 tip transfer to the given tip account. */
  readonly buildTipTransaction: (input: {
    tipAccount: string;
    lamports: number;
  }) => Promise<string>;
  readonly maxTipLamports: number;
  readonly fallbackTipLamports: number;
  readonly tipPercentile?: 'p50' | 'p75' | 'p95';
  readonly pendingTtlMs: number;
  readonly jupiterApiKey?: string;
  /**
   * Pre-trade simulation gate (checklist S4-M15).
   *
   * A **parameter**, not a module-level `Connection` (Standing Rule 2), and
   * optional: when absent the swap is submitted unsimulated, which is the
   * behaviour every caller had before this existed. Supply it from
   * `createSolanaSimulationGateFromEnvironment()`.
   */
  readonly simulation?: SolanaSimulationGate;
  /** Extraction only, not authorization. Signing must already enforce exact final-byte semantics. */
  readonly extractSignatures?: (transactions: readonly string[]) => Promise<readonly string[]>;
  /** Must observe confirmed receipt quantities and fees, never quote estimates. */
  readonly readReceipt?: (pending: PendingJupiterJitoSubmission) => Promise<JupiterJitoReceipt | null>;
  readonly now?: () => Date;
}

function validExecution(execution: JupiterJitoExecutionIdentity, clientOrderId: string): boolean {
  return execution.chain === 'solana' && execution.clientOrderId === clientOrderId
    && typeof execution.executionId === 'string' && execution.executionId.trim().length > 0
    && typeof clientOrderId === 'string' && clientOrderId.trim().length > 0
    && typeof execution.targetAccount === 'string' && execution.targetAccount.startsWith('solana:')
    && (execution.userId === null || (typeof execution.userId === 'string' && execution.userId.trim().length > 0));
}

function positiveRaw(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]+$/.test(value) && BigInt(value) > 0n;
}

function quoteMatchesIntent(quote: JupiterQuote, intent: JupiterJitoIntent): boolean {
  if (!Number.isInteger(intent.slippageBps) || intent.slippageBps < 0 || intent.slippageBps >= 10000
    || quote.swapMode !== 'ExactIn' || quote.inputMint !== intent.inputMint || quote.outputMint !== intent.outputMint
    || quote.inAmount !== intent.inputAmountRaw || quote.slippageBps !== intent.slippageBps
    || !positiveRaw(quote.inAmount) || !positiveRaw(quote.outAmount) || !positiveRaw(quote.otherAmountThreshold)) return false;
  const output = BigInt(quote.outAmount);
  const threshold = BigInt(quote.otherAmountThreshold);
  // Jupiter may round down by one base unit; that cannot silently widen tolerance.
  const minimum = output * BigInt(10000 - intent.slippageBps) / 10000n;
  return threshold >= minimum && threshold <= output;
}

function receiptMatchesPending(receipt: JupiterJitoReceipt, pending: PendingJupiterJitoSubmission): boolean {
  const execution = pending.execution;
  const intent = pending.intent;
  if (!execution || !intent || !receipt.execution || !validExecution(execution, pending.clientOrderId)
    || !validExecution(receipt.execution, pending.clientOrderId)) return false;
  return receipt.execution.executionId === execution.executionId
    && receipt.execution.userId === execution.userId && receipt.execution.targetAccount === execution.targetAccount
    && !!pending.signatures?.includes(receipt.signature)
    && Number.isSafeInteger(receipt.slot) && receipt.slot >= 0
    && receipt.inputMint === intent.inputMint && receipt.outputMint === intent.outputMint
    && positiveRaw(receipt.inputAmountRaw) && positiveRaw(receipt.outputAmountRaw)
    && BigInt(receipt.inputAmountRaw) <= BigInt(intent.inputAmountRaw)
    && typeof receipt.feeLamports === 'string' && /^[0-9]+$/.test(receipt.feeLamports)
    && typeof receipt.feeUsd === 'string' && /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/.test(receipt.feeUsd);
}

export function createJupiterJitoRuntime(options: JupiterJitoRuntimeOptions) {
  if (!Number.isInteger(options.pendingTtlMs) || options.pendingTtlMs < 60_000) {
    throw new Error('pendingTtlMs must be an integer of at least 60000');
  }
  if (!Number.isInteger(options.maxTipLamports) || options.maxTipLamports <= 0) {
    // Without a positive cap the tip is unbounded, and the tip is real SOL
    // charged against position P&L on every trade.
    throw new Error('maxTipLamports must be a positive integer');
  }
  const now = options.now ?? (() => new Date());

  async function submit(input: JupiterJitoSubmitInput): Promise<JupiterJitoSubmission> {
    // Terminal states are sticky: a resolved order must never be resubmitted,
    // however many times the queue redelivers the job.
    const resolved = await options.pendingStore.findResolution(input.clientOrderId);
    if (resolved) {
      return { status: 'already_resolved', clientOrderId: input.clientOrderId, resolution: resolved };
    }
    const pending = await options.pendingStore.findPending(input.clientOrderId);
    if (pending) {
      if (!pending.bundleId || pending.bundleId === 'pending_unknown') {
        return { status: 'submission_unknown', clientOrderId: input.clientOrderId, reason: 'durable-submission-awaiting-reconciliation' };
      }
      return {
        status: 'pending_confirmation',
        clientOrderId: input.clientOrderId,
        bundleId: pending.bundleId,
        lastValidBlockHeight: pending.lastValidBlockHeight
      };
    }

    const execution = input.execution;
    const intent = input.intent;
    if (!execution || !intent || !validExecution(execution, input.clientOrderId)
      || execution.targetAccount !== `solana:${input.signerPublicKey}`
      || intent.recipient !== input.signerPublicKey || !quoteMatchesIntent(input.quote, intent)) {
      return { status: 'rejected', clientOrderId: input.clientOrderId, reason: 'jito-execution-intent-mismatch' };
    }
    if (!options.pendingStore.claim || !options.pendingStore.prepare || !options.extractSignatures) {
      return { status: 'rejected', clientOrderId: input.clientOrderId, reason: 'jito-durable-submit-unavailable' };
    }
    try {
      if (!await options.pendingStore.claim(execution)) {
        return { status: 'submission_unknown', clientOrderId: input.clientOrderId, reason: 'durable-submission-already-claimed' };
      }
    } catch {
      return { status: 'submission_unknown', clientOrderId: input.clientOrderId, reason: 'durable-claim-unavailable' };
    }

    const built = await buildJupiterSwap({
      quote: input.quote,
      userPublicKey: input.signerPublicKey,
      // No priority fee: the Jito tip is what buys inclusion, and layering a
      // priority fee on top is paying twice for the same thing.
      computeUnitPriceMicroLamports: undefined,
      apiKey: options.jupiterApiKey
    });
    if (!built) {
      return { status: 'rejected', clientOrderId: input.clientOrderId, reason: 'swap-build-failed' };
    }

    // Pre-trade simulation (checklist S4-M15).
    //
    // **Why the gate lives inside the runtime rather than in front of it.** The
    // artifact that has to be simulated is the built transaction, and it only
    // ever exists here: `solana-dispatch.ts` holds a quote, and
    // `buildJupiterSwap` is called from this function, after the idempotency
    // guards. Simulating from dispatch would mean either building the swap twice
    // (two paid Jupiter `/swap` calls producing two different transactions, so
    // the one simulated is not the one submitted) or hoisting the build above the
    // resolved/pending checks, which is exactly the ordering that must not change
    // — a redelivered job would then build and simulate a swap for an order that
    // is already terminal.
    //
    // It runs *before* the tip floor is fetched and before anything is signed, so
    // a refused route costs one RPC round trip and nothing else. A skip here is
    // `rejected`, never `submission_unknown`: no bundle was transmitted, so there
    // is no venue-side state to reconcile.
    if (options.simulation) {
      const decision = await options.simulation.evaluate({
        transactionBase64: built.swapTransaction,
        clientOrderId: input.clientOrderId
      });
      if (decision.kind === 'skip') {
        return {
          status: 'rejected',
          clientOrderId: input.clientOrderId,
          reason: `${decision.code}: ${decision.reason}`,
          code: decision.code
        };
      }
    }

    const floor = await getJitoTipFloor(options.jito);
    const tipLamports = selectJitoTip({
      floor,
      percentile: options.tipPercentile ?? 'p75',
      maxTipLamports: options.maxTipLamports,
      fallbackTipLamports: options.fallbackTipLamports
    });
    // Resolved at runtime, TTL-cached, and falling back to the hard-coded set
    // (S4-P18). Never empty, so `selectTipAccount` always has something to pick.
    const tipAccounts = await getJitoTipAccounts(options.jito);
    const tipAccount = selectTipAccount(input.clientOrderId, tipAccounts);

    let signedSwap: string;
    let signedTip: string;
    try {
      signedSwap = await options.signTransaction(built.swapTransaction);
      signedTip = await options.signTransaction(
        await options.buildTipTransaction({ tipAccount, lamports: tipLamports })
      );
    } catch (error) {
      // Nothing was transmitted, so this is unambiguously a rejection rather
      // than an unknown submission.
      return {
        status: 'rejected',
        clientOrderId: input.clientOrderId,
        reason: `signing-failed: ${error instanceof Error ? error.message : 'unknown'}`
      };
    }

    const signedTransactions = [signedSwap, signedTip];
    let prepared: PendingJupiterJitoSubmission;
    try {
      const signatures = await options.extractSignatures(signedTransactions);
      if (signatures.length !== signedTransactions.length
        || signatures.some(signature => !signature || signature === 'pending_unknown')
        || new Set(signatures).size !== signatures.length
        || !Number.isSafeInteger(built.lastValidBlockHeight) || built.lastValidBlockHeight <= 0) {
        throw new Error('signed submission identity invalid');
      }
      prepared = {
        clientOrderId: input.clientOrderId, execution, intent, bundleId: null,
        signedTransactions, signatures, lastValidBlockHeight: built.lastValidBlockHeight,
        expiresAt: new Date(now().getTime() + options.pendingTtlMs), tipLamports
      };
      await options.pendingStore.prepare(prepared);
    } catch {
      // No POST, but an uncertain durable write/claim must not release ownership.
      return { status: 'submission_unknown', clientOrderId: input.clientOrderId, reason: 'durable-preparation-unavailable' };
    }

    try {
      const result = await submitJitoBundle(signedTransactions, options.jito);
      // Once transport was invoked, even malformed/4xx responses do not prove no effect.
      if (!result.ok) {
        return { status: 'submission_unknown', clientOrderId: input.clientOrderId, reason: result.reason };
      }
      if (typeof result.bundleId !== 'string' || !result.bundleId.trim() || result.bundleId === 'pending_unknown') {
        return { status: 'submission_unknown', clientOrderId: input.clientOrderId, reason: 'bundle-identity-unavailable' };
      }
      await options.pendingStore.save({ ...prepared, bundleId: result.bundleId });
      return {
        status: 'submitted', clientOrderId: input.clientOrderId,
        bundleId: result.bundleId, lastValidBlockHeight: built.lastValidBlockHeight
      };
    } catch {
      // Exact bytes/signatures remain in the prewrite even if accepted response is lost.
      return { status: 'submission_unknown', clientOrderId: input.clientOrderId, reason: 'submission-response-or-store-unavailable' };
    }
  }

  /**
   * Resolves one pending bundle (checklist S3-4).
   *
   * Returns `null` when the outcome still cannot be observed — deliberately
   * distinct from a `failed` resolution. Treating an unreachable block engine as
   * failure would let the executor conclude a live bundle died and re-enter the
   * position, double-spending it.
   */
  async function reconcile(
    pending: PendingJupiterJitoSubmission,
    currentBlockHeight?: number
  ): Promise<JupiterJitoResolution | null> {
    const ambiguous = (reason: string): JupiterJitoResolution => ({ status: 'ambiguous', clientOrderId: pending.clientOrderId, reason });
    // Locally persisted signatures can be reconciled without a bundle response.
    try {
      const receipt = await options.readReceipt?.(pending);
      if (receipt) {
        if (!receiptMatchesPending(receipt, pending)) return ambiguous('receipt-identity-or-quantity-mismatch');
        return { status: 'filled', clientOrderId: pending.clientOrderId, signature: receipt.signature,
          slot: receipt.slot, receipt };
      }
    } catch {
      return ambiguous('confirmed-receipt-unavailable');
    }
    if (!pending.bundleId || pending.bundleId === 'pending_unknown') {
      return ambiguous('bundle-response-unknown');
    }
    const status = await getJitoBundleStatus(pending.bundleId, options.jito);
    if (!status) return null;
    if (status.bundleId !== pending.bundleId) return ambiguous('bundle-identity-mismatch');
    if (status.status === 'Landed') return ambiguous('confirmed-receipt-unavailable');
    // Bundle status/absence alone is not a chain receipt or proof all signatures never landed.
    if (status.status === 'Failed') return ambiguous('bundle-failure-requires-chain-evidence');
    if (typeof currentBlockHeight === 'number' && currentBlockHeight > pending.lastValidBlockHeight) {
      return ambiguous('blockhash-expired-outcome-unknown');
    }
    if (now() >= pending.expiresAt) return ambiguous('confirmation-timeout');
    return null;
  }

  async function sweep(currentBlockHeight?: number): Promise<JupiterJitoResolution[]> {
    const pendings = await options.pendingStore.listPending();
    const resolutions: JupiterJitoResolution[] = [];
    for (const pending of pendings) {
      const resolution = await reconcile(pending, currentBlockHeight);
      if (resolution) resolutions.push(resolution);
    }
    return resolutions;
  }

  /** Callback must return true only after idempotent receipt/evidence/accounting COMMIT. */
  async function settle(
    resolution: JupiterJitoResolution,
    commit: (pending: PendingJupiterJitoSubmission, resolution: JupiterJitoResolution) => Promise<boolean>
  ): Promise<boolean> {
    if (resolution.status !== 'filled' || !resolution.receipt) return false;
    try {
      const pending = await options.pendingStore.findPending(resolution.clientOrderId);
      if (!pending || !receiptMatchesPending(resolution.receipt, pending)
        || resolution.signature !== resolution.receipt.signature || resolution.slot !== resolution.receipt.slot) return false;
      if (!await commit(pending, resolution)) return false;
      await options.pendingStore.resolve(resolution.clientOrderId, resolution);
      return true;
    } catch {
      // DB rollback, unknown commit or acknowledgement failure stays replayable.
      return false;
    }
  }

  return { submit, reconcile, sweep, settle };
}

export type JupiterJitoRuntime = ReturnType<typeof createJupiterJitoRuntime>;
