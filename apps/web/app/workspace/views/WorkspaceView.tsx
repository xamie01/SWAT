'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api.js';
import { describeApiError } from '../../../lib/api-error-message.js';

type IngestionChain = 'solana' | 'polygon' | 'robinhood-chain';
type IngestionStatus = 'healthy' | 'stale' | 'empty';

type WorkspaceIngestionItem = {
  chain: IngestionChain;
  status: IngestionStatus;
  lagSeconds: number | null;
};

const INGESTION_CHAINS: Array<{
  chain: IngestionChain;
  label: string;
  bar: string;
}> = [
  { chain: 'solana', label: 'SOLANA MAINNET', bar: 'bg-solana-teal' },
  { chain: 'polygon', label: 'POLYGON CLOB', bar: 'bg-polymarket-violet' },
  { chain: 'robinhood-chain', label: 'ROBINHOOD CHAIN', bar: 'bg-robinhood-amber' }
];

function emptyIngestionItems(): WorkspaceIngestionItem[] {
  return INGESTION_CHAINS.map(({ chain }) => ({ chain, status: 'empty', lagSeconds: null }));
}

function normalizeIngestionItems(value: unknown): WorkspaceIngestionItem[] {
  if (!value || typeof value !== 'object') return emptyIngestionItems();
  const rawItems = (value as { items?: unknown }).items;
  if (!Array.isArray(rawItems)) return emptyIngestionItems();

  return INGESTION_CHAINS.map(({ chain }) => {
    const raw = rawItems.find((item) => (
      Boolean(item)
      && typeof item === 'object'
      && (item as { chain?: unknown }).chain === chain
    )) as Record<string, unknown> | undefined;
    const status = raw?.status;
    const lagSeconds = typeof raw?.lagSeconds === 'number' && Number.isFinite(raw.lagSeconds)
      ? Math.max(0, raw.lagSeconds)
      : null;
    if (status !== 'healthy' && status !== 'stale' && status !== 'empty') {
      return { chain, status: 'empty', lagSeconds: null };
    }
    if (status !== 'empty' && lagSeconds === null) {
      return { chain, status: 'empty', lagSeconds: null };
    }
    return { chain, status, lagSeconds };
  });
}

function formatIngestionLag(seconds: number | null): string {
  if (seconds === null) return 'NO DATA';
  if (seconds < 60) return `${seconds}s LAG`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s LAG`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m LAG`;
}

