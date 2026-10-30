import {
  AddressLookupTableAccount,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction
} from '@solana/web3.js';
import type { JupiterQuote } from './jupiter.js';

/**
 * Jupiter Swap API V2 `/build` transaction-assembly step (checklist S4-M34).
 *
 * Migrated from the undocumented V1 POST /swap to Swap API V2 GET /build.
 * Assembles raw instructions into a VersionedTransaction with Address Lookup
 * Tables (ALTs) resolved in the response payload.
 *
 * Sets `forJitoBundle: true` to exclude DEXes incompatible with Jito bundles,
 * uses `wrapAndUnwrapSol: true` (with wrapUnwrapSOL supported for compatibility),
 * and maps `userPublicKey` to `taker`.
 *
 * Returns null rather than throwing so callers can fall back gracefully.
 */

const JUPITER_API_BASE = 'https://api.jup.ag/swap/v2';
const JUPITER_SWAP_BUILD_TIMEOUT_MS = 8_000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10_000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface JupiterSwapBuildParams {
  readonly quote?: JupiterQuote;
  readonly inputMint?: string;
  readonly outputMint?: string;
  readonly amountLamports?: number | string;
  readonly slippageBps?: number;
  /** The wallet that will sign and pay for the transaction (`taker` in V2). */
  readonly userPublicKey: string;
  /**
   * Wrap/unwrap SOL as needed. Set `true` for safety: a user cannot *spend* an
   * unwrapped SOL balance without this, and a swap that would leave dust in a
   * wrapped token account is wasteful — better to close it and recover the rent.
   * Named `wrapAndUnwrapSol` in V2; `wrapUnwrapSOL` is retained for backwards compatibility.
   */
  readonly wrapAndUnwrapSol?: boolean;
  readonly wrapUnwrapSOL?: boolean;
  /**
   * Exclude DEXes that are incompatible with Jito bundles. Defaults to `true`
   * because SWAT submits transactions exclusively through Jito bundles.
   */
  readonly forJitoBundle?: boolean;
  /**
   * When true, include compute-budget and priority-fee instructions. Should
   * always be false for Jito bundles — the *tip* is what buys inclusion, and a
   * priority fee layered on top is double-paying for the same thing.
   */
  readonly computeUnitPriceMicroLamports?: number;
  readonly apiKey?: string;
  readonly apiBase?: string;
}

export interface JupiterSwapTransaction {
  /** Base64-encoded versioned transaction ready to sign. */
  readonly swapTransaction: string;
  /** The slot the quote was built against; after this expires the tx is stale. */
  readonly lastValidBlockHeight: number;
}

export interface JupiterApiInstruction {
  programId: string;
  accounts: Array<{
    pubkey: string;
    isWritable: boolean;
    isSigner: boolean;
  }>;
  data: string;
}

export interface JupiterSwapBuildResponse {
  computeBudgetInstructions?: JupiterApiInstruction[];
  setupInstructions?: JupiterApiInstruction[];
  swapInstruction?: JupiterApiInstruction;
  cleanupInstruction?: JupiterApiInstruction | null;
  otherInstructions?: JupiterApiInstruction[];
  addressesByLookupTableAddress?: Record<string, string[]>;
  blockhashWithMetadata?: {
    blockhash: string | number[];
    lastValidBlockHeight: number;
  };
  swapTransaction?: string;
  lastValidBlockHeight?: number;
  error?: string;
}

function deserializeInstruction(ix: JupiterApiInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((acc) => ({
      pubkey: new PublicKey(acc.pubkey),
      isWritable: acc.isWritable,
      isSigner: acc.isSigner
    })),
    data: Buffer.from(ix.data, 'base64')
  });
}

