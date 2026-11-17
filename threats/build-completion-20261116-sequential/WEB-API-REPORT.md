# API/web capability truthfulness checkpoint — 2026-11-16

Removed fabricated spot holdings/zero-safe perps fallback, preserve loading/error/unavailable/unassessed/observed-empty and nullable marks/PnL/totals. Spot exit/close-all backend exposes blocked capability; handlers guard unsupported actions, auth/tenant/financial refusal unchanged. LP UI token quantity vs acquisition USD/mode separated, paper-only operations and actual job outcomes, no live removal promise. Vault client no fabricated approval/time/authority and unavailable read not uninitialized. API full test-program restored via tsconfig.test.json/typecheck-only runner api-tests.

Final build-web-api-green-02:63pass8files; production API noEmit01, web noEmit02, API source/test-program noEmit build-web-api-tests-01 all exit0. CPU0lockguard512/640; inputs unchanged, diff clean. Final workspace manifest aa6cd3408c89a7c750984a0c150c9d2308cb901d99c0d99266ef308af81d8cc4. Literal config55c7b8f4fc0de7b6df1460ddf72e55c957fbf73e98e78bd323cc190003dc8d3c. Don't sum reruns.

Paths: apps/api routes/me.ts, me.portfolio.sequential.test.ts, tsconfig.test.json; web lib/portfolio-model.ts/test, positions/vault/LPpositions/LPbuilder pages. No core/LPbackend changes. Browser QA not run (no separately approved preview), no fullNext/native/DB/provider/live/deployment acceptance. Independent source review pending.
