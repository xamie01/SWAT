# SWAT Production Decision Record

Decided 2026-07-26 via structured interview. Companion to `saas-conversion-plan.md`. Each entry is a **made decision** with reasoning and the trigger that would cause revisiting it.

Context driving the decisions: ~8 always-on Node services over one Postgres + one Redis; BullMQ for durable work; node-cron schedulers with in-process guards (single-instance assumption); migrations replay every file each run; latency-sensitive path Helius webhook → indexer → signal-engine → trade-executor → venue APIs (all US endpoints); SaaS Phase 3 puts custodial keys inside trade-executor.

---

## Round 1 — Infrastructure & deployment

**D1. Hosting: one dedicated server + Docker Compose** (Hetzner/OVH class, 8–16 vCPU, 32–64 GB).
Compose/start.sh already works — ships in days. One private network keeps indexer→Redis→executor hops near zero (the sub-60s signal-to-alert target *is* the product). 5–10× cheaper than managed containers. Single point of failure is acceptable pre-revenue: idempotent ingestion means an outage misses signals rather than corrupting state. *Revisit when:* paying users demand an SLA or the box saturates (see D5).

**D2. Environments: prod + staging, staging permanently paper-clamped.**
Staging = small VPS with its own Postgres/Redis, restored nightly from the prod backup (doubles as backup verification, D14). Every deploy and migration lands there first. Three independent locks make staging structurally unable to move money: `LIVE_ENABLED_CHAINS` empty, no `chain_certifications` rows, no custody master key present. Per-PR previews deferred (web tier can get Vercel previews against staging API later).

**D3. Deploys: GitHub Actions → SHA-tagged images → auto-deploy staging → manual one-click prod promotion.**
CI runs `pnpm typecheck/test/build` (satisfies audit item G7-T3). Immutable SHA tags give instant rollback. The manual prod gate is deliberate: services that sign with user keys must not self-deploy on merge. *Later refinement:* auto-deploy web/api, keep the gate for trade-executor + migrations.

**D4. Region: single US region for the whole pipeline; Cloudflare CDN in front of web/API.**
Colocate with the venues (Helius, Polymarket CLOB, Robinhood Chain RPC, Jupiter): execution-path latency is product quality; dashboard-read latency is invisible. Multi-region DR bought later as a managed-Postgres feature (D13), not built by hand. EU hosting only if a legal residency requirement materializes.

## Round 2 — Scaling & load balancing

**D5. Scale vertically first; then split in this order:**
1. Postgres to its own host/managed (D13),
2. dedicated hardened host for trade-executor + custody,
3. replicate stateless tiers (api/web/webhook) behind the proxy.

Scheduler services (scorer/discovery/signal-engine) stay single-instance until their in-process cron guards are refactored to Redis locks (`SET NX PX` or BullMQ repeatable jobs) — that refactor is a prerequisite of ever replicating them. Migrations are already safe for concurrent deployers (`pg_advisory_lock(1)`).

**D6. Trade queue: split `swat-trades` into per-chain queues** (`swat-trades-solana|polygon|robinhood`), one worker each, concurrency 1 per chain.
3× parallelism with zero risk-logic changes (exposure caps, breaker, claims are already chain-keyed), and a venue outage on one chain cannot stall the others (audit F-ACC2). Per-user fairness inside a chain via BullMQ job priorities when fan-out lands. Move BullMQ to its own Redis logical DB/instance (separate from pub/sub + cache) once queue volume grows.

**D7. Ingress: Caddy on the box (TLS, routing api./app./webhook, size limits) + Cloudflare in front (CDN/WAF/DDoS).**
SSE caveats: disable proxy buffering on stream routes; idle timeouts > SSE heartbeat. When API replicas arrive, Caddy `lb_policy`/Cloudflare LB takes over with no architecture change. *(Adopted as part of D10 hardening bundle.)*

**D8. Real-time: generalize the existing SSE+ticket pattern to one `/v1/me/stream` per session; drop dashboard polling** (in SaaS Phase 2).
Fed by existing Redis pub/sub channels (`swat:signal:detected`, `swat:wallet:swap`), filtered by the user's subscriptions. ~10× steady-state load reduction vs 5s polling. SSE over WebSockets: survives proxies/CDN, no client library, nothing needs client→server push today.

**D9. Indexing throughput: protect the global-dedup model** (a wallet is indexed once regardless of subscriber count).
Per-tier quotas cap intake; BullMQ job priority lets paying tiers jump the backfill queue; workers keep 429-aware backoff; `BACKFILL_CONCURRENCY` rises only within the Helius plan's rate budget — upgrade the provider plan before adding parallelism (no key-pooling; ToS risk on the most critical dependency). Pause indexing for zero-subscriber wallets so growth doesn't silently multiply webhook volume.

## Round 3 — Security

**D10. Perimeter/host hardening — full bundle:**
- Cloudflare WAF + edge rate limits (DDoS absorption; credential-stuffing shield on `/v1/auth/*`), plus per-user rate limits in Fastify (argon2id makes offline cracking expensive).
- Postgres/Redis bound to the Docker network only — never 0.0.0.0.
- SSH key-only, no password auth, fail2ban.
- Secrets in SOPS-encrypted env files (age key on host), never in git — the audit already found a literal key in the worktree.
- trade-executor container accepts **no inbound connections** — outbound queue consumer only.
- Audit-log table (auth events, custody ops, withdrawals, tier changes, admin actions) built in SaaS Phase 1; alerting on it rides the existing Telegram alert-service. Tailscale zero-trust for admin surfaces is an easy later add.

