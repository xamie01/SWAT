// Compiler-only alias to actual source exports, not stubs or runtime wiring.
// Avoid the shared service/crypto barrel while checking the PNL dependency closure.
export * from '../../packages/shared/src/types.js';
export * from '../../packages/shared/src/address.js';
export * from '../../packages/shared/src/copy-trade-lifecycle.js';
export * from '../../packages/shared/src/prices.js';
