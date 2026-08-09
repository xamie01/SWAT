import { closePool } from './client.js';
import { seedAdminUser } from './seed-admin.js';

/**
 * `pnpm --filter @swat/db seed:admin`
 *
 * Separate from `migrate` so a schema deploy never depends on choosing an admin
 * password, and so re-running migrations cannot resurrect a rotated credential.
 */
async function main(): Promise<void> {
  const result = await seedAdminUser({
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_INITIAL_PASSWORD
  });

  if (result.created && result.user) {
    console.log(`[seed-admin] created admin ${result.user.email} (${result.user.id})`);
    console.log('[seed-admin] change this password after first login');
  } else {
    console.log(`[seed-admin] no action: ${result.reason}`);
    // Not an error exit: the script is idempotent by design and CI/deploy may
    // run it unconditionally.
  }
}

main()
  .catch((error) => {
    console.error('[seed-admin] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
