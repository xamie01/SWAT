'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api } from '../lib/api.js';

export function AdminNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [emergencyOffTriggered, setEmergencyOffTriggered] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleEmergencyOff = async () => {
    if (!window.confirm('CRITICAL: Are you sure you want to trigger GLOBAL EMERGENCY OFF across all trading venues?')) {
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/v1/trading/emergency-off', { reason: 'Admin dashboard emergency trigger' });
      setEmergencyOffTriggered(true);
      alert('Global emergency off executed successfully.');
    } catch (err: any) {
      alert(`Emergency trigger failed: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogout = async () => {
    try {
      await api.post('/v1/auth/logout', {});
    } catch {
      // Ignore
    }
    router.push('/login');
  };

  const navLinks = [
    { label: 'Trading Matrix', href: '/admin/portfolio', icon: 'hub' },
    { label: 'Workspace', href: '/workspace', icon: 'dashboard' },
    { label: 'Signals', href: '/signals', icon: 'sensors' },
    { label: 'Wallets', href: '/wallets', icon: 'account_balance_wallet' },
    { label: 'Logs', href: '/logs', icon: 'terminal' },
    { label: 'Performance', href: '/performance', icon: 'monitoring' },
    { label: 'Setup', href: '/setup', icon: 'settings' },
  ];

  return (
    <header className="sticky top-0 z-40 w-full bg-surface-container-lowest/90 backdrop-blur-md border-b border-border-subtle">
      <div className="max-w-[1440px] mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <Link href="/admin/portfolio" className="flex items-center gap-2">
            <span className="font-headline-md text-xl font-black tracking-tight text-primary">WAKE</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-status-error text-white">OPERATOR</span>
          </Link>

          <nav className="hidden lg:flex items-center gap-1">
            {navLinks.map((link) => {
              const isActive = pathname === link.href || (link.href !== '/' && pathname.startsWith(`${link.href}/`));
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
          <button
            onClick={handleEmergencyOff}
            disabled={submitting}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-colors ${
              emergencyOffTriggered
                ? 'bg-status-error text-white'
                : 'bg-status-error/10 text-status-error hover:bg-status-error hover:text-white border border-status-error/30'
            }`}
          >
            <span className="material-symbols-outlined text-sm">warning</span>
            <span>{emergencyOffTriggered ? 'TRADING STOPPED' : 'EMERGENCY OFF'}</span>
          </button>

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
