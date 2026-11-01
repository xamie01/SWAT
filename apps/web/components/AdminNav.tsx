'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { WakeLogo } from './WakeLogo.js';
import { api } from '../lib/api.js';

export function AdminNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [emergencyOffTriggered, setEmergencyOffTriggered] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Close mobile drawer on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

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
    { label: 'Clusters', href: '/clusters', icon: 'dataset' },
    { label: 'Logs', href: '/logs', icon: 'terminal' },
    { label: 'Performance', href: '/performance', icon: 'monitoring' },
    { label: 'SaaS Revenue', href: '/admin/revenue', icon: 'payments' },
    { label: 'Setup', href: '/setup', icon: 'settings' },
  ];

  return (
    <header className="sticky top-0 z-40 w-full bg-surface-container-lowest/90 backdrop-blur-md border-b border-border-subtle">
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-4 lg:gap-8">
          <Link href="/admin/portfolio" className="flex items-center gap-2 hover:opacity-90 transition-opacity">
            <WakeLogo size="sm" />
            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-status-error text-white">OPERATOR</span>
          </Link>

          {/* Desktop Nav */}
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

        {/* Desktop Actions */}
        <div className="hidden sm:flex items-center gap-3 ml-auto pl-8 border-l border-border-subtle shrink-0">
          <button
            onClick={handleEmergencyOff}
            disabled={submitting}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-mono font-bold transition-colors shadow-sm ${
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

        {/* Mobile Hamburger Button */}
        <div className="flex items-center gap-2 lg:hidden">
          <button
            onClick={handleEmergencyOff}
            disabled={submitting}
            title="Emergency Off"
            className={`sm:hidden p-1.5 rounded-lg text-xs font-mono font-bold ${
              emergencyOffTriggered
                ? 'bg-status-error text-white'
                : 'bg-status-error/10 text-status-error border border-status-error/30'
            }`}
          >
            <span className="material-symbols-outlined text-base">warning</span>
          </button>

          <button
            type="button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="p-2 text-on-surface-variant hover:text-primary rounded-lg hover:bg-surface-container transition-colors"
            aria-label="Toggle navigation menu"
          >
            <span className="material-symbols-outlined text-2xl">{mobileMenuOpen ? 'close' : 'menu'}</span>
          </button>
        </div>
      </div>

      {/* Mobile Drawer Menu */}
      {mobileMenuOpen && (
        <div className="lg:hidden border-t border-border-subtle bg-surface-container-lowest px-4 py-4 space-y-2 animate-fade-in shadow-xl max-h-[calc(100vh-4rem)] overflow-y-auto">
          <div className="text-[11px] font-bold text-on-surface-variant uppercase tracking-wider px-2 py-1">
            Wake Protocol Operator Console
          </div>
          <nav className="flex flex-col gap-1">
            {navLinks.map((link) => {
              const isActive = pathname === link.href || (link.href !== '/' && pathname.startsWith(`${link.href}/`));
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

          <div className="pt-3 border-t border-border-subtle space-y-2">
            <button
              onClick={handleEmergencyOff}
              disabled={submitting}
              className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-xs font-mono font-bold transition-colors ${
                emergencyOffTriggered
                  ? 'bg-status-error text-white'
                  : 'bg-status-error/10 text-status-error border border-status-error/30 hover:bg-status-error hover:text-white'
              }`}
            >
              <span className="material-symbols-outlined text-sm">warning</span>
              <span>{emergencyOffTriggered ? 'TRADING STOPPED' : 'EMERGENCY OFF'}</span>
            </button>

            <button
              onClick={handleLogout}
              className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-sm text-on-surface-variant hover:text-status-error hover:bg-surface-container transition-colors"
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
