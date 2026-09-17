/**
 * Which Polymarket markets the book feed subscribes to (`S4-M38`).
 *
 * ── The question this answers ─────────────────────────────────────────────
 *
 * The subscriber streams order books into Redis so `signal-engine` can gate
 * fan-out on real depth. It cannot stream *every* Polymarket market — there are
 * tens of thousands, most of them irrelevant to this platform — so something has
 * to choose. This module is that choice, and it is deliberately a DB query plus
 * a **pure** decider rather than a config list, because a hand-maintained list
 * goes stale silently and a stale list reads exactly like a working one.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *
 * Subscribe to the markets this platform might actually have to price, which is
 * the union of two sets:
 *
 *   1. **Markets a tracked master has traded recently** (`source_trades`). These
 *      are the fan-out candidates: a signal fires on a token a master just
 *      traded, and the capacity gate needs that token's book seconds later.
 *   2. **Markets somebody still holds** (`wallet_positions` with a non-zero
 *      balance). An open position has to be exitable, and an exit is priced
 *      against the same book.
 *
 * Set 1 without set 2 would blind the platform to exits on a market that has
 * gone quiet, which is precisely when an exit matters most.
 *
 * ── Eviction, and why it is safe ──────────────────────────────────────────
 *
 * The set is capped (`POLYMARKET_BOOK_MAX_SUBSCRIPTIONS`). When it overflows,
 * the **least recently active** market is dropped, not the newest. A token
 * nobody has traded or held for days has no imminent fan-out to gate, so its
 * book is the least costly one to lose; dropping the newest would blind the gate
 * on exactly the market that just became active.
 *
 * Eviction is safe in the direction that matters: an unsubscribed market has no
 * cache entry, the reader answers `book-not-cached`, and the capacity gate
 * excludes the cohort with `capacity-unknown`. Losing a subscription costs a
 * missed copy, never an unmeasured fill. That asymmetry is what makes a cap
 * acceptable here at all.
 */

import { query } from './client.js';

/**
 * How many markets the feed holds at once.
 *
 * Not derived from a documented venue limit — the market channel publishes none
 * (see `POLYMARKET_MARKET_WS_DEFAULT_SUBSCRIBE_BATCH`'s note). It is a
 * deliberately conservative default bounded by the *resync* path instead, which
 * does have a documented ceiling: `POST /books` takes 500 ids per request, so
 * 2000 markets is four requests per resync cycle. Raising it raises the resync
 * cost linearly and should be done only with the cadence budget re-checked.
 */
export const POLYMARKET_BOOK_MAX_SUBSCRIPTIONS = 2_000;

/** How far back a trade still counts as "recent" for subscription purposes. */
export const POLYMARKET_BOOK_ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface PolymarketBookSubscriptionCandidate {
  /** Chain-prefixed as stored (`polygon:<tokenId>`). */
  readonly tokenMint: string;
  /** Epoch ms of the most recent activity. Drives eviction order. */
  readonly lastActiveAt: number;
  readonly source: 'recent-trade' | 'open-position';
}

export interface PolymarketBookSubscriptionSet {
  /** Bare CLOB token ids, which is what `assets_ids` speaks. */
  readonly tokenIds: readonly string[];
  /** How many candidates the cap excluded. Non-zero is an ops signal. */
  readonly evicted: number;
  readonly counts: {
    readonly recentTrade: number;
    readonly openPosition: number;
  };
}

/**
 * Strip the `polygon:` prefix the repo stores to get the venue's token id.
 *
 * Kept local and total rather than imported: an address that does not carry the
 * prefix is returned unchanged, because both forms appear in fixtures and a
 * throw here would take out the whole seed for one malformed row.
 */
function bareTokenId(tokenMint: string): string {
  const separator = tokenMint.indexOf(':');
  return separator === -1 ? tokenMint : tokenMint.slice(separator + 1);
}

/**
 * Pick the subscription set from the candidates. Pure.
 *
 * Dedupes by token (a market that is both recently traded and held appears
 * twice), orders by most-recent activity, and applies the cap. Split from the
 * query so the ordering and eviction rules are testable with no database —
 * which matters here, because the eviction rule is the part with a consequence.
 */
