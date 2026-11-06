/**
 * End-to-end smoke test for the Polymarket book feed (`S4-M38`).
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * The feed has 115 unit tests across three modules and every one of them runs
 * against injected fakes: a fake WebSocket, a fake `fetch`, an in-memory
 * key/value store. That is the right way to test the *decisions*, and it is
 * structurally incapable of answering the questions that actually matter on
 * first deployment:
 *
 *   1. Does the venue's WebSocket accept our subscribe frame, and does it push
 *      `book` events for the tokens we asked for?
 *   2. Does `POST /books` accept our body shape and return rows our parser
 *      recognises?
 *   3. Does an entry written by `indexer`'s publisher come back out of Redis
 *      decodable by `signal-engine`'s reader — same key, same wire version?
 *   4. Does the whole chain produce a **priced** verdict, or does it produce a
 *      plausible-looking unknown?
 *
 * Every one of those is a live-infrastructure question. A unit test that mocks
 * the socket cannot fail when the venue renames a field.
 *
 * ── What it needs, and what it does NOT need ──────────────────────────────
 *
 * Needs: **Redis**, and outbound network to Polymarket. That is all.
 *
 * Does **not** need Postgres. The token ids are discovered from the venue's own
 * public Gamma API rather than from `source_trades`, so this runs before any
 * migration has ever been applied — which is deliberate, because the point is to
 * de-risk the feed independently of the database work.
 *
 * ── Read-only and side-effect-bounded ─────────────────────────────────────
 *
 * Writes nothing but its own book keys, which carry the feed's normal TTL and
 * expire on their own. Places no orders, touches no wallet, needs no private
 * key, and never consults `TRADING_MODE` because it cannot trade: there is no
 * order path in this file. Safe to run against production Redis, though a local
 * instance is the obvious choice.
 */
export declare function runPolymarketBookAcceptance(): Promise<void>;
//# sourceMappingURL=polymarket-book-acceptance.d.ts.map