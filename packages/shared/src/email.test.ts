import { describe, expect, it, vi } from 'vitest';
import {
  EMAIL_TIMEOUT_DEFAULT_MS,
  EMAIL_TIMEOUT_MAX_MS,
  EMAIL_TIMEOUT_MIN_MS,
  RESEND_DEFAULT_BASE_URL,
  isEmailConfigured,
  isEmailDelivered,
  loadEmailConfigFromEnv,
  sendEmail,
  type EmailConfig,
  type EmailMessage
} from './email.js';

const API_KEY = 're_test_deadbeefdeadbeefdeadbeef';

const config: EmailConfig = {
  apiKey: API_KEY,
  from: 'SWAT <no-reply@mail.example.com>',
  baseUrl: 'https://api.resend.test',
  timeoutMs: 10_000
};

const message: EmailMessage = {
  to: 'user@example.com',
  subject: 'Confirm your withdrawal',
  html: '<p>Confirm</p>',
  text: 'Confirm'
};

/** A fetch that resolves with a fixed provider response and records the call. */
function stubFetch(status: number, body: unknown, init: ResponseInit = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return vi.fn(async () => new Response(payload, {
    status,
    headers: { 'content-type': 'application/json' },
    ...init
  })) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
}

/** Never resolves on its own; rejects only when `sendEmail` aborts it. */
const hangingFetch = (async (_url: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted', 'AbortError'));
    });
  })) as unknown as typeof fetch;

/**
 * Headers arrive immediately with a `200`; the body then never completes.
 *
 * The stream errors on abort because that is the platform contract a real
 * `fetch` body follows — and it is observable only if the caller keeps the
 * signal armed past the headers, which is exactly the property under test.
 */
function stalledBodyFetch(): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // A prefix of valid JSON, so nothing here can be mistaken for a parse
        // error: the only thing wrong with this response is that it never ends.
        controller.enqueue(new TextEncoder().encode('{"id":'));
        init?.signal?.addEventListener('abort', () => {
          controller.error(new DOMException('The operation was aborted', 'AbortError'));
        });
      }
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as unknown as typeof fetch;
}

