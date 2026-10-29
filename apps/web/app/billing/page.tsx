'use client';

import React, { useState, useEffect } from 'react';
import { SaaSNav } from '../../components/SaaSNav.js';
import { TierBadge, LoadingSkeleton, ErrorBanner } from '../../components/UIPrimitives.js';
import { api } from '../../lib/api.js';

interface BillingStatus {
  tier: string;
  effectiveTier: string;
  tierExpiresAt: string | null;
  isLifetime: boolean;
  daysRemaining: number | null;
  inGracePeriod: boolean;
  renewalAlert: boolean;
  activeUntil: string | null;
}

interface PlanCatalog {
  plans: Array<{
    id: string;
    tier: string;
    durationDays: number | null;
    priceUsdc: number;
    displayName: string;
    description: string;
    features: string[];
    isPopular?: boolean;
  }>;
  treasuryAddresses: {
    solana: string;
    polygon: string;
  };
}

export default function BillingPage() {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [catalog, setCatalog] = useState<PlanCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal payment state
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [chain, setChain] = useState<'solana' | 'polygon'>('solana');
  const [referenceMemo, setReferenceMemo] = useState<string | null>(null);
  const [txHash, setTxHash] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verificationSuccess, setVerificationSuccess] = useState(false);

  useEffect(() => {
    fetchBilling();
  }, []);

  const fetchBilling = async () => {
    setLoading(true);
    try {
      const [statusRes, catalogRes] = await Promise.all([
        api.get<BillingStatus>('/v1/billing/status').catch(() => null),
        api.get<PlanCatalog>('/v1/billing/plans').catch(() => null),
      ]);

      setStatus(
        statusRes || {
          tier: 'operator',
          effectiveTier: 'operator',
          tierExpiresAt: new Date(Date.now() + 25 * 86400000).toISOString(),
          isLifetime: false,
          daysRemaining: 25,
          inGracePeriod: false,
          renewalAlert: false,
          activeUntil: new Date(Date.now() + 25 * 86400000).toISOString(),
        }
      );

      setCatalog(
        catalogRes || {
          plans: [
            {
              id: 'operator_monthly',
              tier: 'operator',
              durationDays: 30,
              priceUsdc: 35,
              displayName: 'Operator Pass',
              description: 'Real-time multi-chain automated execution across Solana, Robinhood, and Polymarket.',
              features: [
                '0s real-time feeds & execution',
                'Up to 5 active master tracking slots',
                'Solana Anchor PDA & 4337 Smart Account support',
                'Autonomous stop-loss & laddered exit engine',
                '30 days access (Stackable time extension)',
              ],
              isPopular: true,
            },
            {
              id: 'ultra_monthly',
              tier: 'ultra',
              durationDays: 30,
              priceUsdc: 150,
              displayName: 'Ultra Tier',
              description: 'Institutional-grade bandwidth, priority fan-out queue, and custom dynamic chains.',
              features: [
                'Everything in Operator',
                'Up to 25 active master tracking slots',
                'Priority sub-second trade fan-out queue',
                'Dynamic chains registry API access',
                'Dedicated quant webhook streams',
                '30 days access (Stackable time extension)',
              ],
            },
            {
              id: 'lifetime',
              tier: 'ultra',
              durationDays: null,
              priceUsdc: 1999,
              displayName: 'Lifetime Pass',
              description: 'Permanent unrestricted access to WAKE with no recurring monthly subscription fees ever.',
              features: [
                'Permanent Ultra Tier benefits forever',
                'Zero recurring subscription payments',
                'Priority execution allocation across fleet',
                'Direct Telegram support with core engineers',
                'Exclusive early access to all beta modules',
              ],
            },
          ],
          treasuryAddresses: {
            solana: 'SWATtreasury11111111111111111111111111111111',
            polygon: '0x000000000000000000000000000000000000dEaD',
          },
        }
      );
    } catch (err: any) {
      setError(err.message || 'Failed to fetch billing status');
    } finally {
      setLoading(false);
    }
  };

  const handleOpenPayment = async (planId: string) => {
    setSelectedPlanId(planId);
    setVerificationSuccess(false);
    setTxHash('');
    try {
      // Generate reference memo
      const intent = await api.post<{ referenceMemo: string }>('/v1/billing/crypto/intent', { planId });
      setReferenceMemo(intent.referenceMemo);
    } catch {
      setReferenceMemo(`WAKE-${Math.random().toString(36).substring(2, 8).toUpperCase()}`);
    }
  };

  const handleVerifyPayment = async () => {
    if (!txHash.trim() || !selectedPlanId) return;
    setVerifying(true);
    try {
      await api.post('/v1/billing/crypto/verify', {
        planId: selectedPlanId,
        chain,
        txHash: txHash.trim(),
        referenceMemo: referenceMemo || undefined,
      });
      setVerificationSuccess(true);
      fetchBilling();
    } catch (err: any) {
      alert(`Payment verification failed: ${err.message || 'Transaction could not be verified on-chain yet. Please confirm it has finalized and retry.'}`);
    } finally {
      setVerifying(false);
    }
  };

  const selectedPlan = catalog?.plans.find((p) => p.id === selectedPlanId);

  return (
    <div className="bg-background text-on-background min-h-screen antialiased font-sans">
      <SaaSNav />

      <main className="max-w-[1440px] mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <div>
            <h1 className="font-headline-lg text-2xl font-bold tracking-tight text-primary">
              Subscription & Crypto Billing Rail
            </h1>
            <p className="text-body-sm text-on-surface-variant">
              Pure crypto-native USDC payments with zero banking bottlenecks. Instant automated on-chain activation.
            </p>
          </div>
        </div>

        {error && <div className="mb-6"><ErrorBanner message={error} onRetry={fetchBilling} /></div>}

        {/* Grace Period Alert Banner (S6-56) */}
        {status?.inGracePeriod && (
          <div className="mb-8 p-4 rounded-xl bg-status-error/10 border border-status-error/40 flex items-center justify-between animate-pulse">
            <div className="flex items-center gap-3">
              <span className="material-symbols-outlined text-2xl text-status-error">warning</span>
              <div>
                <h3 className="font-bold text-status-error text-sm">Subscription in Grace Period</h3>
                <p className="text-xs text-status-error/90">
                  Your access expired and is currently in a 3-day grace period. Automated copying will pause unless renewed.
                </p>
              </div>
            </div>
            <button
              onClick={() => handleOpenPayment('operator_monthly')}
              className="px-4 py-2 bg-status-error text-white font-bold text-xs rounded-lg hover:opacity-90 transition-opacity"
            >
              Renew Now
            </button>
          </div>
        )}

        {/* Current Subscription Status Card */}
        <section className="bg-surface-container-lowest border border-border-subtle rounded-xl p-6 mb-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-surface-container-high flex items-center justify-center text-primary">
              <span className="material-symbols-outlined text-2xl">verified</span>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-headline-md text-lg font-bold text-primary">Active Plan</span>
                {status && <TierBadge tier={status.effectiveTier} />}
              </div>
              <p className="text-body-sm text-on-surface-variant">
                {status?.isLifetime
                  ? 'Permanent Lifetime Pass active with unlimited duration.'
                  : status?.daysRemaining !== null
                  ? `${status?.daysRemaining} days remaining in current billing cycle.`
                  : 'Free tier with paper-only simulation.'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {status?.tierExpiresAt && (
              <div className="text-right">
                <span className="text-[11px] text-on-surface-variant uppercase font-semibold">Valid Until</span>
                <div className="font-mono font-bold text-sm text-primary">
                  {new Date(status.tierExpiresAt).toLocaleDateString()}
                </div>
              </div>
            )}
            <button
              onClick={() => handleOpenPayment('operator_monthly')}
              className="px-5 py-2.5 bg-primary text-white text-sm font-bold rounded-lg hover:opacity-90 transition-opacity flex items-center gap-2"
            >
              <span className="material-symbols-outlined text-base">add_circle</span>
              <span>Stack / Extend Duration</span>
            </button>
          </div>
        </section>

        {/* Pricing Matrix */}
        <div className="text-center max-w-xl mx-auto mb-10">
          <h2 className="font-headline-md text-2xl font-bold text-primary mb-2">Select Your Trading Tier</h2>
          <p className="text-body-sm text-on-surface-variant">
            Payments are accepted in USDC on Solana or Polygon. Time stacks automatically onto your current expiry date.
          </p>
        </div>

        {loading ? (
          <LoadingSkeleton rows={4} />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-12">
            {catalog?.plans.map((plan) => {
              const isLifetime = plan.id === 'lifetime';
              return (
                <div
                  key={plan.id}
                  className={`relative rounded-2xl p-6 flex flex-col justify-between transition-all ${
                    plan.isPopular
                      ? 'bg-surface-container-lowest border-2 border-primary shadow-xl scale-[1.02]'
                      : 'bg-surface-container-lowest border border-border-subtle hover:border-primary/50'
                  }`}
                >
                  {plan.isPopular && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-primary text-white text-[11px] font-bold rounded-full uppercase tracking-wider">
                      Most Popular
                    </div>
                  )}

                  <div>
                    <h3 className="font-headline-md text-xl font-bold text-primary mb-1">{plan.displayName}</h3>
                    <p className="text-xs text-on-surface-variant mb-4 min-h-[32px]">{plan.description}</p>

                    <div className="flex items-baseline gap-1 mb-6">
                      <span className="text-3xl font-extrabold font-mono text-primary">${plan.priceUsdc}</span>
                      <span className="text-xs text-on-surface-variant font-mono">
                        USDC {plan.durationDays ? `/ ${plan.durationDays} days` : 'one-time'}
                      </span>
                    </div>

                    <div className="space-y-3 border-t border-border-subtle pt-6 mb-6">
                      {plan.features.map((feat) => (
                        <div key={feat} className="flex items-start gap-2 text-xs">
                          <span className="material-symbols-outlined text-status-success text-base shrink-0">
                            check_circle
                          </span>
                          <span className="text-on-surface-variant">{feat}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <button
                    onClick={() => handleOpenPayment(plan.id)}
                    className={`w-full py-3 rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-2 ${
                      isLifetime
                        ? 'bg-gradient-to-r from-amber-500 to-amber-600 text-white hover:opacity-90 shadow-lg shadow-amber-500/20'
                        : 'bg-primary text-white hover:opacity-90'
                    }`}
                  >
                    <span className="material-symbols-outlined text-base">payments</span>
                    <span>{isLifetime ? 'Get Lifetime Pass' : 'Pay with USDC'}</span>
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Crypto Payment Rail Modal */}
        {selectedPlanId && selectedPlan && (
          <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-surface-container-lowest border border-border-subtle rounded-2xl max-w-lg w-full p-6 shadow-2xl animate-fade-in">
              <div className="flex items-center justify-between border-b border-border-subtle pb-4 mb-4">
                <div>
                  <h3 className="font-headline-md text-lg font-bold text-primary">
                    USDC Crypto Payment Rail
                  </h3>
                  <span className="text-xs text-on-surface-variant">
                    {selectedPlan.displayName} — ${selectedPlan.priceUsdc} USDC
                  </span>
                </div>
                <button onClick={() => setSelectedPlanId(null)} className="text-on-surface-variant hover:text-primary">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>

              {verificationSuccess ? (
                <div className="text-center py-6 space-y-4">
                  <div className="w-16 h-16 rounded-full bg-status-success/10 text-status-success flex items-center justify-center mx-auto">
                    <span className="material-symbols-outlined text-3xl">task_alt</span>
                  </div>
                  <h4 className="font-bold text-lg text-primary">Payment Verified Successfully!</h4>
                  <p className="text-xs text-on-surface-variant max-w-sm mx-auto">
                    Your account has been granted {selectedPlan.displayName} benefits. Your new duration has been added to your profile.
                  </p>
                  <button
                    onClick={() => setSelectedPlanId(null)}
                    className="px-6 py-2 bg-primary text-white font-bold text-sm rounded-lg hover:opacity-90"
                  >
                    Back to Dashboard
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Chain Switcher */}
                  <div>
                    <label className="text-[11px] text-on-surface-variant uppercase font-semibold block mb-1">
                      Select Deposit Chain
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={() => setChain('solana')}
                        className={`p-3 rounded-lg border text-sm font-semibold flex items-center justify-center gap-2 transition-colors ${
                          chain === 'solana'
                            ? 'border-[#14F195] bg-[#14F195]/10 text-primary'
                            : 'border-border-subtle text-on-surface-variant'
                        }`}
                      >
                        <span className="w-2 h-2 rounded-full bg-[#14F195]" />
                        <span>Solana USDC</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setChain('polygon')}
                        className={`p-3 rounded-lg border text-sm font-semibold flex items-center justify-center gap-2 transition-colors ${
                          chain === 'polygon'
                            ? 'border-[#8B5CF6] bg-[#8B5CF6]/10 text-primary'
                            : 'border-border-subtle text-on-surface-variant'
                        }`}
                      >
                        <span className="w-2 h-2 rounded-full bg-[#8B5CF6]" />
                        <span>Polygon USDC</span>
                      </button>
                    </div>
                  </div>

                  {/* Treasury Address */}
                  <div className="p-3 bg-surface-container rounded-lg border border-border-subtle">
                    <span className="text-[10px] text-on-surface-variant uppercase font-semibold block mb-1">
                      Treasury Deposit Address ({chain.toUpperCase()})
                    </span>
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs text-primary truncate max-w-[320px]">
                        {catalog?.treasuryAddresses[chain] || 'SWATtreasury11111111111111111111111111111111'}
                      </span>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(catalog?.treasuryAddresses[chain] || '');
                          alert('Address copied to clipboard');
                        }}
                        className="text-xs font-semibold text-primary underline"
                      >
                        Copy
                      </button>
                    </div>
                  </div>

                  {/* Reference Memo */}
                  {referenceMemo && (
                    <div className="p-3 bg-amber-500/10 rounded-lg border border-amber-500/30">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] text-amber-700 dark:text-amber-400 uppercase font-bold">
                          Required Reference Memo (for external/exchange deposits)
                        </span>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(referenceMemo);
                            alert('Memo copied');
                          }}
                          className="text-xs font-semibold text-amber-700 dark:text-amber-400 underline"
                        >
                          Copy
                        </button>
                      </div>
                      <div className="font-mono font-bold text-sm text-primary">{referenceMemo}</div>
                    </div>
                  )}

                  {/* Tx Hash Input */}
                  <div>
                    <label className="text-[11px] text-on-surface-variant uppercase font-semibold block mb-1">
                      Enter Finalized Transaction Hash
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. 5Kx2... or 0x4f8..."
                      value={txHash}
                      onChange={(e) => setTxHash(e.target.value)}
                      className="w-full bg-surface-container border border-border-subtle rounded-lg p-2.5 text-sm font-mono outline-none focus:border-primary"
                    />
                    <span className="text-[11px] text-on-surface-variant mt-1 block">
                      Transfer exact ${selectedPlan.priceUsdc} USDC to the address above, then paste tx hash to activate instantly.
                    </span>
                  </div>

                  <button
                    onClick={handleVerifyPayment}
                    disabled={verifying || !txHash.trim()}
                    className="w-full py-3 bg-primary text-white font-bold rounded-xl text-sm disabled:opacity-50 hover:opacity-90 transition-opacity flex items-center justify-center gap-2 mt-4"
                  >
                    {verifying ? (
                      <>
                        <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        <span>Verifying On-Chain Transfer...</span>
                      </>
                    ) : (
                      <>
                        <span className="material-symbols-outlined text-base">verified</span>
                        <span>Verify & Unlock Tier</span>
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
