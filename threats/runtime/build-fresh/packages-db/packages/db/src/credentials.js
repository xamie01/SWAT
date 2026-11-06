import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
/**
 * Credential primitives shared by passwords, session tokens, and API keys.
 *
 * Two different hashing strategies live here on purpose, and conflating them is
 * the classic mistake in both directions:
 *
 *   * Passwords are low-entropy and human-chosen, so they need a *slow*,
 *     memory-hard hash (argon2id) to make offline cracking expensive.
 *   * Session tokens and API keys are 256 bits of CSPRNG output. There is no
 *     guessing attack to slow down, so a slow hash would buy nothing and would
 *     put ~110 ms on the critical path of *every authenticated request*.
 *     SHA-256 with a constant-time compare is the correct choice.
 */
/**
 * OWASP-recommended argon2id configuration. Measured at ~110 ms on a 2-core box;
 * see `docs/plans/stage-1-design.md` for the benchmark and why the higher-memory
 * variant was rejected.
 *
 * Safe to change without a migration: an argon2 encoded hash embeds its own
 * parameters, so `verifyPassword` keeps working against hashes written under any
 * previous configuration.
 */
const ARGON2_OPTIONS = {
    memoryCost: 47104,
    timeCost: 1,
    parallelism: 1
};
/**
 * Verified against at login when the email is unknown, so that a request for a
 * nonexistent account costs the same time as one for a real account. Without
 * this, response latency is a user-enumeration oracle regardless of how careful
 * the response *bodies* are.
 *
 * Generated once at module load rather than hard-coded, so no real password can
 * ever collide with it.
 */
let dummyHashPromise = null;
function dummyHash() {
    dummyHashPromise ??= argonHash(randomBytes(32).toString('hex'), ARGON2_OPTIONS);
    return dummyHashPromise;
}
export async function hashPassword(password) {
    return argonHash(password, ARGON2_OPTIONS);
}
export async function verifyPassword(encoded, password) {
    try {
        return await argonVerify(encoded, password);
    }
    catch {
        // A malformed or truncated stored hash must fail closed, not throw a 500
        // that tells the caller their password was at least well-formed.
        return false;
    }
}
/**
 * Burns the same time as a real verify for an account that does not exist.
 * Always returns false.
 */
export async function verifyPasswordAgainstDummy(password) {
    await argonVerify(await dummyHash(), password).catch(() => false);
    return false;
}
/** 256 bits of CSPRNG output, base64url so it is cookie- and header-safe. */
export function generateToken() {
    return randomBytes(32).toString('base64url');
}
export function hashToken(token) {
    return createHash('sha256').update(token).digest();
}
/**
 * Constant-time comparison of two SHA-256 digests.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself leak, so the
 * length is checked first and a mismatch simply returns false.
 */
export function tokenMatches(a, b) {
    return a.length === b.length && timingSafeEqual(a, b);
}
/** Length of the indexed lookup prefix, in characters. */
const API_KEY_PREFIX_LENGTH = 8;
const API_KEY_VENDOR = 'swat_';
/**
 * Format: `swat_<prefix>_<secret>`.
 *
 * The prefix is what makes verification one indexed equality instead of a scan
 * over every key row comparing hashes — that alternative degrades linearly with
 * key count and leaks timing.
 *
 * The prefix is **hex**, not base64url, specifically so it cannot contain `_` or
 * `-`. It appears in logs and support conversations, and a delimiter inside the
 * delimited field is how the first version of `parseApiKeyPrefix` broke.
 */
export function generateApiKey() {
    const prefix = randomBytes(4).toString('hex').slice(0, API_KEY_PREFIX_LENGTH);
    const secret = randomBytes(32).toString('base64url');
    const key = `${API_KEY_VENDOR}${prefix}_${secret}`;
    return { key, prefix, hash: hashToken(key) };
}
/**
 * Extracts the lookup prefix from a presented key, or null if malformed.
 *
 * Parsed by position rather than by `split('_')`: the secret is base64url, whose
 * alphabet includes `_`, so splitting yields a variable number of parts and a
 * naive `parts.length !== 3` check rejects perfectly valid keys. The prefix is
 * fixed-width, so slicing is both correct and unambiguous.
 */
export function parseApiKeyPrefix(key) {
    if (!key.startsWith(API_KEY_VENDOR))
        return null;
    const prefix = key.slice(API_KEY_VENDOR.length, API_KEY_VENDOR.length + API_KEY_PREFIX_LENGTH);
    if (prefix.length !== API_KEY_PREFIX_LENGTH)
        return null;
    if (!/^[0-9a-f]+$/.test(prefix))
        return null;
    // The delimiter must sit exactly after the fixed-width prefix, and there must
    // be a non-empty secret after it.
    if (key[API_KEY_VENDOR.length + API_KEY_PREFIX_LENGTH] !== '_')
        return null;
    if (key.length <= API_KEY_VENDOR.length + API_KEY_PREFIX_LENGTH + 1)
        return null;
    return prefix;
}
//# sourceMappingURL=credentials.js.map