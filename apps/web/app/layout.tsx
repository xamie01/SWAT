import type { ReactNode } from 'react';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'Inter, system-ui, sans-serif', margin: 0, padding: '1.5rem', background: '#0b1020', color: '#e5e7eb' }}>
        {children}
      </body>
    </html>
  );
}
