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

/**
 * Runs a request **and the caller's body read** under one deadline.
 *
 * Local rather than shared, for the same reason `jito.ts` keeps its own: the
 * other variants in this package already differ in signature, and unifying them
 * is a refactor of working call sites that this module does not need.
 *
 * The reason this takes a callback rather than returning a `Response` — which is
 * the shape `jito.ts` and `prices.ts` use — is that `fetch` settles when the
 * *headers* arrive, so clearing the abort timer at that point leaves the body
 * read unbounded. A provider that returns `200` and then stalls the body would
 * hang this module forever. That is worse than any failure it could report: the
 * three-way result exists so a caller can decide, and a promise that never
 * settles gives it nothing to decide on. Keeping the signal armed across the
 * body read turns that case into an ordinary `AbortError`, which maps to
 * `unknown` — the honest answer for a send whose outcome we never observed.
 */
async function withDeadline<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export const RESEND_DEFAULT_BASE_URL = 'https://api.resend.com';

/** Bounds on `EMAIL_SEND_TIMEOUT_MS`. See `loadEmailConfigFromEnv`. */
export const EMAIL_TIMEOUT_MIN_MS = 1_000;
export const EMAIL_TIMEOUT_MAX_MS = 60_000;
export const EMAIL_TIMEOUT_DEFAULT_MS = 10_000;

/** Provider error text is truncated to this many characters before it is returned. */
const DETAIL_MAX_LENGTH = 200;

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
  | 'not-configured'
  | 'invalid-sender'
  | 'invalid-recipient'
  | 'invalid-subject'
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
  | 'timeout'
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
export type EmailSendResult =
  | {
      readonly status: 'sent';
      /**
       * Resend's message id. Present only here, and only when the provider
       * returned it — this is the value an audit row can point at.
       */
      readonly providerMessageId: string;
    }
  | {
      readonly status: 'not_sent';
      readonly reason: EmailNotSentReason;
      /** Human-readable context, truncated. May contain the recipient address. */
      readonly detail: string;
      readonly httpStatus: number | null;
      /** Resend's error name, e.g. `invalid_from_address`, when it gave one. */
      readonly providerCode: string | null;
      /** Safe to retry: nothing was sent, so a retry cannot duplicate delivery. */
      readonly retryable: boolean;
    }
  | {
      readonly status: 'unknown';
      readonly reason: EmailUnknownReason;
      readonly detail: string;
      readonly httpStatus: number | null;
      readonly providerCode: string | null;
      // Deliberately no `retryable`. See the module header: there is no field
      // here for a caller to read as permission to loop.
    };

/**
 * The one predicate a security-critical caller should branch on.
 *
 * Written as a type guard so the withdrawal path reads
 * `if (!isEmailDelivered(result)) return refuse(...)` and cannot accidentally
 * fall through on `unknown`.
 */
export function isEmailDelivered(
  result: EmailSendResult
): result is Extract<EmailSendResult, { status: 'sent' }> {
  return result.status === 'sent';
}

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
export function loadEmailConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): EmailConfig {
  const rawBase = (env.RESEND_API_BASE_URL ?? '').trim() || RESEND_DEFAULT_BASE_URL;
  return {
    apiKey: (env.RESEND_API_KEY ?? '').trim(),
    from: (env.EMAIL_FROM ?? '').trim(),
    replyTo: (env.EMAIL_REPLY_TO ?? '').trim() || undefined,
    // A trailing slash would produce `//emails`, which some proxies 404 on.
    baseUrl: rawBase.replace(/\/+$/, ''),
    timeoutMs: clampTimeout(env.EMAIL_SEND_TIMEOUT_MS)
  };
}

/**
 * Clamps the send timeout.
 *
 * An unclamped `0` or `NaN` (a blank or fat-fingered env value) would abort every
 * request instantly, turning all sends into `unknown` — which fails closed, so no
 * withdrawal would ever complete and the cause would be invisible.
 */
function clampTimeout(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return EMAIL_TIMEOUT_DEFAULT_MS;
  return Math.min(Math.max(Math.round(parsed), EMAIL_TIMEOUT_MIN_MS), EMAIL_TIMEOUT_MAX_MS);
}

