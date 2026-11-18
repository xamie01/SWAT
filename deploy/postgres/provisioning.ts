import { requireAuditReference } from '../../packages/db/src/migration-selection.js';

export type RoleCapability = { readonly role: string; readonly kind: 'runtime' | 'migrator' | 'writer' | 'service' | 'observer' | 'function-owner';
  readonly login: 'externally-approved-direct-only' | 'never'; readonly ownsObjects: boolean; readonly schemaCreate: boolean;
  readonly sourceCapabilities: readonly string[] };
export const SOURCE_CAPABILITY_MATRIX = {
  runtime: { role: 'swat_app', kind: 'runtime', login: 'externally-approved-direct-only', ownsObjects: false, schemaCreate: false, sourceCapabilities: ['tenant RLS', 'protected LP paper store'] },
  migrator: { role: 'swat_migrator', kind: 'migrator', login: 'externally-approved-direct-only', ownsObjects: true, schemaCreate: true, sourceCapabilities: ['reviewed migration plan', 'pg_control_system observer'] },
  custodyWriter: { role: 'swat_custody_writer', kind: 'writer', login: 'externally-approved-direct-only', ownsObjects: false, schemaCreate: false, sourceCapabilities: ['081 custody admissions'] },
  financialReceiptWriter: { role: 'swat_financial_receipt_writer', kind: 'writer', login: 'externally-approved-direct-only', ownsObjects: false, schemaCreate: false, sourceCapabilities: ['082 independent receipts/accounting'] },
  lpAdmitter: { role: 'swat_lp_admitter', kind: 'writer', login: 'externally-approved-direct-only', ownsObjects: false, schemaCreate: false, sourceCapabilities: ['085 tenant paper admissions'] },
  authService: { role: 'swat_auth_service', kind: 'service', login: 'externally-approved-direct-only', ownsObjects: false, schemaCreate: false, sourceCapabilities: [] },
  systemObserver: { role: 'swat_system_observer', kind: 'observer', login: 'externally-approved-direct-only', ownsObjects: false, schemaCreate: false, sourceCapabilities: ['pg_control_system only; no tenant grants'] },
  sourceProviderWriter: { role: 'swat_source_provider_writer', kind: 'writer', login: 'externally-approved-direct-only', ownsObjects: false, schemaCreate: false, sourceCapabilities: [] },
  riskWriter: { role: 'swat_risk_writer', kind: 'writer', login: 'externally-approved-direct-only', ownsObjects: false, schemaCreate: false, sourceCapabilities: ['072 policy control; disabled during migration'] },
  capabilityWriter: { role: 'swat_capability_writer', kind: 'writer', login: 'externally-approved-direct-only', ownsObjects: false, schemaCreate: false, sourceCapabilities: [] },
  valuationWriter: { role: 'swat_valuation_writer', kind: 'writer', login: 'externally-approved-direct-only', ownsObjects: false, schemaCreate: false, sourceCapabilities: [] },
  runtimeLookup: { role: 'swat_runtime_lookup', kind: 'function-owner', login: 'never', ownsObjects: true, schemaCreate: false, sourceCapabilities: ['079 allowlisted lookup functions only'] },
  financialSettler: { role: 'swat_financial_settler', kind: 'function-owner', login: 'never', ownsObjects: true, schemaCreate: false, sourceCapabilities: ['082 allowlisted settlement functions only'] }
} as const satisfies Record<string, RoleCapability>;
export type ProvisionedRole = keyof typeof SOURCE_CAPABILITY_MATRIX;
export type RoleIdentity = {
  readonly currentUser: string; readonly sessionUser: string; readonly roleSetting: string; readonly rowSecurity: string;
  readonly canLogin: boolean; readonly superuser: boolean; readonly bypassRls: boolean; readonly inherit: boolean;
  readonly createRole: boolean; readonly createDb: boolean; readonly replication: boolean;
  readonly membershipsIn: number; readonly membershipsOut: number; readonly ownsRelations: boolean;
  readonly ownsFunctions: boolean; readonly ownsSchemas: boolean; readonly ownsDatabases: boolean;
  readonly schemaCreate: boolean; readonly databaseCreate: boolean;
  readonly ownedFunctionSignatures?: readonly string[];
};
export const FUNCTION_OWNER_ALLOWLIST = {
  runtimeLookup: ['public.swat_claim_runtime_capability(uuid)', 'public.has_worker_execution_capability(uuid)'],
  financialSettler: ['public.swat_apply_perps_reducing_receipt(uuid,text)', 'public.w3_apply_financial_receipt()',
    'public.w3_perps_accounting_requires_application()', 'public.swat_cancel_expired_financial_intent(uuid)', 'public.w3_guard_perps_position_mutation()']
} as const;
/** Checks observed facts, not environment labels or assumed login authority. Caller supplies real catalog evidence. */
export function validateRoleIdentity(key: ProvisionedRole, identity: RoleIdentity, phase: 'disabled' | 'active-direct'): void {
  const capability = SOURCE_CAPABILITY_MATRIX[key];
  const allowedFunctions: readonly string[] = key === 'runtimeLookup' ? FUNCTION_OWNER_ALLOWLIST.runtimeLookup
    : key === 'financialSettler' ? FUNCTION_OWNER_ALLOWLIST.financialSettler : [];
  if (identity?.ownsFunctions && capability?.kind === 'function-owner'
      && (!Array.isArray(identity.ownedFunctionSignatures) || !identity.ownedFunctionSignatures.length
        || new Set(identity.ownedFunctionSignatures).size !== identity.ownedFunctionSignatures.length
        || identity.ownedFunctionSignatures.some(signature => !allowedFunctions.includes(signature)))) {
    throw new Error('Function owner requires exact allowlisted ownership evidence');
  }
  if (!capability || !identity || !['disabled', 'active-direct'].includes(phase)
      || identity.currentUser !== capability.role || identity.sessionUser !== capability.role
      || identity.roleSetting !== 'none' || identity.rowSecurity !== 'on'
      || [identity.superuser, identity.bypassRls, identity.inherit, identity.createRole, identity.createDb, identity.replication].some(v => v !== false)
      || identity.membershipsIn !== 0 || identity.membershipsOut !== 0
      || identity.canLogin !== (phase === 'active-direct') || (capability.login === 'never' && phase !== 'disabled')
      || typeof identity.schemaCreate !== 'boolean' || typeof identity.databaseCreate !== 'boolean'
      || [identity.ownsRelations, identity.ownsFunctions, identity.ownsSchemas, identity.ownsDatabases].some(v => typeof v !== 'boolean')
      || (!capability.schemaCreate && (identity.schemaCreate || identity.databaseCreate))
      || (!capability.ownsObjects && (identity.ownsRelations || identity.ownsFunctions || identity.ownsSchemas || identity.ownsDatabases))
      || (capability.kind === 'function-owner' && (identity.ownsRelations || identity.ownsSchemas || identity.ownsDatabases))) {
    throw new Error('Restricted direct role identity/flags/login/ownership/membership evidence rejected');
  }
}
export type LoginLifecycleApproval = { readonly role: ProvisionedRole; readonly auditReference: string;
  readonly expiresAt: string; readonly credentialProvisionedExternally: true; readonly sessionsDrained: true;
  readonly sourceCapabilitiesIndependentlyQualified: true };
