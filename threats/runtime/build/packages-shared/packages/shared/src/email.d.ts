/**
 * Transactional email via Resend's HTTP API (prerequisite for checklist S4-12,
 * `POST /v1/me/trading/withdraw`).
 *
 * **Why this module exists at all.** Withdrawal confirmation is one of the four
 * independent controls that make a full account takeover unable to exfiltrate
 * funds (stage-4 design §6.2–6.3): the attacker holds the password, the session,
 * and CSRF, but not the victim's mailbox. That control is only real if the
 * confirmation token actually reaches the mailbox, so the send result is a
 * security decision, not a log line.
 *
 * **Why a three-way result instead of a boolean.** The dangerous shape is
 * `{ ok: boolean }`, because `!ok` collapses two outcomes that demand opposite
 * responses. "Resend rejected this address" is a definite non-delivery — tell the
 * user, nothing was sent, a retry changes nothing. "The request timed out" is
 * *ambiguous* — the mail may be in the victim's inbox already. A caller that
 * cannot tell those apart will eventually treat one as the other, and the
 * failure mode that matters is treating an unconfirmed send as good enough to
 * release funds. So `sendEmail` returns `sent` | `not_sent` | `unknown`, and only
 * `sent` carries a provider message id. You cannot construct evidence of
 * delivery you do not have.
 *
 * **The fail-closed rule for callers:** proceed only on `status === 'sent'`.
 * Both other statuses mean the withdrawal stays unconfirmed and expires unused.
 * Never "the send failed, so skip confirmation". (The name of that pending state
 * is S4-12's to define — deliberately not called `pending_confirmation` here,
 * because that string already denotes an in-flight *trade submission* in
 * `robinhood.ts`, `polymarket.ts` and the Jito runtime, and reusing it for a
 * withdrawal would point a reader at the wrong domain.)
 *
 * **Why `retryable` exists only on `not_sent`.** On a definite non-delivery a
 * retry provably cannot double-send, so classifying it is useful. On `unknown` a
 * retry may deliver a second confirmation token for the same withdrawal, so
 * there is deliberately no field a caller can read to justify an automatic
 * retry loop — same reasoning as `submitJitoBundle`'s timeout branch, where the
 * executor must reconcile by status rather than resubmit. If an operator does
 * choose to re-send after an `unknown`, it must be under the *same*
 * `idempotencyKey` and as a logged decision.
 *
 * **Why raw `fetch` rather than the `resend` npm package.** Every other outbound
 * integration in this package (`jito.ts`, `jupiter.ts`, `prices.ts`,
 * `polymarket-clob-auth.ts`) is a thin `fetch` wrapper with no vendor SDK. The
 * send endpoint is one POST with three required fields; an SDK would add a
 * dependency, its own retry policy, and its own error taxonomy on top of the one
 * this module needs to expose.
 *
 * **Server-side only.** `RESEND_API_KEY` is a secret with send authority on the
 * sending domain. It must never appear under a `NEXT_PUBLIC_` name (Next.js
 * inlines those into the client bundle) and this module must only be imported by
 * backend services.
 *
 * Endpoint, headers, and error codes verified against
 * `resend.com/docs/api-reference/emails/send-email` and `.../errors`.
 */
export declare const RESEND_DEFAULT_BASE_URL = "https://api.resend.com";
/** Bounds on `EMAIL_SEND_TIMEOUT_MS`. See `loadEmailConfigFromEnv`. */
export declare const EMAIL_TIMEOUT_MIN_MS = 1000;
export declare const EMAIL_TIMEOUT_MAX_MS = 60000;
export declare const EMAIL_TIMEOUT_DEFAULT_MS = 10000;
export interface EmailConfig {
    /** Resend API key. Secret; never logged, never sent anywhere but Resend. */
    readonly apiKey: string;
    /** Sender, either `user@domain` or `Name <user@domain>`. Domain must be verified. */
    readonly from: string;
    readonly replyTo?: string;
    /** Base URL, no trailing slash. Configurable so tests and proxies can redirect it. */
    readonly baseUrl: string;
    readonly timeoutMs: number;
}
export interface EmailMessage {
    /**
     * Exactly one recipient. Not a list: every current caller sends a
     * per-user security email, and a list is how one user's confirmation token
     * ends up in another user's inbox.
     */
    readonly to: string;
    readonly subject: string;
    readonly html?: string;
    readonly text?: string;
    /**
     * Optional `Idempotency-Key`. Resend holds it for 24h and collapses repeats,
     * which is the only thing that makes a deliberate re-send after `unknown`
     * safe. Use a value derived from the withdrawal id, not a random one.
     */
    readonly idempotencyKey?: string;
}
/** Definite non-delivery. Nothing was handed to the provider, or it refused. */
export type EmailNotSentReason = 
/** No API key or no sender configured — an operator problem, not a user one. */
'not-configured' | 'invalid-sender' | 'invalid-recipient' | 'invalid-subject'
/** Neither `html` nor `text` supplied; Resend would reject it anyway. */
 | 'empty-body'