/**
 * Whether a send could even be attempted. For boot-time checks and health
 * endpoints — not a delivery guarantee.
 */
export function isEmailConfigured(config: EmailConfig): boolean {
  return config.apiKey.length > 0 && config.from.length > 0;
}

/**
 * A bare address, no display name and no list.
 *
 * `\r` and `\n` are rejected everywhere they could reach a header: the JSON body
 * makes classic SMTP header injection unlikely, but `headers`/`subject` do flow
 * into the outbound message and a newline there is never legitimate.
 */
function isPlainAddress(value: string): boolean {
  if (value.length === 0 || value.length > 320) return false;
  if (/[\r\n,;<>\s]/.test(value)) return false;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(value);
}

/** Accepts `user@domain` or `Name <user@domain>`, which Resend needs for a friendly from. */
function isSenderAddress(value: string): boolean {
  if (/[\r\n]/.test(value)) return false;
  const angled = /<([^<>]+)>\s*$/.exec(value);
  return isPlainAddress(angled ? angled[1]!.trim() : value);
}

function notSent(
  reason: EmailNotSentReason,
  detail: string,
  retryable: boolean,
  httpStatus: number | null = null,
  providerCode: string | null = null
): EmailSendResult {
  return { status: 'not_sent', reason, detail: truncate(detail), httpStatus, providerCode, retryable };
}

function unknown(
  reason: EmailUnknownReason,
  detail: string,
  httpStatus: number | null = null,
  providerCode: string | null = null
): EmailSendResult {
  return { status: 'unknown', reason, detail: truncate(detail), httpStatus, providerCode };
}

function truncate(detail: string): string {
  return detail.length > DETAIL_MAX_LENGTH ? `${detail.slice(0, DETAIL_MAX_LENGTH)}…` : detail;
}

/**
 * Strips the API key out of any provider- or transport-supplied text.
 *
 * Not theoretical: a 401 body can quote the credentials it rejected, and a
 * misconfigured proxy in front of the API can echo the request. `detail` is
 * meant to be logged and attached to `custody.withdraw_*` audit rows, so
 * without this a live sending credential ends up in permanent storage — the one
 * place a rotation cannot reach.
 */
