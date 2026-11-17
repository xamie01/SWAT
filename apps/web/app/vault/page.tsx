'use client';

import React, { useState, useEffect } from 'react';
import { SaaSNav } from '../../components/SaaSNav.js';
import { AdminNav } from '../../components/AdminNav.js';
import { ChainBadge, LoadingSkeleton, ErrorBanner } from '../../components/UIPrimitives.js';
import { WalletConnectModalButton } from '../../components/WalletConnectModalButton.js';
import { api } from '../../lib/api.js';
import { describeApiError } from '../../lib/api-error-message.js';
import { FinancialRequestPanel, LocalEnrollmentPanel } from '../../components/FinancialRequestPanel.js';
import { domainTransport, type DomainCapability } from '../../lib/domain-transport.js';
import { enrollmentAllowed, geoNotice, submitPolymarketEnrollment, type PolymarketEnrollmentView } from '../../lib/portfolio-model.js';
import {
  connectSolanaWallet,
  connectEvmWallet,
  linkWalletWithSignature,
  getSolanaProvider,
  getEvmProvider,
  detectSolanaCluster,
  copyToClipboard,
} from '../../lib/wallets.js';

interface VaultData {
  localEnrollment?: DomainCapability;
  solana: {
    pdaAddress: string | null;
    rentLamports: number | null;
    solGasReserve: number | null;
    solGasUsd: number | null;
    solMinGasUsd: number | null;
    hasMinimumGas: boolean;
    status: string;
  };
  robinhood: {
    smartAccountAddress: string | null;
    accountAddress?: string | null;
    sessionKeyStatus: string;
    expiresAt: string | null;
    sponsoredOpsUsedToday: number;
    dailyCap: number;
  };
  polymarket: PolymarketEnrollmentView & {
    depositAddress: string | null;
    signerAddress?: string | null;
    status?: string | null;
    credentialsRecorded?: boolean;
    geoEligible: boolean | null;
    geoExpiresAt: string | null;
  };
  linkedWallets: Array<{
    address: string;
    chain: string;
    verified: boolean;
    linkedAt: string;
    spendableAt: string;
    isCoolingOff: boolean;
  }>;
}

