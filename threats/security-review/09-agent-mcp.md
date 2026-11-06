# 09 — Agent / MCP security review

## A. Scope, boundaries and entrypoint map

Source-only local review, 2026-11-06. No service was started, no network request was made, no credentials or real environment file were read, and no executable source was changed. **Tests NOT RUN.** “Verified” below means an end-to-end source trace through repository handlers and downstream callers, not a successful protocol exchange. Installed dependency behavior, database permissions, deployed firewall/proxy restrictions and Internet reachability are **NOT VERIFIED**.

The README identifies this package as the autonomous-agent MCP bridge (`README.md:54-67`). Its executable development entrypoint loads `src/index.ts`; its published entrypoint is `dist/index.js`, which was excluded (`apps/mcp-server/package.json:5-12`). The source constructs one MCP `Server`, one Redis client and one transport registry at module scope (`apps/mcp-server/src/index.ts:15-30,365-367`). This is an independent Express listener, not a child of the authenticated Fastify API (`apps/mcp-server/src/index.ts:365-405`; `apps/api/src/index.ts:124-148`).

| Boundary / entrypoint | Source trace and trust decision |
|---|---|
| HTTP listener | `MCP_PORT`, default 3005, explicitly binds `0.0.0.0` (`apps/mcp-server/src/index.ts:15,401-405`). Bind is verified; externally reachable deployment is **NOT VERIFIED**. |
| `GET /sse` | Creates a UUID, stores an SSE transport, connects it to the singleton server and removes its map entry on response close; there is no application authentication, Origin or Host decision in this route (`apps/mcp-server/src/index.ts:365-385`). |
| `POST /messages?sessionId=…` | Selects a transport using only the query value; unknown IDs return 404, known IDs enter the dependency's `handlePostMessage` (`apps/mcp-server/src/index.ts:387-399`). Principal binding and authorization are absent from this application path; exact dependency transport behavior is **NOT VERIFIED**. |
| MCP tool listing / dispatch | All seven definitions are listed; dispatch switches only on tool name and arguments, without a principal or permission check (`apps/mcp-server/src/index.ts:33-124,127-355`). |
| Read tools | `get_recent_signals`, `get_wallet_score`, `get_performance`, `get_blacklist` directly select shared DB records (`apps/mcp-server/src/index.ts:128-261`). |
| Administrative tools | `add_to_blacklist` and `remove_from_blacklist` change the shared `config.blacklist` row; `trigger_scorer` publishes the shared scorer command (`apps/mcp-server/src/index.ts:264-350`). |
| Downstream effects | Signal admission reads that same row and returns on a blacklist match; scorer subscribes to the same channel and invokes its guarded batch (`apps/signal-engine/src/index.ts:318-368`; `packages/shared/src/constants.ts:4-14`; `apps/scorer/src/index.ts:275-287,317-337`). |
| Separate API boundary | REST config/scorer endpoints sit behind registered auth and admin-global hooks; those hooks accept an internal service principal or admin for global surfaces (`apps/api/src/index.ts:140-148,864-871,949-968`; `apps/api/src/auth/plugin.ts:98-125,127-195`). Those controls do not wrap MCP's independent listener. |

**Prior suspicion disposition:** unauthenticated application routes, all-interface bind and global config mutation are confirmed in repository source (`apps/mcp-server/src/index.ts:264-339,365-405`). The deployment document's example proxy routes only frontend `/` and backend `/v1/` to ports 3000/3001; it does not establish isolation of a separate port 3005 listener (`DEPLOYMENT.md:453-496`). Actual reverse proxy configuration, private networking, TLS, firewall and service status remain **NOT VERIFIED**. Absence of a published MCP proxy route is not evidence that the direct listener is inaccessible.

## B. Findings and compatible fixes

