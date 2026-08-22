# Stale `dist/` hazards — open items

**Opened 2026-08-20** while landing `S3-25` (commit `1059531`). Tracks three items
that all have **one root cause**, which is why they live in one file: services and
their vitest runs resolve `@swat/shared` and `@swat/db` to `dist/`, and both `dist/`
directories lag their `src/`. That single fact shows up as a deploy blocker, a set of
hidden type errors, and a class of tests that validate the wrong code.

Close an item by ticking it and recording the commit. Delete the file when all three
are closed — it is a tracker, not a reference.

> **Do not resolve these by running `pnpm build`.** The operator's machine crashes
> under it (hard constraint §1 of `docs/agents/continue-build.md`). Per-package
> `tsc --noEmit` emits nothing and is not a build; emitting is.

---

## Why one root cause produces three problems

`packages/shared/package.json` and `packages/db/package.json` both declare
`"main": "dist/index.js"` / `"types": "dist/index.d.ts"`. Nothing maps `@swat/shared`
or `@swat/db` to source — not the app `tsconfig.json` files, and not vitest (there is
no `vitest.config.ts` in any app, so no alias). So **three different consumers** all
read the built artifact:

| Consumer | Reads | Consequence |
| --- | --- | --- |
| Services at runtime (`tsx`) | `dist/index.js` | a missing export is `undefined` → item 1 |
| `tsc --noEmit` in an app | `dist/index.d.ts` | drift is invisible, then appears on rebuild → item 2 |
| vitest in an app | `dist/index.js` | tests exercise stale code → item 3 |

Measured 2026-08-20:

- `packages/shared/dist/index.d.ts` — built **2026-08-08**, with **5** newer sources:
  `index.ts`, `slippage.ts`, `constants.ts`, `jito.ts`, `email.ts`.
- `packages/db/dist/index.d.ts` — built **2026-08-18**, with **4** newer sources:
  `user-execution-settings.ts`, `execution-grants.ts`, `trades.ts`,
  `copy-trade-lifecycle.ts`.

**Never conclude from a stale `dist` that source is broken.** That inference is the
trap this file exists to prevent.

---

## 1. `S3-25` does not run until `@swat/shared` is rebuilt — deploy blocker

- [ ] **Run `pnpm --filter @swat/shared build` on the build machine.** Commit: ____

`chainFromTokenMint` and `tradeQueueForTokenMint` are new exports in
`packages/shared/src/constants.ts`. Verified absent from `dist`: both appear in 1
source file and **0** dist declaration files. Until the rebuild they are `undefined`
at runtime, and the per-chain queue cutover is not merely inert — it is broken:

| Service | Behaviour before the rebuild |
| --- | --- |
| `api` | `POST /v1/signals/:id/execute` throws — `chainFromTokenMint` is not a function |
| `signal-engine` | logs `SKIPPED: cannot resolve a chain` and drops **every** signal |
| `trade-executor` | `chainFromJob` throws → every job fails as `UnrecoverableError` |

`tradeQueueForChain` degrades benignly by comparison: the stale `dist` copy still
carries the old two-argument signature and returns `swat-trades`, which the drain
worker consumes. It is the *new* exports that hard-fail.

**Same class, already outstanding:** `dist/index.d.ts` is missing
`export * from './email.js'` (confirmed by diffing the two barrels), so
`import { sendEmail } from '@swat/shared'` does not resolve either. One rebuild
closes both. `sendEmail` has no caller yet, which is the only reason it has been
invisible.

**Verify the rebuild worked** — this should print `1` twice:

```bash
grep -c "chainFromTokenMint" packages/shared/dist/constants.d.ts
grep -c "export \* from './email.js'" packages/shared/dist/index.d.ts
```

---

## 2. `packages/db/dist` hides three real type errors

- [x] **Add `userId` to three fixtures in `execution-lifecycle.test.ts`.** Commit: `48017fd`. **Done 2026-08-21 — and it was one fix, not three:** all three errors came from the shared `canonicalExecution` helper, so adding `userId: null` there closed them together. `null` rather than a placeholder id, because those fixtures are operator-mode executions and there is no user behind them; inventing one would make a single-tenant path look multi-tenant.
  **Fixing it exposed two more errors the same blindness was hiding** — `jupiter-jito-simulation-wiring.test.ts` indexed `vi.fn().mock.calls`, which TypeScript types as an empty tuple, and cast it directly between unrelated types. Both were invisible because vitest does not typecheck. `apps/trade-executor` now typechecks **clean against source**, which it never had before. 488/488.

`CopyExecutionRecord` gained `userId: string | null` under the `S4-10` tenancy work
(`packages/db/src/copy-trade-lifecycle.ts:86,133`). The field appears **27×** in
`packages/db/src` and **0×** in `packages/db/dist`. Three object literals therefore
typecheck today and stop typechecking the moment `@swat/db` is rebuilt:

