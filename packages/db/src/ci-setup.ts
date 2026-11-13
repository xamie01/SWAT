import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Legacy automatic bootstrap could recreate a predictable, privileged login.
 * Keep the entrypoint as an explicit refusal, not a hidden provisioning fallback.
 */
export async function setup(): Promise<never> {
  throw new Error('Automatic CI database bootstrap is disabled; use audited deploy/postgres/roles.sql and separately provisioned disposable infrastructure');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.error('Automatic CI database bootstrap is disabled; explicit audited role provisioning is required');
  process.exitCode = 1;
}