function parseBlockhash(blockhash: unknown): string | null {
  if (typeof blockhash === 'string' && blockhash.length > 0) return blockhash;
  if (Array.isArray(blockhash) && blockhash.length === 32) {
    try {
      return new PublicKey(Buffer.from(blockhash)).toBase58();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Builds the swap transaction from a quote or mint/amount parameters.
 *
 * Uses Jupiter Swap API V2 `GET /build` with `forJitoBundle: true`.
 * Returns `null` on failure so callers can gracefully fall back or skip.
 */
export async function buildJupiterSwap(
  params: JupiterSwapBuildParams
): Promise<JupiterSwapTransaction | null> {
  const inputMint = params.quote?.inputMint ?? params.inputMint;
  const outputMint = params.quote?.outputMint ?? params.outputMint;
  const amount = params.quote?.inAmount ?? params.amountLamports;
  const slippageBps = params.quote?.slippageBps ?? params.slippageBps;
  const wrapAndUnwrapSol = params.wrapAndUnwrapSol ?? params.wrapUnwrapSOL ?? true;
  const forJitoBundle = params.forJitoBundle ?? true;

  if (!inputMint || !outputMint || amount === undefined || amount === null) {
    console.error('[jupiter] swap build missing inputMint, outputMint, or amount');
    return null;
  }

  const base = params.apiBase ?? JUPITER_API_BASE;
  const url = new URL(`${base}/build`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('taker', params.userPublicKey);
  if (typeof slippageBps === 'number') {
    url.searchParams.set('slippageBps', String(slippageBps));
  }
  url.searchParams.set('wrapAndUnwrapSol', String(wrapAndUnwrapSol));
  url.searchParams.set('forJitoBundle', String(forJitoBundle));

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (params.apiKey) headers['x-api-key'] = params.apiKey;

  try {
    const response = await fetchWithTimeout(
      url.toString(),
      {
        method: 'GET',
        headers
      },
      JUPITER_SWAP_BUILD_TIMEOUT_MS
    );

    if (!response.ok) {
      const snippet = (await response.text().catch(() => '')).slice(0, 200);
      console.error(`[jupiter] swap build failed ${response.status}: ${snippet}`);
      return null;
    }

    const payload = (await response.json()) as JupiterSwapBuildResponse;
    if (payload.error) {
      console.error(`[jupiter] swap build error: ${payload.error}`);
      return null;
    }

    // Direct transaction return (for compatibility with pre-assembled responses or test mocks)
    if (payload.swapTransaction && typeof payload.lastValidBlockHeight === 'number') {
      return {
        swapTransaction: payload.swapTransaction,
        lastValidBlockHeight: payload.lastValidBlockHeight
      };
    }

    // Assemble instructions returned by Swap API V2
    const blockhashStr = parseBlockhash(payload.blockhashWithMetadata?.blockhash);
    const lastValidBlockHeight =
      payload.blockhashWithMetadata?.lastValidBlockHeight ?? payload.lastValidBlockHeight;

    if (!blockhashStr || typeof lastValidBlockHeight !== 'number') {
      console.error('[jupiter] swap build response missing valid blockhash or lastValidBlockHeight');
      return null;
    }

    const lookupTableAccounts: AddressLookupTableAccount[] = [];
    if (
      payload.addressesByLookupTableAddress &&
      typeof payload.addressesByLookupTableAddress === 'object'
    ) {
      for (const [tableKey, addresses] of Object.entries(payload.addressesByLookupTableAddress)) {
        if (Array.isArray(addresses)) {
          try {
            lookupTableAccounts.push(
              new AddressLookupTableAccount({
                key: new PublicKey(tableKey),
                state: {
                  deactivationSlot: BigInt('18446744073709551615'),
                  lastExtendedSlot: 0,
                  lastExtendedSlotStartIndex: 0,
                  authority: undefined,
                  addresses: addresses.map((addr) => new PublicKey(addr))
                }
              })
            );
          } catch (e) {
            console.warn(`[jupiter] failed to parse ALT ${tableKey}:`, e);
          }
        }
      }
    }

    const instructions: TransactionInstruction[] = [];
    if (Array.isArray(payload.computeBudgetInstructions)) {
      instructions.push(...payload.computeBudgetInstructions.map(deserializeInstruction));
    }
    if (Array.isArray(payload.setupInstructions)) {
      instructions.push(...payload.setupInstructions.map(deserializeInstruction));
    }
    if (payload.swapInstruction) {
      instructions.push(deserializeInstruction(payload.swapInstruction));
    }
    if (payload.cleanupInstruction) {
      instructions.push(deserializeInstruction(payload.cleanupInstruction));
    }
    if (Array.isArray(payload.otherInstructions)) {
      instructions.push(...payload.otherInstructions.map(deserializeInstruction));
    }

    if (instructions.length === 0) {
      console.error('[jupiter] swap build returned no instructions');
      return null;
    }

    const message = new TransactionMessage({
      payerKey: new PublicKey(params.userPublicKey),
      recentBlockhash: blockhashStr,
      instructions
    }).compileToV0Message(lookupTableAccounts);

    const versionedTx = new VersionedTransaction(message);
    const swapTransaction = Buffer.from(versionedTx.serialize()).toString('base64');

    return {
      swapTransaction,
      lastValidBlockHeight
    };
  } catch (error) {
    console.error(
      '[jupiter] swap build request failed:',
      error instanceof Error ? error.message : error
    );
    return null;
  }
}
