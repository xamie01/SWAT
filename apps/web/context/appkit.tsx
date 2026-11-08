'use client';

import React, { type ReactNode, useState } from 'react';
import { createAppKit } from '@reown/appkit/react';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { SolanaAdapter } from '@reown/appkit-adapter-solana/react';
import { polygon, mainnet, arbitrum, solana, solanaDevnet } from '@reown/appkit/networks';
import { WagmiProvider, type Config } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// WalletConnect / Reown Cloud Project ID (get one free at https://cloud.reown.com)
// In Next.js, public environment variables exposed to the browser must be prefixed with NEXT_PUBLIC_
export const projectId =
  process.env.NEXT_PUBLIC_PROJECT_ID ||
  process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ||
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ||
  '439694fe56404ce5e89d66f5deb1c713';

export const networks = [polygon, mainnet, arbitrum, solana, solanaDevnet] as const;

// EVM Wagmi Adapter
export const wagmiAdapter = new WagmiAdapter({
  projectId,
  networks: [polygon, mainnet, arbitrum],
  ssr: true,
});

// Solana Adapter
export const solanaAdapter = new SolanaAdapter({
  wallets: [],
});

// Metadata for WAKE
const metadata = {
  name: 'Wake Protocol',
  description: 'Cross-chain copy-trading intelligence across Solana, Robinhood, and Polymarket',
  url: typeof window !== 'undefined' ? window.location.origin : 'https://wake.trade',
  icons: ['https://wake.trade/icon.png'],
};

// Initialize AppKit modal
createAppKit({
  adapters: [wagmiAdapter, solanaAdapter],
  networks: [polygon, mainnet, arbitrum, solana, solanaDevnet],
  projectId,
  metadata,
  themeMode: 'dark',
  features: {
    analytics: false,
    email: false,
    socials: [],
  },
  themeVariables: {
    '--w3m-accent': '#00F0FF',
    '--w3m-border-radius-master': '8px',
  },
});

export function AppKitProvider({ children }: { children: ReactNode }) {
  // QueryClient initialized lazily to avoid cross-request caching in SSR
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
          },
        },
      })
  );

  return (
    <WagmiProvider config={wagmiAdapter.wagmiConfig as Config}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
