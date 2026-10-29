import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import {
  crossTenantScope,
  getPolymarketOutcomeContext,
  insertSignalWithDedupe,
  insertSourceTradeSignal,
  listFanoutCandidates,
  listSourceTradeSignalCandidates,
  markSourceTradeSignalDispatched,
  planFanout,
  query,
  resolveChainMode,
  type ChainModeResolution,
  type FanoutPlan,
  type FanoutPlatformInputs,
  type FanoutSignal,
  type SourceTradeSignalCandidate
} from '@swat/db';
import {
  QUEUES,
  REDIS_CHANNELS,
  scoreToTier,
  chainFromTokenMint,
  fetchTokenMetadata,
  initLogger,
  stripChainPrefix,
  tradeQueueForChain
} from '@swat/shared';
import type { Chain, ExecutionMode } from '@swat/shared';
import { checkTokenSafety } from './safety.js';
import {
  capacityAppliesToDirection,
  planCapacityLedgerEntries,
  projectCohortNotionalUsd,
  recordFanoutCapacityLedger,
  resolveFanoutCapacity
} from './capacity-inputs.js';
import { createPolymarketBookLiquidityReader } from './polymarket-book-reader.js';
import { requirePolymarketSignalContext } from './polymarket-context.js';
import { mayPatternTrade } from './trade-eligibility.js';
import {
  enqueueFanoutTradeJobs,
  planFanoutTradeJobs,
  summariseFanout
} from './fanout-enqueue.js';
import {
  evaluateMirrorableActivity,
  resolveMinimumMirrorableNotionalUsd
} from './mirrorable-activity.js';
import { probeTokenRoutability } from './routability-probe.js';
import {
  runSnipeDetector,
  runAccumulationDetector,
  runRotationDetector,
  runExitDetector
} from './detectors.js';

initLogger('signal-engine');

/**
 * Resolve a cluster's tier from its average composite score (same thresholds as
 * wallet tiers). Used to size trades correctly — previously the trade payload
 * hardcoded 'promising', so every auto-trade was sized at the 0.5x multiplier
 * regardless of the cluster's real quality.
 */
async function getClusterTier(clusterId: string): Promise<'elite' | 'pro' | 'promising' | 'speculative'> {
  const rows = await query<{ avg_composite_score: number | null }>(
    `SELECT avg_composite_score FROM wallet_clusters WHERE id = $1`,
    [clusterId]
  );
  const score = rows[0]?.avg_composite_score;
  return score != null ? scoreToTier(Number(score)) : 'promising';
}

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const alertQueue = new Queue(QUEUES.alerts, { connection: redis });

/**
 * The Polymarket order-book read for the capacity gate (`S4-M38`, closing the
 * feed `S4-M6` was waiting on).
 *
 * Built on the connection above rather than a second one: this is a single `GET`
 * per polygon fan-out, on a path that already awaits three DB reads, so it does
 * not warrant its own socket.
 *
 * The books are written by `indexer` (`polymarket-book-runtime.ts`). If that
 * feed is not running, every read here is `book-not-cached`, which the gate turns
 * into `capacity-unknown` and admits nobody on polygon — the fail-closed
 * direction, and the same behaviour as before this was wired.
 */
const polymarketBookReader = createPolymarketBookLiquidityReader({
  transport: {
    get: (key) => redis.get(key),
    set: async (key, value, ttlMs) => {
      await redis.set(key, value, 'PX', Math.max(1, Math.ceil(ttlMs)));
    },
    mget: (keys) => redis.mget(...keys)
  },
  now: () => Date.now(),
  logger: {
    warn: (message, error) => console.warn(`[signal-engine] ${message}`, error ?? '')
  }
});

/**
 * One trade queue per chain (D6 / S3-25). Created eagerly so a chain's first
 * signal does not pay connection setup on the money path, and keyed by `Chain`
 * so `tradeQueueFor` cannot resolve a name the executor is not listening on.
 */
const tradeQueues = new Map<Chain, Queue>(
  (['solana', 'polygon', 'robinhood-chain'] as const).map((chain) => [
    chain,
    new Queue(tradeQueueForChain(chain), { connection: redis })
  ])
);

