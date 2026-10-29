'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { StatusPill, type StreamState } from './StatusPill.js';
import { TierBadge } from './UIPrimitives.js';
import { api } from '../lib/api.js';

export function SaaSNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [streamState, setStreamState] = useState<StreamState>('connected');
  const [tier, setTier] = useState<string>('operator');
  const [killSwitchActive, setKillSwitchActive] = useState<boolean>(false);

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
      <div className="max-w-[1440px] mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <Link href="/dashboard" className="flex items-center gap-2">
            <span className="font-headline-md text-xl font-black tracking-tight text-primary">WAKE</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-primary text-white">SAAS</span>
          </Link>

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

        <div className="flex items-center gap-4">
          <StatusPill state={streamState} />
          <TierBadge tier={tier} />

          {killSwitchActive && (
            <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded bg-status-error/10 text-status-error text-xs font-mono font-bold border border-status-error/30 animate-pulse">
              KILL-SWITCH ON
            </span>
          )}

          <button
            onClick={handleLogout}
            title="Sign out"
            className="text-on-surface-variant hover:text-status-error transition-colors p-2 rounded-lg hover:bg-surface-container"
          >
            <span className="material-symbols-outlined text-lg">logout</span>
          </button>
        </div>
      </div>
    </header>
  );
}
