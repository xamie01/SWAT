/**
 * Local barrel for the argument-scoped permission policy engine (`S4-P10`).
 *
 * This directory moves to `packages/authority` when that package exists
 * (checklist §7.1); this file becomes its package entrypoint unchanged.
 *
 * Note this is *not* wired into `packages/shared/src/index.ts` yet — see the
 * export list in the S4-P10 report. Until it is, and until `dist/` is rebuilt, a
 * service importing from `@swat/shared` will not see these symbols
 * (`docs/stale-dist-hazards.md`).
 */
export * from './permission-policy.js';
export * from './evm-calldata.js';
