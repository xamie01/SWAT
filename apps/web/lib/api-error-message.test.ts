import { describe, expect, it } from 'vitest';
import { ApiError } from './api.js';
import {
  describeApiError,
  CSRF_MESSAGE,
  FORBIDDEN_MESSAGE,
  SESSION_EXPIRED_MESSAGE
} from './api-error-message.js';

describe('describeApiError', () => {
  it('tells a 401 to sign in again rather than repeating the operation name', () => {
    expect(describeApiError(new ApiError(401, 'Not signed in'), 'Failed to fetch clusters'))
      .toBe(SESSION_EXPIRED_MESSAGE);
  });

  it('does not invite a re-login on 403', () => {
    expect(describeApiError(new ApiError(403, 'Forbidden'), 'Failed to fetch clusters'))
      .toBe(FORBIDDEN_MESSAGE);
    expect(describeApiError(new ApiError(403, 'Forbidden'), 'x')).not.toContain('sign in');
  });

  it('keeps the status on any other ApiError so a 500 is not mistaken for a 400', () => {
    expect(describeApiError(new ApiError(500, 'boom'), 'Failed to save configuration'))
      .toBe('Failed to save configuration (HTTP 500: boom)');
  });

  it('keeps the fallback in front of an opaque network error', () => {
    expect(describeApiError(new TypeError('Failed to fetch'), 'Failed to fetch wallets'))
      .toBe('Failed to fetch wallets (Failed to fetch)');
  });

  it('falls back cleanly on a thrown non-Error', () => {
    expect(describeApiError('nope', 'Failed to fetch wallets')).toBe('Failed to fetch wallets');
    expect(describeApiError(new Error(''), 'Failed to fetch wallets')).toBe('Failed to fetch wallets');
  });
});

describe('describeApiError — CSRF vs role, both 403', () => {
  it('distinguishes a stale CSRF token from a role refusal', () => {
    // Both are 403. Without the split, a stale swat_csrf cookie reads as "you
    // lack permission" and sends the operator hunting a role problem that does
    // not exist -- on a surface they are actually allowed to use.
    const csrf = new ApiError(403, 'Invalid CSRF token', { error: 'Invalid CSRF token', code: 'csrf_invalid' });
    expect(describeApiError(csrf, 'x')).toBe(CSRF_MESSAGE);
    expect(describeApiError(csrf, 'x')).not.toBe(FORBIDDEN_MESSAGE);
  });

  it('still reports a role refusal as a role refusal', () => {
    const forbidden = new ApiError(403, 'Forbidden', { error: 'Forbidden' });
    expect(describeApiError(forbidden, 'x')).toBe(FORBIDDEN_MESSAGE);
  });

  it('matches the API code, not its prose, so rewording cannot re-break it', () => {
    // The message here is deliberately nothing like the real one.
    const reworded = new ApiError(403, 'nope', { code: 'csrf_invalid' });
    expect(describeApiError(reworded, 'x')).toBe(CSRF_MESSAGE);
  });

  it('falls back to the role message when the body is absent or not an object', () => {
    expect(describeApiError(new ApiError(403, 'Forbidden'), 'x')).toBe(FORBIDDEN_MESSAGE);
    expect(describeApiError(new ApiError(403, 'Forbidden', 'plain text'), 'x')).toBe(FORBIDDEN_MESSAGE);
  });
});