| ID | Severity | Confidence | file:line / verification | Abuse (maximum 3 conceptual steps) | Code-level fix |
|---|---|---|---|---|---|
| MCP-01 | **High** | **Verified** | Unauthenticated routes and dispatch: `apps/mcp-server/src/index.ts:123-127,369-399`; mutations: `apps/mcp-server/src/index.ts:264-350`; transaction commit: `packages/db/src/transaction.ts:36-69`; consumers: `apps/signal-engine/src/index.ts:329-363`, `apps/scorer/src/index.ts:317-337`. Protocol exchange, listener access and operational DB/Redis privileges **NOT VERIFIED**. | 1. Reach listener. 2. Obtain session and invoke administrative tool. 3. Change shared blacklist or request scorer work. | Authenticate both routes, bind principal to session, enforce per-tool operator/service permissions, default bind to loopback. |
| MCP-02 | **Medium** | **Verified** | Global SQL-to-output: `apps/mcp-server/src/index.ts:128-140,189-240`; unscoped wrapper: `packages/db/src/client.ts:26-28,65-68`; reviewed RLS target list: `packages/db/sql/064_row_level_security.sql:66-117`. Actual data and exchange **NOT VERIFIED**. | 1. Obtain reachable session. 2. Invoke global read tool. 3. Receive operational records if present and readable. | Gate global reads to operators; introduce separately tenant-scoped tools using authenticated principal, not argument-supplied identity. |
| MCP-03 | **Medium** | **Likely** | Shared server/registry is verified source: `apps/mcp-server/src/index.ts:19-30,365-399`. Cross-session disruption depends on excluded SDK behavior; **Needs check**, protocol isolation **NOT VERIFIED**. | 1. Establish multiple sessions. 2. Exercise independent lifecycles. 3. Possible interference if SDK transport ownership is shared. | Per-session server/context, principal-owned lookup, connection/idle bounds and explicit disposal. |

### MCP-01 — Administrative control-plane bypass

The problematic privilege crossing is specific, not an assertion that arbitrary configuration or shell commands are available: dispatch exposes only the named tools and errors on unknown names (`apps/mcp-server/src/index.ts:33-113,353-361`). Both blacklist mutations validate `tokenMint` merely as a string, then read/write the shared row with parameterized SQL (`apps/mcp-server/src/index.ts:264-339`). Existing-row locking and the 100-entry addition cap are useful integrity controls but do not authenticate the caller (`apps/mcp-server/src/index.ts:267-300,316-339`). A removed entry changes the signal-engine blacklist check, not a proven fund withdrawal or trade execution (`apps/signal-engine/src/index.ts:329-363`). The scorer has an in-process overlap guard, so it is inaccurate to claim unrestricted overlapping batches; repeated accepted commands still reach the manual-batch trigger when not already running (`apps/scorer/src/index.ts:275-287,333-337`).

**Abuse concept 1:** a network-reachable non-operator changes a platform blacklist or requests scoring work through tools that bypass the REST admin boundary. No payloads were constructed or sent.

Numbered fix steps:
1. Default the listener to loopback and require an explicit reviewed setting for non-loopback exposure. This preserves the documented local endpoints while changing unsafe bind behavior (`apps/mcp-server/src/index.ts:401-404`). Treat firewall isolation as defense-in-depth, not a substitute for identity.
2. Authenticate both SSE establishment and message submission; attach an immutable principal to the transport record. Fail closed without configured authentication. Existing SSE clients must gain a supported credential/ticket flow; do not assume REST cookies automatically protect Express (`apps/mcp-server/src/index.ts:369-399`; `apps/api/src/auth/plugin.ts:127-195`).
3. Authorize each tool at dispatch: global reads and blacklist/scorer writes require reviewed operator/service scope. Keep current tool names and response envelopes for authorized clients, but return stable permission errors for denied callers (`apps/mcp-server/src/index.ts:116-124,264-361`).
4. Extract a shared audited config mutation boundary used by MCP and REST, with canonical address validation and actor metadata. Preserve the JSON blacklist representation consumed by signal admission and the Redis channel expected by scorer (`apps/api/src/index.ts:949-968`; `apps/signal-engine/src/index.ts:331-361`; `apps/scorer/src/index.ts:317-337`).

### MCP-02 — Unscoped platform reads

Signals, trade summaries and fills flow from global SQL into JSON text without a user context (`apps/mcp-server/src/index.ts:128-140,195-239`). The reviewed RLS migration therefore must not be cited as protecting these particular query targets (`packages/db/sql/064_row_level_security.sql:70-117`). Other migrations, active policies, DB grants and historical data classification are **NOT VERIFIED**. Wallet statistics may be intentionally public; that does not establish a publication policy for executor identifiers, recent fills or platform performance (`apps/mcp-server/src/index.ts:150-186,213-239`).

**Abuse concept 2:** a reachable non-operator obtains operational trading intelligence not available through admin-gated global REST routes (`apps/api/src/auth/plugin.ts:98-125`).

1. Define publication policy per tool and field; default global operations to operator-only.
2. If user-facing agents are intended, introduce separately scoped queries using the authenticated principal, retaining legacy global tools only for operators. Do not accept a user ID supplied in tool arguments as authority.
3. Test the output contract with two synthetic tenants and an operator; check aggregates as well as individual rows. Bound aggregate work and reject non-finite/non-integer limits, rather than relying solely on the current numeric clamp (`apps/mcp-server/src/index.ts:128-136`).

### MCP-03 — Session-global state and lifecycle