/** Separate external lifecycle source, not an execution API. No password material, SET ROLE or membership grant. */
export function createLoginActivationSource(approval: LoginLifecycleApproval, now: Date): { sql: string; disableSql: string; auditReference: string } {
  requireAuditReference(approval?.auditReference);
  const role = SOURCE_CAPABILITY_MATRIX[approval.role];
  const expiry = Date.parse(approval.expiresAt);
  if (!role || role.login === 'never' || approval.credentialProvisionedExternally !== true || approval.sessionsDrained !== true
      || approval.sourceCapabilitiesIndependentlyQualified !== true || !Number.isFinite(now.getTime())
      || !Number.isFinite(expiry) || new Date(expiry).toISOString() !== approval.expiresAt
      || expiry <= now.getTime() || expiry > now.getTime() + 86_400_000) throw new Error('Explicit bounded direct LOGIN lifecycle approval required');
  return { sql: `-- EXTERNAL DBA ONLY; validateRoleIdentity(disabled) first; runtime/risk stay disabled throughout migration.\nALTER ROLE ${role.role} LOGIN VALID UNTIL '${approval.expiresAt}';`,
    disableSql: `ALTER ROLE ${role.role} NOLOGIN PASSWORD NULL; -- Drain/terminate surviving sessions externally; NOLOGIN does not disconnect them.`, auditReference: approval.auditReference };
}
