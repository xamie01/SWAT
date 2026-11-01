'use client';

import { useEffect, useState } from 'react';
import { AdminNav } from '../../components/AdminNav.js';
import { api } from '../../lib/api.js';
import { describeApiError } from '../../lib/api-error-message.js';
import { connectSolanaWallet, connectEvmWallet } from '../../lib/wallets.js';

export default function WalletsPage() {
  const [wallets, setWallets] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Target mode: 'wallet' (seed trader address) vs 'token' (backfill hot coin contract)
  const [targetType, setTargetType] = useState<'wallet' | 'token'>('wallet');

  // Wallet Form states
  const [singleAddress, setSingleAddress] = useState('');
  const [singleChain, setSingleChain] = useState<'solana' | 'polygon' | 'robinhood-chain'>('solana');
  const [bulkAddresses, setBulkAddresses] = useState('');
  const [bulkChain, setBulkChain] = useState<'solana' | 'polygon' | 'robinhood-chain'>('solana');

  // Token Discovery states
  const [tokenAddress, setTokenAddress] = useState('');
  const [tokenChain, setTokenChain] = useState<'solana' | 'polygon' | 'robinhood-chain'>('solana');
  const [tokenLoading, setTokenLoading] = useState(false);

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

  const discoverFromToken = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = tokenAddress.trim();
    if (!clean) return;

    setTokenLoading(true);
    setError('');
    setSuccess('');

    try {
      const data = await api.post<{ tokenMint?: string; chain?: string; queued?: boolean }>('/v1/discovery/from-token', {
        tokenMint: clean,
        chain: tokenChain
      });

      const chainLabel = tokenChain === 'solana' ? 'Solana' : tokenChain === 'polygon' ? 'Polymarket (Polygon)' : 'Robinhood Chain';
      setSuccess(
        `Token backfill & discovery queued for ${data?.tokenMint ?? clean} on ${chainLabel}! ` +
        `The indexer is analyzing early blocks, backfilling buyer wallets, and seeding candidate alpha traders.`
      );
      setTokenAddress('');
      setTimeout(() => fetchWallets(), 3000);
    } catch (err: unknown) {
      setError(describeApiError(err, 'Failed to trigger token discovery'));
    } finally {
      setTokenLoading(false);
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
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="font-headline-lg text-2xl font-bold tracking-tight text-primary">
              Smart-Money Ingestion & Backfill Studio
            </h1>
            <p className="text-body-sm text-on-surface-variant">
              Seed the intelligence layer by backfilling whale addresses directly, or reverse-discover alpha traders from trending coins.
            </p>
          </div>

          {/* Segmented Control: Trader Wallet vs Hot Coin */}
          <div className="flex items-center gap-1 bg-surface-container p-1 rounded-xl border border-outline-variant">
            <button
              type="button"
              onClick={() => { setTargetType('wallet'); setError(''); setSuccess(''); }}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-wider transition-all ${
                targetType === 'wallet'
                  ? 'bg-primary text-on-primary shadow-sm'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              <span className="material-symbols-outlined text-base">account_balance_wallet</span>
              <span>Trader Address</span>
            </button>
            <button
              type="button"
              onClick={() => { setTargetType('token'); setError(''); setSuccess(''); }}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-wider transition-all ${
                targetType === 'token'
                  ? 'bg-primary text-on-primary shadow-sm'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              <span className="material-symbols-outlined text-base">token</span>
              <span>Hot Coin / Contract</span>
            </button>
          </div>
        </div>

        {error && (
          <div className="card" style={{ background: 'rgba(239, 68, 68, 0.1)', borderColor: 'var(--danger)', marginBottom: '1.5rem' }}>
            <p style={{ color: 'var(--danger)', margin: 0 }}>{error}</p>
          </div>
        )}

        {success && (
          <div className="card" style={{ background: 'rgba(16, 185, 129, 0.1)', borderColor: 'var(--success)', marginBottom: '1.5rem' }}>
            <p style={{ color: 'var(--success)', margin: 0 }}>{success}</p>
          </div>
        )}

        {/* ─── OPTION A: REVERSE-DISCOVERY FROM HOT COIN ─── */}
        {targetType === 'token' && (
          <div className="card mb-8 border-primary/30 bg-surface-container/60 shadow-lg">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shrink-0">
                <span className="material-symbols-outlined text-2xl">radar</span>
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-bold text-on-surface">Discover Alpha Traders from Hot Coin Contract</h3>
                <p className="text-sm text-on-surface-variant mt-1">
                  Enter a token mint or smart contract address. The indexer will trace the contract back to its launch blocks, extract the 
                  <strong> 40 earliest distinct buyers</strong> and <strong>top 10 accumulators</strong>, backfill their entire trade history, 
                  and run the Scorer to surface the winning whales directly to your copy-trading users.
                </p>

                <form onSubmit={discoverFromToken} className="mt-6 space-y-4">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-on-surface-variant mb-2">
                      Target Network / Venue
                    </label>
                    <div className="flex flex-wrap gap-3">
                      <label className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium cursor-pointer transition-colors ${
                        tokenChain === 'solana' ? 'bg-primary/10 border-primary text-primary' : 'bg-surface border-outline-variant text-on-surface-variant hover:border-outline'
                      }`}>
                        <input
                          type="radio"
                          name="tokenChain"
                          value="solana"
                          checked={tokenChain === 'solana'}
                          onChange={() => setTokenChain('solana')}
                          className="sr-only"
                        />
                        <span className="w-2 h-2 rounded-full bg-[#a78bfa]"></span>
                        <span>Solana (SPL / pump.fun)</span>
                      </label>

                      <label className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium cursor-pointer transition-colors ${
                        tokenChain === 'robinhood-chain' ? 'bg-primary/10 border-primary text-primary' : 'bg-surface border-outline-variant text-on-surface-variant hover:border-outline'
                      }`}>
                        <input
                          type="radio"
                          name="tokenChain"
                          value="robinhood-chain"
                          checked={tokenChain === 'robinhood-chain'}
                          onChange={() => setTokenChain('robinhood-chain')}
                          className="sr-only"
                        />
                        <span className="w-2 h-2 rounded-full bg-[#34d399]"></span>
                        <span>Robinhood Chain (Uniswap V3)</span>
                      </label>

                      <label className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium cursor-pointer transition-colors ${
                        tokenChain === 'polygon' ? 'bg-primary/10 border-primary text-primary' : 'bg-surface border-outline-variant text-on-surface-variant hover:border-outline'
                      }`}>
                        <input
                          type="radio"
                          name="tokenChain"
                          value="polygon"
                          checked={tokenChain === 'polygon'}
                          onChange={() => setTokenChain('polygon')}
                          className="sr-only"
                        />
                        <span className="w-2 h-2 rounded-full bg-[#60a5fa]"></span>
                        <span>Polymarket (Polygon CTF)</span>
                      </label>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-on-surface-variant mb-1.5">
                      {tokenChain === 'solana' ? 'SPL Token Mint Address' : 'ERC-20 Contract Address'}
                    </label>
                    <input
                      type="text"
                      placeholder={
                        tokenChain === 'solana'
                          ? "e.g. EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm (WIF, pump.fun mint)"
                          : tokenChain === 'robinhood-chain'
                            ? "e.g. 0x4200000000000000000000000000000000000006"
                            : "e.g. 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 (Polygon token / CTF)"
                      }
                      value={tokenAddress}
                      onChange={(e) => setTokenAddress(e.target.value)}
                      className="w-full px-3.5 py-2.5 bg-black/30 border border-outline-variant rounded-lg font-mono text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary transition-colors"
                    />
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <p className="text-xs text-on-surface-variant flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-sm text-warning">info</span>
                      <span>Indexer runs deduplication automatically. Discovered wallets with ROI &gt; 0% feed the Suggested Masters list.</span>
                    </p>

                    <button
                      type="submit"
                      disabled={tokenLoading || !tokenAddress.trim()}
                      className="px-5 py-2.5 bg-primary text-on-primary rounded-lg font-semibold text-sm hover:opacity-95 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shadow-sm"
                    >
                      {tokenLoading ? (
                        <>
                          <span className="material-symbols-outlined text-base animate-spin">refresh</span>
                          <span>Queueing Discovery...</span>
                        </>
                      ) : (
                        <>
                          <span className="material-symbols-outlined text-base">rocket_launch</span>
                          <span>Discover & Backfill Top Traders</span>
                        </>
                      )}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        )}

        {/* ─── OPTION B: SEED DIRECT TRADER WALLETS ─── */}
        {targetType === 'wallet' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
            {/* Single wallet form */}
            <div className="card">
              <h3 className="font-semibold text-lg text-on-surface">Add Single Whale Wallet</h3>
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
                <div className="mt-2 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={async () => {
                      setError('');
                      try {
                        if (singleChain === 'solana') {
                          const { address } = await connectSolanaWallet();
                          setSingleAddress(address);
                        } else {
                          const { address } = await connectEvmWallet();
                          setSingleAddress(address);
                        }
                      } catch (err: any) {
                        setError(err.message || 'Could not connect wallet.');
                      }
                    }}
                    className="text-xs font-semibold text-primary underline flex items-center gap-1 hover:opacity-80 transition-opacity"
                  >
                    <span className="material-symbols-outlined text-sm">bolt</span>
                    <span>Auto-fill from active {singleChain === 'solana' ? 'Solana' : 'EVM'} wallet extension</span>
                  </button>
                </div>
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
                  {loading ? 'Adding...' : 'Add & Backfill Wallet'}
                </button>
              </form>
            </div>

            {/* Bulk wallet form */}
            <div className="card">
              <h3 className="font-semibold text-lg text-on-surface">Add Multiple Wallets (Batch)</h3>
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
                <div className="mt-2 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={async () => {
                      setError('');
                      try {
                        if (bulkChain === 'solana') {
                          const { address } = await connectSolanaWallet();
                          setBulkAddresses((prev) => prev.trim() ? `${prev.trim()}\n${address}` : address);
                        } else {
                          const { address } = await connectEvmWallet();
                          setBulkAddresses((prev) => prev.trim() ? `${prev.trim()}\n${address}` : address);
                        }
                      } catch (err: any) {
                        setError(err.message || 'Could not connect wallet.');
                      }
                    }}
                    className="text-xs font-semibold text-primary underline flex items-center gap-1 hover:opacity-80 transition-opacity"
                  >
                    <span className="material-symbols-outlined text-sm">bolt</span>
                    <span>Append active {bulkChain === 'solana' ? 'Solana' : 'EVM'} wallet address</span>
                  </button>
                </div>
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
                  {loading ? 'Adding...' : 'Add All & Backfill'}
                </button>
              </form>
            </div>
          </div>
        )}

        {/* ─── WALLET CATALOG LIST ─── */}
        <div style={{ marginTop: '2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h2>Tracked Smart-Money Wallets ({wallets.length})</h2>
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
                {loading ? 'Working...' : 'Reindex All Tracked'}
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
                No wallets indexed yet. Add a seed wallet above or index a hot coin to discover alpha traders automatically.
              </p>
            </div>
          ) : (
            <div className="grid" style={{ gridTemplateColumns: '1fr' }}>
              {wallets.map((wallet: any) => (
                <div key={wallet.address} className="card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1 }}>
                      <code className="break-all font-mono" style={{ fontSize: '0.9rem', color: 'var(--accent)' }}>
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
                      {wallet.discovery_method && (
                        <span className="badge" style={{
                          marginLeft: '0.5rem',
                          background: 'rgba(234, 179, 8, 0.1)',
                          color: '#eab308',
                          border: 'none',
                          fontSize: '0.7rem',
                          verticalAlign: 'middle'
                        }}>
                          {wallet.discovery_method === 'token-early' ? '🎯 Token Early Buyer' :
                           wallet.discovery_method === 'token-big' ? '💰 Token Top Accumulator' :
                           wallet.discovery_method}
                        </span>
                      )}
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