function redactApiKey(text: string, apiKey: string): string {
  if (apiKey.length === 0) return text;
  // split/join rather than a regex: an API key needs no escaping this way.
  return text.split(apiKey).join('[redacted]');
}

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
export async function sendEmail(
  message: EmailMessage,
  config: EmailConfig,
  deps: SendEmailDeps = {}
): Promise<EmailSendResult> {
  // Validate before any request. A send attempted without a key would put a
  // recipient address on the wire for nothing, and the outcome would come back
  // as an opaque 401 instead of naming the operator's actual mistake.
  if (config.apiKey.length === 0) {
    return notSent('not-configured', 'RESEND_API_KEY is not set', false);
  }
  if (!isSenderAddress(config.from)) {
    return notSent('invalid-sender', `EMAIL_FROM is missing or malformed: "${config.from}"`, false);
  }
  if (config.replyTo !== undefined && !isPlainAddress(config.replyTo)) {
    return notSent('invalid-sender', `EMAIL_REPLY_TO is malformed: "${config.replyTo}"`, false);
  }
  if (!isPlainAddress(message.to)) {
    return notSent('invalid-recipient', `recipient is not a single valid address: "${message.to}"`, false);
  }
  const subject = message.subject.trim();
  if (subject.length === 0 || /[\r\n]/.test(message.subject)) {
    return notSent('invalid-subject', 'subject is empty or contains a line break', false);
  }
  if (!message.html && !message.text) {
    return notSent('empty-body', 'neither html nor text was supplied', false);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`
  };
  if (message.idempotencyKey) headers['Idempotency-Key'] = message.idempotencyKey;

  const body: Record<string, unknown> = {
    from: config.from,
    to: [message.to],
    subject
  };
  if (message.html) body.html = message.html;
  if (message.text) body.text = message.text;
  if (config.replyTo) body.reply_to = config.replyTo;

  // The whole exchange — request, error body, success body — runs inside one
  // deadline. See `withDeadline`: settling on headers alone would leave the body
  // read unbounded.
  try {
    return await withDeadline(config.timeoutMs, async (signal): Promise<EmailSendResult> => {
      const response = await (deps.fetchImpl ?? fetch)(`${config.baseUrl}/emails`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal
      });

      if (!response.ok) {
        // The body names the failure far more precisely than the status does
        // (`invalid_from_address` vs a bare 422), and a 429 is two different
        // outcomes depending on it. Read it, but never let a parse failure here
        // decide the classification — the status alone is enough to place the
        // result on the right side of the delivered/not-delivered line, so a
        // body that stalls or is unreadable costs detail, not correctness.
        const { code, snippet } = await readProviderError(response, config.apiKey);
        return classifyErrorStatus(response.status, code, snippet);
      }

      // A 2xx without a parseable id means the message was probably accepted but
      // we have nothing to record. `sent` requires evidence, so this is `unknown`.
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        // An abort here is a stalled body, not a malformed one. Rethrow so the
        // outer handler reports `timeout` and the reason names the real cause;
        // both are `unknown`, but only one is actionable by an operator.
        if (signal.aborted) throw error;
        return unknown(
          'unreadable-response',
          'provider returned 2xx with an unparseable body',
          response.status
        );
      }
      const id = (payload as { id?: unknown } | null)?.id;
      if (typeof id !== 'string' || id.length === 0) {
        return unknown(
          'unreadable-response',
          'provider returned 2xx with no message id',
          response.status
        );
      }
      return { status: 'sent', providerMessageId: id };
    });
  } catch (error) {
    // Both branches are genuinely ambiguous. An abort at `timeoutMs` says
    // nothing about whether Resend accepted the message before we stopped
    // listening, and a transport error is indistinguishable from a response
    // lost on the way back. Reporting either as a definite failure would let a
    // caller conclude the mailbox was never reached and act on that.
    const name = error instanceof Error ? error.name : '';
    const detail = redactApiKey(
      error instanceof Error ? error.message : 'transport failure',
      config.apiKey
    );
    return name === 'AbortError' || name === 'TimeoutError'
      ? unknown('timeout', `aborted after ${config.timeoutMs}ms: ${detail}`)
      : unknown('network-error', detail);
  }
}

/** Reads Resend's `{ name, message, statusCode }` error body without ever throwing. */
async function readProviderError(
  response: Response,
  apiKey: string
): Promise<{ code: string | null; snippet: string }> {
  const raw = redactApiKey(await response.text().catch(() => ''), apiKey);
  try {
    const parsed = JSON.parse(raw) as { name?: unknown; message?: unknown; error?: unknown };
    const code = typeof parsed.name === 'string' ? parsed.name : null;
    const messageText =
      typeof parsed.message === 'string'
        ? parsed.message
        : typeof parsed.error === 'string'
          ? parsed.error
          : raw;
    return { code, snippet: messageText };
  } catch {
    return { code: null, snippet: raw };
  }
}

/**
 * Maps an HTTP status onto the union.
 *
 * The split is by *what the caller can conclude*, not by 4xx/5xx. A 4xx means
 * Resend refused the message before accepting it, so nothing was delivered. A
 * 5xx or a 409 leaves open that a message went out, which is the one thing a
 * confirmation flow must not assume away in either direction.
 */
function classifyErrorStatus(
  status: number,
  code: string | null,
  snippet: string
): EmailSendResult {
  const detail = `http-${status}${code ? ` ${code}` : ''}: ${snippet}`;

  if (status === 429) {
    // Both are 429, and the right response differs: a per-second rate limit
    // clears in a moment, an exhausted daily quota does not clear today.
    const quota = code === 'daily_quota_exceeded' || code === 'monthly_quota_exceeded';
    return quota
      ? notSent('quota-exhausted', detail, false, status, code)
      : notSent('rate-limited', detail, true, status, code);
  }
  if (status === 409) {
    // `invalid_idempotent_request` / `concurrent_idempotent_requests`: an
    // earlier request carried this key and may have delivered. We cannot tell.
    return unknown('idempotency-conflict', detail, status, code);
  }
  if (status >= 500) {
    return unknown('provider-unavailable', detail, status, code);
  }
  // Everything else 4xx: unverified domain, bad key, malformed field, unknown
  // route. All operator or payload errors that an identical retry repeats.
  return notSent('provider-rejected', detail, false, status, code);
}
