'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { WakeLogo } from '../../components/WakeLogo.js';
import { ThemeToggle } from '../../components/ThemeToggle.js';
import { api, ApiError } from '../../lib/api.js';

type TierKey = 'free' | 'operator' | 'ultra' | 'lifetime';

interface TierOption {
  key: TierKey;
  name: string;
  price: string;
  period: string;
  description: string;
  badge?: string;
}

const TIER_OPTIONS: TierOption[] = [
  {
    key: 'free',
    name: 'Standard Free',
    price: '$0',
    period: 'forever',
    description: '1 master wallet slot, 5m delayed signals, manual execution',
  },
  {
    key: 'operator',
    name: 'Operator Pass',
    price: '35 USDC',
    period: '/mo',
    description: '0s real-time signals, 5 whale slots, keyless autonomous execution',
    badge: 'MOST POPULAR',
  },
  {
    key: 'ultra',
    name: 'Ultra Tier',
    price: '150 USDC',
    period: '/mo',
    description: '25 whale slots, priority fan-out queue, quant webhooks & custom chains',
  },
  {
    key: 'lifetime',
    name: 'Lifetime Pass',
    price: '1,999 USDC',
    period: 'one-time',
    description: 'Permanent Ultra access forever, priority fleet execution, zero recurring fees',
    badge: 'LIMITED',
  },
];

function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedTier = searchParams.get('tier') as TierKey | null;

  // Default to requested tier from URL, or Operator as the recommended plan
  const [selectedTier, setSelectedTier] = useState<TierKey>(() => {
    if (requestedTier && ['free', 'operator', 'ultra', 'lifetime'].includes(requestedTier)) {
      return requestedTier;
    }
    return 'operator';
  });

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const selectedTierConfig = TIER_OPTIONS.find((t) => t.key === selectedTier) || TIER_OPTIONS[1]!;

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
      // If user selected a paid tier, direct them to billing checkout; otherwise dashboard.
      if (selectedTier && selectedTier !== 'free') {
        router.push(`/billing?selected=${selectedTier}`);
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
    <div className="bg-background text-on-background min-h-screen antialiased font-sans flex items-center justify-center px-4 sm:px-6 py-12">
      <div className="w-full max-w-2xl bg-surface-container-lowest border border-border-subtle rounded-2xl p-6 sm:p-10 shadow-xl">
        <div className="flex justify-between items-start mb-6">
          <Link href="/" className="inline-block hover:opacity-85 transition-opacity">
            <WakeLogo size="md" />
          </Link>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <span className="px-2.5 py-1 rounded text-[11px] font-mono font-semibold bg-surface-container text-on-surface-variant border border-border-subtle">
              STAGE 4 // SECURE
            </span>
          </div>
        </div>

        <h1 className="font-headline-md text-2xl sm:text-3xl font-extrabold tracking-tight mb-2 text-primary">
          Create Your Trading Account
        </h1>
        <p className="text-body-sm text-on-surface-variant mb-8">
          Select your plan and set up your non-custodial copy-trading environment.
        </p>

        {/* Step 1: Select Your Tier */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <label className="text-label-caps text-on-surface-variant uppercase tracking-wider text-[11px] font-bold">
              1. Choose Access Tier
            </label>
            <span className="text-xs font-mono text-primary font-semibold">
              Selected: {selectedTierConfig.name} ({selectedTierConfig.price})
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {TIER_OPTIONS.map((tier) => {
              const isSelected = selectedTier === tier.key;
              return (
                <div
                  key={tier.key}
                  onClick={() => setSelectedTier(tier.key)}
                  className={`relative cursor-pointer rounded-xl p-4 transition-all border text-left flex flex-col justify-between ${
                    isSelected
                      ? 'border-primary bg-primary/5 ring-2 ring-primary/20 shadow-sm'
                      : 'border-border-subtle bg-surface-container/30 hover:border-border hover:bg-surface-container-low'
                  }`}
                >
                  {tier.badge && (
                    <span className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded text-[9px] font-black tracking-wider uppercase bg-primary text-white">
                      {tier.badge}
                    </span>
                  )}
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <div
                        className={`w-4 h-4 rounded-full border flex items-center justify-center transition-colors ${
                          isSelected ? 'border-primary bg-primary' : 'border-border-subtle bg-transparent'
                        }`}
                      >
                        {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                      </div>
                      <h4 className="font-bold text-sm text-primary">{tier.name}</h4>
                    </div>

                    <div className="text-lg font-black text-primary mb-1 pl-6">
                      {tier.price}{' '}
                      <span className="text-xs font-normal text-on-surface-variant opacity-70">
                        {tier.period}
                      </span>
                    </div>

                    <p className="text-xs text-on-surface-variant pl-6 leading-relaxed">
                      {tier.description}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Step 2: Account Details */}
        <form onSubmit={submit} className="flex flex-col gap-4 border-t border-border-subtle pt-6">
          <div className="mb-1">
            <span className="text-label-caps text-on-surface-variant uppercase tracking-wider text-[11px] font-bold">
              2. Account Credentials
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-label-caps text-on-surface-variant uppercase tracking-wide text-[11px] font-medium">
                Email Address
              </span>
              <input
                type="email"
                required
                autoComplete="email"
                placeholder="trader@domain.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="bg-surface-container-lowest border border-border-subtle rounded-lg px-3 py-2 text-body-md outline-none focus:border-primary text-sm"
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-label-caps text-on-surface-variant uppercase tracking-wide text-[11px] font-medium">
                Display Name (Optional)
              </span>
              <input
                type="text"
                autoComplete="name"
                placeholder="Trader Alias"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="bg-surface-container-lowest border border-border-subtle rounded-lg px-3 py-2 text-body-md outline-none focus:border-primary text-sm"
              />
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                className="bg-surface-container-lowest border border-border-subtle rounded-lg px-3 py-2 text-body-md outline-none focus:border-primary text-sm"
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
                className="bg-surface-container-lowest border border-border-subtle rounded-lg px-3 py-2 text-body-md outline-none focus:border-primary text-sm"
              />
            </label>
          </div>

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
            className="mt-4 bg-primary text-white rounded-xl px-6 py-3 text-sm font-bold shadow-lg shadow-primary/20 hover:opacity-90 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {submitting ? (
              'Creating account…'
            ) : selectedTier === 'free' ? (
              <>
                Create Free Account
                <span className="material-symbols-outlined text-base">arrow_forward</span>
              </>
            ) : (
              <>
                Proceed to {selectedTierConfig.name} Activation ({selectedTierConfig.price})
                <span className="material-symbols-outlined text-base">arrow_forward</span>
              </>
            )}
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
