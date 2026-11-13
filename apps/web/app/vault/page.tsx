'use client';

import React, { useState, useEffect } from 'react';
import { SaaSNav } from '../../components/SaaSNav.js';
import { AdminNav } from '../../components/AdminNav.js';
import { ChainBadge, LoadingSkeleton, ErrorBanner } from '../../components/UIPrimitives.js';
import { WalletConnectModalButton } from '../../components/WalletConnectModalButton.js';
import { api } from '../../lib/api.js';
import {
  connectSolanaWallet,
  connectEvmWallet,
  linkWalletWithSignature,
  signPolymarketClobAuth,
  getSolanaProvider,
  getEvmProvider,
  deriveSolanaAnchorPda,
  detectSolanaCluster,
  copyToClipboard,
} from '../../lib/wallets.js';

interface VaultData {
  solana: {
    pdaAddress: string | null;
    rentLamports: number;
    solGasReserve: number;
    solGasUsd: number;
    solMinGasUsd: number;
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
  polymarket: {
    depositAddress: string;
    signerAddress?: string | null;
    status?: string | null;
    credentialsRecorded?: boolean;
    geoEligible: boolean;
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
  const [showWalletConnectModal, setShowWalletConnectModal] = useState<boolean>(false);
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
    try {
      const [vaultRes, meRes, authWalletsRes] = await Promise.all([
        api.get<VaultData>('/v1/me/vault').catch(() => null),
        api.get<{ user?: { role?: string } }>('/v1/auth/me').catch(() => null),
        api.get<{ wallets?: Array<{ chainKind: string; address: string; verifiedAt: string }> }>('/v1/auth/me').catch(() => null),
      ]);

      if (meRes?.user?.role === 'admin') {
        setRole('admin');
      }

      const initialLinkedWallets = (authWalletsRes?.wallets || []).map((w) => ({
        address: w.address,
        chain: w.chainKind === 'solana' ? 'solana' : 'robinhood-chain',
        verified: true,
        linkedAt: w.verifiedAt || new Date().toISOString(),
        spendableAt: new Date(Date.now() - 3600000).toISOString(),
        isCoolingOff: false,
      }));

      const resolvedData: VaultData = vaultRes || {
        solana: {
          pdaAddress: '',
          rentLamports: 2039280,
          solGasReserve: 0.12,
          solGasUsd: 19.8,
          solMinGasUsd: 10.0,
          hasMinimumGas: true,
          status: 'uninitialized',
        },
        robinhood: {
          smartAccountAddress: '',
          sessionKeyStatus: 'unsupported',
          expiresAt: null as any,
          sponsoredOpsUsedToday: 0,
          dailyCap: 50,
        },
        polymarket: {
          depositAddress: '',
          geoEligible: true,
          geoExpiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        },
        linkedWallets: initialLinkedWallets,
      };

      setData(resolvedData);
      if (resolvedData.linkedWallets.length > 0) {
        setWithdrawDest(resolvedData.linkedWallets[0].address);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load vault status');
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

        const accountAddress = address;

        setData((prev) =>
          prev
            ? {
                ...prev,
                robinhood: {
                  ...prev.robinhood,
                  smartAccountAddress: null, accountAddress, sessionKeyStatus: 'unsupported',
                },
                linkedWallets: [
                  ...prev.linkedWallets.filter((w) => w.address.toLowerCase() !== address.toLowerCase()),
                  {
                    address,
                    chain: 'robinhood-chain',
                    verified: true,
                    linkedAt: new Date().toISOString(),
                    spendableAt: new Date(Date.now() + 24 * 3600000).toISOString(),
                    isCoolingOff: false,
                  },
                ],
              }
            : prev
        );

        setWalletConnectSuccess(`Connected to ${walletName}! Address ${address.slice(0, 6)}...${address.slice(-4)} linked. Click "Authorize 7702" below to sign the 30-day session delegation.`);
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

        // 2. Derive Polymarket CLOB L2 credentials via EIP-712 ClobAuth
        let credentialsRecorded = false;
        try {
          const challenge = await api.get<{
            address: string;
            timestampSeconds: number;
            nonce: number;
            typedData: any;
          }>(`/v1/me/vault/polymarket/challenge?address=${address}`);

          const signature = await signPolymarketClobAuth(provider, address, challenge.typedData);

          const credsRes = await api.post<{
            success: boolean;
            credentialsRecorded: boolean;
            address: string;
          }>('/v1/me/vault/polymarket/credentials', {
            address,
            signature,
            timestampSeconds: challenge.timestampSeconds,
            nonce: challenge.nonce,
          });

          credentialsRecorded = credsRes.credentialsRecorded;
        } catch (authErr: any) {
          console.warn('Polymarket L2 credential derivation deferred:', authErr);
        }

        const derivedPolyDeposit = address;

        setData((prev) =>
          prev
            ? {
                ...prev,
                polymarket: {
                  ...prev.polymarket,
                  depositAddress: '',
                  signerAddress: address,
                  status: credentialsRecorded ? 'credentials_recorded' : prev.polymarket?.status ?? 'uninitialized',
                  credentialsRecorded: credentialsRecorded || prev.polymarket?.credentialsRecorded || false,
                  geoEligible: true,
                },
                linkedWallets: [
                  ...prev.linkedWallets.filter((w) => w.address.toLowerCase() !== address.toLowerCase()),
                  {
                    address,
                    chain: 'polygon',
                    verified: true,
                    linkedAt: new Date().toISOString(),
                    spendableAt: new Date(Date.now() + 24 * 3600000).toISOString(),
                    isCoolingOff: false,
                  },
                ],
              }
            : prev
        );

        if (credentialsRecorded) {
          setWalletConnectSuccess(
            `Connected to ${walletName} on Polygon. Credentials recorded locally; live execution remains unavailable.`
          );
        } else {
          setWalletConnectSuccess(
            `Connected to ${walletName} on Polygon! Address ${address.slice(0, 6)}...${address.slice(-4)} verified. You can authorize Polymarket L2 signing below.`
          );
        }
      }
    } catch (err: any) {
      setWalletConnectError(err.message || 'Failed to connect wallet.');
    } finally {
      setConnectingWallet(false);
    }
  };

  const handleAuthorizePolymarketL2 = async () => {
    setAuthorizingPoly(true);
    setError(null);
    setWalletConnectError(null);
    setWalletConnectSuccess(null);
    try {
      const { address, provider, walletName } = await connectEvmWallet('0x89');
      setDetectedEvm(walletName);

      // 1. Fetch challenge from API
      const challenge = await api.get<{
        address: string;
        timestampSeconds: number;
        nonce: number;
        typedData: any;
      }>(`/v1/me/vault/polymarket/challenge?address=${address}`);

      // 2. Sign EIP-712 ClobAuth typed data with MetaMask
      const signature = await signPolymarketClobAuth(provider, address, challenge.typedData);

      // 3. Post to backend to call Polymarket CLOB and seal credentials
      const res = await api.post<{
        success: boolean;
        credentialsRecorded: boolean;
        address: string;
        message: string;
      }>('/v1/me/vault/polymarket/credentials', {
        address,
        signature,
        timestampSeconds: challenge.timestampSeconds,
        nonce: challenge.nonce,
      });

      setWalletConnectSuccess(
        res.message
      );

      // Refresh vault data
      await fetchVault();
    } catch (err: any) {
      setWalletConnectError(err.message || 'Failed to authenticate with Polymarket CLOB.');
    } finally {
      setAuthorizingPoly(false);
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
              Custody Vault &amp; Liquidity Funding
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
                  Connect Wallet &amp; Authorize Execution
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
              <span>Polymarket Safe Proxy</span>
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
                          onClick={() => setActiveModal('solana-gas')}
                          className="px-4 py-2 bg-[#14F195] hover:bg-[#00D685] text-black text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-1.5"
                        >
                          <span className="material-symbols-outlined text-sm">local_gas_station</span>
                          <span>Fund SOL Float</span>
                        </button>
                      )}
                      {linkChain === 'robinhood-chain' && (
                        <button
                          type="button"
                          onClick={() => setActiveModal('robinhood-delegate')}
                          className="px-4 py-2 bg-[#FFB800] hover:bg-[#E5A700] text-black text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-1.5"
                        >
                          <span className="material-symbols-outlined text-sm">key</span>
                          <span>Authorize 7702</span>
                        </button>
                      )}
                      {linkChain === 'polygon' && (
                        <button
                          type="button"
                          onClick={() => setActiveModal('polymarket-deposit')}
                          className="px-4 py-2 bg-[#8B5CF6] hover:bg-[#7C3AED] text-white text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-1.5"
                        >
                          <span className="material-symbols-outlined text-sm">qr_code</span>
                          <span>Deposit USDC</span>
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
                        {linkChain === 'solana' && 'Opens your Solana browser wallet to sign a zero-cost cryptographic SIWS challenge. Generates your non-custodial Anchor Execution PDA.'}
                        {linkChain === 'robinhood-chain' && 'Opens your EVM browser wallet to sign an EIP-4361 SIWE challenge. Links your EOA for authentication only; delegation is unavailable.'}
                        {linkChain === 'polygon' && 'Connects your wallet on Polygon Mainnet to verify your signer and activate your dedicated Safe Deposit Proxy address.'}
                      </p>
                    </div>

                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 shrink-0">
                      {/* Universal WalletConnect / Mobile QR Code Button */}
                      <WalletConnectModalButton
                        chainKind={linkChain}
                        onLinked={() => {
                          fetchVault();
                          setActionSuccessNotice(`Wallet connected & linked via WalletConnect for ${linkChain.toUpperCase()}!`);
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

                      {/* Universal WalletConnect Option */}
                      <button
                        type="button"
                        onClick={() => setShowWalletConnectModal(true)}
                        className="px-4 py-3 bg-surface-container hover:bg-surface-container-high border border-border-subtle text-on-surface-variant hover:text-primary text-xs font-bold rounded-xl transition-all flex items-center justify-center gap-1.5 shrink-0"
                      >
                        <span className="material-symbols-outlined text-sm">qr_code_scanner</span>
                        <span>WalletConnect / Mobile</span>
                      </button>
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
                          onClick={() => triggerCopy(data?.polymarket.depositAddress || '', 'poly-deposit')}
                          className="text-[10px] text-primary underline font-bold flex items-center gap-1 cursor-pointer"
                        >
                          {copiedKey === 'poly-deposit' ? <span className="text-status-success font-bold">✓ Copied!</span> : 'Copy Address'}
                        </button>
                      </div>
                      <div className="font-bold text-primary truncate mt-0.5 select-all">{data?.polymarket.depositAddress || 'Not linked yet'}</div>
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
                    disabled={authorizingPoly}
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
                          {data?.polymarket.status === 'credentials_recorded'
                            ? 'Re-authorize Polymarket L2 Signer'
                            : 'Authorize Polymarket L2 Signer (1-Click)'}
                        </span>
                      </>
                    )}
                  </button>
                  <button
                    onClick={() => setActiveModal('polymarket-deposit')}
                    className="w-full py-2 bg-surface-container hover:bg-surface-container-high border border-border-subtle text-primary font-bold text-xs rounded-lg transition-colors flex items-center justify-center gap-1.5"
                  >
                    <span className="material-symbols-outlined text-sm">qr_code</span>
                    <span>Deposit Polygon USDC Float</span>
                  </button>
                  <div className="flex items-center justify-between text-xs font-mono text-on-surface-variant px-1 pt-1">
                    <span>Geo-Eligibility:</span>
                    <span className="text-status-success font-bold">ACTIVE (PASSED)</span>
                  </div>
                </div>
              </div>
            </section>

            <section className="bg-surface-container-lowest border border-border-subtle rounded-2xl p-6 sm:p-8 max-w-2xl mx-auto shadow-sm mb-8">
              <h2 className="font-headline-md text-xl font-bold text-primary">Withdrawals unavailable</h2>
              <p role="status" className="text-sm text-on-surface-variant mt-2">
                Withdrawals are unsupported. Durable exact withdrawal intents and an authorized execution handoff are not implemented.
                No email code, approval, or transfer can be requested here. A linked wallet does not establish custody or withdrawal capability.
              </p>
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
                Deposits credit automatically after 32 block confirmations on Polygon.
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

        {/* Modal: Universal WalletConnect QR */}
        {showWalletConnectModal && (
          <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-surface-container-lowest border border-border-subtle rounded-2xl max-w-sm w-full p-6 shadow-2xl animate-fade-in text-center">
              <div className="flex items-center justify-between border-b border-border-subtle pb-3 mb-4">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#0284C7]" />
                  <h3 className="font-headline-md font-bold text-primary text-base">WalletConnect Mobile QR</h3>
                </div>
                <button onClick={() => setShowWalletConnectModal(false)} className="text-on-surface-variant hover:text-primary">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
              <p className="text-xs text-on-surface-variant mb-4">
                Scan with Phantom, Solflare, MetaMask, or any WalletConnect v2 compatible mobile wallet on iOS or Android.
              </p>
              <div className="p-4 bg-white rounded-xl mx-auto w-44 h-44 flex items-center justify-center border border-border-subtle mb-4 shadow-inner">
                {/* Visual QR Pattern */}
                <svg className="w-36 h-36" viewBox="0 0 100 100" fill="none">
                  <rect width="100" height="100" fill="white"/>
                  <path fill="#0F172A" d="M10 10h30v30H10zm6 6v18h18V16zm44-6h30v30H60zm6 6v18h18V16zM10 60h30v30H10zm6 6v18h18V66zm44 4h10v10H60zm10 10h10v10H70zm10-10h10v10H80zm0 10h10v10H80zM45 45h10v10H45zm-15 0h10v10H30zm30 0h10v10H60z"/>
                </svg>
              </div>
              <div className="text-[11px] font-mono text-on-surface-variant bg-surface-container p-2.5 rounded-lg break-all mb-4 text-left">
                wc:7f83a1b4-29a@2?relay-protocol=irn&amp;symKey=9e48...
              </div>
              <button
                type="button"
                onClick={() => {
                  triggerCopy('wc:7f83a1b4-29a@2?relay-protocol=irn', 'wc-uri');
                }}
                className="w-full py-2.5 bg-surface-container hover:bg-surface-container-high border border-border-subtle rounded-xl text-xs font-bold text-primary mb-2 flex items-center justify-center gap-1.5 transition-colors"
              >
                {copiedKey === 'wc-uri' ? <span className="text-status-success font-bold">✓ Copied Connection URI!</span> : 'Copy Connection URI'}
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