function tradeQueueFor(chain: Chain): Queue {
  const queue = tradeQueues.get(chain);
  if (!queue) throw new Error(`No trade queue configured for chain ${chain}`);
  return queue;
}

const MIN_SIGNAL_SCORE = Number(process.env.MIN_SIGNAL_SCORE ?? 70);
const SOURCE_COPY_MAX_EVENT_AGE_MS = Number(
  process.env.SOURCE_COPY_MAX_EVENT_AGE_MS ?? 10 * 60_000
);
const SOURCE_COPY_POSITION_EVIDENCE_MAX_AGE_MS = Number(
  process.env.SOURCE_COPY_POSITION_EVIDENCE_MAX_AGE_MS ?? 10 * 60_000
);
/**
 * Minimum USD notional a master's trade must carry to be mirrored (`S4-M5`).
 * Resolved once here, so the filter itself stays pure and `process.env` cannot
 * change what mirrors mid-run. `0` disables the floor and is the default.
 */
const SOURCE_COPY_MIN_NOTIONAL_USD = resolveMinimumMirrorableNotionalUsd(
  process.env.SOURCE_COPY_MIN_NOTIONAL_USD
);

/**
 * Platform balance floor for fan-out, in USD (`S4-13`).
 *
 * `0` disables the floor and is the default, following
 * `SOURCE_COPY_MIN_NOTIONAL_USD`. A non-zero default here would be this file
 * inventing a platform policy nobody decided. Note that `0` is not "let anyone
 * through": an *unknown* balance still fails closed with `balance-unknown`,
 * which is a different rule and lives in `fanout-eligibility.ts`.
 */
const FANOUT_MIN_BALANCE_USD = Number(process.env.FANOUT_MIN_BALANCE_USD ?? 0);

for (const [name, value] of [
  ['MIN_SIGNAL_SCORE', MIN_SIGNAL_SCORE],
  ['SOURCE_COPY_MAX_EVENT_AGE_MS', SOURCE_COPY_MAX_EVENT_AGE_MS],
  ['SOURCE_COPY_POSITION_EVIDENCE_MAX_AGE_MS', SOURCE_COPY_POSITION_EVIDENCE_MAX_AGE_MS],
  ['FANOUT_MIN_BALANCE_USD', FANOUT_MIN_BALANCE_USD]
] as const) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
}

// ─── Fan-out enumeration (S4-13 / S4-14) ──────────────────────────────────────

/**
 * Master capacity is now assessed per fan-out (`S4-M6`), and this note records
 * exactly how far that goes — because the difference between "wired" and "closed"
 * is where the trap in this item lives.
 *
 * **What now happens.** `resolveFanoutCapacity` in `capacity-inputs.ts` reads the
 * window's accounted notional from `master_capacity_ledger` (`053`), the active
 * follower count, and any per-master policy override; builds a usable-liquidity
 * value from the DexScreener pool TVL `checkTokenSafety` already fetched; and
 * feeds `assessMasterCapacity` a cohort-level projected notional. The verdict maps
 * onto `planFanout`'s gate with the two kinds of "no" kept apart — a real breach
 * excludes users as `capacity-exhausted`, an unevaluable cap as
 * `capacity-unknown`. `unassessablePolicy` is `'skip'` and must stay `'skip'`.
 *
 * **Two things remain, and both are visible in a log rather than silent.**
 *
 *   1. **Polymarket cannot be assessed.** Its liquidity is CLOB depth, not a pool
 *      reserve, and no pre-fan-out feed exists (`S4-M38`). Every polygon fan-out
 *      therefore excludes everyone with `capacity-unknown`, and
 *      `summariseFanout` flags it as a platform fault.
 *   2. **The ledger numerator is unpriced.** The writer below records one row per
 *      fan-out event per mode with `notional_usd NULL` / basis `unpriced`,
 *      because what this call site holds is a projection and not a fill. That
 *      makes a window report `partial-unpriced-legs` — a pass that is explicitly a
 *      LOWER BOUND — instead of the confident zero an **empty** ledger produces.
 *      A priced numerator has to come from where a fill is confirmed, in
 *      `trade-executor`, and until it does `S4-M6` is not ticked.
 */