```
apps/trade-executor/src/execution-lifecycle.test.ts(486,9): error TS2741
apps/trade-executor/src/execution-lifecycle.test.ts(541,9): error TS2741
apps/trade-executor/src/execution-lifecycle.test.ts(580,7): error TS2741
  Property 'userId' is missing in type '{ ... }' but required in type 'CopyExecutionRecord'
```

Pre-existing — inherited from `S4-10`, not introduced by `S3-25`; `git status` shows
the file untouched by that commit. The fix is `userId: null` in each fixture, but it
belongs in a pass that can *verify* against a rebuilt `dist`, which is why it was
reported rather than applied blind.

**Reproduce without a build** (this is how it was found — a temporary tsconfig with
`paths` pointed at source, `--noEmit`, so nothing is emitted):

```bash
cat > apps/trade-executor/tsconfig.srccheck.json <<'JSON'
{ "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true, "rootDir": "../..", "baseUrl": "../..",
    "paths": { "@swat/shared": ["packages/shared/src/index.ts"],
               "@swat/db":     ["packages/db/src/index.ts"] } } }
JSON
./node_modules/.bin/tsc --noEmit -p apps/trade-executor/tsconfig.srccheck.json
rm -f apps/trade-executor/tsconfig.srccheck.json
```

Worth running against **every** app before trusting a clean `tsc --noEmit`. On
2026-08-20 the other four (`api`, `scorer`, `signal-engine`, `alert-service`) were
clean this way; only `trade-executor` was not. **As of 2026-08-21 all five are clean
against source**, so this recipe is now a regression check rather than a discovery
tool — run it after any change that touches a `packages/*` type, because the
dist-based check will not tell you.

---

## 3. App tests validate a build artifact, not source — testing defect

- [ ] **Alias `@swat/shared` / `@swat/db` to `src` for app vitest runs.** Commit: ____

There is no `vitest.config.ts` in any app, so vitest resolves workspace packages
through `package.json` `main` — i.e. `dist`. **Every app test that imports
`@swat/shared` or `@swat/db` is exercising code built on 2026-08-08 / 2026-08-18.**

Tests *inside* `packages/shared` and `packages/db` are unaffected: they import
relatively (`./constants.js`) and get source. So the 214 shared and 305 db tests are
sound. It is the app suites that are pointed at the wrong artifact.

**How it surfaced, concretely.** `apps/trade-executor/src/trade-workers.test.ts` was
first written to call a helper that derived the chain from the job payload. It failed
with `misroutedJobWarning(...)` returning `null` for an obvious misroute — because
the imported `chainFromTokenMint` was `undefined` in `dist`, the call threw, and the
`catch` swallowed it. **A silent pass was one `catch` away.** The guard was
restructured to take an already-derived `Chain` so the assertion could not be
hollowed out this way.

`apps/trade-executor/src/execution-lifecycle.test.ts` documents the same wall from
the other side: its `vi.mock('@swat/shared')` cannot use
`importActual('@swat/shared')` for a new export, so it `importActual`s
`../../../packages/shared/src/constants.js` by path. That works, and it was chosen
over re-implementing the derivation in the mock — a copy in a test double would be
free to drift from the one the producers route on, which defeats the point of
`S3-25` having a single definition.

**Why this was not folded into `S3-25`.** Changing module resolution for all app
suites could turn other tests red or reveal further drift, and the build loop is one
item at a time. It needs its own item, its own commit, and a full run of every app
suite (`trade-executor` 352, `api` 17, `scorer` 18, `signal-engine` 10,
`alert-service` 13) to see what it uncovers. **Expect it to surface real failures —
that is the point of doing it, not a reason to skip it.**

Sketch, not a recommendation until someone has run it:

```ts
// apps/<service>/vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: { alias: {
    '@swat/shared': new URL('../../packages/shared/src/index.ts', import.meta.url).pathname,
    '@swat/db':     new URL('../../packages/db/src/index.ts',     import.meta.url).pathname
  } }
});
```

A shared root config or a `pnpm` workspace-wide alias may be tidier than five copies.
Whoever takes it should also decide whether the app `tsconfig.json` files get the same
`paths`, which would make item 2's class of drift impossible rather than merely
detectable.

---

## Related

- `docs/agents/continue-build.md` §1 (hard constraints — no builds), §8 (the original
  stale-`dist` finding, which this file supersedes with measurements).
- `AUDIT-FIX-CHECKLIST.md` §6.4 `S3-25` — the entry these items came out of.
- `CLAUDE.md` — "`packages/shared` … Built output (`dist/`) is what services import,
  so run `pnpm --filter @swat/shared build` if a service can't resolve a new export."
  That instruction is correct and is item 1.
