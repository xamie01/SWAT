import '@fastify/cookie';
import { z } from 'zod';
import { AUDIT_EVENTS, authenticateUser, createSession, createUser, EmailAlreadyRegisteredError, findUserById, findUserIdByAuthWallet, forUser, linkAuthWallet, listAuthWallets, recordAuditEvent, revokeSession, WalletAlreadyLinkedError } from '@swat/db';
import { buildSignInMessage, generateNonce, normaliseAddress, NONCE_TTL_SECONDS, verifySignInSignature } from './wallet-signature.js';
import { CSRF_COOKIE, SESSION_COOKIE, issueCsrfToken, requireUser } from './plugin.js';
const emailSchema = z.string().trim().min(3).max(254).email();
/**
 * Length over composition. Composition rules push users toward predictable
 * substitutions ("Password1!") without adding real entropy; 12 characters is the
 * OWASP-aligned floor.
 */
const passwordSchema = z.string().min(12).max(200);
const signupSchema = z.object({
    email: emailSchema,
    password: passwordSchema,
    displayName: z.string().trim().min(1).max(64).optional()
});
const loginSchema = z.object({
    email: emailSchema,
    password: z.string().min(1).max(200)
});
const chainKindSchema = z.enum(['evm', 'solana']);
const nonceSchema = z.object({
    chainKind: chainKindSchema,
    address: z.string().trim().min(32).max(100)
});
const verifySchema = z.object({
    chainKind: chainKindSchema,
    address: z.string().trim().min(32).max(100),
    message: z.string().min(1).max(2000),
    signature: z.string().min(1).max(500)
});
function publicUser(user) {
    return {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        tier: user.tier,
        tierExpiresAt: user.tierExpiresAt
    };
}
export async function registerAuthRoutes(app, options) {
    const { redis } = options;
    /** Issues the session + CSRF cookie pair. */
    async function establishSession(reply, user, ip, userAgent) {
        const session = await createSession({ userId: user.id, ip, userAgent });
        const csrf = issueCsrfToken();
        const isSecure = process.env.COOKIE_SECURE !== undefined
            ? process.env.COOKIE_SECURE === 'true'
            : (options.isProduction && (reply.request.protocol === 'https' || reply.request.headers['x-forwarded-proto'] === 'https'));
        reply.setCookie(SESSION_COOKIE, session.token, {
            httpOnly: true,
            secure: isSecure,
            // Lax, not Strict: the wallet-linking flow can return the user via a
            // top-level cross-site navigation, which Strict would strip the cookie
            // from. The double-submit CSRF token covers what Lax does not.
            sameSite: 'lax',
            path: '/',
            expires: session.expiresAt
        });
        reply.setCookie(CSRF_COOKIE, csrf, {
            // Deliberately readable by JavaScript — the client must echo it in a
            // header. That is the "double submit"; secrecy is not what makes it work,
            // same-origin read access is.
            httpOnly: false,
            secure: isSecure,
            sameSite: 'lax',
            path: '/',
            expires: session.expiresAt
        });
    }
    app.post('/v1/auth/signup', async (request, reply) => {
        const parsed = signupSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: 'Bad Request', message: 'Invalid signup payload' });
        }
        try {
            const user = await createUser({
                email: parsed.data.email,
                password: parsed.data.password,
                displayName: parsed.data.displayName ?? null
            });
            await establishSession(reply, user, request.ip, request.headers['user-agent'] ?? null);
            await recordAuditEvent({
                actorType: 'user',
                actorId: user.id,
                event: AUDIT_EVENTS.signup,
                ip: request.ip,
                userAgent: request.headers['user-agent'] ?? null
            });
            return reply.code(201).send({ user: publicUser(user) });
        }
        catch (error) {
            if (error instanceof EmailAlreadyRegisteredError) {
                return reply.code(409).send({ error: 'Email already registered' });
            }
            throw error;
        }
    });
    app.post('/v1/auth/login', async (request, reply) => {
        const parsed = loginSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: 'Bad Request', message: 'Invalid login payload' });
        }
        const user = await authenticateUser(parsed.data.email, parsed.data.password);
        if (!user) {
            await recordAuditEvent({
                actorType: 'anonymous',
                event: AUDIT_EVENTS.loginFailed,
                ip: request.ip,
                userAgent: request.headers['user-agent'] ?? null,
                // The attempted email is the whole point of this row for abuse
                // detection. It is not a secret; the password never appears.
                metadata: { email: parsed.data.email }
            });
            // Identical body for unknown-email and wrong-password. `authenticateUser`
            // burns a matching argon2 verify in the unknown case so timing matches too.
            return reply.code(401).send({ error: 'Invalid credentials' });
        }
        if (user.status !== 'active') {
            return reply.code(403).send({ error: 'Account suspended' });
        }
        await establishSession(reply, user, request.ip, request.headers['user-agent'] ?? null);
        await recordAuditEvent({
            actorType: 'user',
            actorId: user.id,
            event: AUDIT_EVENTS.login,
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null
        });
        return reply.send({ user: publicUser(user) });
    });
    app.post('/v1/auth/logout', async (request, reply) => {
        const token = request.cookies[SESSION_COOKIE];
        if (token)
            await revokeSession(token);
        reply.clearCookie(SESSION_COOKIE, { path: '/' });
        reply.clearCookie(CSRF_COOKIE, { path: '/' });
        if (request.principal?.kind === 'user') {
            await recordAuditEvent({
                actorType: 'user',
                actorId: request.principal.user.id,
                event: AUDIT_EVENTS.logout,
                ip: request.ip
            });
        }
        return reply.send({ ok: true });
    });
    app.get('/v1/auth/me', async (request, reply) => {
        const scope = requireUser(request, reply);
        if (!scope)
            return;
        const user = await findUserById(scope.userId);
        if (!user)
            return reply.code(401).send({ error: 'Unauthorized' });
        const wallets = await listAuthWallets(scope);
        return reply.send({
            user: publicUser(user),
            wallets: wallets.map((wallet) => ({
                chainKind: wallet.chainKind,
                address: wallet.address,
                verifiedAt: wallet.verifiedAt
            }))
        });
    });
    app.post('/v1/auth/wallet/nonce', async (request, reply) => {
        const parsed = nonceSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: 'Bad Request', message: 'Invalid nonce payload' });
        }
        const address = normaliseAddress(parsed.data.chainKind, parsed.data.address);
        const nonce = generateNonce();
        const issuedAt = new Date().toISOString();
        const rawOrigin = (typeof request.headers.origin === 'string' && request.headers.origin.trim().length > 0)
            ? request.headers.origin.trim()
            : null;
        let requestDomain = options.domain;
        let requestUri = options.uri;
        if (rawOrigin) {
            // Validate rawOrigin against configured allowlist or options.uri (H-04)
            const isAllowed = options.allowedOrigins && options.allowedOrigins.length > 0
                ? options.allowedOrigins.includes(rawOrigin)
                : rawOrigin === options.uri;
            if (isAllowed || !options.isProduction) {
                try {
                    const u = new URL(rawOrigin);
                    requestDomain = u.host;
                    requestUri = `${u.protocol}//${u.host}`;
                }
                catch {
                    // Fallback to options default
                }
            }
        }
        const message = buildSignInMessage({
            domain: requestDomain,
            uri: requestUri,
            address,
            nonce,
            issuedAt,
            chainKind: parsed.data.chainKind
        });
        // Bound to the address it was issued for, so a nonce minted for one wallet
        // cannot be spent proving control of another.
        await redis.set(`swat:siwe:${nonce}`, JSON.stringify({ chainKind: parsed.data.chainKind, address, domain: requestDomain, uri: requestUri }), 'EX', NONCE_TTL_SECONDS);
        return reply.send({
            nonce,
            message,
            expiresAt: new Date(Date.now() + NONCE_TTL_SECONDS * 1000).toISOString()
        });
    });
    app.post('/v1/auth/wallet/verify', async (request, reply) => {
        const parsed = verifySchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: 'Bad Request', message: 'Invalid verify payload' });
        }
        const address = normaliseAddress(parsed.data.chainKind, parsed.data.address);
        const nonceLine = parsed.data.message
            .split('\n')
            .find((line) => line.startsWith('Nonce: '));
        const nonce = nonceLine?.slice('Nonce: '.length).trim();
        if (!nonce)
            return reply.code(400).send({ error: 'Bad Request', message: 'Missing nonce' });
        // Atomic consume-and-read. GETDEL makes replay impossible: two concurrent
        // requests with the same nonce cannot both observe it, which a GET-then-DEL
        // pair would allow.
        const bound = await redis.getdel(`swat:siwe:${nonce}`);
        if (!bound)
            return reply.code(410).send({ error: 'Nonce expired or already used' });
        let boundChain = parsed.data.chainKind;
        let boundAddr = address;
        let expectedDomain = options.domain;
        let expectedUri = options.uri;
        try {
            const parsedBound = JSON.parse(bound);
            boundChain = parsedBound.chainKind;
            boundAddr = parsedBound.address;
            expectedDomain = parsedBound.domain || options.domain;
            expectedUri = parsedBound.uri || options.uri;
        }
        catch {
            // Legacy string format fallback
            if (bound !== `${parsed.data.chainKind}:${address}`) {
                return reply.code(401).send({ error: 'Invalid signature' });
            }
        }
        if (boundChain !== parsed.data.chainKind || boundAddr !== address) {
            return reply.code(401).send({ error: 'Invalid signature' });
        }
        const result = await verifySignInSignature({
            chainKind: parsed.data.chainKind,
            address,
            message: parsed.data.message,
            signature: parsed.data.signature,
            expectedNonce: nonce,
            expectedDomain,
            expectedUri
        });
        if (!result.ok) {
            await recordAuditEvent({
                actorType: 'anonymous',
                event: AUDIT_EVENTS.walletLoginFailed,
                ip: request.ip,
                metadata: { chainKind: parsed.data.chainKind, address, reason: result.reason }
            });
            return reply.code(401).send({ error: 'Invalid signature' });
        }
        // Authenticated session present → link. Otherwise → wallet-only login.
        if (request.principal?.kind === 'user') {
            const scope = forUser(request.principal.user.id);
            try {
                const wallet = await linkAuthWallet(scope, {
                    chainKind: parsed.data.chainKind,
                    address
                });
                await recordAuditEvent({
                    actorType: 'user',
                    actorId: scope.userId,
                    event: AUDIT_EVENTS.walletLinked,
                    targetType: 'auth_wallet',
                    targetId: address,
                    ip: request.ip
                });
                return reply.send({
                    wallet: {
                        chainKind: wallet.chainKind,
                        address: wallet.address,
                        verifiedAt: wallet.verifiedAt
                    }
                });
            }
            catch (error) {
                if (error instanceof WalletAlreadyLinkedError) {
                    return reply.code(409).send({ error: 'Wallet already linked to another account' });
                }
                throw error;
            }
        }
        const userId = await findUserIdByAuthWallet(parsed.data.chainKind, address);
        if (!userId) {
            // A proven signature for an unlinked wallet is not an account. Creating one
            // here would let anyone with a keypair mint accounts without an email.
            return reply.code(401).send({ error: 'Wallet not linked to any account' });
        }
        const user = await findUserById(userId);
        if (!user || user.status !== 'active') {
            return reply.code(403).send({ error: 'Account suspended' });
        }
        await establishSession(reply, user, request.ip, request.headers['user-agent'] ?? null);
        await recordAuditEvent({
            actorType: 'user',
            actorId: user.id,
            event: AUDIT_EVENTS.login,
            ip: request.ip,
            metadata: { method: 'wallet', chainKind: parsed.data.chainKind }
        });
        return reply.send({ user: publicUser(user) });
    });
}
//# sourceMappingURL=routes.js.map