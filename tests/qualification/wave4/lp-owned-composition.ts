// Public integration leaf for the coordinator-owned shared financial composition.
// Production bodies are shared through explicit DB leaves, never the ambient barrel.
export { createOwnedLpPaperComposition, lpOwnedSourceGaps } from '@swat/db/dist/lp-paper-owned.js';
export type { OwnedLpPaperComposition, LpOwnedCompositionPorts, LpOwnedBinding, LpOwnedAuthority,
  LpOwnedPurpose, LpOwnedProtectedRecord, LpOwnedProtectedSource, LpOwnedInitialization,
  LpOwnedSecretAdmission, PoolClient, UserScope } from '@swat/db/dist/lp-paper-owned.js';