function callBody(fetchImpl: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const init = fetchImpl.mock.calls[0]![1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

function callHeaders(fetchImpl: { mock: { calls: unknown[][] } }): Record<string, string> {
  const init = fetchImpl.mock.calls[0]![1] as RequestInit;
  return init.headers as Record<string, string>;
}

describe('sendEmail — the delivered path', () => {
  it('reports sent only with a provider message id to prove it', async () => {
    const fetchImpl = stubFetch(200, { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' });

    const result = await sendEmail(message, config, { fetchImpl });

    expect(result).toEqual({
      status: 'sent',
      providerMessageId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794'
    });
    expect(isEmailDelivered(result)).toBe(true);
  });

  it('posts to /emails with bearer auth and a single-recipient array', async () => {
    const fetchImpl = stubFetch(200, { id: 'id-1' });

    await sendEmail({ ...message, idempotencyKey: 'withdrawal-42' }, { ...config, replyTo: 'support@example.com' }, { fetchImpl });

    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.resend.test/emails');
    expect(callHeaders(fetchImpl)).toMatchObject({
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'withdrawal-42'
    });
    expect(callBody(fetchImpl)).toEqual({
      from: 'SWAT <no-reply@mail.example.com>',
      to: ['user@example.com'],
      subject: 'Confirm your withdrawal',
      html: '<p>Confirm</p>',
      text: 'Confirm',
      reply_to: 'support@example.com'
    });
  });

  it('omits the idempotency header when no key is given', async () => {
    const fetchImpl = stubFetch(200, { id: 'id-1' });
    await sendEmail(message, config, { fetchImpl });
    expect(callHeaders(fetchImpl)['Idempotency-Key']).toBeUndefined();
  });

  it('accepts a text-only message', async () => {
    const fetchImpl = stubFetch(200, { id: 'id-1' });
    const result = await sendEmail(
      { to: message.to, subject: message.subject, text: 'Confirm' },
      config,
      { fetchImpl }
    );
    expect(result.status).toBe('sent');
    expect(callBody(fetchImpl).html).toBeUndefined();
  });
});

describe('sendEmail — definite non-delivery (not_sent)', () => {
  it('refuses to attempt a send with no API key, and puts nothing on the wire', async () => {
    // A keyless request would leak a user's address to the provider for nothing
    // and come back as an opaque 401 instead of naming the operator's mistake.
    const fetchImpl = stubFetch(200, { id: 'id-1' });

    const result = await sendEmail(message, { ...config, apiKey: '' }, { fetchImpl });

    expect(result).toMatchObject({ status: 'not_sent', reason: 'not-configured', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', ''],
    ['no domain dot', 'no-reply@localhost'],
    ['header injection', 'no-reply@example.com\r\nBcc: attacker@evil.test'],
    ['unterminated display name', 'SWAT <no-reply@example.com']
  ])('rejects a malformed sender (%s) before sending', async (_label, from) => {
    const fetchImpl = stubFetch(200, { id: 'id-1' });
    const result = await sendEmail(message, { ...config, from }, { fetchImpl });
    expect(result).toMatchObject({ status: 'not_sent', reason: 'invalid-sender' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', ''],
    ['no at sign', 'user.example.com'],
    ['display-name form', 'User <user@example.com>'],
    ['a list', 'a@example.com,b@example.com'],
    ['header injection', 'user@example.com\nBcc: attacker@evil.test']
  ])('rejects a recipient that is not one bare address (%s)', async (_label, to) => {
    // One recipient only: a list is how one user's confirmation token reaches
    // another user's inbox.
    const fetchImpl = stubFetch(200, { id: 'id-1' });
    const result = await sendEmail({ ...message, to }, config, { fetchImpl });
    expect(result).toMatchObject({ status: 'not_sent', reason: 'invalid-recipient' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a malformed reply-to', async () => {
    const result = await sendEmail(message, { ...config, replyTo: 'nope' }, {
      fetchImpl: stubFetch(200, { id: 'id-1' })
    });
    expect(result).toMatchObject({ status: 'not_sent', reason: 'invalid-sender' });
  });

  it.each([['empty', ''], ['whitespace', '   '], ['line break', 'Confirm\r\nBcc: x@y.test']])(
    'rejects a subject that is %s',
    async (_label, subject) => {
      const result = await sendEmail({ ...message, subject }, config, {
        fetchImpl: stubFetch(200, { id: 'id-1' })
      });
      expect(result).toMatchObject({ status: 'not_sent', reason: 'invalid-subject' });
    }
  );

  it('rejects a message with no body at all', async () => {
    const result = await sendEmail({ to: message.to, subject: message.subject }, config, {
      fetchImpl: stubFetch(200, { id: 'id-1' })
    });
    expect(result).toMatchObject({ status: 'not_sent', reason: 'empty-body' });
  });

  it.each([
    [400, 'validation_error'],
    [401, 'missing_api_key'],
    [403, 'invalid_api_key'],
    [422, 'invalid_from_address']
  ])('treats %i %s as definitely not sent and not retryable', async (status, name) => {
    // Resend refused before accepting, so nothing was delivered and an
    // identical retry repeats the same refusal.
    const fetchImpl = stubFetch(status, { statusCode: status, name, message: 'nope' });

    const result = await sendEmail(message, config, { fetchImpl });

    expect(result).toMatchObject({
      status: 'not_sent',
      reason: 'provider-rejected',
      httpStatus: status,
      providerCode: name,
      retryable: false
    });
  });

  it('marks a per-second rate limit retryable', async () => {
    const fetchImpl = stubFetch(429, { name: 'rate_limit_exceeded', message: 'too many' });
    const result = await sendEmail(message, config, { fetchImpl });
    expect(result).toMatchObject({ status: 'not_sent', reason: 'rate-limited', retryable: true });
  });

  it.each([['daily_quota_exceeded'], ['monthly_quota_exceeded']])(
    'marks %s not retryable — retrying now cannot clear a quota',
    async (name) => {
      const fetchImpl = stubFetch(429, { name, message: 'quota' });
      const result = await sendEmail(message, config, { fetchImpl });
      expect(result).toMatchObject({
        status: 'not_sent',
        reason: 'quota-exhausted',
        retryable: false
      });
    }
  );

  it('still classifies a 4xx whose body is not JSON', async () => {
    const fetchImpl = stubFetch(400, '<html>gateway says no</html>', {
      headers: { 'content-type': 'text/html' }
    });
    const result = await sendEmail(message, config, { fetchImpl });
    expect(result).toMatchObject({
      status: 'not_sent',
      reason: 'provider-rejected',
      providerCode: null
    });
  });
});

describe('sendEmail — the ambiguous cases (unknown)', () => {
  it('reports a timeout as unknown, not as failure', async () => {
    // The provider may already have accepted the message. Calling this a
    // failure would let a caller conclude the mailbox was never reached.
    const result = await sendEmail(message, { ...config, timeoutMs: EMAIL_TIMEOUT_MIN_MS }, {
      fetchImpl: hangingFetch
    });

    expect(result.status).toBe('unknown');
    expect(result).toMatchObject({ reason: 'timeout' });
    expect(result.status === 'unknown' && result.detail).toContain('aborted after 1000ms');
  });

  it('does not hang when a 2xx body stalls — the deadline covers the body read too', async () => {
    // Regression guard. `fetch` settles on headers, so a module that clears its
    // abort timer at that point reads the body with no deadline at all: against
    // that shape this test never finishes, it does not merely fail. A withdrawal
    // waiting on a promise that never settles is worse than one that is refused,
    // because nothing downstream ever gets a decision to act on.
    const result = await sendEmail(
      message,
      { ...config, timeoutMs: EMAIL_TIMEOUT_MIN_MS },
      { fetchImpl: stalledBodyFetch() }
    );

    // `timeout`, not `unreadable-response`: the body was never malformed, it was
    // never finished, and only the former tells an operator what to look at.
    expect(result).toMatchObject({ status: 'unknown', reason: 'timeout' });
  });

  it('reports a transport error as unknown — a lost response looks identical', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    const result = await sendEmail(message, config, { fetchImpl });

    expect(result).toMatchObject({ status: 'unknown', reason: 'network-error' });
  });

  it.each([[500], [502], [503]])('reports %i as unknown', async (status) => {
    const fetchImpl = stubFetch(status, { name: 'internal_server_error', message: 'boom' });
    const result = await sendEmail(message, config, { fetchImpl });
    expect(result).toMatchObject({
      status: 'unknown',
      reason: 'provider-unavailable',
      httpStatus: status
    });
  });

  it('reports a 409 idempotency conflict as unknown', async () => {
    // An earlier request carried this key and may have delivered.
    const fetchImpl = stubFetch(409, { name: 'concurrent_idempotent_requests', message: 'in flight' });
    const result = await sendEmail(message, config, { fetchImpl });
    expect(result).toMatchObject({ status: 'unknown', reason: 'idempotency-conflict' });
  });

  it.each([
    ['no id field', { ok: true }],
    ['an empty id', { id: '' }],
    ['a non-string id', { id: 42 }],
    ['null', null]
  ])('reports a 2xx with %s as unknown rather than sent', async (_label, body) => {
    // `sent` is the only status that carries evidence, so it cannot be returned
    // without a message id to record.
    const fetchImpl = stubFetch(200, body);
    const result = await sendEmail(message, config, { fetchImpl });
    expect(result).toMatchObject({ status: 'unknown', reason: 'unreadable-response' });
  });

  it('reports a 2xx with an unparseable body as unknown', async () => {
    const fetchImpl = stubFetch(200, 'not json at all');
    const result = await sendEmail(message, config, { fetchImpl });
    expect(result).toMatchObject({ status: 'unknown', reason: 'unreadable-response' });
  });

  it('gives an unknown result no field a caller could read as permission to retry', async () => {
    const result = await sendEmail(message, config, { fetchImpl: stubFetch(503, { message: 'x' }) });
    expect(result.status).toBe('unknown');
    expect(Object.keys(result)).not.toContain('retryable');
  });
});

describe('the fail-closed contract', () => {
  it('never resolves to sent for any failure mode, and never rejects', async () => {
    const failures: Array<typeof fetch> = [
      stubFetch(400, { name: 'validation_error' }),
      stubFetch(403, { name: 'invalid_api_key' }),
      stubFetch(429, { name: 'rate_limit_exceeded' }),
      stubFetch(409, { name: 'invalid_idempotent_request' }),
      stubFetch(500, { name: 'application_error' }),
      stubFetch(200, { missing: 'id' }),
      hangingFetch,
      vi.fn(async () => {
        throw new Error('socket hang up');
      }) as unknown as typeof fetch
    ];

    for (const fetchImpl of failures) {
      const result = await sendEmail(message, { ...config, timeoutMs: EMAIL_TIMEOUT_MIN_MS }, { fetchImpl });
      // The whole point: nothing here may be mistaken for a delivered mail.
      expect(isEmailDelivered(result)).toBe(false);
      expect(result.status === 'not_sent' || result.status === 'unknown').toBe(true);
    }
  });

  it('isEmailDelivered is true only for sent', () => {
    expect(isEmailDelivered({ status: 'sent', providerMessageId: 'id-1' })).toBe(true);
    expect(
      isEmailDelivered({
        status: 'not_sent',
        reason: 'provider-rejected',
        detail: '',
        httpStatus: 422,
        providerCode: null,
        retryable: false
      })
    ).toBe(false);
    expect(
      isEmailDelivered({
        status: 'unknown',
        reason: 'timeout',
        detail: '',
        httpStatus: null,
        providerCode: null
      })
    ).toBe(false);
  });

  it('never echoes the API key into the result', async () => {
    // Results are logged and written to audit rows. A provider error that
    // reflected the request must not carry send authority into the log.
    const fetchImpl = stubFetch(401, {
      name: 'missing_api_key',
      message: `bad credentials: Bearer ${API_KEY}`
    });

    const result = await sendEmail(message, config, { fetchImpl });

    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(result.status === 'not_sent' && result.detail).toContain('[redacted]');
  });

  it('truncates a hostile provider body instead of returning it whole', async () => {
    const fetchImpl = stubFetch(400, { name: 'validation_error', message: 'x'.repeat(5_000) });
    const result = await sendEmail(message, config, { fetchImpl });
    expect(result.status).toBe('not_sent');
    expect(result.status === 'not_sent' && result.detail.length).toBeLessThanOrEqual(210);
  });
});

describe('loadEmailConfigFromEnv', () => {
  it('reads the server-side keys', () => {
    expect(
      loadEmailConfigFromEnv({
        RESEND_API_KEY: '  re_live_abc  ',
        EMAIL_FROM: 'SWAT <no-reply@mail.example.com>',
        EMAIL_REPLY_TO: 'support@example.com',
        RESEND_API_BASE_URL: 'https://proxy.internal/resend/',
        EMAIL_SEND_TIMEOUT_MS: '7500'
      })
    ).toEqual({
      apiKey: 're_live_abc',
      from: 'SWAT <no-reply@mail.example.com>',
      replyTo: 'support@example.com',
      // Trailing slash stripped: `//emails` 404s on some proxies.
      baseUrl: 'https://proxy.internal/resend',
      timeoutMs: 7_500
    });
  });

  it('never throws on an empty environment', () => {
    // The shared barrel is imported by every service; a boot-time assertion here
    // would stop the indexer because the mail sender is unset.
    const loaded = loadEmailConfigFromEnv({});
    expect(loaded).toEqual({
      apiKey: '',
      from: '',
      replyTo: undefined,
      baseUrl: RESEND_DEFAULT_BASE_URL,
      timeoutMs: EMAIL_TIMEOUT_DEFAULT_MS
    });
    expect(isEmailConfigured(loaded)).toBe(false);
  });

  it('ignores browser-exposed variables', () => {
    // Name assembled rather than written literally: scripts/check-public-secrets.mjs
    // greps source for `NEXT_PUBLIC_*KEY` and would flag the literal even here.
    const browserExposedName = ['NEXT', 'PUBLIC', 'RESEND', 'API', 'KEY'].join('_');
    const loaded = loadEmailConfigFromEnv({
      [browserExposedName]: 're_leaked_to_the_bundle',
      EMAIL_FROM: 'no-reply@mail.example.com'
    });
    expect(loaded.apiKey).toBe('');
    expect(isEmailConfigured(loaded)).toBe(false);
  });

  it.each([
    ['unset', undefined, EMAIL_TIMEOUT_DEFAULT_MS],
    ['blank', '', EMAIL_TIMEOUT_DEFAULT_MS],
    ['not a number', 'soon', EMAIL_TIMEOUT_DEFAULT_MS],
    ['zero', '0', EMAIL_TIMEOUT_DEFAULT_MS],
    ['negative', '-5', EMAIL_TIMEOUT_DEFAULT_MS],
    ['below the floor', '10', EMAIL_TIMEOUT_MIN_MS],
    ['above the ceiling', '900000', EMAIL_TIMEOUT_MAX_MS],
    ['fractional', '2500.6', 2_501]
  ])('clamps a %s timeout', (_label, raw, expected) => {
    // An unclamped 0/NaN aborts every request instantly: all sends become
    // `unknown`, no withdrawal ever completes, and the cause is invisible.
    expect(loadEmailConfigFromEnv({ EMAIL_SEND_TIMEOUT_MS: raw }).timeoutMs).toBe(expected);
  });

  it('requires both a key and a sender to be considered configured', () => {
    expect(isEmailConfigured({ ...config, apiKey: '' })).toBe(false);
    expect(isEmailConfigured({ ...config, from: '' })).toBe(false);
    expect(isEmailConfigured(config)).toBe(true);
  });
});
