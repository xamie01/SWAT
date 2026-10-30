'use client';

import { useEffect, useState } from 'react';
import { AdminNav } from '../../components/AdminNav.js';
import { api } from '../../lib/api.js';
import { describeApiError } from '../../lib/api-error-message.js';

export default function WalletsPage() {
  const [wallets, setWallets] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Form states
  const [singleAddress, setSingleAddress] = useState('');
  const [singleChain, setSingleChain] = useState<'solana' | 'polygon' | 'robinhood-chain'>('solana');
  const [bulkAddresses, setBulkAddresses] = useState('');
  const [bulkChain, setBulkChain] = useState<'solana' | 'polygon' | 'robinhood-chain'>('solana');

  const fetchWallets = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.get<any>('/v1/wallets');
      // The API returns a bare array; tolerate a wrapped { items } shape too.
      setWallets(Array.isArray(data) ? data : data?.items ?? []);
    } catch (err: unknown) {
      setError(describeApiError(err, 'Failed to fetch wallets'));
    } finally {
      setLoading(false);
    }
  };

  const reindexAll = async () => {
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      const data = await api.post<{ queued?: number }>('/v1/wallets/reindex');
      setSuccess(`Indexer started — backfilling ${data?.queued ?? 0} wallet(s). This can take a few minutes.`);
      setTimeout(() => fetchWallets(), 4000);
    } catch (err: unknown) {
      setError(describeApiError(err, 'Failed to start indexer'));
    } finally {
      setLoading(false);
    }
  };

  const addSingleWallet = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!singleAddress.trim()) return;

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      await api.post('/v1/wallets', {
        wallets: [{ address: singleAddress.trim(), chain: singleChain, source: 'manual' }]
      });

      setSuccess('Wallet added! Indexer is backfilling transaction history...');
      setSingleAddress('');
      setTimeout(() => fetchWallets(), 2000);
    } catch (err: unknown) {
      setError(describeApiError(err, 'Failed to add wallet'));
    } finally {
      setLoading(false);
    }
  };

  const addBulkWallets = async (e: React.FormEvent) => {
    e.preventDefault();
    const addresses = bulkAddresses
      .split('\n')
      .map(a => a.trim())
      .filter(a => a.length > 0);

    if (addresses.length === 0) return;

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      await api.post('/v1/wallets', {
        wallets: addresses.map(address => ({ address, chain: bulkChain, source: 'manual' }))
      });

      setSuccess(`Added ${addresses.length} wallets! Indexer is backfilling...`);
      setBulkAddresses('');
      setTimeout(() => fetchWallets(), 2000);
    } catch (err: unknown) {
      setError(describeApiError(err, 'Failed to add wallets'));
    } finally {
      setLoading(false);
    }
  };

  // Load wallets on mount
  useEffect(() => {
    fetchWallets();
  }, []);

  return (
    <div className="min-h-screen bg-background text-on-background antialiased font-sans">
      <AdminNav />
      <main className="max-w-[1440px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <h1 className="font-headline-lg text-2xl font-bold tracking-tight text-primary">Wallet Management</h1>
        <p className="text-body-sm text-on-surface-variant mb-6">
          Add seed wallets to bootstrap the intelligence layer. The indexer will backfill their transaction history.
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

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', marginTop: '2rem' }}>
        {/* Single wallet form */}
        <div className="card">
          <h3>Add Single Wallet</h3>
          <form onSubmit={addSingleWallet}>
            <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem', marginBottom: '0.5rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                <input
                  type="radio"
                  name="singleChain"
                  value="solana"
                  checked={singleChain === 'solana'}
                  onChange={() => setSingleChain('solana')}
                />
                Solana
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                <input
                  type="radio"
                  name="singleChain"
                  value="polygon"
                  checked={singleChain === 'polygon'}
                  onChange={() => setSingleChain('polygon')}
                />
                Polymarket (Polygon)
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                <input
                  type="radio"
                  name="singleChain"
                  value="robinhood-chain"
                  checked={singleChain === 'robinhood-chain'}
                  onChange={() => setSingleChain('robinhood-chain')}
                />
                Robinhood
              </label>
            </div>
            <input
              type="text"
              placeholder={singleChain === 'solana' ? "Solana wallet address" : "EVM wallet address (0x...)"}
              value={singleAddress}
              onChange={(e) => setSingleAddress(e.target.value)}
              style={{
                width: '100%',
                padding: '0.75rem',
                background: 'rgba(0, 0, 0, 0.3)',
                border: '1px solid var(--border-color)',
                borderRadius: '8px',
                color: 'var(--text-primary)',
                fontSize: '0.9rem',
                marginTop: '0.5rem'
              }}
            />
            <button
              type="submit"
              disabled={loading || !singleAddress.trim()}
              style={{
                marginTop: '1rem',
                padding: '0.75rem 1.5rem',
                background: 'var(--accent)',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                fontWeight: 600,
                cursor: loading ? 'wait' : 'pointer',
                opacity: loading || !singleAddress.trim() ? 0.5 : 1
              }}
            >
              {loading ? 'Adding...' : 'Add Wallet'}
            </button>
          </form>
        </div>

        {/* Bulk wallet form */}
        <div className="card">
          <h3>Add Multiple Wallets</h3>
          <form onSubmit={addBulkWallets}>
            <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem', marginBottom: '0.5rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                <input
                  type="radio"
                  name="bulkChain"
                  value="solana"
                  checked={bulkChain === 'solana'}
                  onChange={() => setBulkChain('solana')}
                />
                Solana
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                <input
                  type="radio"
                  name="bulkChain"
                  value="polygon"
                  checked={bulkChain === 'polygon'}
                  onChange={() => setBulkChain('polygon')}
                />
                Polymarket (Polygon)
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                <input
                  type="radio"
                  name="bulkChain"
                  value="robinhood-chain"
                  checked={bulkChain === 'robinhood-chain'}
                  onChange={() => setBulkChain('robinhood-chain')}
                />
                Robinhood
              </label>
            </div>
            <textarea
              placeholder="Paste wallet addresses (one per line)"
              value={bulkAddresses}
              onChange={(e) => setBulkAddresses(e.target.value)}
              rows={5}
              style={{
                width: '100%',
                padding: '0.75rem',
                background: 'rgba(0, 0, 0, 0.3)',
                border: '1px solid var(--border-color)',
                borderRadius: '8px',
                color: 'var(--text-primary)',
                fontSize: '0.9rem',
                marginTop: '0.5rem',
                resize: 'vertical',
                fontFamily: 'monospace'
              }}
            />
            <button
              type="submit"
              disabled={loading || !bulkAddresses.trim()}
              style={{
                marginTop: '1rem',
                padding: '0.75rem 1.5rem',
                background: 'var(--accent)',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                fontWeight: 600,
                cursor: loading ? 'wait' : 'pointer',
                opacity: loading || !bulkAddresses.trim() ? 0.5 : 1
              }}
            >
              {loading ? 'Adding...' : 'Add All'}
            </button>
          </form>
        </div>
      </div>

      {/* Wallet list */}
      <div style={{ marginTop: '2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2>Tracked Wallets ({wallets.length})</h2>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              onClick={reindexAll}
              disabled={loading || wallets.length === 0}
              style={{
                padding: '0.5rem 1rem',
                background: 'var(--accent)',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: loading ? 'wait' : 'pointer',
                fontWeight: 600,
                opacity: loading || wallets.length === 0 ? 0.5 : 1
              }}
            >
              {loading ? 'Working...' : 'Start Indexer'}
            </button>
            <button
              onClick={fetchWallets}
              disabled={loading}
              style={{
                padding: '0.5rem 1rem',
                background: 'rgba(59, 130, 246, 0.1)',
                color: 'var(--accent)',
                border: '1px solid var(--accent)',
                borderRadius: '6px',
                cursor: loading ? 'wait' : 'pointer',
                fontWeight: 500
              }}
            >
              {loading ? 'Loading...' : 'Refresh'}
            </button>
          </div>
        </div>

        {wallets.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
            <p style={{ color: 'var(--text-secondary)' }}>
              No wallets yet. Add your first seed wallet above to get started.
            </p>
          </div>
        ) : (
          <div className="grid" style={{ gridTemplateColumns: '1fr' }}>
            {wallets.map((wallet: any) => (
              <div key={wallet.address} className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <code style={{ fontSize: '0.9rem', color: 'var(--accent)' }}>
                      {wallet.address.includes(':') ? wallet.address.split(':')[1] : wallet.address}
                    </code>
                    <span className="badge" style={{
                      marginLeft: '0.75rem',
                      background: wallet.chain === 'solana' ? 'rgba(167, 139, 250, 0.1)' : wallet.chain === 'polygon' ? 'rgba(59, 130, 246, 0.1)' : 'rgba(16, 185, 129, 0.1)',
                      color: wallet.chain === 'solana' ? '#a78bfa' : wallet.chain === 'polygon' ? '#60a5fa' : '#34d399',
                      border: 'none',
                      fontSize: '0.75rem',
                      verticalAlign: 'middle'
                    }}>
                      {wallet.chain === 'solana' ? 'Solana' : wallet.chain === 'polygon' ? 'Polymarket' : 'Robinhood'}
                    </span>
                    <div style={{ marginTop: '0.75rem' }}>
                      <span className={`badge ${
                        wallet.tier === 'elite' ? 'success' :
                        wallet.tier === 'pro' ? 'warning' : ''
                      }`} style={{ marginRight: '0.5rem' }}>
                        {wallet.tier || 'unscored'}
                      </span>
                      {wallet.composite_score != null && (
                        <span className="badge" style={{ background: 'rgba(255, 255, 255, 0.05)' }}>
                          Score: {wallet.composite_score}
                        </span>
                      )}
                    </div>
                    <div style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                      {wallet.win_rate != null && `Win Rate: ${(wallet.win_rate * 100).toFixed(1)}% · `}
                      {wallet.realized_roi != null && `ROI: ${(wallet.realized_roi * 100).toFixed(0)}%`}
                      {wallet.updated_at && ` · Last active: ${new Date(wallet.updated_at).toLocaleDateString()}`}
                    </div>
                  </div>
                  <div>
                    <span className={`badge ${wallet.status === 'active' ? 'success' : 'warning'}`}>
                      {wallet.status}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  </div>
);
}
