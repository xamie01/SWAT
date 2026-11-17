'use client';

import React, { useState } from 'react';
import { useAppKit, useAppKitAccount, useDisconnect, useAppKitProvider } from '@reown/appkit/react';
import { useSignMessage } from 'wagmi';
import { api } from '../lib/api.js';
import { toBase58 } from '../lib/wallets.js';

interface WalletConnectModalButtonProps {
  chainKind?: 'solana' | 'robinhood-chain' | 'polygon';
  onLinked?: (address: string, chain: string) => void;
  className?: string;
}

export function WalletConnectModalButton({
  chainKind = 'polygon',
  onLinked,
  className = '',
}: WalletConnectModalButtonProps) {
  const { open } = useAppKit();
  const { address, isConnected, status } = useAppKitAccount();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const { walletProvider } = useAppKitProvider(chainKind === 'solana' ? 'solana' : 'eip155');

  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleOpenModal = async () => {
    setError(null);
    setSuccess(null);
    try {
      await open();
    } catch (err: any) {
      setError(err?.message || 'Could not open WalletConnect modal');
    }
  };

  const handleSignAndLink = async () => {
    if (!address) {
      setError('No wallet connected via WalletConnect');
      return;
    }

    setSigning(true);
    setError(null);
    setSuccess(null);

    try {
      const isSolana = chainKind === 'solana';
      const targetChainKind = isSolana ? 'solana' : 'evm';

      // 1. Request cryptographic nonce challenge from WAKE backend
      const { nonce, message } = await api.post<{
        nonce: string;
        message: string;
        expiresAt: string;
      }>('/v1/auth/wallet/nonce', {
        address,
        chainKind: targetChainKind,
      });

      let signature: string;

      // 2. Request signature via WalletConnect bridge
      if (isSolana) {
        if (!walletProvider || typeof (walletProvider as any).signMessage !== 'function') {
          throw new Error('Connected Solana wallet provider does not support signMessage');
        }
        const encoded = new TextEncoder().encode(message);
        const signed = await (walletProvider as any).signMessage(encoded);
        const sigBytes = signed.signature || signed;
        signature = sigBytes instanceof Uint8Array ? toBase58(sigBytes) : String(sigBytes);
      } else {
        // EVM: Use Wagmi signMessage over WalletConnect relay
        signature = await signMessageAsync({
          message,
        });
      }

      // 3. Verify signature with WAKE backend
      await api.post('/v1/auth/wallet/verify', {
        address,
        chainKind: targetChainKind,
        message,
        signature,
      });

      // Ownership linking does not grant vault or enrollment authority.
      setSuccess(`Wallet ownership linked via WalletConnect. Vault deployment, enrollment and live execution remain unavailable.`);
      if (onLinked) {
        onLinked(address, chainKind);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to sign challenge with connected wallet');
    } finally {
      setSigning(false);
    }
  };

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {!isConnected ? (
        <button
          type="button"
          onClick={handleOpenModal}
          className="px-5 py-2.5 bg-gradient-to-r from-[#3B99FC] to-[#0052FF] hover:from-[#2B89EC] hover:to-[#0042DF] text-white text-xs sm:text-sm font-bold rounded-xl shadow-md transition-all flex items-center justify-center gap-2 hover:scale-[1.02]"
        >
          {/* WalletConnect Logo Icon */}
          <svg
            className="w-4 h-4 shrink-0 fill-current"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path d="M4.913 7.524c3.915-3.834 10.26-3.834 14.174 0l.47.46a.48.48 0 0 1 0 .692l-1.616 1.583a.25.25 0 0 1-.347 0l-.645-.632c-2.796-2.738-7.33-2.738-10.126 0l-.69.676a.25.25 0 0 1-.348 0L4.17 8.72a.48.48 0 0 1 0-.692l.743-.704zm17.65 3.407 1.436 1.406a.48.48 0 0 1 0 .692l-6.486 6.353a.25.25 0 0 1-.347 0l-4.593-4.498a.08.08 0 0 0-.116 0l-4.593 4.498a.25.25 0 0 1-.348 0L.93 13.029a.48.48 0 0 1 0-.692l1.435-1.406a.48.48 0 0 1 .695 0l4.593 4.498a.08.08 0 0 0 .116 0l4.593-4.498a.48.48 0 0 1 .695 0l4.593 4.498a.08.08 0 0 0 .116 0l4.593-4.498a.48.48 0 0 1 .695 0z" />
          </svg>
          <span>Connect via WalletConnect (QR Code / Mobile)</span>
        </button>
      ) : (
        <div className="flex flex-col sm:flex-row items-center gap-2 p-3 bg-surface-container rounded-xl border border-border-subtle">
          <div className="flex items-center gap-2 grow truncate">
            <span className="w-2 h-2 rounded-full bg-status-success animate-pulse" />
            <span className="text-xs font-mono font-bold text-primary truncate">
              {address ? `${address.slice(0, 6)}...${address.slice(-4)}` : 'Connected'}
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={handleSignAndLink}
              disabled={signing}
              className="px-3 py-1.5 bg-primary hover:bg-primary/90 text-white text-xs font-bold rounded-lg transition-colors flex items-center gap-1 disabled:opacity-50"
            >
              {signing ? (
                <>
                  <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>Signing on Phone...</span>
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-sm">verified_user</span>
                  <span>Sign &amp; Link</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => disconnect()}
              className="px-2.5 py-1.5 bg-surface-container-high hover:bg-status-error/10 hover:text-status-error text-on-surface-variant text-xs font-medium rounded-lg transition-colors"
              title="Disconnect WalletConnect"
            >
              <span className="material-symbols-outlined text-sm">logout</span>
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="text-[11px] text-status-error font-medium px-1 flex items-center gap-1">
          <span className="material-symbols-outlined text-xs">error</span>
          <span>{error}</span>
        </p>
      )}

      {success && (
        <p className="text-[11px] text-status-success font-medium px-1 flex items-center gap-1">
          <span className="material-symbols-outlined text-xs">check_circle</span>
          <span>{success}</span>
        </p>
      )}
    </div>
  );
}
