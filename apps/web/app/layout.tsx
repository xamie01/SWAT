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
  title: 'WAKE | Operational Cross-Chain Intelligence',
  description: 'Operational cross-chain intelligence layer',
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || 'https://wake.trade'),
  robots: {
    index: true,
    follow: true,
  },
  openGraph: {
    title: 'WAKE | Operational Cross-Chain Intelligence',
    description: 'Operational cross-chain copy-trading intelligence across Solana, Robinhood, and Polymarket',
    siteName: 'WAKE',
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