export default function VaultPage() {
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [data, setData] = useState<VaultData | null>(null);
  const [withdrawalCapability, setWithdrawalCapability] = useState<DomainCapability | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Connect/Link Wallet Form State
  const [linkChain, setLinkChain] = useState<'solana' | 'robinhood-chain' | 'polygon'>('solana');
  const [walletInput, setWalletInput] = useState('');
  const [linking, setLinking] = useState(false);
  const [linkSuccess, setLinkSuccess] = useState<string | null>(null);

  // Injected Extension Detection & 1-Click Connection State
  const [detectedSolana, setDetectedSolana] = useState<string | null>(null);
  const [detectedEvm, setDetectedEvm] = useState<string | null>(null);
  const [connectingWallet, setConnectingWallet] = useState(false);
  const [walletConnectError, setWalletConnectError] = useState<string | null>(null);
  const [walletConnectSuccess, setWalletConnectSuccess] = useState<string | null>(null);
  const [showManualInput, setShowManualInput] = useState(false);
  const [authorizingPoly, setAuthorizingPoly] = useState(false);

  // Interactive Modals
  const [activeModal, setActiveModal] = useState<'solana-gas' | 'robinhood-delegate' | 'polymarket-deposit' | null>(null);

  // Solana Cluster, Copy Feedback & Modals
  const [solanaCluster, setSolanaCluster] = useState<'mainnet-beta' | 'devnet'>('mainnet-beta');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [actionSuccessNotice, setActionSuccessNotice] = useState<string | null>(null);

  const triggerCopy = (text: string, key: string) => {
    const ok = copyToClipboard(text);
    if (ok) {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((curr) => (curr === key ? null : curr)), 2000);
    }
  };

  useEffect(() => {
    fetchVault();
    const sol = getSolanaProvider();
    if (sol) setDetectedSolana(sol.name);
    const evm = getEvmProvider();
    if (evm) setDetectedEvm(evm.name);
  }, []);

  const fetchVault = async () => {
    setLoading(true);
    setError(null);
    setData(null);
    setWithdrawalCapability(undefined);
    try {
      const vaultRes = await api.get<VaultData>('/v1/me/vault');
      setData(vaultRes);
      const capabilities = await domainTransport.capabilities().catch(() => null);
      setWithdrawalCapability(capabilities?.withdrawal);
      const meRes = await api.get<{ user?: { role?: string } }>('/v1/auth/me').catch(() => null);
      setRole(meRes?.user?.role === 'admin' ? 'admin' : 'user');
    } catch (err) {
      setError(describeApiError(err, 'Vault capability status unavailable; funding authority is unverified'));
    } finally {
      setLoading(false);
    }
  };

  /** Real Web3 Wallet Connection (Phantom, Solflare, MetaMask, Rabby) */
  const handleConnectWallet = async (chain: 'solana' | 'robinhood-chain' | 'polygon') => {
    setConnectingWallet(true);
    setWalletConnectError(null);
    setWalletConnectSuccess(null);

    try {
      if (chain === 'solana') {
        const { address, provider, walletName } = await connectSolanaWallet();
        setDetectedSolana(walletName);

        // Sign challenge and link in backend
        await linkWalletWithSignature({
          chainKind: 'solana',
          address,
          provider,
        });

        const detectedCluster = detectSolanaCluster(provider);
        setSolanaCluster(detectedCluster);

        await fetchVault();
        setWalletConnectSuccess(`Connected to ${walletName}. Wallet ownership verified; vault deployment and user-live execution are unsupported. No funding address was created.`);
      } else if (chain === 'robinhood-chain') {
        const { address, provider, walletName } = await connectEvmWallet();
        setDetectedEvm(walletName);

        // Sign challenge and link in backend
        await linkWalletWithSignature({
          chainKind: 'evm',
          address,
          provider,
        });

        await fetchVault();
        setWalletConnectSuccess(`Connected to ${walletName}. Wallet link recorded; delegation, smart account funding and live execution remain unavailable.`);
      } else {
        // Polymarket (Polygon)
        const { address, provider, walletName } = await connectEvmWallet('0x89');
        setDetectedEvm(walletName);

        // 1. Link wallet with SIWE challenge
        await linkWalletWithSignature({
          chainKind: 'evm',
          address,
          provider,
        });

        // Wallet ownership linking is independent from unavailable enrollment.
        await fetchVault();
        setWalletConnectSuccess(`Connected to ${walletName} on Polygon. Wallet ownership link recorded only; Polymarket enrollment, funding and live execution remain unavailable.`);
      }
    } catch (err: any) {
      setWalletConnectError(err.message || 'Failed to connect wallet.');
    } finally {
      setConnectingWallet(false);
    }
  };

  const handleAuthorizePolymarketL2 = async () => {
    setWalletConnectError(null);
    setWalletConnectSuccess(null);
    try {
      // Refuse before opening a wallet, fetching a challenge or requesting any
      // signature. There is no enrollment implementation to execute locally.
      await submitPolymarketEnrollment(data?.polymarket, async () => {
        throw new Error('Authorized enrollment implementation unavailable');
      });
    } catch (err) {
      setWalletConnectError(describeApiError(err, 'Enrollment unavailable'));
    }
  };

  const handleLinkWallet = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!walletInput.trim()) return;

    setLinking(true);
    setLinkSuccess(null);
    setError(null);

    try {
      const address = walletInput.trim();
      const chainKind = linkChain === 'solana' ? 'solana' : 'evm';

      setLinkSuccess('An entered address is not a verified wallet or funding destination. Connect a wallet and sign the SIWE/SIWS challenge to link it.');
      setWalletInput('');
    } catch (err: any) {
      setError(err.message || 'Failed to link wallet');
    } finally {
      setLinking(false);
    }
  };

  const disableLocalGrants = async (chain: 'solana' | 'robinhood-chain') => {
    try {
      const result = await api.post<{ message: string }>('/v1/me/vault/revoke', { chain });
      setActionSuccessNotice(result.message);
      await fetchVault();
    } catch (err: any) { setError(err.message || 'Local disable failed; no on-chain action was attempted.'); }
  };
  const handleRevokeSolanaVault = () => disableLocalGrants('solana');
  const handleRevokeRobinhoodSession = () => disableLocalGrants('robinhood-chain');
  const handleToggleSolanaCluster = async (cluster: 'mainnet-beta' | 'devnet') => {
    setSolanaCluster(cluster);
    setActionSuccessNotice('Network selection is a preview only. Vault deployment verification is unavailable.');
  };

  return (
    <div className="bg-background text-on-background min-h-screen antialiased font-sans">
      {/* Role-Adaptive Navigation */}
      {role === 'admin' ? <AdminNav /> : <SaaSNav />}

      <main className="max-w-[1440px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
          <div>
            <h1 className="font-headline-lg text-2xl font-bold tracking-tight text-primary">
              Wallet Links &amp; Custody Capability
            </h1>
            <p className="text-body-sm text-on-surface-variant">
              Connect trading wallets, derive non-custodial Solana Anchor PDAs, view local credential records. User-live execution is unavailable.
            </p>
          </div>
          {role === 'admin' && (
            <span className="self-start sm:self-auto px-2 py-1 rounded bg-status-error/10 text-status-error border border-status-error/30 text-xs font-mono font-bold">
              OPERATOR TELEMETRY
            </span>
          )}
        </div>

        {error && <div className="mb-6"><ErrorBanner message={error} onRetry={fetchVault} /></div>}

        {/* 1. Multi-Chain Web3 Wallet Connection Hub */}
        <section className="bg-surface-container-lowest border border-border-subtle rounded-2xl p-6 sm:p-8 mb-10 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-primary text-white flex items-center justify-center shrink-0 shadow-md">
                <span className="material-symbols-outlined text-2xl">account_balance_wallet</span>
              </div>
              <div>
                <h2 className="font-headline-md text-xl font-bold text-primary">
                  Connect Wallet &amp; Verify Ownership
                </h2>
                <p className="text-xs sm:text-sm text-on-surface-variant">
                  One-click Web3 extension connection with zero-cost cryptographic SIWE/SIWS proof. No manual copy-pasting required.
                </p>
              </div>
            </div>

            {/* Injected Wallet Status Indicators */}
            <div className="flex flex-wrap items-center gap-2">
              <span className={`px-2.5 py-1 rounded-full text-[11px] font-mono font-semibold flex items-center gap-1.5 border ${
                detectedSolana ? 'bg-[#14F195]/10 text-[#00A86B] dark:text-[#14F195] border-[#14F195]/30' : 'bg-surface-container text-on-surface-variant border-border-subtle'
              }`}>
                <span className={`w-2 h-2 rounded-full ${detectedSolana ? 'bg-[#14F195] animate-pulse' : 'bg-gray-400'}`} />
                <span>{detectedSolana ? `${detectedSolana} Detected` : 'Solana: Not Detected'}</span>
              </span>
              <span className={`px-2.5 py-1 rounded-full text-[11px] font-mono font-semibold flex items-center gap-1.5 border ${
                detectedEvm ? 'bg-[#3B82F6]/10 text-[#2563EB] dark:text-[#60A5FA] border-[#3B82F6]/30' : 'bg-surface-container text-on-surface-variant border-border-subtle'
              }`}>
                <span className={`w-2 h-2 rounded-full ${detectedEvm ? 'bg-[#3B82F6] animate-pulse' : 'bg-gray-400'}`} />
                <span>{detectedEvm ? `${detectedEvm} Detected` : 'EVM: Not Detected'}</span>
              </span>
            </div>
          </div>

          {/* Venue Tabs: Solana, Robinhood, Polymarket */}
          <div className="flex flex-wrap gap-2 mb-6 border-b border-border-subtle pb-4">
            <button
              type="button"
              onClick={() => {
                setLinkChain('solana');
                setWalletConnectError(null);
                setWalletConnectSuccess(null);
              }}
              className={`px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold flex items-center gap-2 border transition-all ${
                linkChain === 'solana'
                  ? 'bg-[#14F195]/15 border-[#14F195] text-primary shadow-sm'
                  : 'bg-surface-container-low border-transparent text-on-surface-variant hover:text-primary hover:bg-surface-container'
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-full bg-[#14F195]" />
              <span>Solana Anchor Vault</span>
              {data?.linkedWallets.some((w) => w.chain === 'solana') && (
                <span className="w-1.5 h-1.5 rounded-full bg-[#14F195]" />
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                setLinkChain('robinhood-chain');
                setWalletConnectError(null);
                setWalletConnectSuccess(null);
              }}
              className={`px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold flex items-center gap-2 border transition-all ${
                linkChain === 'robinhood-chain'
                  ? 'bg-[#FFB800]/15 border-[#FFB800] text-primary shadow-sm'
                  : 'bg-surface-container-low border-transparent text-on-surface-variant hover:text-primary hover:bg-surface-container'
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-full bg-[#FFB800]" />
              <span>Robinhood EOA (delegation unavailable)</span>
              {data?.linkedWallets.some((w) => w.chain === 'robinhood-chain') && (
                <span className="w-1.5 h-1.5 rounded-full bg-[#FFB800]" />
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                setLinkChain('polygon');
                setWalletConnectError(null);
                setWalletConnectSuccess(null);
              }}
              className={`px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold flex items-center gap-2 border transition-all ${
                linkChain === 'polygon'
                  ? 'bg-[#8B5CF6]/15 border-[#8B5CF6] text-primary shadow-sm'
                  : 'bg-surface-container-low border-transparent text-on-surface-variant hover:text-primary hover:bg-surface-container'
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-full bg-[#8B5CF6]" />
              <span>Polymarket credential records</span>
              {data?.linkedWallets.some((w) => w.chain === 'polygon') && (
                <span className="w-1.5 h-1.5 rounded-full bg-[#8B5CF6]" />
              )}
            </button>
          </div>

          {/* Active Venue Wallet Connection Panel */}
          {(() => {
            const currentLinked = data?.linkedWallets.find((w) => w.chain === linkChain);

            return (
              <div className="bg-surface-container-low rounded-xl p-5 border border-border-subtle">
                {currentLinked ? (
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-status-success animate-pulse" />
                        <span className="text-xs font-bold font-mono text-status-success uppercase tracking-wider">
                          Cryptographically Linked &amp; Verified
                        </span>
                      </div>
                      <div className="flex items-center gap-2 pt-1">
                        <code className="text-sm sm:text-base font-mono font-bold text-primary break-all">
                          {currentLinked.address}
                        </code>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(currentLinked.address);
                            alert('Wallet address copied to clipboard');
                          }}
                          className="p-1 rounded text-on-surface-variant hover:text-primary hover:bg-surface-container transition-colors"
                          title="Copy address"
                        >
                          <span className="material-symbols-outlined text-sm">content_copy</span>
                        </button>
                      </div>
                      <p className="text-[11px] text-on-surface-variant">
                        Verified at: {new Date(currentLinked.linkedAt).toLocaleString()}
                        {currentLinked.isCoolingOff && ' · Anti-theft 24h spendable cooldown active'}
                      </p>
                    </div>

                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleConnectWallet(linkChain)}
                        disabled={connectingWallet}
                        className="px-4 py-2 bg-surface-container hover:bg-surface-container-high border border-border-subtle text-primary text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-1.5"
                      >
                        <span className="material-symbols-outlined text-sm">swap_horiz</span>
                        <span>Switch Wallet</span>
                      </button>
                      {linkChain === 'solana' && (
                        <button
                          type="button"
                          disabled
                          onClick={() => setError('Solana funding unavailable; no deployed vault is verified.')}
                          className="px-4 py-2 bg-[#14F195] hover:bg-[#00D685] text-black text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-1.5"
                        >
                          <span className="material-symbols-outlined text-sm">local_gas_station</span>
                          <span>Funding unavailable</span>
                        </button>
                      )}
                      {linkChain === 'robinhood-chain' && (
                        <button
                          type="button"
                          disabled
                          onClick={() => setError('Robinhood delegation unavailable; no spend authority was created.')}
                          className="px-4 py-2 bg-[#FFB800] hover:bg-[#E5A700] text-black text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-1.5"
                        >
                          <span className="material-symbols-outlined text-sm">key</span>
                          <span>Delegation unavailable</span>
                        </button>
                      )}
                      {linkChain === 'polygon' && (
                        <button
                          type="button"
                          disabled
                          onClick={() => setError('Deposit funding unavailable; no proxy address is verified.')}
                          className="px-4 py-2 bg-[#8B5CF6] hover:bg-[#7C3AED] text-white text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-1.5"
                        >
                          <span className="material-symbols-outlined text-sm">qr_code</span>
                          <span>Deposit unavailable</span>
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6">
                    <div className="space-y-1 max-w-lg">
                      <h3 className="font-bold text-sm text-primary">
                        {linkChain === 'solana' && 'Connect Phantom / Solflare (Solana)'}
                        {linkChain === 'robinhood-chain' && 'Connect MetaMask / Rabby (Robinhood EVM)'}
                        {linkChain === 'polygon' && 'Connect Polygon Wallet (Polymarket)'}
                      </h3>
                      <p className="text-xs text-on-surface-variant">
                        {linkChain === 'solana' && 'Opens your Solana browser wallet to sign a zero-cost cryptographic SIWS challenge. Linking does not generate a verified vault or funding address.'}
                        {linkChain === 'robinhood-chain' && 'Opens your EVM browser wallet to sign an EIP-4361 SIWE challenge. Links your EOA for authentication only; delegation is unavailable.'}
                        {linkChain === 'polygon' && 'Links wallet ownership on Polygon. Credentials do not establish a deposit proxy, eligibility or live execution authority.'}
                      </p>
                    </div>

                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 shrink-0">
                      {/* Universal WalletConnect / Mobile QR Code Button */}
                      <WalletConnectModalButton
                        chainKind={linkChain}
                        onLinked={() => {
                          fetchVault();
                          setActionSuccessNotice(`Wallet ownership linked via WalletConnect for ${linkChain.toUpperCase()}. No vault, enrollment or execution authority was created.`);
                          setTimeout(() => setActionSuccessNotice(null), 4000);
                        }}
                      />

                      {linkChain === 'solana' ? (
                        detectedSolana ? (
                          <button
                            type="button"
                            onClick={() => handleConnectWallet('solana')}
                            disabled={connectingWallet}
                            className="px-6 py-3 bg-[#14F195] hover:bg-[#00D685] text-black text-sm font-bold rounded-xl shadow-md transition-all flex items-center justify-center gap-2 hover:scale-[1.02] disabled:opacity-50"
                          >
                            {connectingWallet ? (
                              <>
                                <span className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                                <span>Connecting &amp; Signing...</span>
                              </>
                            ) : (
                              <>
                                <span className="material-symbols-outlined text-base">account_balance_wallet</span>
                                <span>Connect {detectedSolana}</span>
                              </>
                            )}
                          </button>
                        ) : (
                          <a
                            href="https://phantom.app"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-6 py-3 bg-surface-container hover:bg-surface-container-high border border-border-subtle text-primary text-sm font-bold rounded-xl transition-all flex items-center justify-center gap-2"
                          >
                            <span className="material-symbols-outlined text-base">download</span>
                            <span>Install Phantom Wallet</span>
                          </a>
                        )
                      ) : linkChain === 'robinhood-chain' ? (
                        detectedEvm ? (
                          <button
                            type="button"
                            onClick={() => handleConnectWallet('robinhood-chain')}
                            disabled={connectingWallet}
                            className="px-6 py-3 bg-[#FFB800] hover:bg-[#E5A700] text-black text-sm font-bold rounded-xl shadow-md transition-all flex items-center justify-center gap-2 hover:scale-[1.02] disabled:opacity-50"
                          >
                            {connectingWallet ? (
                              <>
                                <span className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                                <span>Connecting &amp; Signing...</span>
                              </>
                            ) : (
                              <>
                                <span className="material-symbols-outlined text-base">account_balance_wallet</span>
                                <span>Connect {detectedEvm}</span>
                              </>
                            )}
                          </button>
                        ) : (
                          <a
                            href="https://metamask.io"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-6 py-3 bg-surface-container hover:bg-surface-container-high border border-border-subtle text-primary text-sm font-bold rounded-xl transition-all flex items-center justify-center gap-2"
                          >
                            <span className="material-symbols-outlined text-base">download</span>
                            <span>Install MetaMask Wallet</span>
                          </a>
                        )
                      ) : (
                        detectedEvm ? (
                          <button
                            type="button"
                            onClick={() => handleConnectWallet('polygon')}
                            disabled={connectingWallet}
                            className="px-6 py-3 bg-[#8B5CF6] hover:bg-[#7C3AED] text-white text-sm font-bold rounded-xl shadow-md transition-all flex items-center justify-center gap-2 hover:scale-[1.02] disabled:opacity-50"
                          >
                            {connectingWallet ? (
                              <>
                                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                <span>Connecting &amp; Signing...</span>
                              </>
                            ) : (
                              <>
                                <span className="material-symbols-outlined text-base">account_balance_wallet</span>
                                <span>Connect Polygon Wallet</span>
                              </>
                            )}
                          </button>
                        ) : (
                          <a
                            href="https://metamask.io"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-6 py-3 bg-surface-container hover:bg-surface-container-high border border-border-subtle text-primary text-sm font-bold rounded-xl transition-all flex items-center justify-center gap-2"
                          >
                            <span className="material-symbols-outlined text-base">download</span>
                            <span>Install MetaMask Wallet</span>
                          </a>
                        )
                      )}


                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Feedback Alerts */}
          {walletConnectSuccess && (
            <div className="mt-4 p-3 bg-status-success/10 border border-status-success/30 rounded-lg text-xs text-status-success font-medium flex items-center gap-2">
              <span className="material-symbols-outlined text-base">check_circle</span>
              <span>{walletConnectSuccess}</span>
            </div>
          )}
          {walletConnectError && (
            <div className="mt-4 p-3 bg-status-error/10 border border-status-error/30 rounded-lg text-xs text-status-error font-medium flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-base">error</span>
                <span>{walletConnectError}</span>
              </div>
              <button
                type="button"
                onClick={() => setWalletConnectError(null)}
                className="text-on-surface-variant hover:text-primary text-xs underline"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Collapsible Manual Address Entry Fallback for Headless / Read-Only Viewers */}
          <div className="mt-4 pt-3 border-t border-border-subtle/50">
            <button
              type="button"
              onClick={() => setShowManualInput(!showManualInput)}
              className="text-[11px] text-on-surface-variant hover:text-primary font-medium flex items-center gap-1 transition-colors"
            >
              <span className="material-symbols-outlined text-sm">
                {showManualInput ? 'expand_less' : 'expand_more'}
              </span>
              <span>
                {showManualInput ? 'Hide manual address input' : 'On a device without wallet extension? Enter address for read-only preview'}
              </span>
            </button>

            {showManualInput && (
              <form onSubmit={handleLinkWallet} className="mt-3 flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  required
                  placeholder={
                    linkChain === 'solana'
                      ? 'Enter Solana wallet address (e.g. 7xKX...)'
                      : 'Enter EVM wallet address (0x...)'
                  }
                  value={walletInput}
                  onChange={(e) => setWalletInput(e.target.value)}
                  className="flex-1 bg-surface-container border border-border-subtle rounded-lg px-3 py-2 text-xs font-mono outline-none focus:border-primary"
                />
                <button
                  type="submit"
                  disabled={linking || !walletInput.trim()}
                  className="px-4 py-2 bg-surface-container-high hover:bg-surface-dim border border-border-subtle text-primary rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 shrink-0 disabled:opacity-50"
                >
                  {linking ? 'Deriving...' : 'Preview Derived Authority'}
                </button>
              </form>
            )}

            {linkSuccess && (
              <div className="mt-2 text-xs text-status-success font-medium">
                {linkSuccess}
              </div>
            )}
          </div>
        </section>

        {loading ? (
          <LoadingSkeleton rows={5} />
        ) : !data ? (
          <p role="status" className="p-6 text-on-surface-variant">Vault observations unavailable. No custody, wallet status or funding authority is inferred.</p>
        ) : (
          <>
            {actionSuccessNotice && (
              <div className="p-3.5 bg-status-success/15 border border-status-success/30 rounded-xl text-status-success text-xs font-semibold mb-6 flex items-center gap-2 animate-fade-in">
                <span className="material-symbols-outlined text-base">task_alt</span>
                <span>{actionSuccessNotice}</span>
              </div>
            )}

            {/* 2. Three Venue Custody Cards */}
            <section className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-12">
              <div className="bg-surface-container-lowest border border-border-subtle rounded-2xl p-6">
                <h3 className="font-bold">Solana vault — deployment unverified</h3>
                <p className="text-xs my-3">Wallet linking does not deploy a vault. Registration and funding are unavailable until on-chain ownership and execution authority can be verified.</p>
                <button onClick={handleRevokeSolanaVault} className="text-xs underline">Disable local Solana grants</button>
                <p className="text-xs mt-3">Local disable does not close an on-chain account, revoke its authority, or refund rent.</p>
              </div>

              <div className="bg-surface-container-lowest border border-border-subtle rounded-2xl p-6">
                <h3 className="font-bold">Robinhood EOA — delegation unsupported</h3>
                <p className="text-xs my-3">Wallet linking remains available, including WalletConnect. No deployed EIP-7702 delegation, smart account, gas sponsorship or automated spend authority is available. Do not fund an assumed smart account.</p>
                <p className="font-mono text-xs break-all">Linked EOA: {data?.robinhood.accountAddress || 'No verified EVM wallet linked'}</p>
                <button disabled className="mt-3 opacity-50">Delegation unavailable</button>
                <button onClick={handleRevokeRobinhoodSession} className="block mt-3 text-xs underline">Disable historical local Robinhood grants</button>
              </div>

              {/* 3. Polymarket Safe Deposit Address */}
              <div className="bg-surface-container-lowest border border-border-subtle rounded-2xl p-6 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-bold text-primary text-base">Polymarket Deposit Proxy</span>
                    <ChainBadge chain="polymarket" />
                  </div>
                  <p className="text-xs text-on-surface-variant mb-4">
                    Locally recorded Polymarket credentials do not establish a deployed deposit proxy or live executor.
                  </p>

                  <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-xs text-amber-800 dark:text-amber-300 mb-4">
                    <div className="font-bold mb-1 flex items-center gap-1">
                      <span className="material-symbols-outlined text-sm">info</span>
                      Zero-Custody Venue Float Rule (ADR-0003)
                    </div>
                    Do not fund an assumed proxy. No deposit address has been verified by this application.
                  </div>

                  <div className="space-y-3 p-3 bg-surface-container-low rounded-xl border border-border-subtle font-mono text-xs mb-4">
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-on-surface-variant uppercase font-semibold">Deposit Proxy Address (Polygon)</span>
                        <button
                          disabled={!data?.polymarket.depositAddress}
                          onClick={() => { if (data?.polymarket.depositAddress) triggerCopy(data.polymarket.depositAddress, 'poly-deposit'); }}
                          className="text-[10px] text-primary underline font-bold flex items-center gap-1 cursor-pointer"
                        >
                          {copiedKey === 'poly-deposit' ? <span className="text-status-success font-bold">✓ Copied!</span> : 'Copy Address'}
                        </button>
                      </div>
                      <div className="font-bold text-primary truncate mt-0.5 select-all">{data?.polymarket.depositAddress || 'Unverified — funding unavailable'}</div>
                    </div>
                    <div className="pt-2 border-t border-border-subtle flex items-center justify-between">
                      <span className="text-on-surface-variant">L2 CLOB Signer:</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                        data?.polymarket.status === 'credentials_recorded'
                          ? 'bg-status-success/15 text-status-success'
                          : 'bg-surface-container-high text-on-surface-variant'
                      }`}>
                        {data?.polymarket.status === 'credentials_recorded' ? 'CREDENTIALS RECORDED — EXECUTION UNAVAILABLE' : 'UNINITIALIZED'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-on-surface-variant">Network:</span>
                      <span className="font-bold text-[#8B5CF6]">Polygon (Chain ID 137)</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-on-surface-variant">Asset:</span>
                      <span className="font-bold text-primary">Native Polygon USDC</span>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={handleAuthorizePolymarketL2}
                    disabled={authorizingPoly || !enrollmentAllowed(data?.polymarket)}
                    className="w-full py-2.5 bg-[#8B5CF6] hover:bg-[#7C3AED] text-white font-bold text-xs rounded-lg transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50 shadow-sm"
                  >
                    {authorizingPoly ? (
                      <>
                        <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        <span>Authenticating with Polymarket...</span>
                      </>
                    ) : (
                      <>
                        <span className="material-symbols-outlined text-sm">verified_user</span>
                        <span>
                          {enrollmentAllowed(data?.polymarket) ? 'Polymarket enrollment' : 'Polymarket enrollment unavailable'}
                        </span>
                      </>
                    )}
                  </button>
                  <button
                    disabled
                          onClick={() => setError('Deposit funding unavailable; no proxy address is verified.')}
                    className="w-full py-2 bg-surface-container hover:bg-surface-container-high border border-border-subtle text-primary font-bold text-xs rounded-lg transition-colors flex items-center justify-center gap-1.5"
                  >
                    <span className="material-symbols-outlined text-sm">qr_code</span>
                    <span>Deposit unavailable</span>
                  </button>
                  <div className="flex items-center justify-between text-xs font-mono text-on-surface-variant px-1 pt-1">
                    <span>Geo-Eligibility:</span>
                    <span className="text-on-surface-variant font-bold">{geoNotice(data?.polymarket.geoEligible)}</span>
                  </div>
                </div>
              </div>
            </section>

            <section className="bg-surface-container-lowest border border-border-subtle rounded-2xl p-6 sm:p-8 max-w-2xl mx-auto shadow-sm mb-8">
              <h2 className="font-headline-md text-xl font-bold text-primary">Withdrawal admission</h2>
              <LocalEnrollmentPanel capability={data?.localEnrollment} />
              <FinancialRequestPanel kind="withdrawal" capability={withdrawalCapability} />
            </section>
          </>
        )}

        {/* Modal: Fund Solana Gas Float */}
        {activeModal === 'solana-gas' && (
          <div role="alert">Vault funding is unsupported. No deployed vault or gas balance has been verified.
            <button onClick={() => setActiveModal(null)}>Close</button>
          </div>
        )}

        {/* Modal: Polymarket Deposit Address */}
        {activeModal === 'polymarket-deposit' && (
          <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-surface-container-lowest border border-border-subtle rounded-2xl max-w-md w-full p-6 shadow-2xl animate-fade-in">
              <div className="flex items-center justify-between border-b border-border-subtle pb-3 mb-4">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#8B5CF6]" />
                  <h3 className="font-headline-md font-bold text-primary text-base">Polymarket Deposit Address</h3>
                </div>
                <button onClick={() => setActiveModal(null)} className="text-on-surface-variant hover:text-primary">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>

              <p className="text-xs text-on-surface-variant mb-4">
                Deposit proxy verification is unavailable. Do not send funds to an assumed proxy. Use the venue directly for account funding.
              </p>

              <div className="p-3 bg-surface-container rounded-xl border border-border-subtle mb-4">
                <span className="text-[10px] text-on-surface-variant uppercase font-semibold block mb-1">
                  Polymarket Proxy Address (Polygon PoS)
                </span>
                <div className="font-mono text-xs text-primary font-bold break-all mb-2">
                  {data?.polymarket.depositAddress}
                </div>
                <button
                  onClick={() => triggerCopy(data?.polymarket.depositAddress || '', 'modal-poly')}
                  className="text-xs font-semibold text-primary underline"
                >
                  {copiedKey === 'modal-poly' ? <span className="text-status-success font-bold">✓ Copied Address!</span> : 'Copy Address'}
                </button>
              </div>

              <div className="p-3 bg-[#8B5CF6]/10 border border-[#8B5CF6]/30 rounded-xl text-xs text-[#8B5CF6] mb-4">
                Deposit processing and confirmation requirements are unverified here. No deposit completion is promised.
              </div>

              <button
                onClick={() => setActiveModal(null)}
                className="w-full py-2.5 bg-primary text-white font-bold rounded-xl text-sm hover:opacity-90"
              >
                Done
              </button>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}
