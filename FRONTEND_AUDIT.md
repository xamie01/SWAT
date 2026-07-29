# FRONTEND AUDIT — Backend/Frontend Union Gap Report

**Date:** 2026-07-25
**Branch:** `PolymarketXRobinhood`
**Scope:** Every route in `apps/api/src/index.ts` cross-referenced against every consumer in `apps/web/`.
**Reference standard:** `gaol.md` (SWAT Standard Goal & Execution Build Plan, 2026-07-16).

---

## 0. Executive summary

The backend exposes **39 routes**. The frontend consumes **19**. That gap alone would be
unremarkable — but the specific shape of the gap is the problem:

1. **Three views are pure mock.** `HealthView`, plus large sections of `AttributionView`,
   `WalletIntelView` and `SignalsView`, render hardcoded literals in places where a
   fully-built backend endpoint already returns the exact data. The column headers are a
   field-for-field match to the API response shape, which means these views were designed
   against the real contract and then never wired.

2. **Two destructive/irreversible controls lie about their outcome.** The signal
   "VERIFY & EXECUTE" button and the CommandCenterView execution-mode toggles report
   success via `alert()` / local `setState` without ever calling the backend. An operator
   cannot distinguish "trade executed" from "nothing happened."

3. **There are two disconnected UIs in one app.** The legacy pages
   (`/wallets`, `/setup`, `/clusters`, `/signals`, `/performance`, `/logs`) hold nearly all
   the *working* wiring. The newer `/workspace` shell holds nearly all the *design*. The
   workspace sidebar links to none of the legacy pages, so the operational buttons
   (Start Indexer, blacklist management, discovery) are unreachable from the primary UI.

The single highest-severity item is **HealthView**, because a fake-green health dashboard is
strictly worse than no dashboard. `gaol.md` §0.2 exists specifically because every historical
Polygon/EVM failure was silent, and states: *"The build phase must never again discover a dead
chain via an empty dashboard."* The current UI reproduces that exact failure mode with
higher confidence.

### Severity index

| # | Finding | Severity | Location |
|---|---|---|---|
| 1 | HealthView is 100% mock; `/v1/health/ingestion` unconsumed | **Critical** | `views/HealthView.tsx` |
| 2 | "VERIFY & EXECUTE" fakes execution via `alert()` | **Critical** | `views/SignalsView.tsx:464` |
| 3 | CommandCenterView mode toggles never POST | **Critical** | `views/CommandCenterView.tsx:213,246` |
| 4 | Hardcoded login credentials in client bundle | **Critical** | `app/page.tsx:23` |
| 5 | Shadow-cost / expectancy / latency unconsumed; fake numbers shown | **High** | `views/AttributionView.tsx` |
| 6 | `risk` config key writable but read by nothing | **High** | `api/src/index.ts:695` |
| 7 | Risk Configuration Matrix inputs are decorative | **High** | `views/RiskExecutionView.tsx:437-450` |
| 8 | Polymarket signal context never joined or displayed | **High** | `api/src/index.ts:419` |
| 9 | `shadow-cost` route registered after `app.listen()` | **Medium** | `api/src/index.ts:726` |
| 10 | Workspace shell orphans all legacy operational pages | **Medium** | `app/workspace/page.tsx:44-52` |
| 11 | Backfill/reindex button unreachable from workspace | **Medium** | `app/wallets/page.tsx:312` |
| 12 | Token blacklist + discovery unreachable from workspace | **Medium** | `app/setup/page.tsx` |
| 13 | WalletIntelView activity feed is mock; history/holdings unconsumed | **Medium** | `views/WalletIntelView.tsx:153-188` |
| 14 | SignalsView filter controls are non-functional | **Low** | `views/SignalsView.tsx:222-266` |
| 15 | `/v1/stats` unconsumed; wallet count computed client-side | **Low** | `views/CommandCenterView.tsx:25` |
| 16 | Cluster timeline / performance / refresh unconsumed | **Low** | `app/clusters/page.tsx` |
| 17 | Trending tokens, discovery log, wallet delete unconsumed | **Low** | multiple |

---

## 1. Full endpoint union table

Legend: **WIRED** = real fetch to real endpoint · **MOCK** = UI exists, renders fabricated data ·
**MISSING** = no consumer at all.