console.warn(
  '[signal-engine] master capacity is wired (S4-M6) with two known gaps: polygon has no '
    + 'pre-fan-out depth feed (S4-M38) so every polygon fan-out excludes users as '
    + 'capacity-unknown, and the ledger numerator is unpriced so a window impact figure is '
    + 'a LOWER BOUND until trade-executor writes priced rows'
);

/**
 * Resolves the chain mode, reporting a failure as `null` rather than as paper.
 *
 * `null` excludes everyone with `chain-mode-unknown`. Defaulting to paper would
 * keep writing ledger rows through exactly the outage an operator set the global
 * kill switch for.
 */
async function resolveFanoutChainMode(chain: Chain): Promise<ChainModeResolution | null> {
  try {
    return await resolveChainMode(chain);
  } catch (error) {
    console.error(
      `[signal-engine] fan-out could not resolve the ${chain} execution mode:`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

interface SignalFanout {
  readonly plan: FanoutPlan;
  /**
   * The chain's clamped mode, carried so the capacity ledger records the mode the
   * cohort actually runs in. Re-resolving it after the fact is how a `paper`
   * verdict gets recorded as `live` flow.
   */
  readonly effectiveMode: ExecutionMode;
}

/**
 * Enumerates and decides one signal's fan-out, or `null` if enumeration failed.
 *
 * `null` means "no per-user jobs", not "no jobs": the operator job is emitted
 * either way, so an enumeration fault degrades to exactly the pre-fan-out
 * behaviour instead of stopping the trade path. It is logged as an error because
 * silently copying for nobody is the failure mode this whole item is guarding
 * against.
 */
async function planSignalFanout(
  sourceTrade: SourceTradeSignalCandidate,
  chain: Chain,
  tokenMint: string,
  score: number,
  poolTvlUsd: number | null
): Promise<SignalFanout | null> {
  try {
    const [candidates, chainMode] = await Promise.all([
      listFanoutCandidates(
        crossTenantScope('fan-out enumeration for a source-trade signal'),
        { masterWalletAddress: sourceTrade.walletAddress, chain }
      ),
      resolveFanoutChainMode(chain)
    ]);

    const signal: FanoutSignal = {
      chain,
      masterWalletAddress: sourceTrade.walletAddress,
      tokenMint,
      direction: sourceTrade.side,
      score,
      eventAt: sourceTrade.eventAt
    };
    const platformWithoutCapacity = {
      chainMode,
      minimumBalanceUsd: FANOUT_MIN_BALANCE_USD
    };

    // Capacity is decided before fan-out and sized after it, so the cohort figure
    // is an upper bound over the users who would be admitted but for capacity.
    // See `projectCohortNotionalUsd` for why erring high is the safe direction.
    const projection = projectCohortNotionalUsd(candidates, signal, platformWithoutCapacity);

    let capacity: FanoutPlatformInputs['capacity'];
    if (!capacityAppliesToDirection(sourceTrade.side)) {
      // A sell is admitted without assessment: refusing one strands an open
      // position with no exit, and a sell's notional is bounded by holdings this
      // path cannot see. Argued in full in `capacityAppliesToDirection`.
      capacity = { outcome: 'admit' };
      console.log(
        `[signal-engine] capacity not assessed for a sell mirror on ${chain} `
          + `(${sourceTrade.walletAddress}): the cap is buy-side, and the cohort's sells are `
          + 'bounded by buys it already gated'
      );
    } else {
      const resolved = await resolveFanoutCapacity({
        masterWalletAddress: sourceTrade.walletAddress,
        chain,
        tokenMint,
        poolTvlUsd,
        projection,
        // Read inside `resolveFanoutCapacity`, after it resolves the cap in
        // force, because the published reserve is calibrated to that exact cap.
        readPolymarketBook: async (request) =>
          (await polymarketBookReader.read(request)).liquidity,
        cohortDirection: 'buy',
        now: new Date()
      });
      capacity = resolved.capacity;
      console.log(`[signal-engine] ${resolved.logLine}`);
    }

    return {
      plan: planFanout(candidates, signal, { ...platformWithoutCapacity, capacity }),
      effectiveMode: chainMode?.effectiveMode ?? 'off'
    };
  } catch (error) {
    console.error(
      `[signal-engine] fan-out enumeration failed for ${sourceTrade.walletAddress}; `
        + 'no user jobs will be queued for this signal:',
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

// ─── Shared helper ─────────────────────────────────────────────────────────────

async function enqueueSignal(opts: {
  patternType: string;
  clusterId: string | null;
  tokenMint: string;
  confidence: number;
  signalScore: number;
  triggerData: Record<string, unknown>;
  dedupeMinutes?: number;
  suppressTrade?: boolean;
  sourceTrade?: SourceTradeSignalCandidate;
}) {
  // 1. Check Blacklist config setting
  try {
    const blacklistRows = await query<{ value: any }>(`SELECT value FROM config WHERE key = 'blacklist'`);
    const rawValue = blacklistRows[0]?.value;
    if (rawValue) {
      let blacklist: string[] = [];
      if (Array.isArray(rawValue)) {
        blacklist = rawValue;
      } else if (typeof rawValue === 'string') {
        try {
          const parsed = JSON.parse(rawValue);
          if (Array.isArray(parsed)) {
            blacklist = parsed;
          } else if (typeof parsed === 'string') {
            try {
              const parsed2 = JSON.parse(parsed);
              blacklist = Array.isArray(parsed2) ? parsed2 : [parsed];
            } catch {
              blacklist = [parsed];
            }
          }
        } catch {
          const trimmed = rawValue.trim();
          blacklist = trimmed.startsWith('[') 
            ? [] 
            : trimmed.split(',').map(s => s.trim());
        }
      } else if (typeof rawValue === 'object' && rawValue !== null) {
        blacklist = Object.values(rawValue).filter(v => typeof v === 'string') as string[];
      }
      
      const tokenKey = stripChainPrefix(opts.tokenMint);
      if (blacklist.some((entry) => stripChainPrefix(entry) === tokenKey)) {
        console.log(`[signal-engine] SKIPPED: token ${opts.tokenMint} is in the blacklist.`);
        return;
      }
    }
  } catch (e: any) {
    console.error(`[signal-engine] failed to read blacklist config:`, e.message);
  }

  // 2. Fetch token metadata (Name & Symbol) from Helius / DexScreener
  let tokenName = 'Unknown';
  let tokenSymbol = 'UNKNOWN';

  // Resolved once, before any write, and shared with the executor (S3-25): this
  // picks both the `tokens.chain` value and the trade queue, and the previous
  // inline `split(':')[0]` accepted any prefix — an unsupported one wrote a
  // bogus chain into `tokens` and then queued a job no venue adapter serves.
  let chain: Chain;
  try {
    chain = chainFromTokenMint(opts.tokenMint);
  } catch (error) {
    console.error(
      `[signal-engine] SKIPPED: cannot resolve a chain for ${opts.tokenMint}:`,
      error instanceof Error ? error.message : error
    );
    return;
  }

  try {
    const meta = await fetchTokenMetadata(opts.tokenMint);
    if (meta?.name && meta?.symbol) {
      tokenName = meta.name;
      tokenSymbol = meta.symbol;
      
      // Upsert into the tokens table so other parts of the database have the metadata
      await query(
        `INSERT INTO tokens (mint, name, symbol, chain)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (mint) DO UPDATE SET name = EXCLUDED.name, symbol = EXCLUDED.symbol`,
        [opts.tokenMint, tokenName, tokenSymbol, chain]
      );
    }
  } catch (e: any) {
    console.error(`[signal-engine] failed to fetch metadata for ${opts.tokenMint}:`, e.message);
  }

  if (chain === 'polygon') {
    const context = requirePolymarketSignalContext(
      await getPolymarketOutcomeContext(opts.tokenMint),
      opts.tokenMint
    );
    tokenName = context.tokenName;
    tokenSymbol = context.tokenSymbol;
    Object.assign(opts.triggerData, context.triggerData);
  }

  const safety = await checkTokenSafety(opts.tokenMint);

  const signal = opts.sourceTrade
    ? await insertSourceTradeSignal({
        sourceTradeId: opts.sourceTrade.sourceTradeId,
        clusterId: opts.clusterId,
        confidence: opts.confidence,
        signalScore: opts.signalScore,
        triggerData: opts.triggerData,
        safetyFlags: safety.flags,
        safetyWarnings: safety.warnings,
        tokenName,
        tokenSymbol,
        maxEventAgeMs: SOURCE_COPY_MAX_EVENT_AGE_MS,
        maxPositionEvidenceAgeMs: SOURCE_COPY_POSITION_EVIDENCE_MAX_AGE_MS
      })
    : await insertSignalWithDedupe(
        {
          patternType:    opts.patternType,
          clusterId:      opts.clusterId,
          tokenMint:      opts.tokenMint,
          confidence:     opts.confidence,
          signalScore:    opts.signalScore,
          triggerData:    opts.triggerData,
          safetyFlags:    safety.flags,
          safetyWarnings: safety.warnings,
          tokenName,
          tokenSymbol
        },
        opts.dedupeMinutes ?? 10
      );

  if (!signal || (!signal.inserted && !opts.sourceTrade)) {
    if (signal) console.log(`[signal-engine] duplicate skipped: ${signal.id}`);
    return;
  }

  if (opts.signalScore < MIN_SIGNAL_SCORE) {
    console.log(`[signal-engine] signal score ${opts.signalScore} below threshold ${MIN_SIGNAL_SCORE} — logged only`);
    if (opts.sourceTrade) await markSourceTradeSignalDispatched(signal.id);
    return;
  }

  await alertQueue.add('signal-alert', {
    signalId:     signal.id,
    pattern:      opts.patternType,
    tokenMint:    opts.tokenMint,
    clusterId:    opts.clusterId,
    confidence:   opts.confidence,
    score:        opts.signalScore,
    isSafe:       safety.isSafe,
    warnings:     safety.warnings,
    liquidity:    safety.liquidity,
    top10HolderPct: safety.top10HolderPct,
    ...opts.triggerData,
    sourceTradeId: opts.sourceTrade?.sourceTradeId,
    direction: opts.sourceTrade?.side
  }, {
    ...(opts.sourceTrade ? { jobId: `source-alert-${signal.id}` } : {}),
    removeOnComplete: true,
    // Retry transient Telegram failures (429/5xx) with backoff; the alert
    // worker is idempotent via signals.alerted_at so retries can't double-send.
    attempts: 4,
    backoff: { type: 'exponential', delay: 2000 }
  });

  // Two independent gates, deliberately. `mayPatternTrade` is the ADR-0005
  // invariant and lives in one place; `suppressTrade` stays as a per-call-site
  // statement of intent. Either one alone blocks the trade, so deleting a flag
  // from a detector changes a log line rather than whether money moves.
  const patternMayTrade = mayPatternTrade(opts.patternType);

  if (patternMayTrade && !opts.suppressTrade && safety.isSafe && opts.signalScore >= 80) {
    const clusterTier = opts.clusterId
      ? await getClusterTier(opts.clusterId)
      : scoreToTier(opts.signalScore);
    console.log(`[signal-engine] ✅ TRADE QUEUED: ${opts.tokenMint} | score: ${opts.signalScore} | tier: ${clusterTier} | chain: ${chain}`);

    // Fan-out (`S4-13`/`S4-14`). Only a source-trade signal has a master wallet
    // to enumerate subscribers of; a pattern signal gets the operator job alone,
    // exactly as before. `mayPatternTrade` already refuses every cluster pattern,
    // so this branch is unreachable for them today — the guard keeps the
    // dependency explicit rather than incidental.
    // `safety.liquidity` is the DexScreener pool TVL `checkTokenSafety` already
    // fetched above, reused rather than re-fetched: a second round trip would add
    // latency to the money path for a number just read, and two reads could
    // disagree. `usableLiquidityForFanout` discards it unread on polygon.
    const fanout = opts.sourceTrade
      ? await planSignalFanout(
        opts.sourceTrade,
        chain,
        opts.tokenMint,
        opts.signalScore,
        safety.liquidity ?? null
      )
      : null;

    if (fanout) {
      const summary = summariseFanout(fanout.plan);
      console.log(`[signal-engine] fan-out ${signal.id}: ${summary.line}`);
      if (summary.warning) {
        console.warn(`[signal-engine] fan-out ${signal.id}: ${summary.warning}`);
      }
    }

    await enqueueFanoutTradeJobs(tradeQueueFor, planFanoutTradeJobs({
      signalId: signal.id,
      tokenMint: opts.tokenMint,
      score: opts.signalScore,
      clusterTier,
      sourceTrade: opts.sourceTrade
        ? {
          sourceTradeId: opts.sourceTrade.sourceTradeId,
          direction: opts.sourceTrade.side
        }
        : null,
      plan: fanout?.plan ?? null
    }));

    // The capacity ledger writer (`S4-M6`), and it runs **after** the enqueue on
    // purpose: the row asserts a cohort order was committed, and an enqueue
    // failure means it was not. Idempotent on `(source_trade_id, execution_mode)`,
    // which matters because `markSourceTradeSignalDispatched` runs only below —
    // so a fan-out that dies mid-way really is re-run whole on the next tick.
    //
    // Without this write the ledger stays empty, an empty window sums to "no
    // capacity used", and the cap above permits every cohort while looking like a
    // control. The notional is recorded as `unpriced` rather than as the
    // projection, so the window reports a LOWER BOUND instead of a fabricated
    // numerator — see `planCapacityLedgerEntries`.
    if (fanout && opts.sourceTrade) {
      await recordFanoutCapacityLedger(planCapacityLedgerEntries({
        masterWalletAddress: opts.sourceTrade.walletAddress,
        chain,
        tokenMint: opts.tokenMint,
        sourceTradeId: opts.sourceTrade.sourceTradeId,
        effectiveMode: fanout.effectiveMode,
        cohortSize: fanout.plan.eligible.length,
        committedAt: new Date()
      }));
    }
  } else if (!patternMayTrade) {
    console.log(`[signal-engine] ⏭️ ${opts.patternType} is discovery-only (ADR-0005) | token: ${opts.tokenMint}`);
  } else if (!safety.isSafe) {
    console.log(`[signal-engine] ❌ trade blocked — safety flags: ${safety.flags.join(', ')} | token: ${opts.tokenMint}`);
  } else if (opts.suppressTrade) {
    console.log(`[signal-engine] ⏭️ trade suppressed by call site | token: ${opts.tokenMint}`);
  } else {
    console.log(`[signal-engine] ⏭️ trade skipped — score ${opts.signalScore} < 80 | token: ${opts.tokenMint}`);
  }

  if (opts.sourceTrade) {
    await markSourceTradeSignalDispatched(signal.id);
  }
}

export async function processSourceTradeSignals(sourceTradeId?: string): Promise<void> {
  const candidates = await listSourceTradeSignalCandidates({
    sourceTradeId,
    maxEventAgeMs: SOURCE_COPY_MAX_EVENT_AGE_MS,
    limit: sourceTradeId ? 1 : 100
  });
  for (const candidate of candidates) {
    // `S4-M5`. The only place a master's own event becomes a copy, so the only
    // place this belongs. `listSourceTradeSignalCandidates` already restricts
    // `direction IN ('buy','sell')` in SQL, which is why this reads as a guard
    // rather than a repair — but the column admits `transfer_in`/`transfer_out`
    // (028:77) and the candidate's `side` is narrowed by assertion only, so the
    // filter is what keeps a future transfer writer from silently mirroring a
    // master shuffling their own wallets. The notional floor is genuinely new:
    // nothing on this path had one.
    const mirrorable = evaluateMirrorableActivity({
      side: candidate.side,
      amountUsd: candidate.amountUsd,
      minimumNotionalUsd: SOURCE_COPY_MIN_NOTIONAL_USD
    });
    if (mirrorable.kind === 'skip') {
      console.log(
        `[signal-engine] not mirrorable (${mirrorable.code}) | source ${candidate.sourceTradeId} | ${mirrorable.reason}`
      );
      continue;
    }

    const routability = await probeTokenRoutability(candidate.tokenMint);
    if (routability.kind === 'skip') {
      console.log(
        `[signal-engine] not routable (${routability.code}) | source ${candidate.sourceTradeId} | ${routability.reason}`
      );
      continue;
    }
    await enqueueSignal({
      patternType: 'source_trade',
      clusterId: candidate.clusterId,
      tokenMint: candidate.tokenMint,
      confidence: candidate.clusterConfidence,
      signalScore: candidate.walletScore,
      sourceTrade: candidate,
      triggerData: {
        sourceWallet: candidate.walletAddress,
        sourceQuantity: candidate.quantity,
        sourceAmountUsd: candidate.amountUsd,
        sourcePriceUsd: candidate.priceUsd,
        sourceEventAt: candidate.eventAt.toISOString(),
        sourceWalletTier: candidate.walletTier
      }
    }).catch((error) => {
      console.error(
        `[signal-engine] failed to derive source signal ${candidate.sourceTradeId}`,
        error
      );
    });
  }
}

// ─── Cluster Pattern Detectors (S4-M26) ───────────────────────────────────────
// Extracted to detectors.ts for query and scoring test isolation.

async function detectSnipePattern() {
  await runSnipeDetector(query, enqueueSignal);
}

async function detectAccumulationPattern() {
  await runAccumulationDetector(query, enqueueSignal);
}

async function detectRotationPattern() {
  await runRotationDetector(query, enqueueSignal);
}

async function detectExitPattern() {
  await runExitDetector(query, enqueueSignal);
}

// ─── Tick ─────────────────────────────────────────────────────────────────────

let tickRunning = false;
async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const results = await Promise.allSettled([
      processSourceTradeSignals(),
      detectSnipePattern(),
      detectAccumulationPattern(),
      detectRotationPattern(),
      detectExitPattern()
    ]);
    const detectorNames = ['source-trade', 'snipe', 'accumulation', 'rotation', 'exit'];
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.error(`[signal-engine] ${detectorNames[index]} detector failed`, result.reason);
      }
    });
  } finally {
    tickRunning = false;
  }
}

setInterval(tick, 15_000);
void tick();

// React immediately to real-time wallet swap events from indexer.
// Pub/sub is a latency optimization only — the 15s polling tick() is the
// authoritative detector — but ioredis does NOT auto-resubscribe after a
// reconnect, so resubscribe on every 'ready' to avoid silently going deaf.
const subscriber = new Redis(redisUrl, { maxRetriesPerRequest: null });
function subscribeSwaps() {
  subscriber.subscribe(REDIS_CHANNELS.walletSwap, (err) => {
    if (err) console.error('[signal-engine] swap subscribe failed', err);
    else console.log('[signal-engine] subscribed to wallet-swap channel.');
  });
}
subscribeSwaps();
subscriber.on('ready', subscribeSwaps);
subscriber.on('error', (e) => console.error('[signal-engine] redis error', e.message));
subscriber.on('message', (_channel, message) => {
  // Trigger an immediate detection cycle on any new swap. Don't log the full
  // payload (high-volume; avoids leaking wallet-activity detail into logs).
  try {
    const payload = JSON.parse(message) as { sourceTradeId?: unknown };
    if (typeof payload.sourceTradeId === 'string' && payload.sourceTradeId.trim()) {
      void processSourceTradeSignals(payload.sourceTradeId).catch((error) => {
        console.error('[signal-engine] source-trade event processing failed', error);
      });
    }
  } catch {
    console.error('[signal-engine] ignored malformed wallet-swap event');
  }
  void tick();
});

console.log('[signal-engine] service running');
