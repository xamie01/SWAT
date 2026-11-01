'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { WakeLogo } from '../components/WakeLogo.js';

export default function LandingPage() {
  const router = useRouter();

  // Accordion active state
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const toggleFaq = (index: number) => {
    setOpenFaq(openFaq === index ? null : index);
  };

  return (
    <div className="bg-background text-on-background min-h-screen antialiased font-sans">
      {/* Top Navigation Shell */}
      <nav className="fixed top-0 left-0 right-0 h-16 bg-surface-container-lowest/80 backdrop-blur-md z-50 border-b border-border-subtle px-6 md:px-12 flex items-center justify-between">
        <Link href="/" className="hover:opacity-85 transition-opacity">
          <WakeLogo size="md" />
        </Link>
        
        <div className="flex items-center gap-4 md:gap-8 text-body-sm font-medium">
          <div className="hidden sm:flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-status-success animate-pulse"></span>
            <span className="text-on-surface-variant font-mono text-[13px] tracking-tight">00:00 UTC</span>
          </div>
          <div className="hidden sm:block px-2 py-1 bg-surface-container text-on-primary-container rounded text-[11px] border border-border-subtle font-mono text-[11px] font-medium tracking-tight">
            ENV: LIVE
          </div>
          
          <div className="flex items-center gap-2">
            <Link 
              href="/login"
              className="text-primary hover:opacity-80 transition-opacity px-3 py-2 text-sm font-bold"
            >
              Sign In
            </Link>
            <Link 
              href="/signup"
              className="bg-primary text-white px-4 py-2 rounded-lg text-sm font-bold hover:opacity-90 transition-opacity"
            >
              Sign Up
            </Link>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="pt-32 pb-24 max-w-[1440px] mx-auto">
        {/* Hero Section */}
        <section className="mb-32 grid grid-cols-1 lg:grid-cols-12 gap-12 items-center px-6 md:px-12">
          <div className="lg:col-span-7 flex flex-col items-start text-left">
            <h1 className="text-[48px] md:text-[68px] leading-[1.05] font-extrabold tracking-tight mb-8 text-primary">
              WAKE: Non-custodial copy-trading that <span className="text-status-success">acts</span>, not just alerts.
            </h1>
            <p className="text-lg md:text-xl text-on-surface-variant max-w-xl leading-relaxed mb-14">
              The bridge between smart-money whale tracking and autonomous on-chain execution. Mirror verified master traders in real time while retaining 100% custody of your capital.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 w-full sm:w-auto">
              <Link 
                href="/signup"
                className="bg-primary text-white px-8 py-4 rounded-xl font-semibold flex items-center justify-center gap-3 transition-transform hover:scale-[1.02]"
              >
                Join Early Access
                <span className="material-symbols-outlined">arrow_forward</span>
              </Link>
              <Link 
                href="/wallets"
                className="border border-border-subtle text-primary px-8 py-4 rounded-xl font-semibold flex items-center justify-center gap-2 bg-surface-container-lowest hover:bg-surface-container-low transition-colors"
              >
                Explore Whales & Hot Coins
              </Link>
            </div>
          </div>
          <div className="lg:col-span-5 relative">
            {/* Sample Signal Card */}
            <div className="bg-white/70 backdrop-blur-md border border-solana-teal/20 rounded-2xl p-8 shadow-xl relative overflow-hidden">
              <div className="scanline"></div>
              <div className="flex justify-between items-start mb-8">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-2 h-2 rounded-full bg-solana-teal"></span>
                    <span className="text-[11px] font-bold text-solana-teal tracking-[0.1em] uppercase">WHALE TRADE DETECTED</span>
                  </div>
                  <h3 className="text-2xl font-bold tracking-tight">Master 0x82...a9f2 → $JUP</h3>
                </div>
                <div className="text-right">
                  <div className="text-[11px] font-bold text-on-surface-variant mb-1 uppercase tracking-wider">WIN RATE</div>
                  <div className="text-3xl font-black text-status-success">82.4%</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4 mb-8">
                <div className="p-4 bg-surface-container/50 rounded-xl border border-border-subtle/50">
                  <div className="text-[11px] font-bold text-on-surface-variant mb-1 uppercase tracking-wider">Execution Vault</div>
                  <div className="font-mono text-sm font-bold text-primary">Solana Keyless PDA</div>
                </div>
                <div className="p-4 bg-surface-container/50 rounded-xl border border-border-subtle/50">
                  <div className="text-[11px] font-bold text-on-surface-variant mb-1 uppercase tracking-wider">Position Sizing</div>
                  <div className="font-mono text-sm font-bold text-primary">Proportional (1.5x)</div>
                </div>
              </div>
              <div className="flex items-center justify-between border-t border-border-subtle pt-6">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-status-success text-lg">bolt</span>
                  <span className="text-sm font-medium text-on-surface-variant">AUTONOMOUS SWAP EXECUTED</span>
                </div>
                <div className="font-mono text-xs text-on-surface-variant opacity-60">Latency: 48ms</div>
              </div>
            </div>
            {/* Background Decorative Element */}
            <div className="absolute -z-10 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-80 bg-solana-teal/10 rounded-full blur-[100px]"></div>
          </div>
        </section>

        {/* The Operational Edge */}
        <section className="mb-32 px-6 md:px-12">
          <div className="text-center max-w-2xl mx-auto mb-16">
            <h2 className="text-3xl md:text-4xl font-black mb-4 tracking-tight">The Operational Edge</h2>
            <p className="text-lg text-on-surface-variant">Why manual tracking and Telegram bots fail in fast markets.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 border border-border-subtle rounded-2xl overflow-hidden shadow-sm">
            <div className="p-8 md:p-14 border-b md:border-b-0 md:border-r border-border-subtle bg-surface-container-low">
              <div className="text-status-error mb-6">
                <span className="material-symbols-outlined text-[48px]">warning</span>
              </div>
              <h3 className="text-2xl font-bold mb-8">The Tracker & Bot Flaws</h3>
              <ul className="space-y-6">
                <li className="flex items-start gap-4 text-on-surface-variant">
                  <span className="material-symbols-outlined text-status-error text-xl shrink-0">close</span>
                  <p className="text-sm md:text-base leading-normal">Telegram alerts arrive 30-90 seconds late — you end up as exit liquidity.</p>
                </li>
                <li className="flex items-start gap-4 text-on-surface-variant">
                  <span className="material-symbols-outlined text-status-error text-xl shrink-0">close</span>
                  <p className="text-sm md:text-base leading-normal">Manual trade execution: switching apps and signing wallets misses the entry wick.</p>
                </li>
                <li className="flex items-start gap-4 text-on-surface-variant">
                  <span className="material-symbols-outlined text-status-error text-xl shrink-0">close</span>
                  <p className="text-sm md:text-base leading-normal">Custodial bot risk: handing private keys to centralized servers risks total drain.</p>
                </li>
              </ul>
            </div>
            <div className="p-8 md:p-14 bg-surface-container-lowest">
              <div className="text-status-success mb-6">
                <span className="material-symbols-outlined text-[48px]">verified</span>
              </div>
              <h3 className="text-2xl font-bold mb-8">The WAKE Solution</h3>
              <ul className="space-y-6">
                <li className="flex items-start gap-4">
                  <span className="material-symbols-outlined text-status-success text-xl shrink-0">check_circle</span>
                  <p className="text-sm md:text-base leading-normal">Sub-100ms on-chain detection via high-frequency RPCs and Jito MEV protection.</p>
                </li>
                <li className="flex items-start gap-4">
                  <span className="material-symbols-outlined text-status-success text-xl shrink-0">check_circle</span>
                  <p className="text-sm md:text-base leading-normal">Zero-custody architecture: Anchor PDAs on Solana and EIP-7702 delegated smart accounts.</p>
                </li>
                <li className="flex items-start gap-4">
                  <span className="material-symbols-outlined text-status-success text-xl shrink-0">check_circle</span>
                  <p className="text-sm md:text-base leading-normal">Lot-proportional scaling: sell exactly when the whale sells, with automated stop-loss protection.</p>
                </li>
              </ul>
            </div>
          </div>
        </section>

        {/* Mechanical Workflow */}
        <section className="mb-32 px-6 md:px-12">
          <div className="flex items-center gap-6 mb-16">
            <div className="h-10 w-1.5 bg-primary rounded-full"></div>
            <h2 className="text-3xl font-black tracking-tight">Mechanical Workflow</h2>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Step 1 */}
            <div className="p-10 bg-surface-container-lowest border border-border-subtle rounded-2xl flex flex-col">
              <div className="font-mono text-xs font-bold text-on-primary-container mb-6 tracking-widest uppercase">01 // DISCOVERY</div>
              <h4 className="text-xl font-bold mb-4">Choose Whales or Hot Coins</h4>
              <p className="text-on-surface-variant text-sm md:text-base flex-grow mb-12">Track verified whale wallets directly, or paste any hot token contract on Solana, Polymarket, or Robinhood Chain to automatically backfill the earliest profitable buyers.</p>
              <div className="h-1.5 bg-surface-container overflow-hidden rounded-full mt-auto">
                <div className="h-full bg-primary w-full"></div>
              </div>
            </div>
            {/* Step 2 */}
            <div className="p-10 bg-surface-container-lowest border border-border-subtle rounded-2xl flex flex-col">
              <div className="font-mono text-xs font-bold text-on-primary-container mb-6 tracking-widest uppercase">02 // INGESTION</div>
              <h4 className="text-xl font-bold mb-4">Zero-Delay Signal Stream</h4>
              <p className="text-on-surface-variant text-sm md:text-base flex-grow mb-12">Wake's high-frequency indexing engine monitors master wallet activity on-chain. When they enter or exit a position, trade signals fan out to followers in milliseconds.</p>
              <div className="flex gap-2 mt-auto">
                <span className="px-3 py-1.5 bg-surface-container rounded-lg font-mono text-[10px] font-bold border border-border-subtle">SOLANA</span>
                <span className="px-3 py-1.5 bg-surface-container rounded-lg font-mono text-[10px] font-bold border border-border-subtle">POLYMARKET</span>
                <span className="px-3 py-1.5 bg-surface-container rounded-lg font-mono text-[10px] font-bold border border-border-subtle">ROBINHOOD</span>
              </div>
            </div>
            {/* Step 3 */}
            <div className="p-10 bg-surface-container-lowest border border-border-subtle rounded-2xl flex flex-col">
              <div className="font-mono text-xs font-bold text-on-primary-container mb-6 tracking-widest uppercase">03 // EXECUTION</div>
              <h4 className="text-xl font-bold mb-4">Autonomous Copy Execution</h4>
              <p className="text-on-surface-variant text-sm md:text-base flex-grow mb-12">Your non-custodial smart vault copies the trade automatically based on your position size limits, max slippage bounds, and autonomous stop-loss parameters.</p>
              <div className="mt-auto p-4 bg-primary text-on-primary rounded-xl flex items-center justify-between font-mono text-sm">
                <span className="font-bold">KEYLESS AUTO-COPY</span>
                <span className="material-symbols-outlined">toggle_on</span>
              </div>
            </div>
          </div>
        </section>

        {/* Multi-Chain Execution Venues */}
        <section className="mb-32 px-6 md:px-12 grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Solana */}
          <div className="relative overflow-hidden group border border-border-subtle rounded-2xl p-10 bg-surface-container-lowest hover:border-solana-teal/50 transition-all hover:shadow-lg">
            <div className="absolute top-0 left-0 w-1.5 h-full bg-solana-teal"></div>
            <div className="flex justify-between items-center mb-8">
              <h3 className="text-2xl font-bold">Solana</h3>
              <span className="px-3 py-1 bg-status-success/10 text-status-success rounded-full font-bold text-[10px]">LIVE</span>
            </div>
            <p className="text-on-surface-variant text-sm md:text-base leading-relaxed">Keyless Anchor PDAs. Instant execution across Raydium, Pump.fun, Meteora, and Jupiter with Jito bundle MEV defense.</p>
          </div>
          {/* Polymarket */}
          <div className="relative overflow-hidden group border border-border-subtle rounded-2xl p-10 bg-surface-container-lowest hover:border-polymarket-violet/50 transition-all hover:shadow-lg">
            <div className="absolute top-0 left-0 w-1.5 h-full bg-polymarket-violet"></div>
            <div className="flex justify-between items-center mb-8">
              <h3 className="text-2xl font-bold">Polymarket</h3>
              <span className="px-3 py-1 bg-status-success/10 text-status-success rounded-full font-bold text-[10px]">LIVE</span>
            </div>
            <p className="text-on-surface-variant text-sm md:text-base leading-relaxed">Prediction market copy trading on Polygon. CLOB orderbook execution, 2-decimal tick sizing, and automated outcome redemption.</p>
          </div>
          {/* Robinhood Chain */}
          <div className="relative overflow-hidden group border border-border-subtle rounded-2xl p-10 bg-surface-container-lowest hover:border-robinhood-amber/50 transition-all hover:shadow-lg">
            <div className="absolute top-0 left-0 w-1.5 h-full bg-robinhood-amber"></div>
            <div className="flex justify-between items-center mb-8">
              <h3 className="text-2xl font-bold">Robinhood Chain</h3>
              <span className="px-3 py-1 bg-status-success/10 text-status-success rounded-full font-bold text-[10px]">LIVE</span>
            </div>
            <p className="text-on-surface-variant text-sm md:text-base leading-relaxed">EIP-7702 delegated smart accounts. Autonomous copy execution with single-click authority delegation and zero key sharing.</p>
          </div>
        </section>

        {/* Transparency / Proof */}
        <section className="mb-32 px-6 md:px-12 bento-grid">
          <div className="col-span-12 lg:col-span-8 bg-white/70 backdrop-blur-md rounded-2xl p-8 md:p-10 shadow-sm border border-border-subtle">
            <h3 className="text-2xl font-black mb-8">Live Execution Stream (Sample)</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left font-mono border-collapse">
                <thead className="border-b border-border-subtle text-on-surface-variant">
                  <tr>
                    <th className="pb-6 text-[11px] font-bold uppercase tracking-wider">TIMESTAMP</th>
                    <th className="pb-6 text-[11px] font-bold uppercase tracking-wider">ACTION</th>
                    <th className="pb-6 text-[11px] font-bold uppercase tracking-wider">MASTER WHALE</th>
                    <th className="pb-6 text-[11px] font-bold uppercase tracking-wider">STATUS</th>
                    <th className="pb-6 text-[11px] font-bold uppercase tracking-wider">PERFORMANCE</th>
                  </tr>
                </thead>
                <tbody className="text-sm">
                  <tr className="border-b border-border-subtle/50 hover:bg-solana-teal/5 transition-colors group">
                    <td className="py-5 font-medium">14:02:11</td>
                    <td className="py-5 text-solana-teal font-bold">SOL / BUY</td>
                    <td className="py-5 opacity-70">0x14...3e2</td>
                    <td className="py-5">COPIED (Anchor PDA)</td>
                    <td className="py-5 text-status-success font-black text-base">+12.4%</td>
                  </tr>
                  <tr className="border-b border-border-subtle/50 hover:bg-solana-teal/5 transition-colors group">
                    <td className="py-5 font-medium">13:58:04</td>
                    <td className="py-5 text-polymarket-violet font-bold">POLY / YES</td>
                    <td className="py-5 opacity-70">0x99...ff0</td>
                    <td className="py-5">COPIED (CTF Safe)</td>
                    <td className="py-5 text-status-success font-black text-base">+28.0%</td>
                  </tr>
                  <tr className="hover:bg-solana-teal/5 transition-colors group">
                    <td className="py-5 font-medium">13:45:30</td>
                    <td className="py-5 text-status-warning font-bold">SOL / EXIT</td>
                    <td className="py-5 opacity-70">0x22...a11</td>
                    <td className="py-5">LOT EXIT (50% Sold)</td>
                    <td className="py-5 text-status-success font-black text-base">+42.1%</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div className="col-span-12 lg:col-span-4 bg-primary text-on-primary rounded-2xl flex flex-col justify-between shadow-lg p-12">
            <div>
              <h3 className="text-2xl font-bold mb-6">Non-Custodial by Design</h3>
              <p className="text-sm md:text-base text-on-primary/80 leading-relaxed">We never hold your private keys or touch your funds. WAKE operates entirely through verifiable smart contracts and on-chain Program Derived Addresses.</p>
            </div>
            <div className="mt-12 space-y-6">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-on-primary/10 flex items-center justify-center">
                  <span className="material-symbols-outlined text-solana-teal">lock_open</span>
                </div>
                <span className="font-semibold text-sm md:text-base">Keyless Anchor PDAs (Solana)</span>
              </div>
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-on-primary/10 flex items-center justify-center">
                  <span className="material-symbols-outlined text-solana-teal">vpn_key</span>
                </div>
                <span className="font-semibold text-sm md:text-base">EIP-7702 Delegated Accounts</span>
              </div>
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section className="mb-32 px-6 md:px-12">
          <div className="text-center max-w-2xl mx-auto mb-16">
            <h2 className="text-4xl font-black mb-4 tracking-tight">Access Tiers</h2>
            <p className="text-lg text-on-surface-variant">Scale your operations with professional infrastructure.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-7xl mx-auto items-stretch">
            {/* Free */}
            <div className="border border-border-subtle bg-surface-container-lowest rounded-2xl p-8 flex flex-col justify-between">
              <div>
                <span className="text-[11px] font-bold text-on-surface-variant mb-4 block text-center uppercase tracking-[0.2em]">Standard</span>
                <div className="text-3xl font-black mb-8 text-center">Free</div>
                <ul className="text-sm text-on-surface-variant space-y-4 mb-8">
                  <li className="flex gap-2.5"><span className="text-primary font-bold">/</span> 5m Delayed Signals</li>
                  <li className="flex gap-2.5"><span className="text-primary font-bold">/</span> Basic Wallet Tracking</li>
                  <li className="flex gap-2.5"><span className="text-primary font-bold">/</span> 1 Monitored Master Slot</li>
                  <li className="flex gap-2.5"><span className="text-primary font-bold">/</span> Read-Only Webhooks</li>
                </ul>
              </div>
              <Link 
                href="/signup?tier=free"
                className="w-full py-3 text-center border border-border-subtle rounded-xl font-bold hover:bg-surface-container-low transition-colors"
              >
                Start Free
              </Link>
            </div>

            {/* Operator */}
            <div className="border-2 border-primary bg-surface-container-highest rounded-2xl p-8 flex flex-col justify-between relative shadow-2xl scale-[1.02] z-10">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 bg-primary text-on-primary rounded-full text-[10px] font-black tracking-widest whitespace-nowrap">MOST POPULAR</div>
              <div>
                <span className="text-[11px] font-bold text-primary/60 mb-4 block text-center uppercase tracking-[0.2em]">Operator</span>
                <div className="text-3xl font-black mb-8 text-center">35 USDC <span className="text-sm font-medium opacity-60">/mo</span></div>
                <ul className="text-sm text-primary space-y-4 mb-8">
                  <li className="flex gap-2.5 font-semibold"><span className="text-status-success">✓</span> 0s Real-Time Signal Stream</li>
                  <li className="flex gap-2.5 font-semibold"><span className="text-status-success">✓</span> Automated Execution Engine</li>
                  <li className="flex gap-2.5 font-semibold"><span className="text-status-success">✓</span> Up to 5 Master Tracking Slots</li>
                  <li className="flex gap-2.5 font-semibold"><span className="text-status-success">✓</span> Solana PDA & 4337 Smart Account</li>
                  <li className="flex gap-2.5 font-semibold"><span className="text-status-success">✓</span> Autonomous Stop-Loss / Exits</li>
                </ul>
              </div>
              <Link 
                href="/signup?tier=operator"
                className="w-full py-3 text-center bg-primary text-on-primary rounded-xl font-black shadow-lg shadow-primary/20 hover:opacity-90 transition-opacity"
              >
                Get Operator Access
              </Link>
            </div>

            {/* Ultra */}
            <div className="border border-border-subtle bg-surface-container-lowest rounded-2xl p-8 flex flex-col justify-between">
              <div>
                <span className="text-[11px] font-bold text-on-surface-variant mb-4 block text-center uppercase tracking-[0.2em]">Ultra</span>
                <div className="text-3xl font-black mb-8 text-center">150 USDC <span className="text-sm font-medium opacity-60">/mo</span></div>
                <ul className="text-sm text-on-surface-variant space-y-4 mb-8">
                  <li className="flex gap-2.5 font-semibold"><span className="text-primary font-bold">/</span> Everything in Operator</li>
                  <li className="flex gap-2.5 font-semibold"><span className="text-primary font-bold">/</span> Up to 25 Active Master Slots</li>
                  <li className="flex gap-2.5 font-semibold"><span className="text-primary font-bold">/</span> Priority Trade Fan-Out Queue</li>
                  <li className="flex gap-2.5 font-semibold"><span className="text-primary font-bold">/</span> Dynamic Chains Registry API</li>
                  <li className="flex gap-2.5 font-semibold"><span className="text-primary font-bold">/</span> Dedicated Quant Webhooks</li>
                </ul>
              </div>
              <Link 
                href="/signup?tier=ultra"
                className="w-full py-3 text-center border border-primary text-primary rounded-xl font-bold hover:bg-primary hover:text-on-primary transition-colors"
              >
                Get Ultra Access
              </Link>
            </div>

            {/* Lifetime */}
            <div className="border border-border-subtle bg-surface-container-lowest rounded-2xl p-8 flex flex-col justify-between">
              <div>
                <span className="text-[11px] font-bold text-on-surface-variant mb-4 block text-center uppercase tracking-[0.2em]">Lifetime</span>
                <div className="text-3xl font-black mb-8 text-center">1,999 USDC <span className="text-xs font-medium opacity-60 block mt-1">one-time</span></div>
                <ul className="text-sm text-on-surface-variant space-y-4 mb-8">
                  <li className="flex gap-2.5 font-semibold"><span className="text-status-success font-bold">✓</span> Permanent Ultra Access Forever</li>
                  <li className="flex gap-2.5 font-semibold"><span className="text-status-success font-bold">✓</span> Zero Recurring Payments</li>
                  <li className="flex gap-2.5 font-semibold"><span className="text-status-success font-bold">✓</span> Priority Fleet Execution</li>
                  <li className="flex gap-2.5 font-semibold"><span className="text-status-success font-bold">✓</span> Direct Core Engineer Telegram</li>
                  <li className="flex gap-2.5 font-semibold"><span className="text-status-success font-bold">✓</span> Exclusive Beta Features Access</li>
                </ul>
              </div>
              <Link 
                href="/signup?tier=lifetime"
                className="w-full py-3 text-center border border-border-subtle rounded-xl font-bold hover:bg-surface-container-low transition-colors"
              >
                Secure Lifetime Spot
              </Link>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="mb-32 px-6 md:px-12 max-w-4xl mx-auto">
          <h2 className="text-3xl font-black mb-16 text-center tracking-tight">Operational FAQ</h2>
          <div className="space-y-4">
            {/* FAQ 1 */}
            <div className="border border-border-subtle rounded-2xl overflow-hidden bg-surface-container-lowest">
              <button 
                onClick={() => toggleFaq(1)}
                className="flex justify-between items-center w-full px-8 py-6 text-left group hover:bg-surface-container-low transition-colors"
              >
                <span className="text-lg font-bold text-primary">How do you handle wallet custody and security?</span>
                <span 
                  className="material-symbols-outlined transition-transform duration-300"
                  style={{ transform: openFaq === 1 ? 'rotate(180deg)' : 'rotate(0deg)' }}
                >
                  {openFaq === 1 ? 'remove' : 'add'}
                </span>
              </button>
              <div className={`${openFaq === 1 ? 'block' : 'hidden'} px-8 pb-8 text-on-surface-variant leading-relaxed text-sm md:text-base`}>
                WAKE is 100% non-custodial. On Solana, your funds remain in an Anchor Program Derived Address (PDA) vault where only your user signature can authorize withdrawals. On EVM and Robinhood Chain, we use EIP-7702 delegated smart accounts with restricted spending allowances. Wake servers never hold or store your private keys.
              </div>
            </div>
            
            {/* FAQ 2 */}
            <div className="border border-border-subtle rounded-2xl overflow-hidden bg-surface-container-lowest">
              <button 
                onClick={() => toggleFaq(2)}
                className="flex justify-between items-center w-full px-8 py-6 text-left group hover:bg-surface-container-low transition-colors"
              >
                <span className="text-lg font-bold text-primary">How does copy trading work?</span>
                <span 
                  className="material-symbols-outlined transition-transform duration-300"
                  style={{ transform: openFaq === 2 ? 'rotate(180deg)' : 'rotate(0deg)' }}
                >
                  {openFaq === 2 ? 'remove' : 'add'}
                </span>
              </button>
              <div className={`${openFaq === 2 ? 'block' : 'hidden'} px-8 pb-8 text-on-surface-variant leading-relaxed text-sm md:text-base`}>
                You add the wallet address of whales you want to follow (or discover early buyers by pasting a token contract). When the whale makes a trade, Wake's high-frequency ingestion engine detects the transaction within milliseconds and your smart vault automatically executes the swap based on your position size and risk limits.
              </div>
            </div>
            
            {/* FAQ 3 */}
            <div className="border border-border-subtle rounded-2xl overflow-hidden bg-surface-container-lowest">
              <button 
                onClick={() => toggleFaq(3)}
                className="flex justify-between items-center w-full px-8 py-6 text-left group hover:bg-surface-container-low transition-colors"
              >
                <span className="text-lg font-bold text-primary">How do lot-proportional exits and stop-losses work?</span>
                <span 
                  className="material-symbols-outlined transition-transform duration-300"
                  style={{ transform: openFaq === 3 ? 'rotate(180deg)' : 'rotate(0deg)' }}
                >
                  {openFaq === 3 ? 'remove' : 'add'}
                </span>
              </button>
              <div className={`${openFaq === 3 ? 'block' : 'hidden'} px-8 pb-8 text-on-surface-variant leading-relaxed text-sm md:text-base`}>
                If a whale reduces their bag by 50%, Wake automatically matches your entry lot and sells exactly 50% of your position. Additionally, you can configure hard stop-loss percentages: if a token drops below your threshold, your vault executes an emergency exit regardless of whether the whale has sold.
              </div>
            </div>

            {/* FAQ 4 */}
            <div className="border border-border-subtle rounded-2xl overflow-hidden bg-surface-container-lowest">
              <button 
                onClick={() => toggleFaq(4)}
                className="flex justify-between items-center w-full px-8 py-6 text-left group hover:bg-surface-container-low transition-colors"
              >
                <span className="text-lg font-bold text-primary">What chains and execution venues are supported?</span>
                <span 
                  className="material-symbols-outlined transition-transform duration-300"
                  style={{ transform: openFaq === 4 ? 'rotate(180deg)' : 'rotate(0deg)' }}
                >
                  {openFaq === 4 ? 'remove' : 'add'}
                </span>
              </button>
              <div className={`${openFaq === 4 ? 'block' : 'hidden'} px-8 pb-8 text-on-surface-variant leading-relaxed text-sm md:text-base`}>
                Wake currently supports Solana (Jupiter, Raydium, Pump.fun, Meteora), Polymarket (Polygon CTF Exchange binary and neg-risk prediction markets), and Robinhood Chain (EIP-7702 delegated smart accounts).
              </div>
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="mb-32 px-6 md:px-12">
          <div className="bg-primary-container text-on-primary-container rounded-[2.5rem] p-12 md:p-24 text-center relative overflow-hidden shadow-2xl">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(20,241,149,0.1),transparent)] pointer-events-none"></div>
            <div className="relative z-10">
              <h2 className="text-4xl md:text-6xl leading-[1.1] font-black text-on-primary mb-8 tracking-tighter">Ready for automated whale execution?</h2>
              <p className="text-lg md:text-xl text-on-primary/70 max-w-2xl mx-auto mb-14 text-balance">Stop watching Telegram bots and start copying alpha on-chain. Set up your non-custodial vault and begin mirroring top traders today.</p>
              <div className="flex flex-col sm:flex-row gap-5 justify-center">
                <Link 
                  href="/signup"
                  className="bg-on-primary text-primary px-12 py-5 rounded-2xl font-bold text-lg hover:scale-[1.03] transition-transform shadow-xl text-center"
                >
                  Join Early Access
                </Link>
                <Link 
                  href="/login"
                  className="border border-on-primary-container/30 text-on-primary px-12 py-5 rounded-2xl font-bold text-lg hover:bg-on-primary/5 transition-colors text-center"
                >
                  Sign In
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="bg-surface-container-lowest border-t border-border-subtle py-20 px-6 md:px-12">
        <div className="max-w-[1440px] mx-auto grid grid-cols-1 md:grid-cols-12 gap-12">
          <div className="md:col-span-5">
            <div className="mb-6">
              <WakeLogo size="md" />
            </div>
            <p className="text-sm md:text-base text-on-surface-variant max-w-sm leading-relaxed">Autonomous, non-custodial copy-trading protocol for professional crypto operators.</p>
          </div>
          <div className="md:col-span-7 grid grid-cols-2 sm:grid-cols-3 gap-8">
            <div>
              <h5 className="text-[11px] font-bold text-on-surface-variant mb-6 uppercase tracking-wider opacity-60">Product</h5>
              <ul className="space-y-4 text-on-surface-variant font-medium text-sm">
                <li><Link className="hover:text-primary transition-colors" href="/wallets">Wallets & Coins</Link></li>
                <li><Link className="hover:text-primary transition-colors" href="/vault">Smart Vault</Link></li>
                <li><Link className="hover:text-primary transition-colors" href="/billing">Pricing</Link></li>
              </ul>
            </div>
            <div>
              <h5 className="text-[11px] font-bold text-on-surface-variant mb-6 uppercase tracking-wider opacity-60">Resources</h5>
              <ul className="space-y-4 text-on-surface-variant font-medium text-sm">
                <li><Link className="hover:text-primary transition-colors" href="/signals">Signal Stream</Link></li>
                <li><Link className="hover:text-primary transition-colors" href="/positions">Active Positions</Link></li>
                <li><Link className="hover:text-primary transition-colors" href="/logs">Audit Logs</Link></li>
              </ul>
            </div>
            <div className="col-span-2 sm:col-span-1">
              <h5 className="text-[11px] font-bold text-on-surface-variant mb-6 uppercase tracking-wider opacity-60">Connect</h5>
              <div className="flex gap-4">
                <a className="w-10 h-10 rounded-full border border-border-subtle flex items-center justify-center hover:bg-surface-container transition-colors" href="https://x.com" target="_blank" rel="noreferrer">
                  <span className="material-symbols-outlined text-lg">public</span>
                </a>
                <a className="w-10 h-10 rounded-full border border-border-subtle flex items-center justify-center hover:bg-surface-container transition-colors" href="https://telegram.org" target="_blank" rel="noreferrer">
                  <span className="material-symbols-outlined text-lg">alternate_email</span>
                </a>
              </div>
            </div>
          </div>
        </div>
        <div className="max-w-[1440px] mx-auto mt-20 pt-10 border-t border-border-subtle flex flex-col sm:flex-row justify-between items-center gap-6 text-[11px] text-on-surface-variant font-mono opacity-60 tracking-wider">
          <span>© 2026 WAKE PROTOCOL. ALL RIGHTS RESERVED.</span>
          <div className="flex gap-8">
            <Link className="hover:text-primary" href="/terms">PRIVACY POLICY</Link>
            <Link className="hover:text-primary" href="/terms">TERMS OF SERVICE</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
