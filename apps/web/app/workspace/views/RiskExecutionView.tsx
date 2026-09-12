'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../../lib/api.js';
import { describeApiError } from '../../../lib/api-error-message.js';

const CHAINS = ['solana', 'polygon', 'robinhood-chain'] as const;
const MODES = ['off', 'paper', 'live', 'live+shadow'] as const;

type Chain = (typeof CHAINS)[number];
type ExecutionMode = (typeof MODES)[number];

interface ChainModeStatus {
  requestedMode: ExecutionMode;
  effectiveMode: ExecutionMode;
  certified: boolean;
  reason?: string;
}

interface TradingStatus {
  modes: Record<Chain, ChainModeStatus>;
  killSwitchActive: boolean;
}

const chainLabels: Record<Chain, string> = {
  solana: 'Solana',
  polygon: 'Polygon / Polymarket',
  'robinhood-chain': 'Robinhood Chain'
};

const modeLabels: Record<ExecutionMode, string> = {
  off: 'Off',
  paper: 'Paper',
  live: 'Live',
  'live+shadow': 'Live + Shadow'
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExecutionMode(value: unknown): value is ExecutionMode {
  return typeof value === 'string' && MODES.some((mode) => mode === value);
}

function parseChainModeStatus(value: unknown): ChainModeStatus | null {
  if (!isRecord(value)
    || !isExecutionMode(value.requestedMode)
    || !isExecutionMode(value.effectiveMode)
    || typeof value.certified !== 'boolean'
    || (value.reason !== undefined && typeof value.reason !== 'string')) {
    return null;
  }

  return {
    requestedMode: value.requestedMode,
    effectiveMode: value.effectiveMode,
    certified: value.certified,
    ...(value.reason === undefined ? {} : { reason: value.reason })
  };
}

function parseTradingStatus(value: unknown): TradingStatus | null {
  if (!isRecord(value) || !isRecord(value.modes) || typeof value.killSwitchActive !== 'boolean') {
    return null;
  }

  const rawModes = value.modes;
  const entries = CHAINS.map((chain) => [chain, parseChainModeStatus(rawModes[chain])] as const);
  if (entries.some(([, status]) => status === null)) return null;

  return {
    modes: Object.fromEntries(entries) as Record<Chain, ChainModeStatus>,
    killSwitchActive: value.killSwitchActive
  };
}

/**
 * The non-2xx branch moved into `apiFetch`, which throws `ApiError` with the
 * status attached. What is left is the shape check, which still has to happen
 * here: a 200 carrying a payload we cannot parse is not a success.
 */
function readStatus(payload: unknown): TradingStatus {
  const status = parseTradingStatus(payload);
  if (!status) throw new Error('Trading control returned an invalid status payload');
  return status;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return describeApiError(error, 'Trading control request failed');
  if (error instanceof Error) return error.message;
  return 'Trading control request failed';
}

export default function RiskExecutionView() {
  const [status, setStatus] = useState<TradingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingChain, setPendingChain] = useState<Chain | null>(null);
  const [emergencyPending, setEmergencyPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const nextStatus = readStatus(await api.get('/v1/trading/status', { signal }));
      setStatus(nextStatus);
      setError(null);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(errorMessage(caught));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchStatus(controller.signal);
    const interval = window.setInterval(() => {
      void fetchStatus(controller.signal);
    }, 5_000);

    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [fetchStatus]);

  const updateMode = async (chain: Chain, mode: ExecutionMode): Promise<void> => {
    setPendingChain(chain);
    setError(null);
    try {
      setStatus(readStatus(await api.post('/v1/trading/mode', { chain, mode })));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPendingChain(null);
    }
  };

  const activateEmergencyOff = async (): Promise<void> => {
    setEmergencyPending(true);
    setError(null);
    try {
      setStatus(readStatus(await api.post('/v1/trading/emergency-off')));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setEmergencyPending(false);
    }
  };

  const confirmEmergencyOff = (): void => {
    const confirmed = window.confirm(
      'Disable new execution on all chains? This does not liquidate or claim that open positions were closed.'
    );
    if (confirmed) void activateEmergencyOff();
  };

  const mutationPending = pendingChain !== null || emergencyPending;

  return (
    <div className="mx-auto max-w-[1440px] space-y-6 p-6">
      <section className="grid grid-cols-1 gap-6 md:grid-cols-12">
        <div className="rounded-lg border border-outline-variant bg-surface-container-lowest p-5 shadow-sm md:col-span-8">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <div className="flex items-center gap-4">
              <div className={`flex h-10 w-10 items-center justify-center rounded-full ${status?.killSwitchActive ? 'bg-secondary/15 text-secondary' : 'bg-error/10 text-error'}`}>
                <span className="material-symbols-outlined font-bold">bolt</span>
              </div>
              <div>
                <h3 className="text-sm font-bold text-primary">All-chain emergency off</h3>
                <p className="text-xs text-secondary">
                  Atomically stores <code>{'{"*":"off"}'}</code>. Executors honor it within one 30-second config TTL.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={confirmEmergencyOff}
              disabled={mutationPending || status?.killSwitchActive === true}
              className="flex items-center justify-center gap-2 rounded bg-error px-6 py-3 text-[10px] font-bold uppercase text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-sm">gavel</span>
              {emergencyPending ? 'Applying…' : status?.killSwitchActive ? 'Emergency off active' : 'Emergency off'}
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-outline-variant bg-surface-container-low p-4 md:col-span-4">
          <p className="mb-1 text-[10px] font-bold tracking-wider text-secondary">CONTROL STATUS</p>
          <p className={`flex items-center gap-2 text-xs font-bold ${error ? 'text-status-error' : status?.killSwitchActive ? 'text-status-warning' : 'text-status-success'}`}>
            <span className={`h-2 w-2 rounded-full ${error ? 'bg-status-error' : status?.killSwitchActive ? 'bg-status-warning' : 'bg-status-success'}`} />
            {loading && !status
              ? 'LOADING'
              : error
                ? 'STATUS UNAVAILABLE'
                : status?.killSwitchActive
                  ? 'ALL CHAINS OFF'
                  : 'API STATUS CURRENT'}
          </p>
          <p className="mt-2 text-[10px] text-secondary">The matrix refreshes from the authenticated API every five seconds.</p>
        </div>
      </section>

      {error && (
        <section role="alert" className="flex items-center justify-between gap-4 rounded-lg border border-error/30 bg-error/5 p-4">
          <div>
            <p className="text-xs font-bold text-error">Trading control update failed</p>
            <p className="mt-1 text-xs text-secondary">{error}. Existing values below are the last confirmed API state.</p>
          </div>
          <button
            type="button"
            onClick={() => { void fetchStatus(); }}
            className="rounded border border-error px-4 py-2 text-[10px] font-bold uppercase text-error"
          >
            Retry
          </button>
        </section>
      )}

      <section className="space-y-4">
        <div>
          <h3 className="text-[10px] font-bold uppercase tracking-widest text-secondary">Execution matrix</h3>
          <p className="mt-1 text-xs text-secondary">Requested modes are independent. Effective modes include live certification and emergency clamps.</p>
        </div>
        <div className="overflow-x-auto rounded-lg border border-outline-variant bg-surface-container-lowest shadow-sm">
          <table className="w-full min-w-[760px] border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-outline-variant bg-surface-container-low text-[10px] font-bold text-secondary">
                <th className="p-4">CHAIN</th>
                <th className="p-4">LIVE READINESS</th>
                <th className="p-4">REQUESTED MODE</th>
                <th className="p-4">EFFECTIVE MODE</th>
                <th className="p-4">CLAMP / RESOLUTION</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {CHAINS.map((chain) => {
                const chainStatus = status?.modes[chain];
                return (
                  <tr key={chain} className="transition-colors hover:bg-surface-container-low/50">
                    <td className="p-4">
                      <p className="text-xs font-bold text-primary">{chainLabels[chain]}</p>
                      <p className="mt-1 font-mono text-[10px] text-secondary">{chain}</p>
                    </td>
                    <td className="p-4">
                      {chainStatus ? (
                        <span className={`inline-flex rounded px-2 py-0.5 text-[10px] font-bold ${chainStatus.certified ? 'bg-status-success/10 text-status-success' : 'bg-status-warning/10 text-status-warning'}`}>
                          {chainStatus.certified ? 'CERTIFIED' : 'NOT CERTIFIED'}
                        </span>
                      ) : (
                        <span className="text-xs text-secondary">Unavailable</span>
                      )}
                    </td>
                    <td className="p-4">
                      <div className="flex w-fit rounded border border-outline-variant bg-surface-container-low p-0.5">
                        {MODES.map((mode) => (
                          <button
                            type="button"
                            key={mode}
                            onClick={() => { void updateMode(chain, mode); }}
                            disabled={!chainStatus || mutationPending}
                            className={`rounded px-3 py-1 text-[10px] font-bold transition-all disabled:cursor-not-allowed disabled:opacity-50 ${chainStatus?.requestedMode === mode ? 'bg-primary text-white' : 'text-secondary hover:text-primary'}`}
                          >
                            {modeLabels[mode]}
                          </button>
                        ))}
                      </div>
                    </td>
                    <td className="p-4">
                      <span className="text-xs font-bold text-primary">
                        {chainStatus ? modeLabels[chainStatus.effectiveMode] : 'Unavailable'}
                      </span>
                      {pendingChain === chain && <p className="mt-1 text-[10px] text-secondary">Updating…</p>}
                    </td>
                    <td className="max-w-[360px] p-4">
                      <p className={`text-xs ${chainStatus?.reason ? 'text-status-warning' : 'text-secondary'}`}>
                        {chainStatus?.reason ?? (chainStatus ? 'Requested mode is effective' : 'No confirmed API status')}
                      </p>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-status-warning/30 bg-status-warning/5 p-4">
        <div className="flex items-start gap-3">
          <span className="material-symbols-outlined text-status-warning">verified_user</span>
          <div>
            <h4 className="text-xs font-bold text-status-warning">Live modes remain evidence-gated</h4>
            <p className="mt-1 text-xs leading-relaxed text-secondary">
              Selecting Live or Live + Shadow changes the requested mode only. The API keeps the effective mode at Paper until both operator opt-in and a current reviewed chain certification are present.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