/** Resend refused: unverified domain, bad key, malformed field. */
 | 'provider-rejected'
/** 429 `rate_limit_exceeded` — refused before acceptance, worth retrying. */
 | 'rate-limited'
/** 429 `daily_quota_exceeded` / `monthly_quota_exceeded` — retrying now cannot help. */
 | 'quota-exhausted';
/** Delivery could not be established either way. Treat as not delivered. */
export type EmailUnknownReason = 
/** The request was aborted at `timeoutMs`; the provider may still have accepted it. */
'timeout'
/** Transport failure. Indistinguishable from a lost response, so not a definite failure. */
 | 'network-error'
/** 5xx: the send may have been accepted before the error surfaced. */
 | 'provider-unavailable'
/** 409: another request used this idempotency key, and that one may have delivered. */
 | 'idempotency-conflict'
/** 2xx with no usable message id — accepted, but with no evidence to record. */
 | 'unreadable-response';
/**
 * The send contract. Three states, because "I could not confirm this was sent"
 * must not be expressible as either success or clear failure.
 */
export type EmailSendResult = {
    readonly status: 'sent';
    /**
     * Resend's message id. Present only here, and only when the provider
     * returned it — this is the value an audit row can point at.
     */
    readonly providerMessageId: string;
} | {
    readonly status: 'not_sent';
    readonly reason: EmailNotSentReason;
    /** Human-readable context, truncated. May contain the recipient address. */
    readonly detail: string;
    readonly httpStatus: number | null;
    /** Resend's error name, e.g. `invalid_from_address`, when it gave one. */
    readonly providerCode: string | null;
    /** Safe to retry: nothing was sent, so a retry cannot duplicate delivery. */
    readonly retryable: boolean;
} | {
    readonly status: 'unknown';
    readonly reason: EmailUnknownReason;
    readonly detail: string;
    readonly httpStatus: number | null;
    readonly providerCode: string | null;
};
/**
 * The one predicate a security-critical caller should branch on.
 *
 * Written as a type guard so the withdrawal path reads
 * `if (!isEmailDelivered(result)) return refuse(...)` and cannot accidentally
 * fall through on `unknown`.
 */
export declare function isEmailDelivered(result: EmailSendResult): result is Extract<EmailSendResult, {
    status: 'sent';
}>;
/**
 * Reads config from the environment. Never throws.
 *
 * Not throwing is deliberate: `packages/shared`'s barrel re-exports this module
 * into every service, so a top-level environment assertion here would stop the
 * indexer booting because the mail sender is unset. A missing key surfaces at
 * send time as `not_sent` / `not-configured` instead — and `isEmailConfigured`
 * exists so a service that *does* need mail can say so at boot rather than
 * discovering it during a user's withdrawal.
 *
 * Reads only server-side names. Nothing `NEXT_PUBLIC_*` is consulted, by design.
 */
export declare function loadEmailConfigFromEnv(env?: Record<string, string | undefined>): EmailConfig;
/**
 * Whether a send could even be attempted. For boot-time checks and health
 * endpoints — not a delivery guarantee.
 */
export declare function isEmailConfigured(config: EmailConfig): boolean;
export interface SendEmailDeps {
    /**
     * Injected so tests exercise the real abort wiring without touching globals or
     * the network. Defaults to the platform `fetch`.
     */
    readonly fetchImpl?: typeof fetch;
}
/**
 * Sends one transactional email.
 *
 * Never throws and never rejects — every transport and provider failure is
 * mapped onto the result union. A caller that forgot a `try/catch` therefore
 * cannot end up in an enclosing handler that treats the exception as "carry on";
 * the only way past this function is to read `status`.
 */
export declare function sendEmail(message: EmailMessage, config: EmailConfig, deps?: SendEmailDeps): Promise<EmailSendResult>;
//# sourceMappingURL=email.d.ts.map