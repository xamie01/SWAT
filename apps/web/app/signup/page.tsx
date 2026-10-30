'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { WakeLogo } from '../../components/WakeLogo.js';
import { api, ApiError } from '../../lib/api.js';

function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedTier = searchParams.get('tier');

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const getTierLabel = (tier: string | null) => {
    switch (tier) {
      case 'operator':
        return 'Operator Tier ($35 USDC/mo)';
      case 'ultra':
        return 'Ultra Tier ($150 USDC/mo)';
      case 'lifetime':
        return 'Lifetime Pass ($1,999 USDC)';
      default:
        return 'Standard Free Account';
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');

    if (password.length < 8) {
      setError('Password must be at least 8 characters long.');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    if (!termsAccepted) {
      setError('You must accept the Terms of Service to continue.');
      return;
    }

    setSubmitting(true);
    try {
      await api.post('/v1/auth/signup', {
        email,
        password,
        displayName: displayName.trim() || undefined,
      });

      // Session cookies are established automatically by the API response.
      // If user selected a paid tier, direct them to billing; otherwise dashboard.
      if (requestedTier && ['operator', 'ultra', 'lifetime'].includes(requestedTier)) {
        router.push(`/billing?selected=${requestedTier}`);
      } else {
        router.push('/dashboard');
      }
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.status === 409) {
          setError('An account with this email already exists. Please sign in.');
        } else {
          setError(caught.message || 'Signup failed.');
        }
      } else {
        setError('Could not reach the server. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-background text-on-background min-h-screen antialiased font-sans flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-md">
        <Link href="/" className="inline-block mb-8 hover:opacity-85 transition-opacity">
          <WakeLogo size="md" />
        </Link>

        <h1 className="font-headline-md text-2xl font-bold tracking-tight mb-2">Create Account</h1>
        <p className="text-body-sm text-on-surface-variant mb-6">
          Set up your trading environment and access multi-chain intelligence.
        </p>

        {requestedTier && (
          <div className="mb-6 p-3 bg-surface-container rounded-lg border border-border-subtle flex items-center justify-between text-xs font-mono">
            <span className="text-on-surface-variant">Selected Tier:</span>
            <span className="font-bold text-primary">{getTierLabel(requestedTier)}</span>
          </div>
        )}

        <form onSubmit={submit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-label-caps text-on-surface-variant uppercase tracking-wide text-[11px] font-medium">
              Display Name (Optional)
            </span>
            <input
              type="text"
              autoComplete="name"
              placeholder="Operator Alias"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="bg-surface-container-lowest border border-border-subtle rounded-lg px-3 py-2 text-body-md outline-none focus:border-primary"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-label-caps text-on-surface-variant uppercase tracking-wide text-[11px] font-medium">
              Email Address
            </span>
            <input
              type="email"
              required
              autoComplete="email"
              placeholder="operator@swat.internal"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="bg-surface-container-lowest border border-border-subtle rounded-lg px-3 py-2 text-body-md outline-none focus:border-primary"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-label-caps text-on-surface-variant uppercase tracking-wide text-[11px] font-medium">
              Password (min 8 characters)
            </span>
            <input
              type="password"
              required
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="bg-surface-container-lowest border border-border-subtle rounded-lg px-3 py-2 text-body-md outline-none focus:border-primary"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-label-caps text-on-surface-variant uppercase tracking-wide text-[11px] font-medium">
              Confirm Password
            </span>
            <input
              type="password"
              required
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="bg-surface-container-lowest border border-border-subtle rounded-lg px-3 py-2 text-body-md outline-none focus:border-primary"
            />
          </label>

          <label className="flex items-start gap-2.5 mt-2 cursor-pointer">
            <input
              type="checkbox"
              checked={termsAccepted}
              onChange={(e) => setTermsAccepted(e.target.checked)}
              className="mt-1 accent-primary rounded"
            />
            <span className="text-xs text-on-surface-variant leading-relaxed">
              I agree to the Terms of Service and acknowledge that trading cryptocurrencies and prediction markets involves significant financial risk.
            </span>
          </label>

          {error && (
            <p role="alert" className="text-body-sm text-status-error font-medium mt-1">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || !email || !password || !confirmPassword || !termsAccepted}
            className="mt-4 bg-primary text-on-primary rounded-lg px-4 py-2.5 text-body-md font-semibold disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {submitting ? 'Creating account…' : 'Create Account'}
          </button>
        </form>

        <div className="mt-8 pt-6 border-t border-border-subtle text-center">
          <p className="text-body-sm text-on-surface-variant">
            Already have an account?{' '}
            <Link href="/login" className="text-primary font-semibold hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={<div className="bg-background min-h-screen" />}>
      <SignupForm />
    </Suspense>
  );
}
