'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function LpLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  const navLinks = [
    { href: '/lp/discover', label: 'Discover Pools', icon: 'travel_explore' },
    { href: '/lp/whales', label: 'LP Whales & Copy', icon: 'group' },
    { href: '/lp/builder', label: 'Custom Ladder Builder', icon: 'tune' },
    { href: '/lp/positions', label: 'My Positions', icon: 'pie_chart' },
  ];

  return (
    <div className="bg-background text-on-surface min-h-screen font-sans flex flex-col">
      {/* Top Navigation Bar */}
      <header className="h-16 border-b border-outline-variant bg-surface px-6 md:px-12 flex items-center justify-between z-50 sticky top-0">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-3 hover:opacity-85 transition-opacity">
            <img
              alt="WAKE Logo"
              className="w-7 h-7 object-contain"
              src="https://lh3.googleusercontent.com/aida/AP1WRLtbiJamaZZC7KwG5HAC1bnTyrrpCooabzkx-afw4Hp3qnVeDYAxIj9CLKbXPMe92O_IlprpgSWFQtrJZtapEqhgnCmjmkhv1LuJYEAbn2qfgPjlfX3MnBwrz-NwtXz4Z-EEAR3Se7g1jQv9ih8wMXyH5w_5ItNZkzn3ToFuhTgeAt6kCATuziBpGQsuYGlz4yx3GgwHDVkghvJpYolBYA_-A1cOUIGqWivShnnDEsXeOA5JXcwqWUD4se4"
            />
            <span className="font-bold text-lg text-primary leading-none">WAKE</span>
          </Link>

          <div className="h-4 w-px bg-outline-variant"></div>

          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-primary">LP Liquidity Protocol</span>
            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-primary/20 text-primary border border-primary/30 uppercase">
              CLMM & DLMM
            </span>
          </div>
        </div>

        {/* Action Links */}
        <div className="flex items-center gap-4">
          <Link
            href="/workspace"
            className="text-xs font-bold text-on-surface-variant hover:text-primary transition-colors flex items-center gap-1.5"
          >
            <span className="material-symbols-outlined text-[16px]">grid_view</span>
            <span>Workspace</span>
          </Link>
          <div className="h-4 w-px bg-outline-variant"></div>
          <div className="flex items-center gap-2 text-xs font-mono text-on-surface-variant">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>MULTI-CHAIN ACTIVE</span>
          </div>
        </div>
      </header>

      {/* Sub-Header Tabs */}
      <div className="bg-surface-container-low border-b border-outline-variant px-6 md:px-12 py-2 flex items-center gap-2 overflow-x-auto">
        {navLinks.map((item) => {
          const isActive = pathname === item.href || (pathname === '/lp' && item.href === '/lp/discover');
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-2 transition-all shrink-0 ${
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
      <main className="flex-1 bg-surface-container-lowest p-6 md:p-8">
        <div className="max-w-[1440px] mx-auto">{children}</div>
      </main>
    </div>
  );
}
