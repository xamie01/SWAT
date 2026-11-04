'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { WakeLogo } from '../components/WakeLogo.js';
import { ThemeToggle } from '../components/ThemeToggle.js';

export default function LandingPage() {
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const toggleFaq = (index: number) => {
    setOpenFaq(openFaq === index ? null : index);
  };

  return (
    <div className="bg-canvas-base text-on-surface min-h-screen antialiased font-body transition-colors duration-200">
      {/* HEADER / NAVIGATION SHELL */}
      <header className="fixed top-0 left-0 right-0 z-50 bg-surface-deep/90 backdrop-blur-md border-b border-border-subtle dark:border-border-muted transition-colors">
        <div className="h-14 max-w-[1280px] mx-auto px-4 sm:px-6 md:px-8 flex items-center justify-between gap-3">
          {/* Logo & Protocol Title */}
          <div className="flex items-center gap-5">
            <Link href="/" className="flex items-center gap-2 group shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/wake-logo.png"
                alt="Wake Protocol Logo"
                width={26}
                height={26}
                className="h-6 w-6 object-contain dark:hidden block"
              />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/wake-logo-white.png"
                alt="Wake Protocol Logo"
                width={26}
                height={26}
                className="h-6 w-6 object-contain dark:block hidden"
              />
              <div className="flex items-baseline gap-1">
                <span className="font-headline font-bold text-base text-primary tracking-tight">WAKE</span>
                <span className="font-mono text-[9px] text-text-tertiary tracking-widest uppercase">PROTOCOL</span>
              </div>
            </Link>

            {/* Desktop Navigation Links */}
            <nav className="hidden lg:flex items-center gap-4 xl:gap-5 ml-1">
              <a href="#product" className="text-xs font-medium text-on-surface-variant hover:text-primary transition-colors">
                Product
              </a>
              <a href="#whales" className="text-xs font-medium text-on-surface-variant hover:text-primary transition-colors">
                Whales & Signals
              </a>
              <a href="#chains" className="text-xs font-medium text-on-surface-variant hover:text-primary transition-colors">
                Chains
              </a>
              <a href="#pricing" className="text-xs font-medium text-on-surface-variant hover:text-primary transition-colors">
                Access Tiers
              </a>
              <a href="#faq" className="text-xs font-medium text-on-surface-variant hover:text-primary transition-colors">
                FAQ
              </a>
              <Link href="/learn" className="text-xs font-medium text-on-surface-variant hover:text-primary transition-colors">
                Documentation
              </Link>
            </nav>
          </div>

          {/* Right Status Indicators & Auth Square Buttons */}
          <div className="flex items-center gap-2 sm:gap-2.5">
            {/* Live Ticker Pulse */}
            <div className="hidden sm:flex items-center gap-1.5 px-2 py-0.5 bg-surface-container-low border border-border-subtle rounded text-[10px] font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-status-success dark:bg-crimson-signal animate-pulse"></span>
              <span className="text-on-surface tracking-wider uppercase font-medium">
                LIVE: 00:00 UTC
              </span>
            </div>

            {/* Theme Toggle Button (Compact) */}
            <ThemeToggle className="p-1.5 rounded" />

            {/* Square Buttons Side-by-Side: Sign In & Sign Up */}
            <div className="flex items-center gap-1.5">
              <Link
                href="/login"
                className="inline-flex items-center justify-center font-headline text-xs font-semibold px-2.5 py-1.5 rounded bg-surface-raised border border-border-subtle dark:border-border-muted text-primary hover:bg-surface-container hover:border-border-prominent transition-all shadow-xs"
              >
                Sign In
              </Link>
              <Link
                href="/signup"
                className="inline-flex items-center justify-center font-headline text-xs font-semibold px-2.5 py-1.5 rounded bg-primary text-white dark:bg-crimson-signal dark:text-white dark:hover:bg-crimson-glow hover:opacity-90 transition-all shadow-xs dark:shadow-[0_0_10px_rgba(239,68,68,0.25)]"
              >
                Sign Up
              </Link>
            </div>

            {/* Mobile Hamburger Toggle */}
            <button
              type="button"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="lg:hidden p-1.5 text-on-surface-variant hover:text-primary rounded hover:bg-surface-container transition-colors"
              aria-label="Toggle navigation menu"
            >
              <span className="material-symbols-outlined text-xl">
                {mobileMenuOpen ? 'close' : 'menu'}
              </span>
            </button>
          </div>
        </div>

        {/* Mobile Navigation Drawer */}
        {mobileMenuOpen && (
          <div className="lg:hidden border-t border-border-subtle dark:border-border-muted bg-surface-deep px-4 py-4 space-y-3 shadow-xl">
            <nav className="flex flex-col gap-1.5">
              <a
                href="#product"
                onClick={() => setMobileMenuOpen(false)}
                className="px-3 py-1.5 rounded text-xs font-medium text-on-surface-variant hover:text-primary hover:bg-surface-container transition-colors"
              >
                Product
              </a>
              <a
                href="#whales"
                onClick={() => setMobileMenuOpen(false)}
                className="px-3 py-1.5 rounded text-xs font-medium text-on-surface-variant hover:text-primary hover:bg-surface-container transition-colors"
              >
                Whales & Signals
              </a>
              <a
                href="#chains"
                onClick={() => setMobileMenuOpen(false)}
                className="px-3 py-1.5 rounded text-xs font-medium text-on-surface-variant hover:text-primary hover:bg-surface-container transition-colors"
              >
                Chains
              </a>
              <a
                href="#pricing"
                onClick={() => setMobileMenuOpen(false)}
                className="px-3 py-1.5 rounded text-xs font-medium text-on-surface-variant hover:text-primary hover:bg-surface-container transition-colors"
              >
                Access Tiers
              </a>
              <a
                href="#faq"
                onClick={() => setMobileMenuOpen(false)}
                className="px-3 py-1.5 rounded text-xs font-medium text-on-surface-variant hover:text-primary hover:bg-surface-container transition-colors"
              >
                FAQ
              </a>
              <Link
                href="/learn"
                onClick={() => setMobileMenuOpen(false)}
                className="px-3 py-1.5 rounded text-xs font-medium text-on-surface-variant hover:text-primary hover:bg-surface-container transition-colors"
              >
                Documentation
              </Link>
            </nav>
            <div className="pt-3 border-t border-border-subtle dark:border-border-muted flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Link
                  href="/login"
                  onClick={() => setMobileMenuOpen(false)}
                  className="px-3 py-1.5 rounded text-xs font-semibold border border-border-subtle dark:border-border-muted text-primary hover:bg-surface-container transition-colors"
                >
                  Sign In
                </Link>
                <Link
                  href="/signup"
                  onClick={() => setMobileMenuOpen(false)}
                  className="px-3 py-1.5 rounded text-xs font-semibold bg-primary text-white dark:bg-crimson-signal dark:text-white transition-colors"
                >
                  Sign Up
                </Link>
              </div>
              <div className="flex items-center gap-1.5 font-mono text-[10px] text-text-tertiary">
                <span className="w-1.5 h-1.5 rounded-full bg-status-success dark:bg-crimson-signal animate-pulse"></span>
                <span>ENV: LIVE</span>
              </div>
            </div>
          </div>
        )}
      </header>

      {/* MAIN CONTENT WRAPPER */}
      <main className="w-full pt-14" id="product">
        {/* SECTION 1: HERO */}
        <section className="relative w-full max-w-[1280px] mx-auto px-4 sm:px-6 md:px-8 pt-12 md:pt-20 pb-20 overflow-hidden">
          {/* Ambient Lighting Accents */}
          <div className="absolute -top-32 left-1/4 w-96 h-96 bg-solana-teal/15 dark:bg-crimson-signal/10 rounded-full blur-[120px] pointer-events-none transition-colors duration-500"></div>
          <div className="absolute top-48 right-10 w-80 h-80 bg-polymarket-violet/10 dark:bg-crimson-deep/15 rounded-full blur-[100px] pointer-events-none transition-colors duration-500"></div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center relative z-10">
            {/* Left Column: Copy & Actions */}
            <div className="lg:col-span-7 flex flex-col gap-6">
              {/* Telemetry Pill */}
              <div className="inline-flex items-center gap-2 px-3 py-1 bg-surface-container-low dark:bg-surface-deep border border-solana-teal/30 dark:border-crimson-signal/40 rounded-full w-fit shadow-xs dark:shadow-[0_0_12px_rgba(239,68,68,0.2)]">
                <span className="w-2 h-2 rounded-full bg-status-success dark:bg-crimson-signal animate-pulse"></span>
                <span className="font-mono text-[11px] text-status-success dark:text-crimson-signal tracking-widest uppercase font-semibold">
                  WHALE TRADE DETECTED
                </span>
              </div>

              {/* Main Headline */}
              <h1 className="font-headline text-3xl sm:text-5xl lg:text-[54px] text-primary tracking-tight leading-[1.08] font-bold">
                WAKE: Non-custodial copy-trading that{' '}
                <span className="text-status-success dark:text-crimson-signal underline decoration-status-success/30 dark:decoration-crimson-deep decoration-2 underline-offset-4">
                  acts
                </span>
                , not just alerts.
              </h1>

              {/* Subtitle */}
              <p className="text-base sm:text-lg text-text-secondary max-w-xl leading-relaxed">
                The bridge between smart-money whale tracking and autonomous on-chain execution. Mirror verified master traders in real time while retaining 100% custody of your capital.
              </p>

              {/* Action Buttons */}
              <div className="flex flex-wrap items-center gap-4 pt-2">
                <Link
                  href="/signup"
                  className="inline-flex items-center justify-center gap-2 font-headline text-sm sm:text-base font-semibold px-6 py-3.5 bg-primary text-on-primary dark:bg-crimson-signal dark:text-white dark:hover:bg-crimson-glow hover:opacity-90 transition-all rounded shadow-md dark:shadow-[0_0_18px_rgba(239,68,68,0.35)] group"
                >
                  <span>Join Early Access</span>
                  <span className="material-symbols-outlined text-[18px] group-hover:translate-x-0.5 transition-transform">
                    arrow_forward
                  </span>
                </Link>

                <Link
                  href="/wallets"
                  className="inline-flex items-center justify-center font-headline text-sm sm:text-base font-medium px-6 py-3.5 bg-surface-raised border border-border-subtle dark:border-border-muted text-primary hover:border-border-prominent hover:bg-surface-container transition-all rounded"
                >
                  Explore Whales & Hot Coins
                </Link>
              </div>

              {/* Telemetry Micro-Row */}
              <div className="flex flex-wrap items-center gap-6 pt-2 font-mono text-[11px] text-text-tertiary">
                <div className="flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-status-positive text-[16px]">verified_user</span>
                  <span>Non-Custodial Anchor PDA</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-status-success dark:text-crimson-signal text-[16px]">bolt</span>
                  <span>Sub-50ms RPC Mesh</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-text-secondary text-[16px]">shield</span>
                  <span>Jito MEV Shielded</span>
                </div>
              </div>
            </div>

            {/* Right Column: Interactive Live Whale HUD Card */}
            <div className="lg:col-span-5" id="whales">
              <div className="relative bg-surface-deep border border-border-subtle dark:border-border-muted rounded-xl p-6 shadow-2xl flex flex-col gap-5 backdrop-blur-xl transition-colors">
                {/* Scanline Effect */}
                <div className="scanline"></div>

                {/* Card Header Indicator */}
                <div className="flex items-center justify-between border-b border-border-subtle pb-3">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-status-success dark:bg-crimson-signal animate-ping"></span>
                    <span className="font-mono text-[11px] text-text-secondary uppercase tracking-wider">
                      LIVE FEED // INGESTION
                    </span>
                  </div>
                  <span className="font-mono text-[11px] text-text-tertiary">BLOCK #289,104,221</span>
                </div>

                {/* Master Wallet & Win Rate */}
                <div className="flex items-start justify-between gap-4">
                  <div className="flex flex-col">
                    <span className="font-mono text-[11px] text-text-tertiary uppercase tracking-wider">
                      SOURCE WHALE
                    </span>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="font-headline text-lg sm:text-xl text-primary font-bold">
                        Master 0x82...a9f2
                      </span>
                      <span className="material-symbols-outlined text-status-success dark:text-crimson-signal text-[18px]">
                        arrow_forward
                      </span>
                      <span className="font-headline text-lg sm:text-xl text-status-success dark:text-crimson-signal font-bold">
                        $JUP
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-col items-end">
                    <span className="font-mono text-[11px] text-text-tertiary uppercase tracking-wider">
                      WIN RATE
                    </span>
                    <span className="font-mono text-2xl sm:text-3xl text-status-positive leading-tight font-bold">
                      82.4%
                    </span>
                  </div>
                </div>

                {/* Configuration Grid */}
                <div className="grid grid-cols-2 gap-3 bg-surface-raised p-3 rounded border border-border-subtle">
                  <div className="flex flex-col">
                    <span className="font-mono text-[11px] text-text-tertiary uppercase">Execution Vault</span>
                    <span className="font-body text-sm text-primary font-medium mt-0.5">Solana Keyless PDA</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="font-mono text-[11px] text-text-tertiary uppercase">Position Sizing</span>
                    <span className="font-body text-sm text-primary font-medium mt-0.5">Proportional (1.5x)</span>
                  </div>
                </div>

                {/* Real-time Sparkline Visualization */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center font-mono text-[11px] text-text-tertiary">
                    <span>EXECUTION TRAJECTORY (T-0)</span>
                    <span className="text-status-positive font-semibold">+18.9% SLIPPAGE PROTECTED</span>
                  </div>
                  <div className="h-16 w-full bg-surface-container-lowest rounded p-1 flex items-end overflow-hidden border border-border-subtle">
                    <svg
                      className="w-full h-full text-status-success dark:text-crimson-signal"
                      fill="none"
                      preserveAspectRatio="none"
                      viewBox="0 0 300 45"
                    >
                      <path
                        d="M0 40 L30 38 L60 30 L90 32 L120 22 L150 24 L180 14 L210 18 L240 8 L270 12 L300 4"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeWidth="2.5"
                      />
                      <path
                        d="M0 40 L30 38 L60 30 L90 32 L120 22 L150 24 L180 14 L210 18 L240 8 L270 12 L300 4 L300 45 L0 45 Z"
                        fill="currentColor"
                        fillOpacity="0.12"
                      />
                    </svg>
                  </div>
                </div>

                {/* Status Bar */}
                <div className="flex items-center justify-between pt-2 border-t border-border-subtle">
                  <div className="inline-flex items-center gap-1.5 px-2 py-1 bg-surface-container text-status-success dark:text-crimson-signal rounded border border-border-subtle dark:border-crimson-signal/30 text-xs font-semibold">
                    <span className="material-symbols-outlined text-[16px]">bolt</span>
                    <span className="font-mono tracking-wider">AUTONOMOUS SWAP EXECUTED</span>
                  </div>
                  <div className="flex items-center gap-1 font-mono text-xs text-text-secondary">
                    <span className="text-text-tertiary">Latency:</span>
                    <span className="font-bold text-primary">48ms</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 2: THE OPERATIONAL EDGE (COMPARISON GRID) */}
        <section className="w-full bg-surface-container-lowest border-y border-border-subtle py-16 md:py-24">
          <div className="max-w-[1280px] mx-auto px-4 sm:px-6 md:px-8 flex flex-col gap-10">
            <div className="flex flex-col gap-1 items-start max-w-2xl">
              <div className="font-mono text-xs text-status-success dark:text-crimson-signal uppercase tracking-widest font-semibold">
                DIAGNOSTIC COMPARISON
              </div>
              <h2 className="font-headline text-3xl md:text-4xl text-primary font-bold">
                The Operational Edge
              </h2>
              <p className="text-base sm:text-lg text-text-secondary">
                Why manual tracking and Telegram bots fail in fast markets.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              {/* Flaws Card */}
              <div className="bg-surface-deep border border-border-subtle dark:border-border-muted rounded-xl p-8 flex flex-col gap-6 relative overflow-hidden">
                <div className="flex items-center gap-3 border-b border-border-subtle pb-4">
                  <div className="w-9 h-9 rounded bg-status-error/10 border border-status-error/20 flex items-center justify-center shrink-0">
                    <span className="material-symbols-outlined text-status-error text-[20px]">warning</span>
                  </div>
                  <div>
                    <h3 className="font-headline text-xl text-primary font-semibold">The Tracker & Bot Flaws</h3>
                    <span className="font-mono text-[11px] text-text-tertiary">COMMON BOT ARCHITECTURES</span>
                  </div>
                </div>

                <div className="flex flex-col gap-4">
                  <div className="flex items-start gap-3">
                    <div className="w-5 h-5 rounded-full bg-status-error/15 text-status-error flex items-center justify-center shrink-0 mt-0.5">
                      <span className="material-symbols-outlined text-[14px]">close</span>
                    </div>
                    <p className="text-sm text-on-surface-variant leading-relaxed">
                      <strong className="text-primary">Telegram alerts arrive 30–90 seconds late:</strong> by the time you receive the push notification, smart money has already moved and you end up as exit liquidity.
                    </p>
                  </div>

                  <div className="flex items-start gap-3">
                    <div className="w-5 h-5 rounded-full bg-status-error/15 text-status-error flex items-center justify-center shrink-0 mt-0.5">
                      <span className="material-symbols-outlined text-[14px]">close</span>
                    </div>
                    <p className="text-sm text-on-surface-variant leading-relaxed">
                      <strong className="text-primary">Manual trade execution friction:</strong> switching apps, pasting contract addresses, setting slippage, and signing hardware wallets misses the entry wick completely.
                    </p>
                  </div>

                  <div className="flex items-start gap-3">
                    <div className="w-5 h-5 rounded-full bg-status-error/15 text-status-error flex items-center justify-center shrink-0 mt-0.5">
                      <span className="material-symbols-outlined text-[14px]">close</span>
                    </div>
                    <p className="text-sm text-on-surface-variant leading-relaxed">
                      <strong className="text-primary">Catastrophic custodial bot risk:</strong> handing private keys to centralized web servers or Telegram databases risks total wallet drain.
                    </p>
                  </div>
                </div>
              </div>

              {/* The WAKE Solution */}
              <div className="bg-surface-deep border border-border-subtle dark:border-border-muted rounded-xl p-8 flex flex-col gap-6 relative overflow-hidden shadow-xs dark:shadow-[0_0_24px_rgba(239,68,68,0.06)]">
                <div className="flex items-center gap-3 border-b border-border-subtle pb-4">
                  <div className="w-9 h-9 rounded bg-status-positive/10 border border-status-positive/30 flex items-center justify-center shrink-0">
                    <span className="material-symbols-outlined text-status-positive text-[20px]">verified</span>
                  </div>
                  <div>
                    <h3 className="font-headline text-xl text-primary font-semibold">The WAKE Solution</h3>
                    <span className="font-mono text-[11px] text-status-positive font-semibold">PROPRIETARY SUB-BLOCK PIPELINE</span>
                  </div>
                </div>

                <div className="flex flex-col gap-4">
                  <div className="flex items-start gap-3">
                    <div className="w-5 h-5 rounded-full bg-status-positive-muted text-status-positive flex items-center justify-center shrink-0 mt-0.5">
                      <span className="material-symbols-outlined text-[14px]">check</span>
                    </div>
                    <p className="text-sm text-on-surface-variant leading-relaxed">
                      <strong className="text-primary">Sub-100ms on-chain detection:</strong> direct geodistributed RPC indexing with dedicated Jito MEV private bundlers avoids sandwich attacks entirely.
                    </p>
                  </div>

                  <div className="flex items-start gap-3">
                    <div className="w-5 h-5 rounded-full bg-status-positive-muted text-status-positive flex items-center justify-center shrink-0 mt-0.5">
                      <span className="material-symbols-outlined text-[14px]">check</span>
                    </div>
                    <p className="text-sm text-on-surface-variant leading-relaxed">
                      <strong className="text-primary">Zero-custody architecture:</strong> sovereign Anchor PDAs on Solana and EIP-7702 delegated smart accounts ensure keys never leave your custody.
                    </p>
                  </div>

                  <div className="flex items-start gap-3">
                    <div className="w-5 h-5 rounded-full bg-status-positive-muted text-status-positive flex items-center justify-center shrink-0 mt-0.5">
                      <span className="material-symbols-outlined text-[14px]">check</span>
                    </div>
                    <p className="text-sm text-on-surface-variant leading-relaxed">
                      <strong className="text-primary">Lot-proportional scaling & hard safety:</strong> mirror exact lot percentages when the whale trims, backed by user-defined stop-loss tripwires.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 3: MECHANICAL WORKFLOW */}
        <section className="w-full max-w-[1280px] mx-auto px-4 sm:px-6 md:px-8 py-16 md:py-24">
          <div className="flex flex-col gap-10">
            <div className="flex items-center gap-3">
              <div className="w-1.5 h-6 bg-status-success dark:bg-crimson-signal rounded-full"></div>
              <h2 className="font-headline text-3xl md:text-4xl text-primary font-bold">Mechanical Workflow</h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Step 01 */}
              <div className="bg-surface-deep border border-border-subtle dark:border-border-muted hover:border-border-prominent transition-all rounded-xl p-6 flex flex-col justify-between gap-6 group">
                <div className="flex flex-col gap-3">
                  <span className="font-mono text-xs text-text-tertiary tracking-widest uppercase">
                    01 // DISCOVERY
                  </span>
                  <h3 className="font-headline text-xl text-primary font-semibold">Choose Whales or Hot Coins</h3>
                  <p className="text-sm text-text-secondary leading-relaxed">
                    Track verified whale wallets directly, or paste any hot token contract on Solana, Polymarket, or Robinhood Chain to automatically backfill the earliest profitable buyers.
                  </p>
                </div>
                <div className="pt-4 border-t border-border-subtle flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-text-secondary font-mono text-xs">
                    <span className="material-symbols-outlined text-[16px] text-status-success dark:text-crimson-signal">
                      manage_search
                    </span>
                    <span>FILTER ENGINE ACTIVE</span>
                  </div>
                  <span className="w-2 h-2 rounded-full bg-status-positive"></span>
                </div>
              </div>

              {/* Step 02 */}
              <div className="bg-surface-deep border border-border-subtle dark:border-border-muted hover:border-border-prominent transition-all rounded-xl p-6 flex flex-col justify-between gap-6 group">
                <div className="flex flex-col gap-3">
                  <span className="font-mono text-xs text-text-tertiary tracking-widest uppercase">
                    02 // INGESTION
                  </span>
                  <h3 className="font-headline text-xl text-primary font-semibold">Zero-Delay Signal Stream</h3>
                  <p className="text-sm text-text-secondary leading-relaxed">
                    Wake's high-frequency indexing engine monitors master wallet activity on-chain. When they enter or exit a position, trade signals fan out to followers in milliseconds.
                  </p>
                </div>
                <div className="pt-4 border-t border-border-subtle flex items-center gap-2">
                  <span className="px-2 py-0.5 bg-surface-raised border border-border-subtle rounded font-mono text-[10px] font-bold text-text-secondary">
                    SOLANA
                  </span>
                  <span className="px-2 py-0.5 bg-surface-raised border border-border-subtle rounded font-mono text-[10px] font-bold text-text-secondary">
                    POLYMARKET
                  </span>
                  <span className="px-2 py-0.5 bg-surface-raised border border-border-subtle rounded font-mono text-[10px] font-bold text-text-secondary">
                    ROBINHOOD
                  </span>
                </div>
              </div>

              {/* Step 03 */}
              <div className="bg-surface-deep border border-border-subtle dark:border-border-muted hover:border-status-success/50 dark:hover:border-crimson-signal/50 transition-all rounded-xl p-6 flex flex-col justify-between gap-6 group shadow-xs dark:shadow-[0_0_20px_rgba(239,68,68,0.08)]">
                <div className="flex flex-col gap-3">
                  <span className="font-mono text-xs text-status-success dark:text-crimson-signal tracking-widest uppercase font-semibold">
                    03 // EXECUTION
                  </span>
                  <h3 className="font-headline text-xl text-primary font-semibold">Autonomous Copy Execution</h3>
                  <p className="text-sm text-text-secondary leading-relaxed">
                    Your non-custodial smart vault copies the trade automatically based on your position size limits, max slippage bounds, and autonomous stop-loss parameters.
                  </p>
                </div>
                <div className="pt-4 border-t border-border-subtle flex items-center justify-between bg-surface-raised p-2.5 rounded border border-border-subtle">
                  <div className="flex items-center gap-1.5 font-mono text-xs text-primary font-medium">
                    <span className="w-1.5 h-1.5 rounded-full bg-status-success dark:bg-crimson-signal animate-pulse"></span>
                    <span>KEYLESS AUTO-COPY</span>
                  </div>
                  <div className="flex items-center gap-1 text-status-success dark:text-crimson-signal font-mono text-xs font-bold">
                    <span>ACTIVE</span>
                    <span className="material-symbols-outlined text-[18px]">toggle_on</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 4: SUPPORTED EXECUTION CHAINS */}
        <section className="w-full bg-surface-container-lowest border-y border-border-subtle py-16 md:py-20" id="chains">
          <div className="max-w-[1280px] mx-auto px-4 sm:px-6 md:px-8">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Solana */}
              <div className="bg-surface-deep border border-border-subtle dark:border-border-muted hover:border-border-prominent p-6 rounded-xl flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded bg-surface-raised border border-border-subtle flex items-center justify-center font-bold text-primary font-mono text-xs">
                      SOL
                    </div>
                    <h3 className="font-headline text-xl text-primary font-semibold">Solana</h3>
                  </div>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded font-mono text-[10px] text-status-positive bg-status-positive-muted/20 border border-status-positive/30 font-semibold">
                    <span className="w-1 h-1 rounded-full bg-status-positive"></span> LIVE
                  </span>
                </div>
                <p className="text-sm text-text-secondary leading-relaxed">
                  Keyless Anchor PDAs. Instant execution across Raydium, Pump.fun, Meteora, and Jupiter with Jito bundle MEV defense.
                </p>
                <div className="pt-2 font-mono text-xs text-text-tertiary">
                  Avg execution: 42ms // 0% mempool leak
                </div>
              </div>

              {/* Polymarket */}
              <div className="bg-surface-deep border border-border-subtle dark:border-border-muted hover:border-border-prominent p-6 rounded-xl flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded bg-surface-raised border border-border-subtle flex items-center justify-center font-bold text-primary font-mono text-xs">
                      PM
                    </div>
                    <h3 className="font-headline text-xl text-primary font-semibold">Polymarket</h3>
                  </div>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded font-mono text-[10px] text-status-positive bg-status-positive-muted/20 border border-status-positive/30 font-semibold">
                    <span className="w-1 h-1 rounded-full bg-status-positive"></span> LIVE
                  </span>
                </div>
                <p className="text-sm text-text-secondary leading-relaxed">
                  Prediction market copy trading on Polygon. CLOB orderbook execution, 2-decimal tick sizing, and automated outcome redemption.
                </p>
                <div className="pt-2 font-mono text-xs text-text-tertiary">
                  CLOB REST/WebSocket engine // CTF Safe
                </div>
              </div>

              {/* Robinhood Chain */}
              <div className="bg-surface-deep border border-border-subtle dark:border-border-muted hover:border-border-prominent p-6 rounded-xl flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded bg-surface-raised border border-border-subtle flex items-center justify-center font-bold text-primary font-mono text-xs">
                      RH
                    </div>
                    <h3 className="font-headline text-xl text-primary font-semibold">Robinhood Chain</h3>
                  </div>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded font-mono text-[10px] text-status-positive bg-status-positive-muted/20 border border-status-positive/30 font-semibold">
                    <span className="w-1 h-1 rounded-full bg-status-positive"></span> LIVE
                  </span>
                </div>
                <p className="text-sm text-text-secondary leading-relaxed">
                  EIP-7702 delegated smart accounts. Autonomous copy execution with single-click authority delegation and zero key sharing.
                </p>
                <div className="pt-2 font-mono text-xs text-text-tertiary">
                  EIP-7702 Delegation // Session scopes
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 5: LIVE EXECUTION STREAM & NON-CUSTODIAL ARCHITECTURE */}
        <section className="w-full max-w-[1280px] mx-auto px-4 sm:px-6 md:px-8 py-16 md:py-24">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
            {/* Live Stream Table (8 Cols) */}
            <div className="lg:col-span-8 bg-surface-deep border border-border-subtle dark:border-border-muted rounded-xl p-6 flex flex-col gap-4">
              <div className="flex items-center justify-between border-b border-border-subtle pb-3">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-status-success dark:bg-crimson-signal animate-pulse"></span>
                  <h3 className="font-headline text-xl text-primary font-bold">
                    Live Execution Stream (Sample)
                  </h3>
                </div>
                <span className="font-mono text-[11px] text-text-tertiary uppercase">TELEMETRY SYNCED</span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-border-subtle font-mono text-[11px] text-text-tertiary uppercase tracking-wider">
                      <th className="py-3 px-2">TIMESTAMP</th>
                      <th className="py-3 px-2">ACTION</th>
                      <th className="py-3 px-2">MASTER WHALE</th>
                      <th className="py-3 px-2">STATUS</th>
                      <th className="py-3 px-2 text-right">PERFORMANCE</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle font-mono text-xs sm:text-sm">
                    <tr className="hover:bg-surface-raised/60 transition-colors">
                      <td className="py-3.5 px-2 text-text-secondary">14:02:11</td>
                      <td className="py-3.5 px-2">
                        <span className="px-2 py-0.5 bg-surface-raised border border-border-subtle text-primary rounded text-xs font-semibold">
                          SOL / BUY
                        </span>
                      </td>
                      <td className="py-3.5 px-2 font-mono text-xs text-primary">0x14...3e2</td>
                      <td className="py-3.5 px-2 text-text-secondary">
                        <span className="inline-flex items-center gap-1.5 text-xs">
                          <span className="w-1.5 h-1.5 rounded-full bg-status-positive"></span> COPIED (Anchor PDA)
                        </span>
                      </td>
                      <td className="py-3.5 px-2 text-right text-status-positive font-bold">+12.4%</td>
                    </tr>
                    <tr className="hover:bg-surface-raised/60 transition-colors">
                      <td className="py-3.5 px-2 text-text-secondary">13:58:04</td>
                      <td className="py-3.5 px-2">
                        <span className="px-2 py-0.5 bg-surface-raised border border-border-subtle text-primary rounded text-xs font-semibold">
                          POLY / YES
                        </span>
                      </td>
                      <td className="py-3.5 px-2 font-mono text-xs text-primary">0x99...ff0</td>
                      <td className="py-3.5 px-2 text-text-secondary">
                        <span className="inline-flex items-center gap-1.5 text-xs">
                          <span className="w-1.5 h-1.5 rounded-full bg-status-positive"></span> COPIED (CTF Safe)
                        </span>
                      </td>
                      <td className="py-3.5 px-2 text-right text-status-positive font-bold">+28.0%</td>
                    </tr>
                    <tr className="hover:bg-surface-raised/60 transition-colors">
                      <td className="py-3.5 px-2 text-text-secondary">13:45:30</td>
                      <td className="py-3.5 px-2">
                        <span className="px-2 py-0.5 bg-surface-raised border border-border-subtle text-status-warning dark:text-crimson-signal rounded text-xs font-semibold">
                          SOL / EXIT
                        </span>
                      </td>
                      <td className="py-3.5 px-2 font-mono text-xs text-primary">0x22...a11</td>
                      <td className="py-3.5 px-2 text-text-secondary">
                        <span className="inline-flex items-center gap-1.5 text-xs">
                          <span className="w-1.5 h-1.5 rounded-full bg-status-warning dark:bg-crimson-signal"></span> LOT EXIT (50% Sold)
                        </span>
                      </td>
                      <td className="py-3.5 px-2 text-right text-status-positive font-bold">+42.1%</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* Non-Custodial by Design Card (4 Cols) */}
            <div className="lg:col-span-4 bg-surface-deep border border-border-subtle dark:border-border-muted rounded-xl p-6 flex flex-col justify-between gap-6">
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-status-success dark:text-crimson-signal text-[22px]">
                    shield_lock
                  </span>
                  <h3 className="font-headline text-xl text-primary font-bold">Non-Custodial by Design</h3>
                </div>
                <p className="text-sm text-text-secondary leading-relaxed">
                  We never hold your private keys or touch your funds. WAKE operates entirely through verifiable smart contracts and on-chain Program Derived Addresses.
                </p>
              </div>

              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3 p-3 bg-surface-raised border border-border-subtle rounded-lg">
                  <div className="w-9 h-9 rounded bg-surface-container flex items-center justify-center shrink-0">
                    <span className="material-symbols-outlined text-primary text-[18px]">lock_open</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="font-headline text-sm text-primary font-semibold">Keyless Anchor PDAs</span>
                    <span className="font-mono text-[11px] text-text-tertiary">Solana programmatic accounts</span>
                  </div>
                </div>

                <div className="flex items-center gap-3 p-3 bg-surface-raised border border-border-subtle rounded-lg">
                  <div className="w-9 h-9 rounded bg-surface-container flex items-center justify-center shrink-0">
                    <span className="material-symbols-outlined text-primary text-[18px]">vpn_key</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="font-headline text-sm text-primary font-semibold">EIP-7702 Delegated Accounts</span>
                    <span className="font-mono text-[11px] text-text-tertiary">Scope-limited EVM authorizations</span>
                  </div>
                </div>
              </div>

              <div className="pt-2 border-t border-border-subtle flex items-center justify-between font-mono text-xs text-text-tertiary">
                <span>ZERO COUNTERPARTY RISK</span>
                <span className="text-status-positive font-semibold">AUDITED</span>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 6: ACCESS TIERS (PRICING) */}
        <section className="w-full bg-surface-container-lowest border-y border-border-subtle py-16 md:py-24" id="pricing">
          <div className="max-w-[1280px] mx-auto px-4 sm:px-6 md:px-8 flex flex-col gap-10">
            <div className="flex flex-col gap-1 items-center text-center max-w-xl mx-auto">
              <div className="font-mono text-xs text-status-success dark:text-crimson-signal uppercase tracking-widest font-semibold">
                INFRASTRUCTURE TIERS
              </div>
              <h2 className="font-headline text-3xl md:text-4xl text-primary font-bold">Access Tiers</h2>
              <p className="text-base sm:text-lg text-text-secondary">
                Scale your operations with professional infrastructure.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 items-stretch">
              {/* Tier 1: Standard */}
              <div className="bg-surface-deep border border-border-subtle dark:border-border-muted rounded-xl p-6 flex flex-col justify-between gap-6 hover:border-border-prominent transition-all">
                <div className="flex flex-col gap-4">
                  <div>
                    <span className="font-mono text-xs text-text-tertiary uppercase">TIER 01</span>
                    <h3 className="font-headline text-xl text-primary font-bold">Standard</h3>
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span className="font-headline text-3xl sm:text-4xl text-primary font-bold">Free</span>
                  </div>
                  <ul className="flex flex-col gap-2.5 pt-2 text-xs text-text-secondary">
                    <li className="flex items-center gap-2">
                      <span className="text-text-tertiary font-mono">/</span> 5m Delayed Signals
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="text-text-tertiary font-mono">/</span> Basic Wallet Tracking
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="text-text-tertiary font-mono">/</span> 1 Monitored Master Slot
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="text-text-tertiary font-mono">/</span> Read-Only Webhooks
                    </li>
                  </ul>
                </div>
                <Link
                  href="/signup?tier=free"
                  className="w-full py-2.5 text-center font-headline text-sm font-medium bg-surface-raised border border-border-subtle dark:border-border-muted text-primary hover:border-border-prominent rounded transition-colors"
                >
                  Start Free
                </Link>
              </div>

              {/* Tier 2: Operator (Featured) */}
              <div className="bg-surface-deep border-2 border-primary dark:border-crimson-signal rounded-xl p-6 flex flex-col justify-between gap-6 relative shadow-lg dark:shadow-[0_0_28px_rgba(239,68,68,0.22)]">
                <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 px-3 py-0.5 bg-primary text-on-primary dark:bg-crimson-signal dark:text-white font-mono text-[10px] tracking-wider uppercase font-bold rounded-full shadow-md">
                  MOST POPULAR
                </div>
                <div className="flex flex-col gap-4 pt-1">
                  <div>
                    <span className="font-mono text-xs text-status-success dark:text-crimson-signal uppercase font-semibold">
                      TIER 02 // QUANT
                    </span>
                    <h3 className="font-headline text-xl text-primary font-bold">Operator</h3>
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span className="font-headline text-3xl sm:text-4xl text-primary font-bold">35 USDC</span>
                    <span className="text-xs text-text-tertiary">/mo</span>
                  </div>
                  <ul className="flex flex-col gap-2.5 pt-2 text-xs text-primary">
                    <li className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-status-success dark:text-crimson-signal text-[16px]">check</span> 0s Real-Time Signal Stream
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-status-success dark:text-crimson-signal text-[16px]">check</span> Automated Execution Engine
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-status-success dark:text-crimson-signal text-[16px]">check</span> Up to 5 Master Tracking Slots
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-status-success dark:text-crimson-signal text-[16px]">check</span> Solana PDA & 4337 Smart Account
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-status-success dark:text-crimson-signal text-[16px]">check</span> Autonomous Stop-Loss / Exits
                    </li>
                  </ul>
                </div>
                <Link
                  href="/signup?tier=operator"
                  className="w-full py-2.5 text-center font-headline text-sm font-semibold bg-primary text-on-primary dark:bg-crimson-signal dark:text-white dark:hover:bg-crimson-glow rounded shadow-md dark:shadow-[0_0_14px_rgba(239,68,68,0.3)] transition-all"
                >
                  Get Operator Access
                </Link>
              </div>

              {/* Tier 3: Ultra */}
              <div className="bg-surface-deep border border-border-subtle dark:border-border-muted rounded-xl p-6 flex flex-col justify-between gap-6 hover:border-border-prominent transition-all">
                <div className="flex flex-col gap-4">
                  <div>
                    <span className="font-mono text-xs text-text-tertiary uppercase">TIER 03 // FLEET</span>
                    <h3 className="font-headline text-xl text-primary font-bold">Ultra</h3>
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span className="font-headline text-3xl sm:text-4xl text-primary font-bold">150 USDC</span>
                    <span className="text-xs text-text-tertiary">/mo</span>
                  </div>
                  <ul className="flex flex-col gap-2.5 pt-2 text-xs text-text-secondary">
                    <li className="flex items-center gap-2">
                      <span className="text-text-tertiary font-mono">/</span> Everything in Operator
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="text-text-tertiary font-mono">/</span> Up to 25 Active Master Slots
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="text-text-tertiary font-mono">/</span> Priority Trade Fan-Out Queue
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="text-text-tertiary font-mono">/</span> Dynamic Chains Registry API
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="text-text-tertiary font-mono">/</span> Dedicated Quant Webhooks
                    </li>
                  </ul>
                </div>
                <Link
                  href="/signup?tier=ultra"
                  className="w-full py-2.5 text-center font-headline text-sm font-medium bg-surface-raised border border-border-subtle dark:border-border-muted text-primary hover:border-border-prominent rounded transition-colors"
                >
                  Get Ultra Access
                </Link>
              </div>

              {/* Tier 4: Lifetime */}
              <div className="bg-surface-deep border border-border-subtle dark:border-border-muted rounded-xl p-6 flex flex-col justify-between gap-6 hover:border-border-prominent transition-all">
                <div className="flex flex-col gap-4">
                  <div>
                    <span className="font-mono text-xs text-text-tertiary uppercase">PERPETUAL</span>
                    <h3 className="font-headline text-xl text-primary font-bold">Lifetime</h3>
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span className="font-headline text-3xl sm:text-4xl text-primary font-bold">1,999 USDC</span>
                    <span className="text-xs text-text-tertiary">one-time</span>
                  </div>
                  <ul className="flex flex-col gap-2.5 pt-2 text-xs text-primary">
                    <li className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-status-positive text-[16px]">check</span> Permanent Ultra Access Forever
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-status-positive text-[16px]">check</span> Zero Recurring Payments
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-status-positive text-[16px]">check</span> Priority Fleet Execution
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-status-positive text-[16px]">check</span> Direct Core Engineer Telegram
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-status-positive text-[16px]">check</span> Exclusive Beta Features Access
                    </li>
                  </ul>
                </div>
                <Link
                  href="/signup?tier=lifetime"
                  className="w-full py-2.5 text-center font-headline text-sm font-semibold bg-primary text-on-primary dark:bg-white dark:text-black hover:opacity-90 rounded transition-opacity"
                >
                  Secure Lifetime Spot
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 7: OPERATIONAL FAQ (ACCORDION) */}
        <section className="w-full max-w-[1280px] mx-auto px-4 sm:px-6 md:px-8 py-16 md:py-24" id="faq">
          <div className="max-w-3xl mx-auto flex flex-col gap-10">
            <div className="flex flex-col gap-1 items-center text-center">
              <div className="font-mono text-xs text-status-success dark:text-crimson-signal uppercase tracking-widest font-semibold">
                SECURITY & MECHANICS
              </div>
              <h2 className="font-headline text-3xl md:text-4xl text-primary font-bold">Operational FAQ</h2>
            </div>

            <div className="flex flex-col gap-3">
              {/* Item 1 */}
              <div className="bg-surface-deep border border-border-subtle dark:border-border-muted rounded-lg overflow-hidden transition-colors">
                <button
                  type="button"
                  onClick={() => toggleFaq(1)}
                  className="w-full px-6 py-4 flex items-center justify-between text-left font-headline text-base sm:text-lg text-primary font-medium"
                >
                  <span>How do you handle wallet custody and security?</span>
                  <span className="material-symbols-outlined text-text-secondary transition-transform">
                    {openFaq === 1 ? 'remove' : 'add'}
                  </span>
                </button>
                {openFaq === 1 && (
                  <div className="px-6 pb-5 text-sm sm:text-base text-text-secondary leading-relaxed border-t border-border-subtle pt-3">
                    WAKE is 100% non-custodial. On Solana, your funds remain in an Anchor Program Derived Address (PDA) vault where only your user signature can authorize withdrawals. On EVM and Robinhood Chain, we use EIP-7702 delegated smart accounts with restricted spending allowances. Wake servers never hold or store your private keys.
                  </div>
                )}
              </div>

              {/* Item 2 */}
              <div className="bg-surface-deep border border-border-subtle dark:border-border-muted rounded-lg overflow-hidden transition-colors">
                <button
                  type="button"
                  onClick={() => toggleFaq(2)}
                  className="w-full px-6 py-4 flex items-center justify-between text-left font-headline text-base sm:text-lg text-primary font-medium"
                >
                  <span>How does copy trading work?</span>
                  <span className="material-symbols-outlined text-text-secondary transition-transform">
                    {openFaq === 2 ? 'remove' : 'add'}
                  </span>
                </button>
                {openFaq === 2 && (
                  <div className="px-6 pb-5 text-sm sm:text-base text-text-secondary leading-relaxed border-t border-border-subtle pt-3">
                    You add the wallet address of whales you want to follow (or discover early buyers by pasting a token contract). When the whale makes a trade, Wake's high-frequency ingestion engine detects the transaction within milliseconds and your smart vault automatically executes the swap based on your position size and risk limits.
                  </div>
                )}
              </div>

              {/* Item 3 */}
              <div className="bg-surface-deep border border-border-subtle dark:border-border-muted rounded-lg overflow-hidden transition-colors">
                <button
                  type="button"
                  onClick={() => toggleFaq(3)}
                  className="w-full px-6 py-4 flex items-center justify-between text-left font-headline text-base sm:text-lg text-primary font-medium"
                >
                  <span>How do lot-proportional exits and stop-losses work?</span>
                  <span className="material-symbols-outlined text-text-secondary transition-transform">
                    {openFaq === 3 ? 'remove' : 'add'}
                  </span>
                </button>
                {openFaq === 3 && (
                  <div className="px-6 pb-5 text-sm sm:text-base text-text-secondary leading-relaxed border-t border-border-subtle pt-3">
                    If a whale reduces their bag by 50%, Wake automatically matches your entry lot and sells exactly 50% of your position. Additionally, you can configure hard stop-loss percentages: if a token drops below your threshold, your vault executes an emergency exit regardless of whether the whale has sold.
                  </div>
                )}
              </div>

              {/* Item 4 */}
              <div className="bg-surface-deep border border-border-subtle dark:border-border-muted rounded-lg overflow-hidden transition-colors">
                <button
                  type="button"
                  onClick={() => toggleFaq(4)}
                  className="w-full px-6 py-4 flex items-center justify-between text-left font-headline text-base sm:text-lg text-primary font-medium"
                >
                  <span>What chains and execution venues are supported?</span>
                  <span className="material-symbols-outlined text-text-secondary transition-transform">
                    {openFaq === 4 ? 'remove' : 'add'}
                  </span>
                </button>
                {openFaq === 4 && (
                  <div className="px-6 pb-5 text-sm sm:text-base text-text-secondary leading-relaxed border-t border-border-subtle pt-3">
                    Wake currently supports Solana (Jupiter, Raydium, Pump.fun, Meteora), Polymarket (Polygon CTF Exchange binary and neg-risk prediction markets), and Robinhood Chain (EIP-7702 delegated smart accounts).
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 8: FINAL CONVERSION CTA BANNER */}
        <section className="w-full max-w-[1280px] mx-auto px-4 sm:px-6 md:px-8 pb-20">
          <div className="relative bg-surface-deep border border-border-subtle dark:border-crimson-signal/40 rounded-2xl p-8 sm:p-12 md:p-16 overflow-hidden shadow-xl dark:shadow-[0_0_40px_rgba(239,68,68,0.15)] flex flex-col items-center text-center gap-6">
            <div className="absolute inset-0 bg-gradient-to-b from-solana-teal/5 dark:from-crimson-signal/5 via-transparent to-transparent pointer-events-none"></div>

            <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-surface-raised border border-border-subtle rounded-full">
              <span className="w-2 h-2 rounded-full bg-status-success dark:bg-crimson-signal animate-pulse"></span>
              <span className="font-mono text-[11px] text-text-secondary uppercase tracking-widest">
                DEPLOY NON-CUSTODIAL VAULT
              </span>
            </div>

            <h2 className="font-headline text-3xl sm:text-5xl text-primary font-bold max-w-2xl leading-tight">
              Ready for automated whale execution?
            </h2>

            <p className="text-base sm:text-lg text-text-secondary max-w-xl">
              Stop watching Telegram bots and start copying alpha on-chain. Set up your non-custodial vault and begin mirroring top traders today.
            </p>

            <div className="flex flex-wrap items-center justify-center gap-4 pt-2 z-10">
              <Link
                href="/signup"
                className="inline-flex items-center justify-center gap-2 font-headline text-sm sm:text-base font-semibold px-8 py-3.5 bg-primary text-on-primary dark:bg-crimson-signal dark:text-white dark:hover:bg-crimson-glow hover:opacity-90 transition-all rounded shadow-lg dark:shadow-[0_0_20px_rgba(239,68,68,0.4)]"
              >
                <span>Join Early Access</span>
                <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
              </Link>

              <Link
                href="/login"
                className="inline-flex items-center justify-center font-headline text-sm sm:text-base font-medium px-8 py-3.5 bg-surface-raised border border-border-subtle dark:border-border-muted text-primary hover:border-border-prominent transition-all rounded"
              >
                Sign In
              </Link>
            </div>

            {/* Live Terminal Status Ticker Strip */}
            <div className="w-full pt-6 border-t border-border-subtle mt-4 flex flex-wrap items-center justify-between gap-3 font-mono text-xs text-text-tertiary">
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-status-positive"></span>
                <span>RPC LATENCY: 28MS</span>
              </div>
              <div className="flex items-center gap-2">
                <span>00:00 UTC</span>
                <span>•</span>
                <span className="text-primary font-semibold">ENV: LIVE</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[16px] text-status-success dark:text-crimson-signal">
                  bolt
                </span>
                <span>AUTO-REEVALUATION FREQUENCY: 100MS</span>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* FOOTER */}
      <footer className="w-full bg-surface-deep border-t border-border-subtle dark:border-border-muted mt-12 transition-colors">
        <div className="max-w-[1280px] mx-auto px-4 sm:px-6 md:px-8 py-16">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-10 pb-12 border-b border-border-subtle">
            <div className="md:col-span-5 flex flex-col gap-4">
              <div className="flex items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/wake-logo.png"
                  alt="Wake Protocol Logo"
                  width={28}
                  height={28}
                  className="h-7 w-7 object-contain dark:hidden block"
                />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/wake-logo-white.png"
                  alt="Wake Protocol Logo"
                  width={28}
                  height={28}
                  className="h-7 w-7 object-contain dark:block hidden"
                />
                <span className="font-headline text-lg text-primary tracking-tight font-bold">WAKE</span>
                <span className="font-mono text-[10px] text-text-tertiary tracking-widest uppercase">
                  PROTOCOL
                </span>
              </div>
              <p className="text-sm text-text-secondary max-w-sm leading-relaxed">
                Autonomous, non-custodial copy-trading protocol for professional crypto operators.
              </p>
              <div className="flex items-center gap-2 text-status-positive font-mono text-xs mt-1">
                <span className="w-2 h-2 rounded-full bg-status-positive"></span>
                <span>ALL SYSTEMS OPERATIONAL</span>
              </div>
            </div>

            <div className="md:col-span-7 grid grid-cols-2 sm:grid-cols-3 gap-8">
              <div className="flex flex-col gap-3">
                <span className="font-mono text-xs uppercase text-text-tertiary tracking-wider font-semibold">
                  Product
                </span>
                <ul className="flex flex-col gap-2">
                  <li>
                    <Link href="/dashboard" className="text-xs text-on-surface-variant hover:text-primary transition-colors">
                      Execution Terminal
                    </Link>
                  </li>
                  <li>
                    <Link href="/wallets" className="text-xs text-on-surface-variant hover:text-primary transition-colors">
                      Whale Watchers
                    </Link>
                  </li>
                  <li>
                    <Link href="/positions" className="text-xs text-on-surface-variant hover:text-primary transition-colors">
                      Positions
                    </Link>
                  </li>
                  <li>
                    <Link href="/signals" className="text-xs text-on-surface-variant hover:text-primary transition-colors">
                      Telemetry Stream
                    </Link>
                  </li>
                </ul>
              </div>

              <div className="flex flex-col gap-3">
                <span className="font-mono text-xs uppercase text-text-tertiary tracking-wider font-semibold">
                  Resources
                </span>
                <ul className="flex flex-col gap-2">
                  <li>
                    <Link href="/learn" className="text-xs text-on-surface-variant hover:text-primary transition-colors">
                      Documentation
                    </Link>
                  </li>
                  <li>
                    <Link href="/logs" className="text-xs text-on-surface-variant hover:text-primary transition-colors">
                      Security & Audits
                    </Link>
                  </li>
                  <li>
                    <Link href="/performance" className="text-xs text-on-surface-variant hover:text-primary transition-colors">
                      Latency Benchmarks
                    </Link>
                  </li>
                  <li>
                    <Link href="/vault" className="text-xs text-on-surface-variant hover:text-primary transition-colors">
                      Vault Custody
                    </Link>
                  </li>
                </ul>
              </div>

              <div className="flex flex-col gap-3">
                <span className="font-mono text-xs uppercase text-text-tertiary tracking-wider font-semibold">
                  Protocol
                </span>
                <ul className="flex flex-col gap-2">
                  <li>
                    <Link href="/lp/discover" className="text-xs text-on-surface-variant hover:text-primary transition-colors">
                      LP Protocol
                    </Link>
                  </li>
                  <li>
                    <Link href="/clusters" className="text-xs text-on-surface-variant hover:text-primary transition-colors">
                      Cluster Intelligence
                    </Link>
                  </li>
                  <li>
                    <Link href="/billing" className="text-xs text-on-surface-variant hover:text-primary transition-colors">
                      Access Governance
                    </Link>
                  </li>
                  <li>
                    <a href="https://x.com" target="_blank" rel="noreferrer" className="text-xs text-on-surface-variant hover:text-primary transition-colors">
                      X / Community
                    </a>
                  </li>
                </ul>
              </div>
            </div>
          </div>

          <div className="pt-8 flex flex-col sm:flex-row items-center justify-between gap-4 font-mono text-xs text-text-tertiary">
            <div>© 2026 WAKE Protocol. Institutional non-custodial execution infrastructure.</div>
            <div className="flex items-center gap-6">
              <Link href="/terms" className="hover:text-primary transition-colors">
                Terms of Execution
              </Link>
              <Link href="/terms" className="hover:text-primary transition-colors">
                Privacy Policy
              </Link>
              <Link href="/terms" className="hover:text-primary transition-colors">
                Risk Disclosure
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
