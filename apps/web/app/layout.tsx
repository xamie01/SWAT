import type { ReactNode } from 'react';
import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist',
  subsets: ['latin'],
  display: 'swap',
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Wake Protocol | Operational Cross-Chain Intelligence',
  description: 'Wake Protocol: Cross-chain copy-trading intelligence across Solana, Robinhood, and Polymarket',
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || 'https://wake.trade'),
  icons: {
    icon: '/logo.svg',
  },
  robots: {
    index: true,
    follow: true,
  },
  openGraph: {
    title: 'Wake Protocol | Operational Cross-Chain Intelligence',
    description: 'Operational cross-chain copy-trading intelligence across Solana, Robinhood, and Polymarket',
    siteName: 'Wake Protocol',
    type: 'website',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-background text-on-background min-h-screen font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
