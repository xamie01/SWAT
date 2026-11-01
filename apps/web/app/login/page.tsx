'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '../../lib/api.js';

function LoginForm() {
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
      const destination = next && next.startsWith('/') && !next.startsWith('//') ? next : '/workspace';
      router.push(destination);
    } catch (caught) {
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
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center font-mono text-xs">Loading sign-in...</div>}>
      <LoginForm />
    </Suspense>
  );
}