| Endpoint | Method | Backend impl | Frontend consumer | State |
|---|---|---|---|---|
| `/v1/health` | GET | `index.ts:143` | — | MISSING |
| `/v1/health/ingestion` | GET | `index.ts:149` | `HealthView` renders literals | **MOCK** |
| `/v1/stats` | GET | `index.ts:160` | — | MISSING |
| `/v1/auth/ticket` | POST | `index.ts:119` | `logs/page.tsx:71` | WIRED |
| `/v1/wallets` | GET | `index.ts:209` | `wallets/page.tsx:31`, `CommandCenterView:22` | WIRED |
| `/v1/wallets` | POST | `index.ts:224` | `wallets/page.tsx:74,111` | WIRED |
| `/v1/wallets/:address` | GET | `index.ts:214` | `WalletIntelView:18` | WIRED |
| `/v1/wallets/:address` | DELETE | `index.ts:244` | — | MISSING |
| `/v1/wallets/reindex` | POST | `index.ts:238` | `wallets/page.tsx:50` | WIRED (orphaned) |
| `/v1/wallets/:address/history` | GET | `index.ts:255` | `WalletIntelView` renders literals | **MOCK** |
| `/v1/wallets/:address/holdings` | GET | `index.ts:283` | "Positions" tab is a stub | **MOCK** |
| `/v1/discovery/from-token` | POST | `index.ts:315` | `setup/page.tsx:154` | WIRED (orphaned) |
| `/v1/discovery/run` | POST | `index.ts:338` | — | MISSING |
| `/v1/discovery/log` | GET | `index.ts:343` | — | MISSING |
| `/v1/clusters` | GET | `index.ts:356` | `clusters/page.tsx:26` | WIRED |
| `/v1/clusters/:id` | GET | `index.ts:367` | `clusters/page.tsx:47` | WIRED |
| `/v1/clusters/:id/performance` | GET | `index.ts:384` | — | MISSING |
| `/v1/clusters/:id/refresh` | POST | `index.ts:399` | — | MISSING |
| `/v1/clusters/:id/timeline` | GET | `index.ts:405` | — | MISSING |
| `/v1/signals` | GET | `index.ts:419` | `signals/page.tsx:13`, `SignalsView:135`, `CommandCenterView:28` | WIRED (partial) |
| `/v1/signals/stats` | GET | `index.ts:440` | `CommandCenterView:19` | WIRED |
| `/v1/signals/:id` | GET | `index.ts:453` | — | MISSING |
| `/v1/signals/:id/ignore` | POST | `index.ts:460` | "REJECT SIGNAL" only closes drawer | **MOCK** |
| `/v1/signals/:id/execute` | POST | `index.ts:466` | "VERIFY & EXECUTE" fires `alert()` | **MOCK** |
| `/v1/tokens/trending` | GET | `index.ts:509` | — | MISSING |
| `/v1/tokens/:mint` | GET | `index.ts:526` | — | MISSING |
| `/v1/trading/status` | GET | `index.ts:538` | `RiskExecutionView:20` | WIRED |
| `/v1/trading/mode` | POST | `index.ts:562` | `RiskExecutionView:38` | WIRED |
| `/v1/trading/portfolio` | GET | `index.ts:586` | `performance/page.tsx` | WIRED |
| `/v1/trading/performance` | GET | `index.ts:596` | `performance/page.tsx:23`, `AttributionView:17` | WIRED |
| `/v1/trading/trades` | GET | `index.ts:612` | `performance/page.tsx`, `AttributionView:18` | WIRED (count only) |
| `/v1/trading/expectancy` | GET | `index.ts:623` | — | MISSING |
| `/v1/trading/latency` | GET | `index.ts:628` | `AttributionView` prints `"Live Data"` | **MOCK** |
| `/v1/trading/shadow-cost` | GET | `index.ts:726` | `AttributionView` prints `1.2`/`4.6` BPS | **MOCK** |
| `/v1/config` | GET | `index.ts:648` | `setup/page.tsx:28` | WIRED |
| `/v1/config` | POST | `index.ts:697` | `setup/page.tsx:74,99` (blacklist only) | WIRED (partial) |
| `/v1/scorer/run` | POST | `index.ts:653` | `setup/page.tsx:123` | WIRED (orphaned) |
| `/v1/logs` | GET | `index.ts:658` | `logs/page.tsx` | WIRED |
| `/v1/logs/stream` | GET (SSE) | `index.ts:671` | `logs/page.tsx` | WIRED |

**Tally:** 19 WIRED · 8 MOCK · 12 MISSING.

---

## 2. Critical findings

### 2.1 HealthView is entirely fabricated — `gaol.md` §0.2 and §13 violation

**Where:** `apps/web/app/workspace/views/HealthView.tsx` (331 lines, **zero** `fetch` calls).

The table at `HealthView.tsx:57-65` declares exactly these columns:

```
CHAIN | STATUS | LAST EVENT | BATCH LAG | 24H STATS (I/S/F) | RATIO | TARGET LAG
```

`GET /v1/health/ingestion` (`api/src/index.ts:149`) returns exactly these fields via
`buildIngestionHealthSnapshots()`:

```ts
// packages/shared/src/ingestion-health.ts:29
type IngestionHealthSnapshot = {
  chain, status,            // 'healthy' | 'stale' | 'empty'
  lastEventAt, lastBatchAt, lastSuccessAt,
  lagSeconds, batchLagSeconds,
  staleAfterSeconds, targetLagSeconds,
  inserted24h, skipped24h, failed24h,
  insertRatio
};
```

Per-chain thresholds are already codified in `INGESTION_HEALTH_POLICY`
(`packages/shared/src/ingestion-health.ts:9`): solana 5 min, polygon 10 min,
robinhood-chain 15 min — matching `gaol.md` §0.2 exactly.

Instead, the view hardcodes `"400ms ago"`, `"12ms"`, `"1.2M / 4k / 0"`, `"Healthy"`, and
`w-[99.5%]` bar widths. The "Force Re-Sync" button (`HealthView.tsx:9-15`) is a 1.5-second
`setTimeout` followed by `alert('Global Ingestion nodes re-synchronized successfully.')` — it
touches no backend.

