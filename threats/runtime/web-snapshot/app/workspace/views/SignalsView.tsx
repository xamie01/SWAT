'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api.js';
import { describeApiError } from '../../../lib/api-error-message.js';

type Chain = 'solana' | 'polygon' | 'robinhood-chain';

type Signal = {
  id: string;
  time: string;
  chain: string;
  chainColor: string;
  pattern: string;
  patternBg: string;
  patternColor: string;
  asset: string;
  context: string;
  wallets: string;
  latency: string;
  latencyColor: string;
  confidence: number;
  safetyIcon: string;
  safetyColor: string;
  safetyRating: string;
  status: string;
  tokenMint: string | null;
  safetyWarnings: string[];
  triggerData: Record<string, unknown> | null;
};

const CHAIN_META: Record<Chain, { label: string; color: string }> = {
  solana: { label: 'Solana', color: 'bg-solana-teal' },
  polygon: { label: 'Polymarket', color: 'bg-polymarket-violet' },
  'robinhood-chain': { label: 'Robinhood', color: 'bg-robinhood-amber' }
};

const PATTERN_OPTIONS = ['All Patterns', 'snipe', 'accumulation', 'rotation', 'stealth', 'exit'];

// signals.chain is an indexed NOT NULL column (sql/013). Fall back to the address
// prefix only when the API predates it — never sniff for '0x', since every stored
// address is chain-prefixed and would misclassify.
function resolveChain(raw: unknown, tokenMint: string | null): Chain {
  if (raw === 'solana' || raw === 'polygon' || raw === 'robinhood-chain') return raw;
  const prefix = (tokenMint ?? '').split(':')[0];
  if (prefix === 'polygon' || prefix === 'robinhood-chain') return prefix;
  return 'solana';
}

