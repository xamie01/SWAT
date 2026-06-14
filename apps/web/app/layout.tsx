import type { ReactNode } from 'react';
import './globals.css';
import Link from 'next/link';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <div className="brand">SWAT</div>
          <Link href="/">Dashboard</Link>
          <Link href="/signals">Signals</Link>
          <Link href="/wallets">Wallets</Link>
          <Link href="/clusters">Clusters</Link>
          <Link href="/setup">Setup</Link>
        </nav>
        <div className="container">
          {children}
        </div>
      </body>
    </html>
  );
}