**D11. Custody keys: envelope encryption now, KMS migration before balances get large.**
Per-key AES-256-GCM data keys wrapped by a master key that exists only in trade-executor's env on the hardened host: a DB dump alone is worthless; an API-server compromise cannot decrypt (API may request keygen, never decryption). `packages/custody` is built around a `KeyWrapper` interface so env-master-key → AWS KMS/Vault Transit is a config change, not a refactor. Withdrawals only to verified linked auth wallets (SIWE/SIWS-proven) + email confirmation + daily cap — makes full account takeover unable to exfiltrate to an attacker address. *Standing option:* price Turnkey/Privy-class custody vendors; verify raw-signing support for Polymarket L2 credential derivation before any commitment.

**D12. Tenant isolation: app-layer scoping + adversarial tests.**
`user_id` comes from the session, never the request payload; encoded once in a `packages/db` query-helper layer (`forUser(userId)`) so it cannot be forgotten per-route. Admin routes on a separate prefix with role check + IP allowlist. CSRF tokens on state-changing routes (cookie auth). The browser-exposed `NEXT_PUBLIC_API_KEY` is removed in SaaS Phase 1; the legacy `API_KEY` becomes internal service→API only, rotated. CI includes a suite attempting cross-tenant access on every `/v1/me/*` route. RLS rejected for now (single DB role + pooled connections make `SET LOCAL` fragile; cross-tenant jobs would need bypasses) — may be added later as backstop on custody/balance tables only.

**D13. Compliance: architecture prepared now; counsel engaged before Phase 3 (custody) launches.** *(Non-negotiable gate.)*
ToS/risk disclosures from a lawyer pre-custody. Geo-blocking of sanctioned jurisdictions at Cloudflare; Polymarket features get a stricter per-user geo-gate inheriting venue restrictions. Immutable per-user financial trail (deposits/withdrawals/trades — same table as D10's audit log discipline). Tier system able to require identity verification later without redesign. Actual KYC deferred until counsel says the operating jurisdiction requires it.

## Round 4 — Database management

**D14. Postgres: self-hosted in Compose now → managed (RDS/Neon class) at first paying cohort.**
The migration is a pg_dump weekend while small, a downtime project once large — do it early. PgBouncer (transaction mode) in front once API replicas exist. **Caveat:** `migrate.ts`'s session-level advisory lock (and any future `SET LOCAL`) must connect directly to Postgres, not through PgBouncer.

**D15. Backups: nightly `pg_dump` to encrypted offsite object storage (B2/S3, 30-day retention); staging restores from it nightly — the backup is tested continuously for free.**
Redis: hourly RDB snapshots suffice; durable truth is Postgres and BullMQ jobs replay safely via deterministic job IDs (`backfill-<chain>-<address>`; `(signalId, target_account)` post-audit). Honest RPO: up to 24h. *Trigger for PITR (RPO ~minutes):* per-user money in `trades` — arrives with the D14 managed move at the latest.

**D16. Migrations: keep the replay-everything model, add guard rails.**
The model is audit-hardened (advisory lock, per-file transactions, twice-replayed verification); switching tools mid-remediation means re-verifying 28 files for ergonomics. Guard rails: (a) migrations run as a dedicated deploy step, not service startup; (b) CI replays the full set twice on scratch Postgres + once on a staging-data copy; (c) expand-and-contract for breaking changes (add → dual-write → backfill → switch reads → drop later); (d) never a destructive statement in the same release as the code depending on it. *Revisit tooling past ~60 files or ~30s replay time.*

**D17. Data growth: evidence-based, staged.**
- **Now:** `pg_stat_statements` enabled; BRIN index on transaction timestamps (detectors constantly scan recent windows); `readPool`/`writePool` split in `packages/db` — costs nothing today, makes D18 a config change.
- **At ~50M rows:** monthly declarative partitioning of `transactions`/`source_trades` so retention = `DROP PARTITION`, not a vacuum storm.
- **Retention by value:** raw transactions archived to Parquet on object storage after 12–18 months (re-fetchable from chain); `signals`/`trades`/audit log kept forever (product record + compliance trail); `price_snapshots` downsampled after 90 days.

**D18. Read scaling: nothing now.** First step when dashboards strain the primary = read replica (a managed-Postgres checkbox after D14) for staleness-tolerant endpoints only (stats, history, attribution). **Never** route balances, signal claiming (`claimSignalForExecution` needs read-your-own-writes), or config reads through a replica. Endpoint tagging happens for free via the D17 pool split. ClickHouse-class OLAP deferred until wallet-behavior analytics demand it.

---

## Sequenced adoption

| When | Do |
|---|---|
| Now (pre-SaaS launch) | D1 box · D7 Caddy+Cloudflare · D2 staging · D3 CI/CD · D10 hardening · D15 backups · `pg_stat_statements` + BRIN (D17) |
| SaaS Phase 1–2 | D12 tenancy discipline + audit-log table · D8 SSE feed · D9 quotas/priorities · readPool/writePool split |
| Before SaaS Phase 3 (custody) | D11 custody build · **D13 legal opinion (gate)** · executor network isolation · withdrawal controls |
| First paying cohort | D14 managed Postgres + PITR · D6 per-chain queues · BullMQ Redis split |
| Growth triggers | D5 splits in order (DB → executor host → stateless replicas after Redis-lock refactor) · D17 partitioning at ~50M rows · D18 replica |
