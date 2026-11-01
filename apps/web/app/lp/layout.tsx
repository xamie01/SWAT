'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function LpLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  const navLinks = [
    { href: '/lp/discover', label: 'Discover Pools', icon: 'travel_explore' },
    { href: '/lp/copy', label: 'Copy Masters', icon: 'content_copy' },
    { href: '/lp/whales', label: 'Whale Leaderboard', icon: 'military_tech' },
    { href: '/lp/builder', label: 'Ladder Builder', icon: 'tune' },
    { href: '/lp/positions', label: 'My Positions', icon: 'pie_chart' },
  ];

  return (
    <div className="bg-background text-on-surface min-h-screen font-sans flex flex-col">
      {/* Top Navigation Bar */}
      <header className="h-14 sm:h-16 border-b border-outline-variant bg-surface px-3 sm:px-6 md:px-12 flex items-center justify-between z-50 sticky top-0 shadow-xs">
        <div className="flex items-center gap-2.5 sm:gap-4 md:gap-6">
          <Link href="/" className="flex items-center gap-2 sm:gap-3 hover:opacity-85 transition-opacity">
            <img
              alt="WAKE Logo"
              className="w-6 h-6 sm:w-7 sm:h-7 object-contain"
              src="https://lh3.googleusercontent.com/aida/AP1WRLtbiJamaZZC7KwG5HAC1bnTyrrpCooabzkx-afw4Hp3qnVeDYAxIj9CLKbXPMe92O_IlprpgSWFQtrJZtapEqhgnCmjmkhv1LuJYEAbn2qfgPjlfX3MnBwrz-NwtXz4Z-EEAR3Se7g1jQv9ih8wMXyH5w_5ItNZkzn3ToFuhTgeAt6kCATuziBpGQsuYGlz4yx3GgwHDVkghvJpYolBYA_-A1cOUIGqWivShnnDEsXeOA5JXcwqWUD4se4"
            />
            <span className="font-bold text-base sm:text-lg text-primary leading-none">WAKE</span>
          </Link>

          <div className="h-4 w-px bg-outline-variant hidden sm:block"></div>

          <div className="flex items-center gap-1.5 sm:gap-2">
            <span className="text-[11px] sm:text-xs font-bold text-primary truncate max-w-[120px] sm:max-w-none">
              LP Protocol
            </span>
            <span className="px-1.5 sm:px-2 py-0.5 rounded text-[9px] sm:text-[10px] font-mono font-bold bg-primary/20 text-primary border border-primary/30 uppercase">
              CLMM & DLMM
            </span>
          </div>
        </div>

        {/* Action Links */}
        <div className="flex items-center gap-2 sm:gap-4">
          <Link
            href="/dashboard"
            className="text-xs font-bold text-on-surface-variant hover:text-primary transition-colors flex items-center gap-1 sm:gap-1.5 px-2.5 py-1 sm:px-3 sm:py-1.5 rounded-lg bg-surface-container hover:bg-surface-container-high border border-border-subtle"
          >
            <span className="material-symbols-outlined text-[16px]">dashboard</span>
            <span className="hidden xs:inline">Dashboard</span>
          </Link>

          <div className="h-4 w-px bg-outline-variant hidden sm:block"></div>

          <div className="flex items-center gap-1.5 text-[11px] sm:text-xs font-mono text-on-surface-variant">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span className="hidden md:inline">MULTI-CHAIN ACTIVE</span>
            <span className="md:hidden text-[10px] font-bold text-emerald-400">LIVE</span>
          </div>
        </div>
      </header>

      {/* Sub-Header Tabs */}
      <div className="bg-surface-container-low border-b border-outline-variant px-3 sm:px-6 md:px-12 py-2 flex items-center gap-1.5 sm:gap-2 overflow-x-auto no-scrollbar scroll-smooth">
        {navLinks.map((item) => {
          const isActive =
            pathname === item.href ||
            (pathname === '/lp' && item.href === '/lp/discover') ||
            (pathname.startsWith('/lp/copy') && item.href === '/lp/copy');

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all shrink-0 whitespace-nowrap active:scale-95 ${
                isActive
                  ? 'bg-primary text-on-primary shadow-sm'
                  : 'text-on-surface-variant hover:text-primary hover:bg-surface-container'
              }`}
            >
              <span className="material-symbols-outlined text-[16px]">{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>

      {/* Page Content */}
      <main className="flex-1 bg-surface-container-lowest p-3 sm:p-5 md:p-8">
        <div className="max-w-[1440px] mx-auto">{children}</div>
      </main>
    </div>
  );
}
