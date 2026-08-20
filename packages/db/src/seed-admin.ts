import { query } from './client.js';
import { createUser, EmailAlreadyRegisteredError, type UserRecord } from './users.js';

/**
 * Idempotent admin bootstrap.
 *
 * Kept out of migration `039` on purpose. A migration that seeds a credential
 * would put a password hash into a file that replays on every deploy (D16), and
 * would make the schema undeployable without also choosing an admin password.
 * This is a separate, explicitly-invoked step.
 *
 * Existing operator `trades` and `copy_executions` are deliberately **not**
 * backfilled to this user (ADR-0001). Attributing historical single-operator
 * activity to an account would corrupt that account's P&L, expectancy, and
 * exposure caps with trades it never made.
 */

export interface SeedAdminResult {
  readonly created: boolean;
  readonly user: UserRecord | null;
  readonly reason?: string;
}

export async function seedAdminUser(input: {
  email: string | undefined;
  password: string | undefined;
}): Promise<SeedAdminResult> {
  if (!input.email || !input.password) {
    return {
      created: false,
      user: null,
      reason: 'ADMIN_EMAIL and ADMIN_INITIAL_PASSWORD must both be set'
    };
  }
  if (input.password.length < 12) {
    // Matches the signup policy. A weak bootstrap credential on the one account
    // that can reach every admin route is the worst place to make an exception.
    return { created: false, user: null, reason: 'ADMIN_INITIAL_PASSWORD must be at least 12 characters' };
  }

  const existing = await query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
    input.email
  ]);
  if (existing[0]) {
    // Never rewrite the password of an existing admin. Re-running the seed after
    // the operator has rotated it must not silently restore the bootstrap value.
    return { created: false, user: null, reason: 'admin already exists' };
  }

  try {
    const user = await createUser({
      email: input.email,
      password: input.password,
      displayName: 'Operator',
      role: 'admin',
      tier: 'ultra'
    });
    return { created: true, user };
  } catch (error) {
    // Lost a race with a concurrent seed; the desired end state still holds.
    if (error instanceof EmailAlreadyRegisteredError) {
      return { created: false, user: null, reason: 'admin already exists' };
    }
    throw error;
  }
}
