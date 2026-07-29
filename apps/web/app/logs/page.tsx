'use client';

import { useState, useEffect, useRef } from 'react';

type LogItem = {
  timestamp: string;
  service: string;
  level: 'info' | 'error';
  message: string;
};

const API_KEY = process.env.NEXT_PUBLIC_API_KEY ?? 'swat-dev-key';

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ??
  (typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname}:3001`
    : 'http://localhost:3001');

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
  const terminalEndRef = useRef<HTMLDivElement | null>(null);

  // Fetch initial history
  useEffect(() => {
    async function fetchLogs() {
      try {
        const res = await fetch(`${API_BASE}/v1/logs`, {
          headers: { 'x-api-key': API_KEY }
        });
        if (res.ok) {
          const data = await res.json();
          // Redis logs are pushed to list head (LIFO), reverse to chronological (oldest to newest)
          setLogs(data.items ? data.items.reverse() : []);
        }
      } catch (err) {
        console.error('Failed to fetch logs history', err);
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
        // Fetch a one-time ticket for SSE authentication
        const res = await fetch(`${API_BASE}/v1/auth/ticket`, {
          method: 'POST',
          headers: { 'x-api-key': API_KEY }
        });
        if (!res.ok) throw new Error('Failed to get SSE ticket');
        const data = await res.json();
        ticket = data.ticket;
      } catch (err) {
        console.error('SSE Ticket Error:', err);
        setStatus('disconnected');
        clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(connectStream, 3000);
        return;
      }
      
      eventSource = new EventSource(`${API_BASE}/v1/logs/stream?ticket=${ticket}`);

      eventSource.onopen = () => {
        setStatus('connected');
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
    <main style={{ maxWidth: '100%', padding: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ margin: 0 }}>System Logs</h1>
          <p style={{ color: 'var(--text-secondary)', margin: '0.25rem 0 0 0' }}>
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
            <p style={{ color: 'var(--text-secondary)' }}>No logs match filter rules.</p>
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
  );
}
