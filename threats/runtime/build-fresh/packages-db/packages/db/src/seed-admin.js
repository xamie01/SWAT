import { query } from './client.js';
import { createUser, EmailAlreadyRegisteredError } from './users.js';
export async function seedAdminUser(input) {
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
    const existing = await query('SELECT id FROM users WHERE email = $1', [
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
    }
    catch (error) {
        // Lost a race with a concurrent seed; the desired end state still holds.
        if (error instanceof EmailAlreadyRegisteredError) {
            return { created: false, user: null, reason: 'admin already exists' };
        }
        throw error;
    }
}
//# sourceMappingURL=seed-admin.js.map