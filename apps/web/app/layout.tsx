import type { ReactNode } from 'react';
import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono, Inter, JetBrains_Mono } from 'next/font/google';
import { ThemeProvider } from '../components/ThemeProvider.js';
import { AppKitProvider } from '../context/appkit.js';
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

const interSans = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  variable: '--font-jetbrains-mono',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Wake Protocol | Operational Cross-Chain Intelligence',
  description: 'Wake Protocol: Cross-chain copy-trading intelligence across Solana, Robinhood, and Polymarket',
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || 'https://wake.trade'),
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/icon.png', type: 'image/png' },
      { url: '/logo.svg', type: 'image/svg+xml' },
    ],
    shortcut: '/favicon.ico',
    apple: '/apple-icon.png',
  },
  robots: {
    index: false,
    follow: false,
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
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${interSans.variable} ${jetbrainsMono.variable}`}
    >
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap"
          rel="stylesheet"
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var stored = localStorage.getItem('wake_theme');
                  var theme = stored ? stored : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
                  if (theme === 'dark') {
                    document.documentElement.classList.add('dark');
                  } else {
                    document.documentElement.classList.remove('dark');
                  }
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body className="bg-canvas-base text-on-surface min-h-screen font-body antialiased transition-colors duration-200">
        <ThemeProvider>
          <AppKitProvider>
            {children}
          </AppKitProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