**Impact:** All three chains render green whether or not ingestion is alive. This defeats
the stated purpose of Phase 0.2 and falsifies three "✅" cells in the `gaol.md` §13
Definition-of-Done matrix.

**Fix:**

1. Add the fetch (server data already has the right shape — no transform needed):
   ```ts
   const [health, setHealth] = useState<{ generatedAt: string; items: any[] }>({ generatedAt: '', items: [] });
   useEffect(() => {
     const load = async () => {
       const res = await fetch(`${apiUrl}/v1/health/ingestion`, { headers: { 'X-Api-Key': apiKey } });
       if (res.ok) setHealth(await res.json());
     };
     load();
     const int = setInterval(load, 15_000);
     return () => clearInterval(int);
   }, []);
   ```
2. Replace the three hardcoded `<tr>` blocks with `health.items.map(...)`. Drive the status
   chip from `item.status` (`healthy` → success, `stale` → error, `empty` → warning), the
   ratio bar width from `item.insertRatio`, and "LAST EVENT" from `item.lagSeconds`.
3. Delete the `triggerSync` handler, or repoint it at `POST /v1/wallets/reindex`. Do not
   leave a button that claims success it cannot verify.
4. Render `health.generatedAt` so a frozen page is visually obvious.

---

### 2.2 "VERIFY & EXECUTE" fakes a real trade

**Where:** `apps/web/app/workspace/views/SignalsView.tsx:463-468`

```tsx
<button
  onClick={() => { alert('Operational Trade Executed successfully!'); setSelectedSignal(null); }}
>
  VERIFY &amp; EXECUTE
</button>
```

No network call. The operator is told a trade executed when nothing happened.

The backend endpoint is real and does meaningful work — `POST /v1/signals/:id/execute`
(`api/src/index.ts:466`) resolves cluster tier from `avg_composite_score`, returns `409` when
`token_mint` is null, and enqueues to `tradeQueue` with `manual: true`, `attempts: 4`, and
exponential backoff.

The sibling "REJECT SIGNAL" button (`:457`) has the same defect — it only calls
`setSelectedSignal(null)` and never hits `POST /v1/signals/:id/ignore` (`api/src/index.ts:460`),
so the signal stays `pending` forever.

**Impact:** This is the most dangerous class of bug in the report. A financial action control
that reports fabricated success. It also silently breaks the reject path, leaving rejected
signals eligible for auto-execution.

**Fix:** Wire both, surface real errors, and never claim success on a non-2xx:

```tsx
const [acting, setActing] = useState(false);

const executeSignal = async (id: string) => {
  setActing(true);
  try {
    const res = await fetch(`${apiUrl}/v1/signals/${id}/execute`, {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' }
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Execute failed (${res.status})`);
    setBanner({ kind: 'ok', text: `Signal ${id} queued for execution.` });
    setSelectedSignal(null);
  } catch (e: any) {
    setBanner({ kind: 'err', text: e.message });   // stay open on failure
  } finally {
    setActing(false);
  }
};
```

Mirror for `ignore`. Note the wording: the backend *enqueues*, so the UI must say "queued",
not "executed" — the fill is confirmed later by the executor.

---

### 2.3 CommandCenterView execution toggles are inert

**Where:** `apps/web/app/workspace/views/CommandCenterView.tsx:213, 246`

```tsx
onClick={() => setSolanaMode(mode)}     // local state only
onClick={() => setPolygonMode(mode)}    // local state only
```

The "Execution Control Plane" section renders OFF / PAPER / LIVE / LIVE+SHADOW buttons that
mutate React state and nothing else. The Robinhood row (`:276-279`) is hardcoded
`disabled` with a static "Paper Only (Certification Pending)" label — it does not reflect the
real certification state from `getActiveCertifiedChains()`.

The button highlight therefore shows the operator's *last click*, not the system's actual
mode. Initial state is `useState('LIVE')` for Solana (`:6`) — so on first paint this view
asserts Solana is LIVE regardless of the truth. Meanwhile the adjacent "Ingestion Health"
panel (`:293-321`) is also hardcoded, and names a chain that does not exist in this system
("Ethereum WSS").

**Impact:** Two views disagree about execution mode. `RiskExecutionView` shows the real
value; `CommandCenterView` shows a fiction, and its toggles give false feedback on the most
safety-critical control in the product.

**Fix:** Either (recommended) delete the duplicated control plane and ingestion panel from
`CommandCenterView` and link to `RiskExecutionView` / `HealthView` as the single source of
truth — or reuse the same wiring already proven in `RiskExecutionView:18-50` (`fetchStatus` +
`updateMode`). Do not maintain two independent implementations of the kill-switch surface.

---

### 2.4 Hardcoded credentials in a client component

**Where:** `apps/web/app/page.tsx:22-28`

```tsx
if (email === 'admin@wake.com' && password === 'password123') {
  router.push('/workspace');
}
```

This is a `'use client'` component, so the credential pair ships in the browser bundle. It is
also printed on the login page itself — `app/page.tsx:572` renders
`admin@wake.com / password123` as demo-hint text. It provides no actual protection either
way: `/workspace` is directly navigable, and the API is guarded independently by `X-Api-Key`.

Compounding this, `NEXT_PUBLIC_API_KEY` is baked into the bundle across all pages (default
`'swat-dev-key'`). The backend correctly refuses to boot in production without `API_KEY`
(`api/src/index.ts:68`), but any `NEXT_PUBLIC_*` value is public by definition.

**Fix:** Remove the credential check. If gating is needed, use a real session (server-side
route handler + httpOnly cookie) and proxy API calls through Next.js server routes so the
API key never reaches the client. Track as a prerequisite before any public deploy.

---

## 3. High-severity findings

### 3.1 The entire §9 attribution loop is unrendered — fake numbers in its place

`gaol.md` §9 is titled *"the part that proves the mission"*. Three endpoints implement it.
None are consumed, and `AttributionView` prints invented values where each belongs.

| `gaol.md` ref | Endpoint | Backend | What the UI shows instead |
|---|---|---|---|
| §9.2 / §9.3 | `/v1/trading/expectancy` | `index.ts:623` → `getExpectancyReport()` (`attribution-queries.ts:101`) | nothing rendered anywhere |
| §9.5 | `/v1/trading/latency` | `index.ts:628` | literal string `"Live Data"` (`AttributionView.tsx:60`) |
| §7.4 | `/v1/trading/shadow-cost` | `index.ts:726` | `LIVE SLIP 1.2 BPS` / `SHADOW SLIP 4.6 BPS` (`:190-205`) |

`AttributionView` fetches only `/v1/trading/performance` (three global aggregates) and
`/v1/trading/trades` — and uses the latter *only* to take `.length` for a counter
(`AttributionView.tsx:21`), discarding all 17 selected columns.

Worst offender, `AttributionView.tsx:200-205`:

```tsx
<span className="font-bold">Observation:</span> Low-latency execution via direct validator
RPCs on Solana is saving <span className="...">3.4bps</span> relative to public mempool
execution (Shadow).
```

This is a fabricated analytical conclusion presented as a measured finding, positioned
next to real fetched data. `gaol.md` §7.4 designates this exact number *"the go/no-go input
for scaling position sizes."*

**Available data shapes** (already validated by unit tests in `attribution-queries.test.ts`):

```ts
// GET /v1/trading/expectancy → { items: ExpectancyRow[] }
{ pattern_type, tier, chain, execution_mode,
  total_signals, hit_rate_pct, avg_win_usd, avg_loss_usd, expectancy_usd }

