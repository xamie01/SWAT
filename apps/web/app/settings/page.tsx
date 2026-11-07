'use client';

import React, { useState, useEffect } from 'react';
import { SaaSNav } from '../../components/SaaSNav.js';
import { LoadingSkeleton, ErrorBanner } from '../../components/UIPrimitives.js';
import { api } from '../../lib/api.js';

interface ExecutionSettings {
  maxPositionPct: number;
  maxSlippageBps: number;
  autoExecute: boolean;
  concurrentPositionCap: number;
  killSwitchActive: boolean;
  userBalanceUsd: number;
  venueMinOrderSizeUsd: number;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<ExecutionSettings>({
    maxPositionPct: 5,
    maxSlippageBps: 100,
    autoExecute: false,
    concurrentPositionCap: 5,
    killSwitchActive: false,
    userBalanceUsd: 0,
    venueMinOrderSizeUsd: 10,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<any>('/v1/me/execution-settings');
      if (data?.settings) {
        const solanaChain = data.chains?.find((c: any) => c.chain === 'solana');
        setSettings({
          maxPositionPct: data.settings.maxPositionPct ?? 5,
          maxSlippageBps: solanaChain?.maxSlippageBps ?? 100,
          autoExecute: Boolean(data.settings.autoExecute),
          concurrentPositionCap: data.settings.maxConcurrentPositions ?? 5,
          killSwitchActive: Boolean(data.settings.killed),
          userBalanceUsd: data.positionCap?.balanceUsd ?? 0,
          venueMinOrderSizeUsd: data.positionCap?.minOrderSizeUsd ?? 10,
        });
      }
    } catch (err: any) {
      setError(err.message || 'Failed to fetch settings');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSuccess(false);
    try {
      // S4-M4: Correct PATCH method and schema fields for execution-settings
      await api.patch('/v1/me/execution-settings', {
        maxPositionPct: settings.maxPositionPct,
        autoExecute: settings.autoExecute,
        maxConcurrentPositions: settings.concurrentPositionCap,
      });

      // API-08: Update per-chain slippage with correct PATCH method and propagate errors
      await api.patch('/v1/me/execution-settings/chains/solana', {
        mode: settings.autoExecute ? 'live' : 'paper',
        maxSlippageBps: settings.maxSlippageBps,
      });

      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      alert(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleKillSwitch = async () => {
    const nextState = !settings.killSwitchActive;
    if (nextState && !confirm('WARNING: Activating emergency kill switch will immediately halt all automated trade executions for your account. Continue?')) {
      return;
    }
    setSettings((prev) => ({ ...prev, killSwitchActive: nextState }));
    try {
      // S6-8: Correct schema { killed: boolean }
      await api.put('/v1/me/execution-settings/kill-switch', { killed: nextState });
    } catch (err: any) {
      alert(`Kill switch toggle failed: ${err.message}`);
      setSettings((prev) => ({ ...prev, killSwitchActive: !nextState }));
    }
  };

  // S6-25: Derived below-minimum calculation
  const positionSizeAtCap =
    settings.concurrentPositionCap > 0
      ? settings.userBalanceUsd / settings.concurrentPositionCap
      : 0;
  const isBelowMinimum = positionSizeAtCap < settings.venueMinOrderSizeUsd;
  const maxSafeCap = Math.max(1, Math.floor(settings.userBalanceUsd / settings.venueMinOrderSizeUsd));

  return (
    <div className="bg-background text-on-background min-h-screen antialiased font-sans">
      <SaaSNav />

      <main className="max-w-[1440px] mx-auto px-6 py-8">
        <div className="mb-8">
          <h1 className="font-headline-lg text-2xl font-bold tracking-tight text-primary">
            Risk & Execution Controls
          </h1>
          <p className="text-body-sm text-on-surface-variant">
            Configure automated sizing rules, position ceilings, maximum slippage tolerance, and emergency safety cutoffs.
          </p>
        </div>

        {error && <div className="mb-6"><ErrorBanner message={error} onRetry={fetchSettings} /></div>}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Main Risk Form */}
          <div className="lg:col-span-8 bg-surface-container-lowest border border-border-subtle rounded-2xl p-6 sm:p-8">
            {loading ? (
              <LoadingSkeleton rows={5} />
            ) : (
              <form onSubmit={handleSave} className="space-y-6">
                {/* 1. Max Position Size % */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="font-bold text-sm text-primary">
                      Maximum Position Size (% of Available Float)
                    </label>
                    <span className="font-mono font-bold text-sm text-primary">{settings.maxPositionPct}%</span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="25"
                    step="1"
                    value={settings.maxPositionPct}
                    onChange={(e) =>
                      setSettings((prev) => ({ ...prev, maxPositionPct: Number(e.target.value) }))
                    }
                    className="w-full accent-primary"
                  />
                  <span className="text-xs text-on-surface-variant mt-1 block">
                    Caps the maximum capital allocation per mirrored entry trade.
                  </span>
                </div>

                {/* 2. Concurrent Position Cap + S6-25 Warning */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="font-bold text-sm text-primary">
                      Concurrent Open Positions Cap
                    </label>
                    <span className="font-mono font-bold text-sm text-primary">
                      {settings.concurrentPositionCap} positions
                    </span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="20"
                    step="1"
                    value={settings.concurrentPositionCap}
                    onChange={(e) =>
                      setSettings((prev) => ({ ...prev, concurrentPositionCap: Number(e.target.value) }))
                    }
                    className="w-full accent-primary"
                  />
                  <span className="text-xs text-on-surface-variant mt-1 block">
                    Estimated allocation per position: ~${positionSizeAtCap.toFixed(2)} USD (at current float of ${settings.userBalanceUsd.toFixed(2)}).
                  </span>

                  {/* S6-25 Warning Alert */}
                  {isBelowMinimum && (
                    <div className="mt-3 p-3 rounded-lg bg-status-warning/10 border border-status-warning/30 flex items-start gap-2.5 text-xs text-status-warning">
                      <span className="material-symbols-outlined text-base shrink-0">warning</span>
                      <div>
                        <span className="font-bold">Below-Minimum Allocation Warning:</span> At your current balance
                        (${settings.userBalanceUsd.toFixed(2)}), allocating across {settings.concurrentPositionCap} positions
                        drops each order below the venue minimum order size (${settings.venueMinOrderSizeUsd} USD).
                        Trades beyond {maxSafeCap} positions will be automatically skipped.
                      </div>
                    </div>
                  )}
                </div>

                {/* 3. Slippage Bps */}
                <div>
                  <label className="font-bold text-sm text-primary block mb-1">
                    Maximum Execution Slippage (Basis Points)
                  </label>
                  <input
                    type="number"
                    min="10"
                    max="500"
                    value={settings.maxSlippageBps}
                    onChange={(e) =>
                      setSettings((prev) => ({ ...prev, maxSlippageBps: Number(e.target.value) }))
                    }
                    className="w-full bg-surface-container border border-border-subtle rounded-lg p-2.5 text-sm font-mono outline-none focus:border-primary"
                  />
                  <span className="text-xs text-on-surface-variant mt-1 block">
                    100 bps = 1.00%. Orders experiencing price deviation above this threshold are rejected.
                  </span>
                </div>

                {/* 4. Automated Execution Toggle */}
                <div className="pt-4 border-t border-border-subtle flex items-center justify-between">
                  <div>
                    <div className="font-bold text-sm text-primary">Autonomous On-Chain Execution</div>
                    <div className="text-xs text-on-surface-variant">
                      When enabled, trades are executed immediately upon receiving master signals without manual prompts.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.autoExecute}
                    onChange={(e) =>
                      setSettings((prev) => ({ ...prev, autoExecute: e.target.checked }))
                    }
                    className="w-5 h-5 accent-primary cursor-pointer"
                  />
                </div>

                <div className="pt-4">
                  <button
                    type="submit"
                    disabled={saving}
                    className="w-full py-3 bg-primary text-white font-bold rounded-xl text-sm hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
                  >
                    {saving ? 'Saving Preferences...' : 'Save Risk Preferences'}
                  </button>
                  {success && (
                    <div className="text-center text-status-success text-xs font-semibold mt-2">
                      Preferences saved successfully!
                    </div>
                  )}
                </div>
              </form>
            )}
          </div>

          {/* Emergency Kill Switch Card */}
          <div className="lg:col-span-4 bg-surface-container-lowest border border-border-subtle rounded-2xl p-6 flex flex-col justify-between">
            <div>
              <div className="w-12 h-12 rounded-xl bg-status-error/10 text-status-error flex items-center justify-center mb-4">
                <span className="material-symbols-outlined text-2xl">power_settings_new</span>
              </div>
              <h2 className="font-headline-md text-lg font-bold text-primary mb-2">
                Emergency Account Kill Switch
              </h2>
              <p className="text-xs text-on-surface-variant leading-relaxed mb-6">
                Instantly disconnects your custody accounts from the automated execution queue. No new copy trades will be submitted
                until you deliberately turn this switch off.
              </p>

              <div className="p-3 rounded-lg bg-surface-container-low border border-border-subtle text-xs mb-6">
                <div className="flex items-center justify-between font-mono">
                  <span>Current State:</span>
                  <span
                    className={`font-bold ${
                      settings.killSwitchActive ? 'text-status-error' : 'text-status-success'
                    }`}
                  >
                    {settings.killSwitchActive ? 'HALTED / ENGAGED' : 'ARMED / NORMAL'}
                  </span>
                </div>
              </div>
            </div>

            <button
              onClick={handleToggleKillSwitch}
              className={`w-full py-3 rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-2 ${
                settings.killSwitchActive
                  ? 'bg-status-success text-white hover:opacity-90'
                  : 'bg-status-error text-white hover:opacity-90'
              }`}
            >
              <span className="material-symbols-outlined text-base">power_settings_new</span>
              <span>
                {settings.killSwitchActive ? 'Disengage Kill Switch' : 'Trigger Emergency Kill Switch'}
              </span>
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
