'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '../../lib/api.js';

/**
 * Real login against POST /v1/auth/login (checklist S6-3 / S6-5 partial).
 *
 * Replaces the previous behaviour, which was that `/` simply pushed the visitor
 * to `/workspace` with no credential of any kind -- the console was open to
 * anyone who could reach the port, and every request it made carried a shared
 * key baked into the JavaScript bundle.
 *
 * The session is established entirely by cookies the API sets on the response.
 * This component never sees, stores or forwards a token, which is the point:
 * there is nowhere for a secret to leak from because the client holds none.
 */
export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await api.post('/v1/auth/login', { email, password });
      // A relative path only. `next` arrives from the query string, so treating
      // it as a URL would let a crafted link bounce a freshly-authenticated
      // operator to an attacker's host.
      const destination = next && next.startsWith('/') && !next.startsWith('//') ? next : '/workspace';
      router.push(destination);
    } catch (caught) {
      // The API returns an identical body for unknown-email and wrong-password,
      // and burns a matching argon2 verify so the timing matches too. Echoing its
      // message rather than elaborating keeps that property intact.
      setError(
        caught instanceof ApiError
          ? caught.status === 401
            ? 'Invalid email or password.'
            : caught.status === 403
              ? 'This account is suspended.'
              : caught.message
          : 'Could not reach the API.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-background text-on-background min-h-screen antialiased font-sans flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <Link href="/" className="flex items-center gap-3 mb-10 hover:opacity-80 transition-opacity">
          <span className="font-headline-md text-xl font-black tracking-tighter text-primary">WAKE</span>
        </Link>

        <h1 className="font-headline-md text-2xl font-bold tracking-tight mb-2">Sign in</h1>
        <p className="text-body-sm text-on-surface-variant mb-8">
          Operator and user accounts use the same sign-in.
        </p>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-2">
            <span className="text-label-caps text-on-surface-variant uppercase tracking-wide text-[11px] font-medium">
              Email
            </span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="bg-surface-container-lowest border border-border-subtle rounded px-3 py-2 text-body-md outline-none focus:border-primary"
            />
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-label-caps text-on-surface-variant uppercase tracking-wide text-[11px] font-medium">
              Password
            </span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="bg-surface-container-lowest border border-border-subtle rounded px-3 py-2 text-body-md outline-none focus:border-primary"
            />
          </label>

          {error ? (
            <p role="alert" className="text-body-sm text-status-error">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={submitting || !email || !password}
            className="mt-2 bg-primary text-on-primary rounded px-4 py-2 text-body-md font-medium disabled:opacity-50"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {/*
          No signup link yet, deliberately. `POST /v1/auth/signup` exists, but a
          page for it is checklist S6-5 and linking to a route that does not
          resolve is worse than not offering it. The first admin comes from
          `pnpm --filter @swat/db seed:admin`, not from this form -- signup
          creates a plain `user`, which cannot reach the operator console.
        */}
      </div>
    </div>
  );
}
