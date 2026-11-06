export declare function hashPassword(password: string): Promise<string>;
export declare function verifyPassword(encoded: string, password: string): Promise<boolean>;
/**
 * Burns the same time as a real verify for an account that does not exist.
 * Always returns false.
 */
export declare function verifyPasswordAgainstDummy(password: string): Promise<boolean>;
/** 256 bits of CSPRNG output, base64url so it is cookie- and header-safe. */
export declare function generateToken(): string;
export declare function hashToken(token: string): Buffer;
/**
 * Constant-time comparison of two SHA-256 digests.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself leak, so the
 * length is checked first and a mismatch simply returns false.
 */
export declare function tokenMatches(a: Buffer, b: Buffer): boolean;
export interface ApiKeyParts {
    /** The full secret. Shown to the user once and never stored. */
    readonly key: string;
    /** Indexed lookup handle, safe to store and display. */
    readonly prefix: string;
    readonly hash: Buffer;
}
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
export declare function generateApiKey(): ApiKeyParts;
/**
 * Extracts the lookup prefix from a presented key, or null if malformed.
 *
 * Parsed by position rather than by `split('_')`: the secret is base64url, whose
 * alphabet includes `_`, so splitting yields a variable number of parts and a
 * naive `parts.length !== 3` check rejects perfectly valid keys. The prefix is
 * fixed-width, so slicing is both correct and unambiguous.
 */
export declare function parseApiKeyPrefix(key: string): string | null;
//# sourceMappingURL=credentials.d.ts.map