The UUID offers a hard-to-guess lookup handle, but no owner or permissions record accompanies it (`apps/mcp-server/src/index.ts:367-374,387-395`). The source has neither an application connection quota nor a timeout in its SSE setup (`apps/mcp-server/src/index.ts:365-385`). This is an isolation/resource concern; response mix-up, transport replacement, malformed-session acceptance and dependency-level protections need a pinned-SDK investigation and are **NOT VERIFIED** (`apps/mcp-server/package.json:14-20`).

**Abuse concept 3:** another connected client or excessive idle connections interfere with session ownership/lifecycle. This is a hypothesis for safe regression testing, not a demonstrated attack.

1. Create a server/context per session and bind POST authorization to the same principal.
2. Add bounded registry size, idle expiry, message limits and deterministic disposal on connect failure or close.
3. Preserve endpoint/tool compatibility, but reject missing, duplicate/non-string and foreign session IDs before dependency dispatch (`apps/mcp-server/src/index.ts:387-399`).

**Additional hardening, not a separate exploitation claim:** tool failures echo raw exception messages to clients; sanitize these to stable codes while retaining internal diagnostics (`apps/mcp-server/src/index.ts:356-361`). Existing tests mock Express and SDK transport, assert the all-interface listener and cover clamp/publish/unknown-tool behavior, not authentication or real session isolation (`apps/mcp-server/src/index.test.ts:14-36,64-121`).

## C. Invariants and safe local test descriptions

**All tests NOT RUN.** Proposed tests use dummy principals, mocked DB/Redis and inert data, never deployed endpoints or credentials.

- No unauthenticated SSE/message request reaches tool dispatch; non-admin principals cannot mutate blacklist or publish scorer commands. Assert zero side effects on rejected calls, covering the paths above (`apps/mcp-server/src/index.ts:264-350,369-399`).
- Session A cannot submit through session B; closing A must not break B. Check connect-failure cleanup, expiry and registry caps with mocked transports before any approved isolated protocol test (`apps/mcp-server/src/index.ts:367-399`).
- Authorized mutations preserve signal-engine blacklist serialization and scorer channel compatibility; repeated scorer requests respect worker overlap behavior (`apps/signal-engine/src/index.ts:331-363`; `apps/scorer/src/index.ts:275-287,317-337`).
- Mock unusual string/number inputs and synthetic DB failures to assert bounded queries and sanitized errors (`apps/mcp-server/src/index.ts:128-136,265,314,356-361`).

## D. Exclusions and exact coverage appendix

No exploit code, runtime transport exchange, dependency audit, deployment attestation, signing-key review or on-chain execution assessment. Agent discovery searched local executable inventories, including ignored paths, for MCP SDK/FastMCP/stdio/SSE constructs; only the package above was identified as an executable MCP listener. This is search coverage, not proof that no external bridge exists. The similarly named alert bridge is explicitly a Redis-to-BullMQ one-way adapter, not an HTTP/MCP route (`apps/alert-service/src/alert-bridge.ts:33-66`). MCP client configuration files and agent skills were not opened; configured remote tools and their security are **NOT VERIFIED**.

Paths below are relative to `/home/xahmie/Documents/SWAT`; exact ranges distinguish full reads from excerpts.

**In-depth:** `apps/mcp-server/src/index.ts:1-405` (route/tool sections reread); `apps/mcp-server/src/index.test.ts:1-122`; `apps/mcp-server/package.json:1-26`; `apps/api/src/auth/plugin.ts:1-253`; `packages/db/src/client.ts:1-84`; `packages/db/src/transaction.ts:1-71`; `packages/db/sql/064_row_level_security.sql:1-117`.

**Skim / targeted excerpts:** `README.md:1-163`; `apps/api/src/index.ts:75-185,840-976` plus hook-name search; `apps/signal-engine/src/index.ts:300-414`; `apps/scorer/src/index.ts:267-344`; `packages/db/sql/001_init.sql:105-148`; `DEPLOYMENT.md:449-533` plus port/proxy search; `apps/alert-service/src/alert-bridge.ts:1-68`; `scripts/start.sh:1-163` (read only, never executed); `packages/db/src/index.ts:1-6` and `packages/shared/src/constants.ts:4-14` (targeted grep only); remaining SQL files only for RLS/trade-schema name searches.

**Not reviewed:** `.mcp.json`, `.vscode/mcp.json`, `agent/skills/**`, `.agents/skills/**` except the loaded review workflow; `apps/mcp-server/tsconfig.json`; dependency implementations; compiled outputs, locks, real `.env`, deployment credential files, service/process/network state; remaining DB migrations and package source not explicitly listed. `docker-compose.yml` received only a targeted MCP/proxy keyword search, not a security review. No inferred proxy or network restriction is credited.
