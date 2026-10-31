'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { WakeLogo } from './WakeLogo.js';
import { StatusPill, type StreamState } from './StatusPill.js';
import { TierBadge } from './UIPrimitives.js';
import { api } from '../lib/api.js';

export function SaaSNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [streamState, setStreamState] = useState<StreamState>('connected');
  const [tier, setTier] = useState<string>('operator');
  const [killSwitchActive, setKillSwitchActive] = useState<boolean>(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Auto-close drawer on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    // Fetch user status
    api
      .get<{ user: { tier: string }; executionSettings?: { killSwitchActive: boolean } }>('/v1/me/account')
      .then((data) => {
        if (data?.user?.tier) setTier(data.user.tier);
        if (data?.executionSettings?.killSwitchActive !== undefined) {
          setKillSwitchActive(data.executionSettings.killSwitchActive);
        }
      })
      .catch(() => {
        // Fallback gracefully
      });
  }, []);

  const handleLogout = async () => {
    try {
      await api.post('/v1/auth/logout', {});
    } catch {
      // Ignore network errors during logout
    }
    router.push('/login');
  };

  const navLinks = [
    { label: 'Dashboard', href: '/dashboard', icon: 'dashboard' },
    { label: 'Positions', href: '/positions', icon: 'trending_up' },
    { label: 'Funding & Vault', href: '/vault', icon: 'account_balance_wallet' },
    { label: 'Billing', href: '/billing', icon: 'credit_card' },
    { label: 'Risk Settings', href: '/settings', icon: 'tune' },
  ];

  return (
    <header className="sticky top-0 z-40 w-full bg-surface-container-lowest/90 backdrop-blur-md border-b border-border-subtle">
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-4 md:gap-8">
          <Link href="/dashboard" className="flex items-center gap-2 hover:opacity-90 transition-opacity">
            <WakeLogo size="sm" />
            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-primary text-white">TRADER</span>
          </Link>

          {/* Desktop Nav */}
          <nav className="hidden md:flex items-center gap-1">
            {navLinks.map((link) => {
              const isActive = pathname === link.href || pathname.startsWith(`${link.href}/`);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-surface-container text-primary font-semibold'
                      : 'text-on-surface-variant hover:text-primary hover:bg-surface-container-low'
                  }`}
                >
                  <span className="material-symbols-outlined text-base">{link.icon}</span>
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Right Status & Actions */}
        <div className="flex items-center gap-2 sm:gap-4">
          <div className="hidden xs:flex items-center gap-2">
            <StatusPill state={streamState} />
            <TierBadge tier={tier} />
          </div>

          {killSwitchActive && (
            <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded bg-status-error/10 text-status-error text-xs font-mono font-bold border border-status-error/30 animate-pulse">
              KILL-SWITCH ON
            </span>
          )}

          <button
            onClick={handleLogout}
            title="Sign out"
            className="hidden sm:flex text-on-surface-variant hover:text-status-error transition-colors p-2 rounded-lg hover:bg-surface-container"
          >
            <span className="material-symbols-outlined text-lg">logout</span>
          </button>

          {/* Mobile hamburger button */}
          <button
            type="button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="md:hidden p-2 text-on-surface-variant hover:text-primary rounded-lg hover:bg-surface-container transition-colors"
            aria-label="Toggle navigation menu"
          >
            <span className="material-symbols-outlined text-2xl">{mobileMenuOpen ? 'close' : 'menu'}</span>
          </button>
        </div>
      </div>

      {/* Mobile Drawer Menu */}
      {mobileMenuOpen && (
        <div className="md:hidden border-t border-border-subtle bg-surface-container-lowest px-4 py-4 space-y-3 animate-fade-in shadow-xl">
          <div className="flex items-center justify-between px-2 py-1">
            <div className="flex items-center gap-2">
              <StatusPill state={streamState} />
              <TierBadge tier={tier} />
            </div>
            {killSwitchActive && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-status-error/10 text-status-error text-xs font-mono font-bold border border-status-error/30 animate-pulse">
                KILL-SWITCH ON
              </span>
            )}
          </div>

          <nav className="flex flex-col gap-1">
            {navLinks.map((link) => {
              const isActive = pathname === link.href || pathname.startsWith(`${link.href}/`);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileMenuOpen(false)}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-surface-container text-primary font-bold'
                      : 'text-on-surface-variant hover:text-primary hover:bg-surface-container-low'
                  }`}
                >
                  <span className="material-symbols-outlined text-lg">{link.icon}</span>
                  <span>{link.label}</span>
                </Link>
              );
            })}
          </nav>

          <div className="pt-2 border-t border-border-subtle">
            <button
              onClick={handleLogout}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm text-on-surface-variant hover:text-status-error hover:bg-surface-container transition-colors"
            >
              <span className="material-symbols-outlined text-lg">logout</span>
              <span>Sign out</span>
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
