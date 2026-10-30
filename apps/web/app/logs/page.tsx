'use client';

import { useState, useEffect, useRef } from 'react';
import { AdminNav } from '../../components/AdminNav.js';
import { api, ApiError, resolveApiBase } from '../../lib/api.js';
import { describeApiError } from '../../lib/api-error-message.js';

type LogItem = {
  timestamp: string;
  service: string;
  level: 'info' | 'error';
  message: string;
};

/**
 * The SSE stream is the one call that cannot go through `lib/api.ts`.
 *
 * `EventSource` sets no request headers -- that is why the one-time ticket flow
 * exists at all. So this page needs the API origin as a string, and takes it
 * from the same `resolveApiBase` the client uses rather than re-deriving it, so
 * the history request and the stream can never end up pointed at different hosts.
 */
function apiBase(): string {
  return resolveApiBase(
    typeof window === 'undefined'
      ? null
      : { protocol: window.location.protocol, hostname: window.location.hostname }
  );
}

const SERVICE_COLORS: Record<string, string> = {
  api: '#60a5fa',            // blue
  indexer: '#34d399',        // emerald
  scorer: '#fbbf24',         // amber
  'signal-engine': '#a78bfa', // purple
  'trade-executor': '#f472b6', // pink
  'alert-service': '#fb7185', // rose
  unknown: '#94a3b8'         // slate
};