export function selectPolymarketBookSubscriptions(
  candidates: readonly PolymarketBookSubscriptionCandidate[],
  maxSubscriptions: number = POLYMARKET_BOOK_MAX_SUBSCRIPTIONS
): PolymarketBookSubscriptionSet {
  const cap = Math.max(0, Math.floor(maxSubscriptions));
  const best = new Map<string, PolymarketBookSubscriptionCandidate>();

  for (const candidate of candidates) {
    const tokenId = bareTokenId(candidate.tokenMint);
    if (tokenId.length === 0) continue;
    const held = best.get(tokenId);
    // Keep the most recent activity across both sources, so a token that is held
    // *and* freshly traded sorts by the trade rather than by whichever row the
    // query happened to emit second.
    if (held === undefined || candidate.lastActiveAt > held.lastActiveAt) {
      best.set(tokenId, candidate);
    }
  }

  const ordered = [...best.entries()].sort((a, b) => {
    const byRecency = b[1].lastActiveAt - a[1].lastActiveAt;
    // Ties broken by token id so the set is deterministic across restarts; an
    // unstable set would resubscribe a different tail on every boot.
    return byRecency !== 0 ? byRecency : a[0].localeCompare(b[0]);
  });

  const kept = ordered.slice(0, cap);
  let recentTrade = 0;
  let openPosition = 0;
  for (const [, candidate] of kept) {
    if (candidate.source === 'open-position') openPosition += 1;
    else recentTrade += 1;
  }

  return {
    tokenIds: kept.map(([tokenId]) => tokenId),
    evicted: Math.max(0, ordered.length - kept.length),
    counts: { recentTrade, openPosition }
  };
}

interface CandidateRow {
  token_mint: string;
  last_active_at: Date | string;
  source: string;
}

/**
 * Read the candidate markets from Postgres.
 *
 * One query with a `UNION ALL` rather than two round trips, and the pure
 * selector above does the merging — so the SQL stays a plain read with no
 * ranking logic to disagree with the tested decider.
 */
export async function fetchPolymarketBookSubscriptionCandidates(params: {
  readonly now: Date;
  readonly activityWindowMs?: number;
} ): Promise<readonly PolymarketBookSubscriptionCandidate[]> {
  const windowMs = params.activityWindowMs ?? POLYMARKET_BOOK_ACTIVITY_WINDOW_MS;
  const since = new Date(params.now.getTime() - windowMs);

  const rows = await query<CandidateRow>(
    `SELECT token_mint, MAX(created_at) AS last_active_at, 'recent-trade' AS source
       FROM source_trades
      WHERE chain = 'polygon'
        AND created_at >= $1
      GROUP BY token_mint
      UNION ALL
     SELECT token_mint, MAX(updated_at) AS last_active_at, 'open-position' AS source
       FROM wallet_positions
      WHERE chain = 'polygon'
        AND balance > 0
      GROUP BY token_mint`,
    [since]
  );

  return rows.map((row) => ({
    tokenMint: row.token_mint,
    lastActiveAt: new Date(row.last_active_at).getTime(),
    source: row.source === 'open-position' ? ('open-position' as const) : ('recent-trade' as const)
  }));
}

/**
 * The seed set for the book feed at startup: read, then decide.
 *
 * Returns an empty set rather than throwing when the read fails. An indexer that
 * refuses to boot because one seed query failed would stop ingesting every
 * chain; an empty seed degrades to "no Polymarket depth", which the capacity
 * gate already handles by admitting nobody on polygon. Live discovery
 * (`subscriber.subscribe(...)` as trades arrive) repopulates it regardless.
 */
export async function loadPolymarketBookSubscriptionSet(params: {
  readonly now: Date;
  readonly activityWindowMs?: number;
  readonly maxSubscriptions?: number;
  readonly onFailure?: (detail: string) => void;
}): Promise<PolymarketBookSubscriptionSet> {
  try {
    const candidates = await fetchPolymarketBookSubscriptionCandidates({
      now: params.now,
      ...(params.activityWindowMs === undefined ? {} : { activityWindowMs: params.activityWindowMs })
    });
    return selectPolymarketBookSubscriptions(
      candidates,
      params.maxSubscriptions ?? POLYMARKET_BOOK_MAX_SUBSCRIPTIONS
    );
  } catch (error) {
    const detail =
      `Polymarket book subscription seed failed: ${error instanceof Error ? error.message : String(error)}. `
      + 'Starting with no seeded markets; live discovery will still subscribe as trades arrive, and '
      + 'polygon fan-out reads capacity-unknown until a book lands.';
    if (params.onFailure !== undefined) params.onFailure(detail);
    return { tokenIds: [], evicted: 0, counts: { recentTrade: 0, openPosition: 0 } };
  }
}
