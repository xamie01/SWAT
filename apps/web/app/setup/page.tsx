'use client';

import { useState, useEffect } from 'react';
import { api } from '../../lib/api.js';
import { describeApiError } from '../../lib/api-error-message.js';

export default function SetupPage() {
  const [loading, setLoading] = useState(false);
  const [scorerLoading, setScorerLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [tokenMint, setTokenMint] = useState('');
  const [blacklist, setBlacklist] = useState<string[]>([]);
  const [newBlacklistMint, setNewBlacklistMint] = useState('');

  // Fetch blacklist config on load
  useEffect(() => {
    async function fetchConfig() {
      try {
        const config = await api.get<{ blacklist?: unknown }>('/v1/config');
        const rawValue = config?.blacklist;
        if (rawValue) {
          let parsedList: string[] = [];
          if (Array.isArray(rawValue)) {
            parsedList = rawValue;
          } else if (typeof rawValue === 'string') {
            try {
              const parsed = JSON.parse(rawValue);
              parsedList = Array.isArray(parsed) ? parsed : [parsed];
            } catch {
              parsedList = rawValue.trim().startsWith('[')
                ? []
                : rawValue.split(',').map((s: string) => s.trim());
            }
          }
          setBlacklist(parsedList);
        } else {
          setBlacklist([]);
        }
      } catch (err: unknown) {
        // Surfaced in the error banner rather than only the console: a 401 here
        // means the blacklist shown below is not the saved one, and silently
        // rendering an empty list invites the operator to re-add every entry.
        setError(describeApiError(err, 'Failed to load configuration'));
      }
    }
    fetchConfig();
  }, []);

  const addToBlacklist = async (e: React.FormEvent) => {
    e.preventDefault();
    const mint = newBlacklistMint.trim();
    if (!mint) return;
    if (blacklist.includes(mint)) {
      setError('Token address is already blacklisted');
      return;
    }

    const updatedList = [...blacklist, mint];
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      await api.post('/v1/config', { blacklist: updatedList });
      setBlacklist(updatedList);
      setNewBlacklistMint('');
      setSuccess(`Added token ${mint.substring(0, 8)}... to blacklist.`);
    } catch (err: unknown) {
      setError(describeApiError(err, 'Failed to save blacklist configuration'));
    } finally {
      setLoading(false);
    }
  };

  const removeFromBlacklist = async (mint: string) => {
    const updatedList = blacklist.filter(item => item !== mint);
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      await api.post('/v1/config', { blacklist: updatedList });
      setBlacklist(updatedList);
      setSuccess(`Removed token ${mint.substring(0, 8)}... from blacklist.`);
    } catch (err: unknown) {
      setError(describeApiError(err, 'Failed to save blacklist configuration'));
    } finally {
      setLoading(false);
    }
  };

  const triggerScorer = async () => {
    setScorerLoading(true);
    setError('');
    setSuccess('');

    try {
      await api.post('/v1/scorer/run', {});

      setSuccess('Scorer batch run successfully triggered in the background. Calculating wallet metrics, tiers, and generating clusters now.');
    } catch (err: unknown) {
      setError(describeApiError(err, 'Failed to trigger scorer'));
    } finally {
      setScorerLoading(false);
    }
  };

  const triggerDiscovery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tokenMint.trim()) return;

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const data = await api.post<{ tokenMint?: string }>('/v1/discovery/from-token', {
        tokenMint: tokenMint.trim()
      });

      setSuccess(
        `Token discovery queued for ${data?.tokenMint}. ` +
        `Early and biggest buyers will be backfilled, scored, and clustered automatically.`
      );
      setTokenMint('');
    } catch (err: unknown) {
      setError(describeApiError(err, 'Failed to trigger discovery'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main>
      <h1>Setup & Administration</h1>
      <p style={{ color: 'var(--text-secondary)' }}>
        Bootstrap the intelligence layer and trigger batch jobs.
      </p>

      {error && (
        <div className="card" style={{ background: 'rgba(239, 68, 68, 0.1)', borderColor: 'var(--danger)', marginTop: '1rem' }}>
          <p style={{ color: 'var(--danger)', margin: 0 }}>{error}</p>
        </div>
      )}

      {success && (
        <div className="card" style={{ background: 'rgba(16, 185, 129, 0.1)', borderColor: 'var(--success)', marginTop: '1rem' }}>
          <p style={{ color: 'var(--success)', margin: 0 }}>{success}</p>
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: '1fr', marginTop: '2rem' }}>
        {/* Scorer status card */}
        <div className="card">
          <h3>Step 2: Run Scorer Batch</h3>
          <p style={{ color: 'var(--text-secondary)', margin: '1rem 0' }}>
            The scorer computes wallet metrics, assigns tiers, and generates clusters from tracked wallets.
            By default it runs at <strong>02:00 UTC</strong> daily.
          </p>
          <button
            onClick={triggerScorer}
            disabled={scorerLoading}
            style={{
              padding: '0.75rem 1.5rem',
              background: 'var(--warning)',
              color: 'black',
              border: 'none',
              borderRadius: '8px',
              fontWeight: 600,
              cursor: scorerLoading ? 'not-allowed' : 'pointer',
              opacity: scorerLoading ? 0.5 : 1,
              marginTop: '1rem'
            }}
          >
            {scorerLoading ? 'Running Scorer...' : 'Run Scorer Batch Now'}
          </button>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '1rem' }}>
            After the scorer runs, check <a href="/clusters" style={{ color: 'var(--accent)' }}>Clusters</a> to verify clusters were generated.
          </p>
        </div>

        {/* Discovery form */}
        <div className="card">
          <h3>Step 3: Discover Wallets from Token</h3>
          <p style={{ color: 'var(--text-secondary)', margin: '1rem 0' }}>
            Auto-discover profitable wallets that bought a token early (within 10 min of launch, &gt;0.5 SOL invested).
            This expands your seed wallet set.
          </p>
          <form onSubmit={triggerDiscovery}>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              Token Mint Address
            </label>
            <input
              type="text"
              placeholder="TokenMintAddress111111111111111111111111111"
              value={tokenMint}
              onChange={(e) => setTokenMint(e.target.value)}
              style={{
                width: '100%',
                padding: '0.75rem',
                background: 'rgba(0, 0, 0, 0.3)',
                border: '1px solid var(--border-color)',
                borderRadius: '8px',
                color: 'var(--text-primary)',
                fontSize: '0.9rem',
                fontFamily: 'monospace'
              }}
            />
            <button
              type="submit"
              disabled={loading || !tokenMint.trim()}
              style={{
                marginTop: '1rem',
                padding: '0.75rem 1.5rem',
                background: 'var(--accent)',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                fontWeight: 600,
                cursor: loading || !tokenMint.trim() ? 'not-allowed' : 'pointer',
                opacity: loading || !tokenMint.trim() ? 0.5 : 1
              }}
            >
              {loading ? 'Discovering...' : 'Discover Wallets'}
            </button>
          </form>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '1rem' }}>
            Returns up to 50 early buyers. Run the scorer again after discovery completes.
          </p>
        </div>

        {/* Token Blacklist Card */}
        <div className="card">
          <h3>Token Blacklist Settings</h3>
          <p style={{ color: 'var(--text-secondary)', margin: '1rem 0' }}>
            Add token mint contract addresses (e.g. stablecoins USDC/USDT, or specific spam/honeypots) that you want to ignore. Coordinated buys/sells on these tokens will not generate intelligence signals.
          </p>
          <form onSubmit={addToBlacklist}>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                type="text"
                placeholder="Token Mint Address to blacklist..."
                value={newBlacklistMint}
                onChange={(e) => setNewBlacklistMint(e.target.value)}
                style={{
                  flex: 1,
                  padding: '0.75rem',
                  background: 'rgba(0, 0, 0, 0.3)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '8px',
                  color: 'var(--text-primary)',
                  fontSize: '0.9rem',
                  fontFamily: 'monospace'
                }}
              />
              <button
                type="submit"
                disabled={loading || !newBlacklistMint.trim()}
                style={{
                  padding: '0.75rem 1.5rem',
                  background: 'var(--danger)',
                  color: 'white',
                  border: 'none',
                  borderRadius: '8px',
                  fontWeight: 600,
                  cursor: loading || !newBlacklistMint.trim() ? 'not-allowed' : 'pointer'
                }}
              >
                Blacklist
              </button>
            </div>
          </form>

          {blacklist.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '1.5rem', fontStyle: 'italic' }}>
              No contract addresses currently blacklisted.
            </p>
          ) : (
            <div style={{ marginTop: '1.5rem' }}>
              <h4 style={{ color: 'var(--text-primary)', fontSize: '0.9rem', marginBottom: '0.5rem' }}>Blacklisted Contracts ({blacklist.length}):</h4>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: '200px', overflowY: 'auto' }}>
                {blacklist.map((mint) => (
                  <li key={mint} style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '0.5rem 0.75rem',
                    background: 'rgba(0,0,0,0.2)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    marginBottom: '0.5rem',
                    fontSize: '0.85rem'
                  }}>
                    <code style={{ color: 'var(--text-secondary)' }}>{mint}</code>
                    <button
                      onClick={() => removeFromBlacklist(mint)}
                      style={{
                        padding: '0.25rem 0.5rem',
                        background: 'rgba(239, 68, 68, 0.1)',
                        border: '1px solid var(--danger)',
                        color: 'var(--danger)',
                        borderRadius: '4px',
                        fontSize: '0.75rem',
                        cursor: 'pointer'
                      }}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Bootstrap checklist */}
        <div className="card">
          <h3>Bootstrap Checklist</h3>
          <p style={{ color: 'var(--text-secondary)', margin: '1rem 0 1.5rem 0' }}>
            Follow this sequence to get your first signal:
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
              <div style={{
                width: '28px',
                height: '28px',
                borderRadius: '50%',
                background: 'var(--accent)',
                color: 'white',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                fontSize: '0.9rem',
                flexShrink: 0
              }}>
                1
              </div>
              <div>
                <h4 style={{ margin: '0 0 0.25rem 0', fontSize: '1rem', color: 'var(--text-primary)' }}>
                  Add Seed Wallets
                </h4>
                <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  Go to <a href="/wallets" style={{ color: 'var(--accent)' }}>Wallets</a> and add 5–10 known profitable wallets.
                  Find them on Solscan or whale-tracker Discord.
                </p>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
              <div style={{
                width: '28px',
                height: '28px',
                borderRadius: '50%',
                background: 'var(--warning)',
                color: 'white',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                fontSize: '0.9rem',
                flexShrink: 0
              }}>
                2
              </div>
              <div>
                <h4 style={{ margin: '0 0 0.25rem 0', fontSize: '1rem', color: 'var(--text-primary)' }}>
                  Run Scorer Batch
                </h4>
                <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  Set <code>RUN_ON_STARTUP=true</code> in <code>.env</code> and restart <code>pnpm dev:scorer</code>.
                  This generates clusters.
                </p>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
              <div style={{
                width: '28px',
                height: '28px',
                borderRadius: '50%',
                background: 'var(--success)',
                color: 'white',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                fontSize: '0.9rem',
                flexShrink: 0
              }}>
                3
              </div>
              <div>
                <h4 style={{ margin: '0 0 0.25rem 0', fontSize: '1rem', color: 'var(--text-primary)' }}>
                  Expand via Discovery
                </h4>
                <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  Use the form above to discover wallets from a profitable token.
                  This auto-expands your wallet network.
                </p>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
              <div style={{
                width: '28px',
                height: '28px',
                borderRadius: '50%',
                background: 'rgba(255, 255, 255, 0.2)',
                color: 'var(--text-primary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                fontSize: '0.9rem',
                flexShrink: 0
              }}>
                4
              </div>
              <div>
                <h4 style={{ margin: '0 0 0.25rem 0', fontSize: '1rem', color: 'var(--text-primary)' }}>
                  Wait for Signals
                </h4>
                <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  The signal-engine polls every 15 seconds. When cluster wallets trade together, signals appear on the <a href="/signals" style={{ color: 'var(--accent)' }}>Signals</a> page.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