// GET /v1/trading/latency → { items: [...] }
{ chain, pattern_type, tier, execution_mode, p50_sec, p95_sec }

// GET /v1/trading/shadow-cost → { report: [...] }
{ chain, matched_trades, avg_execution_cost_bps }
```

**Fix:**
1. Delete the hardcoded "Observation" paragraph and the `1.2`/`4.6` BPS literals. Replace with
   a per-chain table driven by `shadow-cost`; render an explicit "no matched shadow pairs yet"
   empty state rather than a plausible-looking number.
2. Replace `"Live Data"` with `p50_sec`/`p95_sec` per chain from `/v1/trading/latency`. Per
   `gaol.md` §1, flag Solana p50 ≥ 60 s as a threshold breach.
3. Add the expectancy grid — one row per `(pattern × tier × chain × mode)`. Per §9.3, display
   it adjacent to `minScore` from `/v1/trading/status`, since the report is the stated basis
   for changing that threshold.
4. Use the full `/v1/trading/trades` payload for the "Attribution Ledger" table instead of
   discarding it.

---

### 3.2 The `risk` config key is writable but read by nothing

`gaol.md` §8 requires per-chain risk enforcement read from the `risk` config key
(*"hot-changeable"*): per-trade cap, daily exposure cap, persisted circuit breaker,
kill switch, balance floor.

`risk` is in `ALLOWED_CONFIG_KEYS` (`api/src/index.ts:695`), so `POST /v1/config` accepts it.
A repo-wide grep for consumers returns **only that allowlist line** — no service reads it:

```
$ grep -rn "'risk'" --include=*.ts apps/ packages/*/src/ | grep -v test
apps/api/src/index.ts:695:const ALLOWED_CONFIG_KEYS = new Set([... 'risk' ...]);
```

Compare `blacklist`, which is genuinely consumed at `apps/signal-engine/src/index.ts:51`.

**Impact:** Writing risk limits appears to succeed and changes nothing. This is a
write-only sink for the settings an operator would most expect to be load-bearing. `gaol.md`
§8 is not implemented, and the API surface implies otherwise.

**Fix:** Backend first — this is not a frontend bug. Add a `parseRiskConfig()` to
`@swat/shared` (alongside the existing `parseExecutionMode`), read it in the executor before
claiming a signal, and add `GET /v1/trading/risk` returning the resolved effective limits.
Only then build UI against it. Until that exists, the Risk Configuration Matrix (§3.3) must
not present itself as functional.

---

### 3.3 Risk Configuration Matrix is entirely decorative

**Where:** `apps/web/app/workspace/views/RiskExecutionView.tsx:340-451`

Every control in this panel is cosmetic:

| Control | Line | Actual behavior |
|---|---|---|
| Global Position Cap `$25,000,000` | `:350` | `defaultValue`, uncontrolled, never read |
| SOL / MATIC min threshold | `:362-367` | static text |
| Minimum Signal Score Floor | `:383` | local `useState(78)`, never POSTed |
| Liquidity Floor `5,000` | `:398` | `defaultValue`, never read |
| Max Slippage Tolerance | `:410` | local `useState`, never POSTed |
| Daily Exposure `$8,421,902 / $10M` | `:428` | hardcoded, `width: '84%'` hardcoded |
| **Apply Risk Profile** | `:445` | `alert('New risk profiles applied to live execution node.')` |
| **Revert Changes** | `:439` | `alert('Risk Configuration settings reset.')` |
| **Run Missing Tests** | `:314` | `alert('Executing Missing Tests...')` |

"Apply Risk Profile" claiming settings were applied *to the live execution node* is the same
false-confirmation defect as §2.2.

Additionally the Certification Gates panel (`:288-334`) hardcodes Solana and Polygon as
`CERTIFIED` and Robinhood as `RESTRICTED`, plus a hardcoded warning banner (`:456-472`)
asserting two specific failed gates. Real certification state is available from
`resolveChainMode()` → `certified` / `reason`, which this same file already fetches and
renders correctly in the Execution Matrix above (`:131`, `:163-167`).

**Impact:** An operator can set a position cap, click Apply, receive confirmation, and have
changed nothing — while the panel simultaneously displays fabricated exposure utilisation
(84% of a $10M limit) that could drive a real trading decision.

**Fix:** Blocked on §3.2. In the interim, the honest move is to disable the inputs and label
the panel "not yet enforced" rather than leave controls that lie. Once `risk` is enforced:
POST via `/v1/config` with the `risk` key, then re-read to confirm. Drive the certification
chips from the already-fetched `modes[chain].certified` / `.reason` and delete the hardcoded
banner. Remove the "Run Missing Tests" button — per `gaol.md` §7/§10.3 certification is a
manual checklist pasted into `docs/certification/<chain>.md`, not a dashboard action.

---

### 3.4 Polymarket signal context is never joined or displayed

`gaol.md` §1 (Polymarket standard) requires: *"every polygon signal carries market question
+ outcome + end date"*, and §13 lists "Signals carry chain-native context →
market question/outcome/date" as a Definition-of-Done gate.

The data exists. `packages/db/sql/012_polymarket_markets.sql:2` defines:

```sql
CREATE TABLE polymarket_markets (
  condition_id VARCHAR(66) PRIMARY KEY,
  question TEXT NOT NULL,
  slug TEXT,
  end_date TIMESTAMP,
  outcome_count INTEGER NOT NULL,
  clob_token_ids JSONB,
  status VARCHAR(20) DEFAULT 'active',
  resolved_outcome VARCHAR(50),
  ...
);
```

and `tokens.polymarket_condition_id` (`:17`) links outcome tokens to their market. A helper
`getPolymarketMarket(conditionId)` exists at `packages/db/src/polymarket.ts:23`.

But `GET /v1/signals` (`api/src/index.ts:426`) is:

```sql
SELECT * FROM signals WHERE 1=1 ...
```

No join to `tokens` or `polymarket_markets`. The `signals` table
(`packages/db/sql/001_init.sql:99`) has no question/outcome/end_date columns of its own — only
`token_name` / `token_symbol` added by `008_token_metadata.sql`. So the market question is
unreachable by any frontend consumer.

Consequently `SignalsView` degrades: `context` falls back to `s.cluster_id || 'Global'`
(`SignalsView.tsx:163`) and `asset` to a raw mint. Its own `MOCK_SIGNALS` fixture
(`:53-54`) shows the intended design — `asset: 'ETH hit $4k in March?'`,
`context: 'Outcome: Yes | Price: $0.42'` — which the live path cannot produce.

Chain detection is also wrong. `SignalsView.tsx:145-151` and `CommandCenterView.tsx:145-151`
both infer chain from the mint string:

```ts
if (mint.startsWith('0x'))      chainName = 'Robinhood';
else if (mint.includes(':'))    chainName = 'Polymarket';
```

Per `CLAUDE.md`, **all** addresses are stored chain-prefixed (`solana:`, `polygon:`,
`robinhood-chain:`). So no mint starts with `0x` — the Robinhood branch is dead code — and
*every* mint contains `:`, meaning solana and robinhood signals are both mislabelled
"Polymarket". Every row in both feeds shows the wrong chain.

**Fix:**
1. Backend — join the context in `GET /v1/signals`:
   ```sql
   SELECT s.*, tok.symbol, tok.name, tok.chain,
          pm.question, pm.end_date, pm.status AS market_status, pm.resolved_outcome
     FROM signals s
     LEFT JOIN tokens tok ON tok.mint = s.token_mint
     LEFT JOIN polymarket_markets pm ON pm.condition_id = tok.polymarket_condition_id
    WHERE 1=1 ...
   ```
2. Frontend — replace mint-sniffing with the authoritative prefix split in both views:
   ```ts
   const chain = (s.token_mint ?? '').split(':')[0];   // 'solana' | 'polygon' | 'robinhood-chain'
   ```
3. For `chain === 'polygon'`, render `question` as the asset label and
   `Outcome / end_date` as context, matching the `MOCK_SIGNALS` design intent.

---

## 4. Medium-severity findings

### 4.1 `/v1/trading/shadow-cost` is registered after `app.listen()`

**Where:** `api/src/index.ts:720-746` — `app.listen()` at `:721`, route defined at `:726`.

I verified this empirically against the installed Fastify 5.8.5 rather than assuming:

```
route-after-listen: registered without throwing
/before -> 200
/after  -> 200
```

It works **today** because both run in the same synchronous tick before the listen promise
resolves. But it is latent breakage: any `await` inserted between them, or a Fastify version
that tightens `onReady` sealing, turns this into a boot-time
`FST_ERR_INSTANCE_ALREADY_LISTENING` or a silent 404 on a route the frontend is being
asked to depend on (§3.1).

**Fix:** Move the handler above the `// ─── Start ───` block with the other `/v1/trading/*`
routes (after `:644`). No behavior change today; removes the trap.

### 4.2 Two disconnected UIs — workspace orphans every operational control

`apps/web/app/workspace/page.tsx:44-52` defines the entire sidebar:

```
workspace · command_center · signals · wallet_intel · health · risk_execution · attribution
```

The only `<Link href>` in the shell is `href="/"` (`:59`). There is **no** navigation to
`/wallets`, `/setup`, `/clusters`, `/signals`, `/performance`, or `/logs`.

This inverts the quality distribution: the legacy pages contain nearly all the *working*
wiring, and the workspace contains nearly all the *design*. An operator who lands on
`/workspace` cannot reach:

| Control | Lives at | Backend it drives |
|---|---|---|
| **Start Indexer** (bulk backfill) | `wallets/page.tsx:312` | `POST /v1/wallets/reindex` |
| Add single / bulk wallet (+ chain selector) | `wallets/page.tsx:162,234` | `POST /v1/wallets` |
| **Token blacklist** add/remove | `setup/page.tsx:286,344` | `POST /v1/config` (`blacklist`) |
| Discover wallets from token | `setup/page.tsx:237` | `POST /v1/discovery/from-token` |
| Run Scorer Batch | `setup/page.tsx:208` | `POST /v1/scorer/run` |
| Cluster member drill-down | `clusters/page.tsx:47` | `GET /v1/clusters/:id` |
| Live log stream | `logs/page.tsx` | `GET /v1/logs/stream` |

**Fix:** Add these to the workspace sidebar (as new tabs or plain links). Cheapest correct
move: add `Wallets`, `Setup`, `Clusters`, `Logs` as `<Link>` entries in the same nav list, so
the working controls become reachable without a rewrite. Longer term, port them into views
and retire the duplicates — but not before the mock views above are wired, or the app loses
its only functioning surfaces.

### 4.3 Backfill / reindex is the most important orphaned button

Called out explicitly in the request. `POST /v1/wallets/reindex` (`api/src/index.ts:238`)
enqueues a backfill for **every** tracked wallet via `enqueueBackfill()` → `createWalletBackfillJob`,
whose `jobId` dedupe makes re-enqueue a safe no-op.

It is correctly wired at `wallets/page.tsx:45-63` ("Start Indexer"), including a refetch
after 4 s. The defect is purely reachability (§4.2) plus two ergonomics gaps:

- **No per-wallet backfill.** The wallet list (`wallets/page.tsx:353-396`) renders address,
  chain, tier, score, win rate, ROI — but no per-row action. Re-indexing one stale wallet
  requires re-indexing all of them.
- **No delete.** `DELETE /v1/wallets/:address` (`api/src/index.ts:244`, cascades via
  `deleteWalletCascade`) has no UI at all.

**Fix:** Add per-row `Backfill` and `Remove` buttons. Note the chain-prefix invariant from
`CLAUDE.md` — the list renders `wallet.address.split(':')[1]`, and both endpoints take a raw
address plus `?chain=`, so pass the split parts, never the prefixed string:

```tsx
const [chain, raw] = wallet.address.includes(':')
  ? wallet.address.split(':') : ['solana', wallet.address];

// re-index one wallet
await fetch(`${API_BASE}/v1/wallets`, {
  method: 'POST',
  headers: { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ wallets: [{ address: raw, chain, source: 'manual' }] })
});   // upsert is idempotent and re-enqueues backfill (index.ts:232)

// remove (confirm first — cascades transactions)
await fetch(`${API_BASE}/v1/wallets/${raw}?chain=${chain}`,
  { method: 'DELETE', headers: { 'X-Api-Key': API_KEY } });
```

### 4.4 Token-contract tracking inputs are split and partially unreachable

Also called out explicitly. There are three distinct "add a token contract" flows, and the
picture is uneven:

| Purpose | UI | Endpoint | State |
|---|---|---|---|
| **Blacklist** a token (suppress signals) | `setup/page.tsx:286` | `POST /v1/config` `blacklist` | works; consumed at `signal-engine/src/index.ts:51`; unreachable from workspace |
| **Discover wallets** from a token | `setup/page.tsx:237` | `POST /v1/discovery/from-token` | works; solana-only (`index.ts:317` rejects other chains); unreachable from workspace |
| **Inspect** a token | — | `GET /v1/tokens/:mint`, `GET /v1/tokens/trending` | no UI at all |

Gaps to close:
- Blacklist input has **no client-side validation** and no chain selector — it writes whatever
  string is typed. The discovery form validates via `walletAddressSchema` server-side
  (`index.ts:320`), but blacklist entries bypass any check, so a typo silently becomes a
  permanent no-op filter entry.
- `POST /v1/discovery/run` (untargeted sweep, `index.ts:338`) and `GET /v1/discovery/log`
  (audit trail, `:343`) have no UI. The log matters for `gaol.md` §0.1's acceptance criterion
  ("insert a discovered wallet → observe a backfill job → observe transactions rows").
- No trending-tokens view despite a built endpoint ranking by distinct buyers over 24 h.

**Fix:** Surface all three in one "Token Intelligence" view — trending list (with a one-click
"discover from this token"), a blacklist manager with per-chain validation, and the discovery
log as an activity feed. Add a "Run Discovery Sweep" button for `/v1/discovery/run`.

### 4.5 WalletIntelView renders four fake transactions

**Where:** `views/WalletIntelView.tsx:153-188`

The "Activity Feed" tab hardcodes four rows (`$JUP 12.5K SOL`, `$PYTH 8.2K SOL`, …) with
invented hashes. `GET /v1/wallets/:address/history` (`api/src/index.ts:255`) returns real
`signature, direction, target_token, amount_in, amount_out, amount_in_usd, amount_out_usd,
program_id, timestamp` with cursor pagination via `nextCursor` — unconsumed.

The "Positions" tab (`:192-196`) shows a placeholder; `GET /v1/wallets/:address/holdings`
(`:283`) computes net positions with cost basis and realized USD — unconsumed.

Also mock in this view: the "Stealth Snipe Cluster #41 / 98.2% affinity" banner (`:208-213`),
the Cluster Conviction Matrix percentages (`:226-255`), Related Clusters (`:266-304`), and
the Operator Briefing prose (`:315`) which asserts specific findings about a hardcoded
address. Default search value is the placeholder `'0x8a2...f3b'` (`:7`), which is not a valid
address on any of the three chains.

**Fix:** Wire the Activity Feed to `/history` (paginate with `nextCursor`) and Positions to
`/holdings`. Replace the cluster banner and Related Clusters with `GET /v1/clusters` +
`GET /v1/clusters/:id`. Delete the Operator Briefing — it is generated prose presented as
analysis. Clear the default search value.

---

## 5. Low-severity findings

### 5.1 SignalsView filter controls don't filter

Working: Network buttons (`:206`) and the Confidence slider (`:243`) — both feed the
`filteredSignals` predicate at `:183-187`.

Non-functional: the Pattern `<select>` (`:222-229`, no `onChange`), the Safety Rating
buttons (`:252-254`, no handlers), and the Lookback 1h/4h/24h buttons (`:262-264`, no
handlers). All are decorative.

Note that `GET /v1/signals` already accepts `status`, `min_score`, `pattern`, and `limit`
server-side (`api/src/index.ts:419-436`) with bounds enforced by `clampLimit` — the pattern
filter should be pushed to the query rather than filtered client-side.

Also mock in this view: the four summary cards at `:344-374` (`142` verified, `24ms` latency,
`68%` ratio, `STABLE` risk pulse), the drawer's "Source Evidence" paragraph (`:408-410`,
which references JUP regardless of the selected signal), the Wallet Cluster Graph
placeholder (`:416`), and the three-step Execution Log (`:427-452`).

**Fix:** Wire `pattern` into the request URL; implement or delete the Safety and Lookback
controls. Replace the four summary cards with `/v1/signals/stats` (already returns `total`,
`alerted`, `executed`, `rejected`, `avg_score`). Replace the drawer's fabricated evidence with
the signal's real `trigger_data` JSONB (`001_init.sql:106`) fetched via `GET /v1/signals/:id`.

### 5.2 `/v1/stats` unconsumed; counts recomputed client-side

`GET /v1/stats` (`api/src/index.ts:160`) returns `wallets, active, elite, pro, signals,
signalsToday, trades, paperTrades, clusters` in four indexed aggregate queries.

`CommandCenterView` instead fetches the **full** wallet list and takes `.length`
(`:25`), then reads `clusters` / `signalsToday` / `trades` off `/v1/signals/stats`
(`:19-20`) — which returns none of those three (it returns `total, alerted, executed,
rejected, avg_score`). So "Active Clusters", "Signals (24h)" and "Confirmed Executions" are
all permanently `0` from the `useState` initialiser, while labelled "LIVE".

**Fix:** Point the metrics grid at `/v1/stats`. Removes the full-table transfer and fixes
three counters that currently display 0 with a LIVE badge.

### 5.3 Cluster endpoints partially unconsumed

`clusters/page.tsx` wires the list and member drill-down. Unconsumed:
`GET /v1/clusters/:id/performance` (`:384`, avg ROI / win rate / score / member count),
`GET /v1/clusters/:id/timeline` (`:405`, last 30 signals), and
`POST /v1/clusters/:id/refresh` (`:399`, publishes to `REDIS_CHANNELS.clusterRefresh`).

**Fix:** Add a performance strip and signal timeline to the expanded cluster row, plus a
"Refresh Cluster" button.

---

## 6. What is correctly wired

Worth stating precisely, both to avoid re-doing it and because one item is the headline
`gaol.md` gate:

- **Per-chain execution mode switching — `gaol.md` §13's primary Definition of Done.**
  `RiskExecutionView:18-50` fetches `GET /v1/trading/status` and POSTs
  `/v1/trading/mode`, polling every 5 s. The backend validates against the full
  `off | paper | live | live+shadow` union (`api/src/index.ts:569`) and rejects invalid chains
  with 400. `resolveChainMode()` (`packages/db/src/execution-config.ts:40`) correctly
  implements the §2 precedence chain (DB config with 30 s TTL → `TRADING_MODE_<CHAIN>` env →
  legacy `TRADING_MODE` → `paper`), the `LIVE_ENABLED_CHAINS` clamp, and the `{"*":"off"}`
  global kill switch (`:51-58`). **It returns `requestedMode`, `effectiveMode`, `certified`
  and `reason`** — so §4.4's "visible, not silent" clamp requirement is satisfied
  end-to-end, and `RiskExecutionView:163-167` renders the clamp reason correctly.
  This part meets the standard.
- Kill switch (`RiskExecutionView:52-62`) — confirms, then POSTs `off` for all three chains.
  Caveat: the confirm dialog claims it "will close all open positions", which the endpoint
  does not do; it only halts new execution. Reword.
- Wallet add (single + bulk, with chain selector) and reindex — `wallets/page.tsx`.
- Blacklist read/add/remove — `setup/page.tsx`; genuinely consumed by the signal engine.
- Discovery from token, scorer trigger — `setup/page.tsx`.
- Cluster list + member expansion — `clusters/page.tsx`.
- Log viewer with SSE and the one-time ticket handshake — `logs/page.tsx` + `/v1/auth/ticket`.
- Performance page — `performance/page.tsx` uses `/v1/trading/performance`, `/portfolio`,
  and the full `/trades` payload (the only view that renders trade rows properly).

---

## 7. Recommended sequence

Ordered by risk retired per unit of work.

**Phase A — stop the UI from lying (do first)**
1. §2.2 Wire signal execute/reject; remove `alert()` success. *Highest risk: fake financial confirmation.*
2. §2.3 Delete or wire CommandCenterView's mode toggles + ingestion panel.
3. §3.3 Disable the Risk Configuration Matrix and label it unenforced (real fix blocked on §3.2).
4. §2.1 Wire HealthView to `/v1/health/ingestion`. *Response shape already matches the table columns — wiring only.*
5. §2.4 Remove hardcoded credentials.

**Phase B — close the reachability gap**
6. §4.2 Add Wallets / Setup / Clusters / Logs to the workspace sidebar. *Cheapest high-value fix in the report.*
7. §4.3 Per-wallet backfill + delete buttons.
8. §4.4 Token Intelligence view (trending + blacklist w/ validation + discovery log).

**Phase C — render the attribution loop (`gaol.md` §9)**
9. §3.1 Wire expectancy, latency, shadow-cost; delete the fabricated BPS values and "Observation".
10. §5.2 Point metrics at `/v1/stats`; fix the three counters stuck at 0.
11. §4.5 Wallet history + holdings.

**Phase D — backend prerequisites**
12. §3.2 Implement `risk` config enforcement in the executor (`gaol.md` §8), then build §3.3's UI for real.
13. §3.4 Join Polymarket context into `GET /v1/signals`; fix chain detection in both feed views.
14. §4.1 Move the `shadow-cost` route above `app.listen()`.

**Note on §3.4's chain-detection bug:** it is a two-line frontend fix
(`token_mint.split(':')[0]`) affecting every row of both signal feeds, independent of the
backend join. Worth pulling into Phase A.

---

## 8. Verification notes

Claims in this report were checked against source rather than inferred:

- Endpoint inventory: `grep -nE "\.(get|post|put|patch|delete)\(" apps/api/src/index.ts` → 39 routes.
- Consumer inventory: `grep -rn "v1/" apps/web/app --include=*.tsx` → 19 distinct endpoints.
- Mock views confirmed by absence of `fetch` (`HealthView`: 331 lines, 0 fetch calls).
- Route-after-`listen()` behavior (§4.1) was tested empirically against the installed
  Fastify 5.8.5 in `apps/api/`, not assumed — it currently returns 200.
- `resolveChainMode`'s return shape was read at `packages/db/src/execution-config.ts:25-87`,
  which corrected an earlier assumption that clamp reasons were missing from the API. They
  are present and correctly rendered.
- `risk` config non-consumption confirmed by repo-wide grep excluding tests: one hit, the
  allowlist declaration itself.
- Chain-prefix invariant per `CLAUDE.md` and `packages/db/sql/010_chain_discriminator.sql`,
  which is what makes the `mint.startsWith('0x')` branch dead code.