export default function LogsPage() {
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [serviceFilter, setServiceFilter] = useState<string>('all');
  const [levelFilter, setLevelFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  // Two separate failures, because they have different consequences: history can
  // fail while the stream works (you see new lines but no backlog) and the stream
  // can fail while history works (you see a frozen snapshot). Collapsing them
  // into one message would misdescribe whichever half is actually broken.
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const terminalEndRef = useRef<HTMLDivElement | null>(null);

  // Fetch initial history
  useEffect(() => {
    async function fetchLogs() {
      try {
        const data = await api.get<{ items?: LogItem[] }>('/v1/logs');
        // Redis logs are pushed to list head (LIFO), reverse to chronological (oldest to newest)
        setLogs(data?.items ? data.items.reverse() : []);
        setHistoryError(null);
      } catch (err: unknown) {
        // Was console-only, which rendered an auth failure as 'No logs match
        // filter rules.' -- an empty terminal that looks like a quiet system.
        const message = describeApiError(err, 'Failed to fetch log history');
        console.error(message, err);
        setHistoryError(message);
      } finally {
        setLoading(false);
      }
    }
    fetchLogs();
  }, []);

  // Connect to SSE Live Stream
  useEffect(() => {
    let eventSource: EventSource | null = null;
    let reconnectTimeout: any = null;

    async function connectStream() {
      setStatus('connecting');
      let ticket = '';
      try {
        // A one-time ticket, because EventSource cannot carry a header. The POST
        // itself goes through the client so it picks up the CSRF token.
        const data = await api.post<{ ticket?: string }>('/v1/auth/ticket');
        if (!data?.ticket) throw new Error('Ticket response carried no ticket');
        ticket = data.ticket;
      } catch (err: unknown) {
        // `POST /v1/auth/ticket` requires role=admin, so a signed-in non-admin
        // gets a 403 here. The generic 'not permitted' wording does not explain
        // why the terminal below stopped updating, so say it in terms of the
        // stream: everything else on this page still works for them.
        const message = err instanceof ApiError && err.isForbidden
          ? 'Live streaming requires an admin account. The history below is still current as of page load.'
          : describeApiError(err, 'Could not start the live log stream');
        console.error(message, err);
        setStreamError(message);
        setStatus('disconnected');
        // Do not reconnect on 401/403. The old code retried every three seconds
        // forever, so an expired session became an indefinite loop of failing
        // POSTs; middleware will move the operator to /login on their next
        // navigation, and hammering the API until then achieves nothing. A 403
        // will never resolve on its own at all -- the role does not change mid-session.
        if (err instanceof ApiError && (err.isUnauthenticated || err.isForbidden)) return;
        clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(connectStream, 3000);
        return;
      }

      eventSource = new EventSource(`${apiBase()}/v1/logs/stream?ticket=${encodeURIComponent(ticket)}`);

      eventSource.onopen = () => {
        setStatus('connected');
        setStreamError(null);
      };

      eventSource.onmessage = (event) => {
        try {
          const newLog = JSON.parse(event.data) as LogItem;
          // Malformed log handling: skip if not an object or missing required fields
          if (!newLog || typeof newLog !== 'object' || !newLog.timestamp || !newLog.message) {
            return;
          }
          setLogs((prev) => {
            const updated = [...prev, newLog];
            // Cap at 1000 items in browser memory to avoid leakage
            if (updated.length > 1000) {
              return updated.slice(updated.length - 1000);
            }
            return updated;
          });
        } catch (e) {
          console.error('Failed to parse incoming log', e);
        }
      };

      eventSource.onerror = (err) => {
        console.error('SSE Error:', err);
        setStatus('disconnected');
        eventSource?.close();
        
        // Retry cleanup: ensure we clear before setting to prevent multiple loops
        clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(connectStream, 3000);
      };
    }

    connectStream();

    return () => {
      eventSource?.close();
      clearTimeout(reconnectTimeout);
    };
  }, []);

  // Handle auto scrolling
  useEffect(() => {
    if (autoScroll && terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  // Clean logs function
  const clearLogs = () => {
    setLogs([]);
  };

  // Filter logs
  const filteredLogs = logs.filter((log) => {
    if (serviceFilter !== 'all' && log.service !== serviceFilter) return false;
    if (levelFilter !== 'all' && log.level !== levelFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchMsg = log.message?.toLowerCase().includes(q);
      const matchService = log.service?.toLowerCase().includes(q);
      return matchMsg || matchService;
    }
    return true;
  });

  return (
    <div className="min-h-screen bg-background text-on-background antialiased font-sans">
      <AdminNav />
      <main className="max-w-[1440px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <h1 className="font-headline-lg text-2xl font-bold tracking-tight text-primary">System Logs</h1>
            <p className="text-body-sm text-on-surface-variant mb-4">
              Real-time live streaming logs from the SWAT backend microservices.
            </p>
          </div>

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          {status === 'connected' && <span className="badge success" style={{ background: 'rgba(16, 185, 129, 0.1)' }}>● Stream Live</span>}
          {status === 'connecting' && <span className="badge warning" style={{ background: 'rgba(245, 158, 11, 0.1)' }}>⚡ Reconnecting...</span>}
          {status === 'disconnected' && <span className="badge danger" style={{ background: 'rgba(239, 68, 68, 0.1)' }}>✖ Connection Offline</span>}
          
          <button
            onClick={clearLogs}
            style={{
              padding: '0.5rem 1rem',
              background: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid var(--danger)',
              color: 'var(--danger)',
              borderRadius: '6px',
              cursor: 'pointer',
              fontWeight: 600
            }}
          >
            Clear Screen
          </button>
        </div>
      </div>

      {/* A badge reading 'Connection Offline' does not say whether the operator
          should sign in again, ask for admin, or wait for the API to come back. */}
      {streamError && (
        <div
          className="card"
          style={{
            marginTop: '1rem',
            padding: '0.75rem 1rem',
            background: 'rgba(239, 68, 68, 0.1)',
            borderColor: 'var(--danger)'
          }}
        >
          <p style={{ color: 'var(--danger)', margin: 0, fontSize: '0.9rem' }}>{streamError}</p>
        </div>
      )}

      {/* Control bar */}
      <div className="card" style={{ marginTop: '1.5rem', padding: '1rem', background: 'rgba(15, 20, 35, 0.5)' }}>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ flex: '1 1 250px' }}>
            <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>Search Logs</label>
            <input
              type="text"
              placeholder="Filter by keyword..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: '100%',
                padding: '0.5rem',
                background: 'rgba(0, 0, 0, 0.3)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                color: 'white',
                fontSize: '0.9rem'
              }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>Service</label>
            <select
              value={serviceFilter}
              onChange={(e) => setServiceFilter(e.target.value)}
              style={{
                padding: '0.5rem',
                background: 'rgba(0, 0, 0, 0.3)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                color: 'white',
                fontSize: '0.9rem',
                cursor: 'pointer'
              }}
            >
              <option value="all">All Services</option>
              <option value="api">api</option>
              <option value="indexer">indexer</option>
              <option value="scorer">scorer</option>
              <option value="signal-engine">signal-engine</option>
              <option value="trade-executor">trade-executor</option>
              <option value="alert-service">alert-service</option>
            </select>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>Level</label>
            <select
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value)}
              style={{
                padding: '0.5rem',
                background: 'rgba(0, 0, 0, 0.3)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                color: 'white',
                fontSize: '0.9rem',
                cursor: 'pointer'
              }}
            >
              <option value="all">All Levels</option>
              <option value="info">info</option>
              <option value="error">error</option>
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', height: '100%', marginTop: '1.25rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', fontSize: '0.9rem' }}>
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
                style={{ marginRight: '0.5rem', cursor: 'pointer' }}
              />
              Auto-Scroll
            </label>
          </div>
        </div>
      </div>

      {/* Terminal window */}
      <div
        style={{
          marginTop: '1rem',
          background: '#040711',
          border: '1px solid var(--border-color)',
          borderRadius: '10px',
          height: '60vh',
          overflowY: 'auto',
          overflowX: 'auto',
          padding: '1rem',
          fontFamily: 'Consolas, Monaco, "Courier New", Courier, monospace',
          fontSize: '0.85rem',
          lineHeight: '1.4',
          boxShadow: 'inset 0 4px 10px rgba(0,0,0,0.8)'
        }}
      >
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
            <p style={{ color: 'var(--text-secondary)' }}>Loading logs history...</p>
          </div>
        ) : filteredLogs.length === 0 ? (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
            <p style={{ color: historyError ? '#f87171' : 'var(--text-secondary)' }}>
              {historyError ?? 'No logs match filter rules.'}
            </p>
          </div>
        ) : (
          filteredLogs.map((log, index) => {
            const svcColor = SERVICE_COLORS[log.service] || SERVICE_COLORS.unknown;
            const isError = log.level === 'error';
            return (
              <div
                key={`${log.timestamp}-${log.service}-${index}`}
                style={{
                  display: 'flex',
                  gap: '0.75rem',
                  padding: '0.15rem 0',
                  borderBottom: '1px solid rgba(255,255,255,0.02)',
                  color: isError ? '#f87171' : '#e2e8f0',
                  alignItems: 'flex-start'
                }}
              >
                {/* Timestamp */}
                <span style={{ color: '#64748b', flexShrink: 0 }}>
                  [{new Date(log.timestamp).toLocaleTimeString()}]
                </span>

                {/* Service Tag */}
                <span
                  style={{
                    color: svcColor,
                    fontWeight: 'bold',
                    flexShrink: 0,
                    width: '110px',
                    display: 'inline-block'
                  }}
                >
                  [{log.service.substring(0, 12)}]
                </span>

                {/* Level Tag */}
                {isError && (
                  <span
                    style={{
                      background: 'rgba(239, 68, 68, 0.2)',
                      color: '#f87171',
                      padding: '0 0.25rem',
                      borderRadius: '3px',
                      fontSize: '0.75rem',
                      fontWeight: 'bold',
                      textTransform: 'uppercase',
                      flexShrink: 0
                    }}
                  >
                    ERR
                  </span>
                )}

                {/* Message */}
                <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {log.message}
                </span>
              </div>
            );
          })
        )}
        <div ref={terminalEndRef} />
      </div>
    </main>
  </div>
);
}