export default function SignalsView() {
  const [selectedSignal, setSelectedSignal] = useState<Signal | null>(null);
  const [confidenceFilter, setConfidenceFilter] = useState(80);
  const [selectedNetwork, setSelectedNetwork] = useState('All');
  const [selectedPattern, setSelectedPattern] = useState('All Patterns');
  const [signals, setSignals] = useState<Signal[]>([]);
  const [stats, setStats] = useState<{
    total: number; alerted: number; executed: number; rejected: number; avg_score: number | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const fetchSignals = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (selectedPattern !== 'All Patterns') params.set('pattern', selectedPattern);
      const suffix = params.toString() ? `?${params.toString()}` : '';

      // Stats failure stays tolerated, as before: the old code only threw on the
      // signals response and rendered `null` stats otherwise. Promise.all would
      // now reject on either, so the stats call swallows its own error.
      const [data, statsData] = await Promise.all([
        api.get<any>(`/v1/signals${suffix}`),
        api.get<any>('/v1/signals/stats').catch(() => null)
      ]);

      const mapped: Signal[] = (data.items || []).map((s: any) => {
        const tokenMint: string | null = s.token_mint ?? null;
        const chain = resolveChain(s.chain, tokenMint);
        const meta = CHAIN_META[chain];
        const confidence = Number(s.confidence ?? 0);
        const warnings: string[] = Array.isArray(s.safety_warnings) ? s.safety_warnings : [];
        const flags: string[] = Array.isArray(s.safety_flags) ? s.safety_flags : [];
        const hasRisk = warnings.length > 0 || flags.length > 0;
        const bareMint = (tokenMint ?? '').includes(':') ? (tokenMint as string).split(':').slice(1).join(':') : tokenMint;

        return {
          id: s.id,
          time: s.created_at ? new Date(s.created_at).toLocaleTimeString([], { hour12: false }) : '--:--:--',
          chain: meta.label,
          chainColor: meta.color,
          pattern: (s.pattern_type || 'UNKNOWN').toUpperCase(),
          patternBg: 'bg-primary text-on-primary',
          patternColor: 'text-on-primary',
          asset: s.token_symbol ? `$${s.token_symbol}` : s.token_name || bareMint || 'Unknown asset',
          context: bareMint ? `${bareMint.slice(0, 6)}...${bareMint.slice(-4)}` : (s.cluster_id ? `Cluster ${String(s.cluster_id).slice(0, 8)}` : 'Global'),
          wallets: s.cluster_id ? 'Cluster' : 'Unclustered',
          latency: s.status ?? 'pending',
          latencyColor: s.status === 'executed' ? 'text-status-success' : 'text-on-surface-variant',
          confidence,
          safetyIcon: hasRisk ? 'report' : 'verified_user',
          safetyColor: hasRisk ? 'text-status-warning' : 'text-status-success',
          safetyRating: hasRisk ? 'Caution' : 'Secure',

          status: s.status ?? 'pending',
          tokenMint,
          safetyWarnings: [...warnings, ...flags],
          triggerData: s.trigger_data && typeof s.trigger_data === 'object' ? s.trigger_data : null
        };
      });
      setSignals(mapped);
      setStats(statsData);
      setLoadError(null);
    } catch (err: unknown) {
      console.error('[web] signals request failed', err);
      setLoadError(describeApiError(err, 'Unable to load signals. Displayed rows may be out of date.'));
    } finally {
      setLoading(false);
    }
  }, [selectedPattern]);

  useEffect(() => {
    void fetchSignals();
    const interval = setInterval(() => void fetchSignals(), 5000);
    return () => clearInterval(interval);
  }, [fetchSignals]);

  // The backend enqueues to BullMQ and returns { queued: true } — it does not confirm a
  // fill. Wording must stay "queued" so the operator does not read this as a settled trade.
  const actOnSignal = async (signal: Signal, action: 'execute' | 'ignore') => {
    setActing(true);
    setBanner(null);
    try {
      await api.post(`/v1/signals/${signal.id}/${action}`);
      setBanner({
        kind: 'ok',
        text: action === 'execute'
          ? `Signal ${signal.id.slice(0, 8)} queued for execution — awaiting executor confirmation.`
          : `Signal ${signal.id.slice(0, 8)} marked rejected.`
      });
      setSelectedSignal(null);
      void fetchSignals();
    } catch (err: unknown) {
      // Keep the drawer open on failure so the operator sees which signal did not act.
      setBanner({ kind: 'err', text: describeApiError(err, 'Request failed') });
    } finally {
      setActing(false);
    }
  };

  const filteredSignals = signals.filter(sig => {
    if (sig.confidence < confidenceFilter) return false;
    if (selectedNetwork !== 'All' && sig.chain !== selectedNetwork) return false;
    return true;
  });

  return (
    <div className="max-w-[1440px] mx-auto p-6 relative">
      {/* Header Section */}
      <div className="mb-6">
        <h2 className="text-lg font-bold text-primary">Signals Review</h2>
        <p className="text-on-surface-variant text-xs">Deep inspection and verification of cross-chain intelligence.</p>
      </div>

      {/* Filter Bar */}
      <div className="bg-surface-container-lowest border border-border-subtle rounded-lg p-4 mb-6 shadow-sm flex flex-wrap items-end gap-6">
        {/* Chain Filter */}
        <div className="space-y-2">
          <label className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Network</label>
          <div className="flex gap-2">
            {['All', 'Solana', 'Polymarket', 'Robinhood'].map((net) => (
              <button
                key={net}
                onClick={() => setSelectedNetwork(net)}
                className={`px-3 py-1.5 text-xs font-bold rounded ${
                  selectedNetwork === net 
                    ? 'bg-primary text-on-primary' 
                    : 'bg-surface-container border border-border-subtle text-on-surface-variant'
                }`}
              >
                {net}
              </button>
            ))}
          </div>
        </div>

        {/* Pattern Filter */}
        <div className="space-y-2">
          <label className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Pattern</label>
          <select
            value={selectedPattern}
            onChange={(e) => setSelectedPattern(e.target.value)}
            className="bg-surface-container border-border-subtle rounded text-xs py-1.5 pr-8 focus:ring-primary focus:border-primary"
          >
            {PATTERN_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt === 'All Patterns' ? opt : opt.charAt(0).toUpperCase() + opt.slice(1)}
              </option>
            ))}
          </select>
        </div>

        {/* Confidence Slider */}
        <div className="space-y-2 flex-1 max-w-xs">
          <div className="flex justify-between">
            <label className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Confidence</label>
            <span className="text-[10px] font-mono text-primary font-bold">&gt; {confidenceFilter}%</span>
          </div>
          <input
            type="range"
            min="0"
            max="100"
            value={confidenceFilter}
            onChange={(e) => setConfidenceFilter(Number(e.target.value))}
            className="w-full h-1.5 bg-surface-container-highest rounded-lg appearance-none cursor-pointer accent-primary"
          />
        </div>

        {/* Result count */}
        <div className="space-y-2">
          <label className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Matching</label>
          <p className="text-xs font-mono font-bold text-primary py-1.5">
            {filteredSignals.length} of {signals.length}
          </p>
        </div>
      </div>

      {banner && (
        <div
          role="alert"
          className={`mb-6 flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${
            banner.kind === 'ok'
              ? 'border-status-success/30 bg-status-success/5 text-status-success'
              : 'border-status-error/30 bg-status-error/5 text-status-error'
          }`}
        >
          <span className="material-symbols-outlined text-[18px]">
            {banner.kind === 'ok' ? 'check_circle' : 'error'}
          </span>
          <span className="flex-1">{banner.text}</span>
          <button onClick={() => setBanner(null)} className="text-xs font-bold underline">Dismiss</button>
        </div>
      )}

      {loadError && (
        <div role="alert" className="mb-6 flex items-center gap-3 rounded-lg border border-status-warning/30 bg-status-warning/5 px-4 py-3 text-sm text-status-warning">
          <span className="material-symbols-outlined text-[18px]">warning</span>
          <span>{loadError}</span>
        </div>
      )}

      {/* Signal Table Container */}
      <div className="bg-surface-container-lowest border border-border-subtle rounded-lg overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead className="bg-surface-container-low border-b border-border-subtle sticky top-0">
            <tr>
              <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Time (UTC)</th>
              <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Chain</th>
              <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Pattern</th>
              <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Asset/Context</th>
              <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Wallets</th>
              <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Status</th>
              <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Confidence</th>
              <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant text-center">Safety</th>
              <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle text-[13px]">
            {loading && signals.length === 0 ? (
              <tr>
                <td className="px-4 py-10 text-center text-sm text-on-surface-variant" colSpan={9}>Loading signals...</td>
              </tr>
            ) : filteredSignals.length === 0 ? (
              <tr>
                <td className="px-4 py-10 text-center text-sm text-on-surface-variant" colSpan={9}>
                  {signals.length === 0
                    ? 'No signals have been generated yet.'
                    : `No signals match the current filters (${signals.length} hidden).`}
                </td>
              </tr>
            ) : (
              filteredSignals.map((sig) => (
              <tr
                key={sig.id}
                onClick={() => setSelectedSignal(sig)}
                className={`transition-colors hover:bg-surface-container-low cursor-pointer ${
                  selectedSignal?.id === sig.id ? 'bg-surface-container-high' : ''
                }`}
              >
                <td className="px-4 py-3 font-mono text-on-surface-variant">{sig.time}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-4 ${sig.chainColor} rounded-full`}></span>
                    <span className="text-xs font-bold text-primary">{sig.chain}</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 ${sig.patternBg} text-[10px] font-bold rounded`}>
                    {sig.pattern}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-col">
                    <span className="text-xs font-bold text-primary">{sig.asset}</span>
                    <span className="text-[10px] font-mono text-on-surface-variant">{sig.context}</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-primary font-medium">{sig.wallets}</span>
                    <span className="material-symbols-outlined text-sm text-on-surface-variant">group</span>
                  </div>
                </td>
                <td className={`px-4 py-3 font-mono text-xs ${sig.latencyColor}`}>{sig.latency}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 w-12 h-1 bg-surface-container rounded-full overflow-hidden">
                      <div className="h-full bg-status-success" style={{ width: `${sig.confidence}%` }}></div>
                    </div>
                    <span className="text-xs font-mono">{sig.confidence}%</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-center">
                  <span className={`material-symbols-outlined text-lg ${sig.safetyColor}`} style={{ fontVariationSettings: "'FILL' 1" }}>
                    {sig.safetyIcon}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <button className="px-3 py-1 text-[10px] font-bold border border-border-subtle rounded hover:bg-primary hover:text-on-primary">
                    INSPECT
                  </button>
                </td>
              </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Dashboard Stats Summary — GET /v1/signals/stats */}
      <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-surface-container-lowest p-4 rounded-lg border border-border-subtle shadow-sm">
          <p className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest mb-1">Total Signals</p>
          <p className="text-2xl font-bold text-primary">{stats ? Number(stats.total ?? 0).toLocaleString() : '--'}</p>
          <div className="flex items-center gap-1 mt-2 text-[10px] text-on-surface-variant font-bold">
            <span>All time</span>
          </div>
        </div>
        <div className="bg-surface-container-lowest p-4 rounded-lg border border-border-subtle shadow-sm">
          <p className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest mb-1">Alerted</p>
          <p className="text-2xl font-bold text-primary">{stats ? Number(stats.alerted ?? 0).toLocaleString() : '--'}</p>
          <div className="flex items-center gap-1 mt-2 text-[10px] text-on-surface-variant font-bold">
            <span>Avg score {stats?.avg_score != null ? Number(stats.avg_score).toFixed(1) : 'n/a'}</span>
          </div>
        </div>
        <div className="bg-surface-container-lowest p-4 rounded-lg border border-border-subtle shadow-sm">
          <p className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest mb-1">Executed</p>
          <p className="text-2xl font-bold text-status-success">{stats ? Number(stats.executed ?? 0).toLocaleString() : '--'}</p>
          <div className="flex items-center gap-1 mt-2 text-[10px] text-on-surface-variant font-bold">
            <span>Queued or filled</span>
          </div>
        </div>
        <div className="bg-surface-container-lowest p-4 rounded-lg border border-border-subtle shadow-sm">
          <p className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest mb-1">Rejected</p>
          <p className="text-2xl font-bold text-primary">{stats ? Number(stats.rejected ?? 0).toLocaleString() : '--'}</p>
          <div className="flex items-center gap-1 mt-2 text-[10px] text-on-surface-variant font-bold">
            <span>Operator or engine</span>
          </div>
        </div>
      </div>

      {/* Detail Drawer */}
      <div 
        className={`fixed top-0 right-0 h-screen w-[480px] bg-surface-container-lowest border-l border-border-subtle shadow-2xl z-[100] transform transition-transform duration-300 ease-in-out ${
          selectedSignal ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {selectedSignal && (
          <div className="h-full flex flex-col">
            {/* Drawer Header */}
            <div className="p-6 border-b border-border-subtle flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-primary">Signal Inspection</h3>
                <p className="text-xs text-on-surface-variant">{selectedSignal.asset} · {selectedSignal.chain}</p>
              </div>
              <button 
                onClick={() => setSelectedSignal(null)}
                className="p-2 hover:bg-surface-container rounded-full transition-colors"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            {/* Drawer Content */}
            <div className="flex-1 overflow-y-auto p-6 space-y-8">
              {/* Source Evidence Section — real trigger_data JSONB */}
              <div>
                <h4 className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant mb-4">Source Evidence</h4>
                <div className="bg-surface-container-low p-4 rounded-lg border border-border-subtle">
                  <div className="flex justify-between items-center mb-3">
                    <span className="text-xs font-bold text-primary">Trigger Data</span>
                    <span className="text-[10px] font-bold text-primary bg-white px-2 py-0.5 rounded border border-border-subtle uppercase">
                      {selectedSignal.status}
                    </span>
                  </div>
                  {selectedSignal.triggerData ? (
                    <pre className="text-[10px] font-mono text-on-surface-variant leading-relaxed whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
                      {JSON.stringify(selectedSignal.triggerData, null, 2)}
                    </pre>
                  ) : (
                    <p className="text-xs text-on-surface-variant">No trigger data recorded for this signal.</p>
                  )}
                </div>
              </div>
              {/* Safety */}
              <div>
                <h4 className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant mb-4">Safety Assessment</h4>
                {selectedSignal.safetyWarnings.length === 0 ? (
                  <div className="flex items-center gap-2 rounded-lg border border-status-success/30 bg-status-success/5 px-4 py-3">
                    <span className="material-symbols-outlined text-[18px] text-status-success">verified_user</span>
                    <span className="text-xs text-status-success font-semibold">No safety flags or warnings recorded.</span>
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {selectedSignal.safetyWarnings.map((warning, idx) => (
                      <li key={idx} className="flex items-start gap-2 rounded-lg border border-status-warning/30 bg-status-warning/5 px-4 py-2">
                        <span className="material-symbols-outlined text-[16px] text-status-warning mt-0.5">warning</span>
                        <span className="text-xs text-status-warning">{warning}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {/* Identity */}
              <div>
                <h4 className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant mb-4">Identity</h4>
                <dl className="space-y-2 text-xs">
                  <div className="flex justify-between gap-4">
                    <dt className="text-on-surface-variant">Signal ID</dt>
                    <dd className="font-mono text-right break-all">{selectedSignal.id}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-on-surface-variant">Chain</dt>
                    <dd className="font-mono text-right">{selectedSignal.chain}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-on-surface-variant">Token</dt>
                    <dd className="font-mono text-right break-all">{selectedSignal.tokenMint ?? 'None (not executable)'}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-on-surface-variant">Confidence</dt>
                    <dd className="font-mono text-right">{selectedSignal.confidence}%</dd>
                  </div>
                </dl>
              </div>
            </div>
            {/* Drawer Footer */}
            <div className="p-6 border-t border-border-subtle bg-surface-container-lowest space-y-3">
              {!selectedSignal.tokenMint && (
                <p className="text-[10px] text-status-warning font-semibold">
                  This signal has no token and cannot be executed (API returns 409).
                </p>
              )}
              <div className="flex gap-4">
                <button
                  onClick={() => void actOnSignal(selectedSignal, 'ignore')}
                  disabled={acting}
                  className="flex-1 bg-surface-container border border-border-subtle text-primary py-3 rounded font-bold text-xs hover:bg-surface-variant transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {acting ? 'WORKING...' : 'REJECT SIGNAL'}
                </button>
                <button
                  onClick={() => void actOnSignal(selectedSignal, 'execute')}
                  disabled={acting || !selectedSignal.tokenMint}
                  className="flex-1 bg-primary text-white py-3 rounded font-bold text-xs shadow-lg active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
                >
                  {acting ? 'WORKING...' : 'QUEUE EXECUTION'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