export default function WorkspaceView() {
  const [showToast, setShowToast] = useState(true);
  const [ingestionItems, setIngestionItems] = useState<WorkspaceIngestionItem[]>(emptyIngestionItems);
  const [ingestionGeneratedAt, setIngestionGeneratedAt] = useState<string | null>(null);
  const [ingestionLoading, setIngestionLoading] = useState(true);
  const [ingestionError, setIngestionError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const loadIngestionHealth = async () => {
      try {
        const data = await api.get<{ generatedAt?: unknown; items?: unknown }>(
          '/v1/health/ingestion',
          { signal: controller.signal }
        );
        const generatedAt = typeof data.generatedAt === 'string' ? new Date(data.generatedAt) : null;
        setIngestionItems(normalizeIngestionItems(data));
        setIngestionGeneratedAt(
          generatedAt && !Number.isNaN(generatedAt.getTime()) ? generatedAt.toISOString() : null
        );
        setIngestionError(false);
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error(describeApiError(error, '[web] workspace ingestion health request failed'), error);
        setIngestionItems(emptyIngestionItems());
        setIngestionGeneratedAt(null);
        setIngestionError(true);
      } finally {
        if (!controller.signal.aborted) setIngestionLoading(false);
      }
    };

    void loadIngestionHealth();
    const interval = window.setInterval(() => void loadIngestionHealth(), 30_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, []);

  const ingestionSummary = ingestionError
    ? { label: 'UNAVAILABLE', tone: 'text-status-error', dot: 'bg-status-error' }
    : ingestionLoading
      ? { label: 'LOADING', tone: 'text-on-surface-variant', dot: 'bg-on-surface-variant' }
      : ingestionItems.some((item) => item.status === 'empty')
        ? { label: 'NO DATA', tone: 'text-status-error', dot: 'bg-status-error' }
        : ingestionItems.some((item) => item.status === 'stale')
          ? { label: 'ATTENTION', tone: 'text-status-warning', dot: 'bg-status-warning' }
          : { label: 'HEALTHY', tone: 'text-status-success', dot: 'bg-status-success' };

  const ingestionUpdatedAt = ingestionGeneratedAt
    ? `${new Date(ingestionGeneratedAt).toISOString().slice(11, 19)} UTC`
    : 'NO CURRENT RESPONSE';

  return (
    <div className="max-w-[1440px] mx-auto p-6 space-y-6">
      {/* Workspace Controls Sub-header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-surface p-4 rounded-xl border border-outline-variant shadow-sm">
        <div>
          <h2 className="text-lg font-bold text-primary">Custom Dashboard</h2>
          <p className="text-xs text-on-surface-variant">Configure your operational layout and active widget set.</p>
        </div>
        <div className="flex items-center gap-3">
          <button className="flex items-center gap-2 px-3 py-1.5 bg-surface border border-outline text-xs font-medium hover:bg-surface-container-low transition-colors rounded-lg">
            <span className="material-symbols-outlined text-[18px]">edit</span> Edit Layout
          </button>
          <button className="flex items-center gap-2 px-3 py-1.5 bg-surface border border-outline text-xs font-medium hover:bg-surface-container-low transition-colors rounded-lg">
            <span className="material-symbols-outlined text-[18px]">add</span> Add Widget
          </button>
          <button className="flex items-center gap-2 px-3 py-1.5 bg-primary text-white text-xs font-medium hover:bg-primary/90 transition-colors rounded-lg">
            <span className="material-symbols-outlined text-[18px]">save</span> Save Template
          </button>
        </div>
      </div>

      {/* BENTO GRID WORKSPACE */}
      <div className="grid grid-cols-12 gap-4">
        {/* 1. Pinned Signal Feed (Large Span) */}
        <section className="col-span-12 lg:col-span-8 bg-surface border border-outline-variant rounded-xl overflow-hidden shadow-sm flex flex-col h-[400px]">
          <div className="px-4 py-3 border-b border-outline-variant flex items-center justify-between bg-surface-container-lowest">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-status-success">auto_awesome</span>
              <h3 className="text-[11px] font-bold text-primary uppercase tracking-wider">High Conviction Feed (Score &gt; 90)</h3>
            </div>
            <span className="text-[11px] font-bold text-on-surface-variant">Live Updates</span>
          </div>
          <div className="flex-1 overflow-auto custom-scrollbar">
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 bg-surface-container-low z-10">
                <tr className="text-[11px] font-bold text-on-surface-variant border-b border-outline-variant">
                  <th className="px-4 py-2 font-semibold">Time</th>
                  <th className="px-4 py-2 font-semibold">Chain</th>
                  <th className="px-4 py-2 font-semibold">Source Cluster</th>
                  <th className="px-4 py-2 font-semibold">Asset/Market</th>
                  <th className="px-4 py-2 font-semibold">Score</th>
                  <th className="px-4 py-2 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/50">
                {/* Row 1 */}
                <tr className="hover:bg-surface-container-low/50 transition-colors group">
                  <td className="px-4 py-3 font-mono text-[13px]">14:22:04</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-solana-teal"></div>
                      <span className="text-xs">Solana</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-0.5 rounded bg-surface-container-high text-xs">C-928_Snipe</span>
                  </td>
                  <td className="px-4 py-3 text-xs font-bold">WAKE_LP</td>
                  <td className="px-4 py-3">
                    <span className="text-status-success font-bold font-mono">98.2</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button className="px-3 py-1 bg-primary text-white text-[11px] font-bold rounded-lg uppercase tracking-tight">Execute</button>
                  </td>
                </tr>
                {/* Row 2 */}
                <tr className="hover:bg-surface-container-low/50 transition-colors group">
                  <td className="px-4 py-3 font-mono text-[13px]">14:18:55</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-polymarket-violet"></div>
                      <span className="text-xs">Polygon</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-0.5 rounded bg-surface-container-high text-xs">P-Alpha_5</span>
                  </td>
                  <td className="px-4 py-3 text-xs">Market #2912</td>
                  <td className="px-4 py-3">
                    <span className="text-status-success font-bold font-mono">94.1</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button className="px-3 py-1 bg-primary text-white text-[11px] font-bold rounded-lg uppercase tracking-tight">Review</button>
                  </td>
                </tr>
                {/* Row 3 */}
                <tr className="hover:bg-surface-container-low/50 transition-colors group">
                  <td className="px-4 py-3 font-mono text-[13px]">14:05:12</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-robinhood-amber"></div>
                      <span className="text-xs">Robinhood</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-0.5 rounded bg-surface-container-high text-xs">R-Explorer</span>
                  </td>
                  <td className="px-4 py-3 text-xs">RH_DEGEN</td>
                  <td className="px-4 py-3">
                    <span className="text-status-success font-bold font-mono">91.8</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button className="px-3 py-1 bg-primary text-white text-[11px] font-bold rounded-lg uppercase tracking-tight">Simulate</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* 2. Active Watchlist */}
        <section className="col-span-12 lg:col-span-4 bg-surface border border-outline-variant rounded-xl overflow-hidden shadow-sm flex flex-col h-[400px]">
          <div className="px-4 py-3 border-b border-outline-variant flex items-center justify-between bg-surface-container-lowest">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary">visibility</span>
              <h3 className="text-[11px] font-bold text-primary uppercase tracking-wider">Whale Clusters</h3>
            </div>
            <span className="material-symbols-outlined text-on-surface-variant cursor-pointer hover:text-primary">more_vert</span>
          </div>
          <div className="p-4 space-y-4 flex-1 overflow-auto custom-scrollbar">
            {/* Cluster 1 */}
            <div className="p-3 border border-outline-variant rounded-lg bg-surface-container-low hover:border-primary transition-colors cursor-pointer group">
              <div className="flex justify-between items-start mb-2">
                <span className="text-sm font-bold group-hover:text-primary transition-colors">Solana_Sniper_Elite</span>
                <span className="px-1.5 py-0.5 rounded bg-solana-teal/20 text-[10px] text-primary font-bold uppercase border border-solana-teal/30">Active</span>
              </div>
              <div className="flex gap-2 items-center text-[11px] text-on-surface-variant mb-3 font-semibold">
                <span className="material-symbols-outlined text-xs">group</span> 14 Wallets
                <span className="material-symbols-outlined text-xs">history</span> Last active: 2m ago
              </div>
              <div className="flex items-center justify-between">
                <div className="flex -space-x-2">
                  <div className="w-6 h-6 rounded-full bg-surface-dim border border-outline ring-2 ring-surface flex items-center justify-center text-[10px] font-bold">W1</div>
                  <div className="w-6 h-6 rounded-full bg-surface-dim border border-outline ring-2 ring-surface flex items-center justify-center text-[10px] font-bold">W2</div>
                  <div className="w-6 h-6 rounded-full bg-surface-dim border border-outline ring-2 ring-surface flex items-center justify-center text-[10px] font-bold">W3</div>
                  <div className="w-6 h-6 rounded-full bg-primary border border-outline ring-2 ring-surface flex items-center justify-center text-[10px] font-bold text-on-primary">+11</div>
                </div>
                <div className="text-right">
                  <p className="text-[10px] uppercase font-bold text-on-surface-variant">Net Balance</p>
                  <p className="text-xs font-mono text-status-success font-semibold">+$2.14M</p>
                </div>
              </div>
            </div>
            {/* Cluster 2 */}
            <div className="p-3 border border-outline-variant rounded-lg bg-surface-container-low hover:border-primary transition-colors cursor-pointer group">
              <div className="flex justify-between items-start mb-2">
                <span className="text-sm font-bold group-hover:text-primary transition-colors">Polygon_Insiders</span>
                <span className="px-1.5 py-0.5 rounded bg-polymarket-violet/20 text-[10px] text-primary font-bold uppercase border border-polymarket-violet/30">Idle</span>
              </div>
              <div className="flex gap-2 items-center text-[11px] text-on-surface-variant mb-3 font-semibold">
                <span className="material-symbols-outlined text-xs">group</span> 5 Wallets
                <span className="material-symbols-outlined text-xs">history</span> Last active: 4h ago
              </div>
              <div className="flex items-center justify-between">
                <div className="flex -space-x-2">
                  <div className="w-6 h-6 rounded-full bg-surface-dim border border-outline ring-2 ring-surface flex items-center justify-center text-[10px] font-bold">P1</div>
                  <div className="w-6 h-6 rounded-full bg-primary border border-outline ring-2 ring-surface flex items-center justify-center text-[10px] font-bold text-on-primary">+4</div>
                </div>
                <div className="text-right">
                  <p className="text-[10px] uppercase font-bold text-on-surface-variant">Net Balance</p>
                  <p className="text-xs font-mono text-on-surface font-semibold">+$412k</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 3. Chain Telemetry Widget */}
        <section className="col-span-12 lg:col-span-4 bg-surface border border-outline-variant rounded-xl shadow-sm h-[320px] flex flex-col">
          <div className="px-4 py-3 border-b border-outline-variant flex items-center justify-between bg-surface-container-lowest">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary">monitoring</span>
              <h3 className="text-[11px] font-bold text-primary uppercase tracking-wider">Chain Ingestion Health</h3>
            </div>
          </div>
          <div className="p-4 flex-1 flex flex-col justify-around">
            <div className="space-y-4">
              {ingestionItems.map((item) => {
                const meta = INGESTION_CHAINS.find(({ chain }) => chain === item.chain)!;
                const tone = item.status === 'healthy'
                  ? 'text-status-success'
                  : item.status === 'stale'
                    ? 'text-status-warning'
                    : 'text-status-error';
                const width = item.status === 'healthy' ? '100%' : item.status === 'stale' ? '55%' : '0%';
                const bar = item.status === 'healthy' ? meta.bar : item.status === 'stale' ? 'bg-status-warning' : 'bg-status-error';
                return (
                  <div key={item.chain}>
                    <div className="flex justify-between items-center mb-1 gap-3">
                      <span className="text-[11px] font-bold">{meta.label}</span>
                      <span className={`font-mono text-[11px] font-bold ${tone}`}>{formatIngestionLag(item.lagSeconds)}</span>
                    </div>
                    <div className="h-1.5 w-full bg-surface-container-high rounded-full overflow-hidden">
                      <div className={`h-full ${bar}`} style={{ width }}></div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="pt-4 border-t border-outline-variant/30 flex items-center justify-between text-[11px] text-on-surface-variant font-bold">
              <span>UPDATED: {ingestionUpdatedAt}</span>
              <span className={`flex items-center gap-1 ${ingestionSummary.tone}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${ingestionSummary.dot}`}></span> {ingestionSummary.label}
              </span>
            </div>
          </div>
        </section>

        {/* 4. Quick Execution Tile */}
        <section className="col-span-12 lg:col-span-5 bg-primary text-on-primary border border-outline-variant rounded-xl shadow-md h-[320px] p-6 flex flex-col justify-between overflow-hidden relative">
          {/* Subtle background noise/grid */}
          <div className="absolute inset-0 opacity-10 pointer-events-none" style={{ backgroundImage: 'radial-gradient(circle, #fff 1px, transparent 1px)', backgroundSize: '20px 20px' }}></div>
          <div className="relative z-10">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-solana-teal">bolt</span>
                <h3 className="text-[11px] font-bold text-surface-container-highest uppercase tracking-wider">Terminal Snipe</h3>
              </div>
              <span className="px-2 py-1 bg-on-primary-fixed text-primary rounded text-[10px] font-bold">PAPER MODE</span>
            </div>
            <div className="space-y-1 mb-6">
              <p className="text-[11px] text-on-primary-container font-bold tracking-wider">TARGET ASSET</p>
              <h4 className="text-2xl font-bold tracking-tight">$WAKE_DEGEN</h4>
              <p className="text-xs font-mono text-on-primary-container opacity-80">SOL: 0x937...f9a1</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="p-3 bg-white/10 rounded-lg border border-white/10">
                <p className="text-[10px] text-on-primary-container font-bold uppercase tracking-wider">Confidence</p>
                <p className="text-[18px] font-bold text-status-success">98.2%</p>
              </div>
              <div className="p-3 bg-white/10 rounded-lg border border-white/10">
                <p className="text-[10px] text-on-primary-container font-bold uppercase tracking-wider">Whales Buying</p>
                <p className="text-[18px] font-bold text-on-primary">12</p>
              </div>
            </div>
          </div>
          <div className="relative z-10 pt-4">
            <button className="w-full py-3 bg-solana-teal text-primary text-xs font-bold rounded-lg shadow-lg hover:brightness-110 active:scale-[0.98] transition-all flex items-center justify-center gap-2 uppercase tracking-wide">
              <span className="material-symbols-outlined">rocket_launch</span> Execute Pinned Signal
            </button>
          </div>
        </section>

        {/* 5. Recent Performance Sparklines */}
        <section className="col-span-12 lg:col-span-3 bg-surface border border-outline-variant rounded-xl shadow-sm h-[320px] flex flex-col">
          <div className="px-4 py-3 border-b border-outline-variant flex items-center justify-between bg-surface-container-lowest">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary">insights</span>
              <h3 className="text-[11px] font-bold text-primary uppercase tracking-wider">Performance (1H)</h3>
            </div>
          </div>
          <div className="p-4 flex-1 flex flex-col space-y-6">
            {/* Sparkline 1: Paper */}
            <div className="space-y-1">
              <div className="flex justify-between items-end">
                <p className="text-[11px] text-on-surface-variant font-bold tracking-wider">PAPER TRADES</p>
                <p className="text-lg font-bold text-status-success">+4.2%</p>
              </div>
              {/* Mock Sparkline with CSS */}
              <div className="h-12 flex items-end gap-1 px-1">
                <div className="flex-1 bg-status-success/20 rounded-t h-4 animate-pulse"></div>
                <div className="flex-1 bg-status-success/20 rounded-t h-6"></div>
                <div className="flex-1 bg-status-success/20 rounded-t h-5"></div>
                <div className="flex-1 bg-status-success/20 rounded-t h-8"></div>
                <div className="flex-1 bg-status-success/20 rounded-t h-10"></div>
                <div className="flex-1 bg-status-success/20 rounded-t h-7"></div>
                <div className="flex-1 bg-status-success/20 rounded-t h-11"></div>
                <div className="flex-1 bg-status-success rounded-t h-12"></div>
              </div>
            </div>
            {/* Sparkline 2: Live */}
            <div className="space-y-1">
              <div className="flex justify-between items-end">
                <p className="text-[11px] text-on-surface-variant font-bold tracking-wider">LIVE EXECUTION</p>
                <p className="text-lg font-bold text-on-surface-variant">-- %</p>
              </div>
              <div className="h-12 flex items-center justify-center px-1 border border-dashed border-outline-variant rounded-lg bg-surface-container-low">
                <span className="text-[11px] text-on-surface-variant italic font-semibold">No live orders active</span>
              </div>
            </div>
            <div className="pt-4 border-t border-outline-variant/30 text-center">
              <p className="text-xs text-primary hover:underline cursor-pointer font-bold">View full attribution reports</p>
            </div>
          </div>
        </section>
      </div>

      {/* FLOATING CHAT/COMMAND ACTION */}
      <div className="fixed bottom-6 right-6 z-50">
        <button className="w-14 h-14 bg-primary rounded-full shadow-2xl flex items-center justify-center text-on-primary hover:scale-105 active:scale-95 transition-transform group relative">
          <span className="material-symbols-outlined text-[28px]">smart_toy</span>
          <div className="absolute right-16 px-4 py-2 bg-inverse-surface text-inverse-on-surface text-xs rounded-lg shadow-xl opacity-0 translate-x-4 pointer-events-none group-hover:opacity-100 group-hover:translate-x-0 transition-all whitespace-nowrap">
            Ask WAKE Assistant
          </div>
        </button>
      </div>

      {/* NOTIFICATION TOAST */}
      {showToast && (
        <div className="fixed top-20 right-6 z-[60] bg-surface-container-lowest border border-outline-variant p-4 rounded-xl shadow-xl max-w-sm flex gap-4 animate-in slide-in-from-right duration-500">
          <div className="w-10 h-10 bg-status-success/10 rounded-full flex items-center justify-center text-status-success shrink-0">
            <span className="material-symbols-outlined">check_circle</span>
          </div>
          <div>
            <h4 className="text-sm font-bold text-primary">Execution Successful</h4>
            <p className="text-xs text-on-surface-variant mt-1 leading-relaxed">Paper fill for 10.0 SOL completed at $152.11. Latency: 1.2s</p>
            <div className="mt-2 flex gap-3">
              <button className="text-[11px] text-primary font-bold hover:underline uppercase tracking-wider">VIEW TX</button>
              <button 
                onClick={() => setShowToast(false)}
                className="text-[11px] text-on-surface-variant font-bold hover:underline uppercase tracking-wider"
              >
                DISMISS
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
