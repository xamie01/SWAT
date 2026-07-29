'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function LandingPage() {
  const router = useRouter();

  // Accordion active state
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const toggleFaq = (index: number) => {
    setOpenFaq(openFaq === index ? null : index);
  };

  const enterWorkspace = () => router.push('/workspace');

  return (
    <div className="bg-background text-on-background min-h-screen antialiased font-sans">
      {/* Top Navigation Shell */}
      <nav className="fixed top-0 left-0 right-0 h-16 bg-surface-container-lowest/80 backdrop-blur-md z-50 border-b border-border-subtle px-6 md:px-12 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-4 hover:opacity-80 transition-opacity">
          <img 
            alt="WAKE Logo" 
            className="h-8 w-auto" 
            src="https://lh3.googleusercontent.com/aida/AP1WRLtWod_shvYwZo04JI9qz9KbCkE4ccfvLt5YPoZfWK9_5IWgDMRxVww6XBAGkZRs0T-1jmcBXgmhsCcR8eu3dkshLlD6BnHpBiyrEunns1F0WH2lTlznG7mzTzzj4AeokEA0E_YMu73Zl7jCGS4uT0bRbBz2ViYg97kcTe_MBHntKuHo1vbl-A-yjjaHUil_JfO9AItouKrQCMCDBsCiM7mFfBKz_TwWyqrffxRbNdYPgyTdQ2oShfFx3O4" 
          />
          <span className="font-headline-md text-xl font-black tracking-tighter text-primary">WAKE</span>
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
            <button 
              onClick={enterWorkspace}
              className="text-primary hover:opacity-80 transition-opacity px-3 py-2 text-sm font-bold"
            >
              Sign In
            </button>
            <button 
              onClick={enterWorkspace}
              className="bg-primary text-white px-4 py-2 rounded-lg text-sm font-bold hover:opacity-90 transition-opacity"
            >
              Sign Up
            </button>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="pt-32 pb-24 max-w-[1440px] mx-auto">
        {/* Hero Section */}
        <section className="mb-32 grid grid-cols-1 lg:grid-cols-12 gap-12 items-center px-6 md:px-12">
          <div className="lg:col-span-7 flex flex-col items-start text-left">
            <h1 className="text-[48px] md:text-[68px] leading-[1.05] font-extrabold tracking-tight mb-8 text-primary">
              WAKE: Cross-chain intelligence that <span className="text-status-success">acts</span>, not just alerts.
            </h1>
            <p className="text-lg md:text-xl text-on-surface-variant max-w-xl leading-relaxed mb-14">
              The bridge between detecting alpha and capturing it. Real-time wallet clusters monitored by high-frequency ingestion engines.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 w-full sm:w-auto">
              <button 
                onClick={enterWorkspace}
                className="bg-primary text-white px-8 py-4 rounded-xl font-semibold flex items-center justify-center gap-3 transition-transform hover:scale-[1.02]"
              >
                Join Early Access
                <span className="material-symbols-outlined">arrow_forward</span>
              </button>
              <button 
                onClick={enterWorkspace}
                className="border border-border-subtle text-primary px-8 py-4 rounded-xl font-semibold flex items-center justify-center gap-2 bg-surface-container-lowest hover:bg-surface-container-low transition-colors"
              >
                View Live Feed
              </button>
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
                    <span className="text-[11px] font-bold text-solana-teal tracking-[0.1em] uppercase">SOLANA SNIPE DETECTED</span>
                  </div>
                  <h3 className="text-2xl font-bold tracking-tight">0x82...a9f2 → $JUP</h3>
                </div>
                <div className="text-right">
                  <div className="text-[11px] font-bold text-on-surface-variant mb-1 uppercase tracking-wider">CONFIDENCE</div>
                  <div className="text-3xl font-black text-status-success">94.8%</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4 mb-8">
                <div className="p-4 bg-surface-container/50 rounded-xl border border-border-subtle/50">
                  <div className="text-[11px] font-bold text-on-surface-variant mb-1 uppercase tracking-wider">Intent</div>
                  <div className="font-mono text-sm font-bold text-primary">Aggressive Accumulation</div>
                </div>
                <div className="p-4 bg-surface-container/50 rounded-xl border border-border-subtle/50">
                  <div className="text-[11px] font-bold text-on-surface-variant mb-1 uppercase tracking-wider">Cluster Size</div>
                  <div className="font-mono text-sm font-bold text-primary">14 Wallets</div>
                </div>
              </div>
              <div className="flex items-center justify-between border-t border-border-subtle pt-6">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-status-success text-lg">bolt</span>
                  <span className="text-sm font-medium text-on-surface-variant">AUTO-EXECUTION TRIGGERED</span>
                </div>
                <div className="font-mono text-xs text-on-surface-variant opacity-60">Latency: 42ms</div>
              </div>
            </div>
            {/* Background Decorative Element */}
            <div className="absolute -z-10 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-80 bg-solana-teal/10 rounded-full blur-[100px]"></div>
          </div>
        </section>

        {/* The Gap */}
        <section className="mb-32 px-6 md:px-12">
          <div className="text-center max-w-2xl mx-auto mb-16">
            <h2 className="text-3xl md:text-4xl font-black mb-4 tracking-tight">The Operational Edge</h2>
            <p className="text-lg text-on-surface-variant">Why traditional trackers fail in high-stakes environments.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 border border-border-subtle rounded-2xl overflow-hidden shadow-sm">
            <div className="p-8 md:p-14 border-b md:border-b-0 md:border-r border-border-subtle bg-surface-container-low">
              <div className="text-status-error mb-6">
                <span className="material-symbols-outlined text-[48px]">warning</span>
              </div>
              <h3 className="text-2xl font-bold mb-8">The Tracker Problem</h3>
              <ul className="space-y-6">
                <li className="flex items-start gap-4 text-on-surface-variant">
                  <span className="material-symbols-outlined text-status-error text-xl shrink-0">close</span>
                  <p className="text-sm md:text-base leading-normal">Alerts arrive after the volume spike has already cleared.</p>
                </li>
                <li className="flex items-start gap-4 text-on-surface-variant">
                  <span className="material-symbols-outlined text-status-error text-xl shrink-0">close</span>
                  <p className="text-sm md:text-base leading-normal">Contextless pings without cluster intelligence or intent scoring.</p>
                </li>
                <li className="flex items-start gap-4 text-on-surface-variant">
                  <span className="material-symbols-outlined text-status-error text-xl shrink-0">close</span>
                  <p className="text-sm md:text-base leading-normal">Manual execution required: you're already exit liquidity.</p>
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
                  <p className="text-sm md:text-base leading-normal">In-flight transaction analysis (Mempool + Jito bundle detection).</p>
                </li>
                <li className="flex items-start gap-4">
                  <span className="material-symbols-outlined text-status-success text-xl shrink-0">check_circle</span>
                  <p className="text-sm md:text-base leading-normal">Proprietary cluster scoring mapping entity relationships.</p>
                </li>
                <li className="flex items-start gap-4">
                  <span className="material-symbols-outlined text-status-success text-xl shrink-0">check_circle</span>
                  <p className="text-sm md:text-base leading-normal">Shadow-trading &amp; Auto-Execution modes for sub-second capture.</p>
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
              <div className="font-mono text-xs font-bold text-on-primary-container mb-6 tracking-widest uppercase">01 // ANALYTICS</div>
              <h4 className="text-xl font-bold mb-4">Scoring Logic</h4>
              <p className="text-on-surface-variant text-sm md:text-base flex-grow mb-12">Every transaction is scored 0-100 based on wallet age, capital source, and historical accuracy cluster rating.</p>
              <div className="h-1.5 bg-surface-container overflow-hidden rounded-full mt-auto">
                <div className="h-full bg-primary w-3/4"></div>
              </div>
            </div>
            {/* Step 2 */}
            <div className="p-10 bg-surface-container-lowest border border-border-subtle rounded-2xl flex flex-col">
              <div className="font-mono text-xs font-bold text-on-primary-container mb-6 tracking-widest uppercase">02 // CLASSIFICATION</div>
              <h4 className="text-xl font-bold mb-4">Pattern Recognition</h4>
              <p className="text-on-surface-variant text-sm md:text-base flex-grow mb-12">WAKE automatically categorizes flows into Snipe, Long-term Accumulation, Rotation, or Panic Exit.</p>
              <div className="flex gap-2 mt-auto">
                <span className="px-3 py-1.5 bg-surface-container rounded-lg font-mono text-[10px] font-bold border border-border-subtle">SNIPE</span>
                <span className="px-3 py-1.5 bg-surface-container rounded-lg font-mono text-[10px] font-bold border border-border-subtle">ACCUM</span>
                <span className="px-3 py-1.5 bg-surface-container rounded-lg font-mono text-[10px] font-bold border border-border-subtle">EXIT</span>
              </div>
            </div>
            {/* Step 3 */}
            <div className="p-10 bg-surface-container-lowest border border-border-subtle rounded-2xl flex flex-col">
              <div className="font-mono text-xs font-bold text-on-primary-container mb-6 tracking-widest uppercase">03 // EXECUTION</div>
              <h4 className="text-xl font-bold mb-4">Signal Thresholds</h4>
              <p className="text-on-surface-variant text-sm md:text-base flex-grow mb-12">Set custom risk parameters. <span className="font-bold text-primary">≥80</span> triggers visual alerts, <span className="font-bold text-primary">≥90</span> triggers auto-buy.</p>
              <div className="mt-auto p-4 bg-primary text-on-primary rounded-xl flex items-center justify-between font-mono text-sm">
                <span className="font-bold">AUTO-EXECUTE MODE</span>
                <span className="material-symbols-outlined">toggle_on</span>
              </div>
            </div>
          </div>
        </section>

        {/* Market Coverage */}
        <section className="mb-32 px-6 md:px-12 grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Solana */}
          <div className="relative overflow-hidden group border border-border-subtle rounded-2xl p-10 bg-surface-container-lowest hover:border-solana-teal/50 transition-all hover:shadow-lg">
            <div className="absolute top-0 left-0 w-1.5 h-full bg-solana-teal"></div>
            <div className="flex justify-between items-center mb-8">
              <h3 className="text-2xl font-bold">Solana</h3>
              <span className="px-3 py-1 bg-status-success/10 text-status-success rounded-full font-bold text-[10px]">LIVE</span>
            </div>
            <p className="text-on-surface-variant text-sm md:text-base leading-relaxed">Full RPC coverage. Monitoring Raydium, Pump.fun, and Meteora pools with sub-20ms latency.</p>
          </div>
          {/* Polymarket */}
          <div className="relative overflow-hidden group border border-border-subtle rounded-2xl p-10 bg-surface-container-lowest/50 opacity-80">
            <div className="absolute top-0 left-0 w-1.5 h-full bg-polymarket-violet"></div>
            <div className="flex justify-between items-center mb-8">
              <h3 className="text-2xl font-bold">Polymarket</h3>
              <span className="px-3 py-1 bg-status-neutral/10 text-status-neutral rounded-full font-bold text-[10px]">COMING SOON</span>
            </div>
            <p className="text-on-surface-variant text-sm md:text-base leading-relaxed">Prediction market probability shifts and entity-led whale moves on Polygon.</p>
          </div>
          {/* Robinhood Chain */}
          <div className="relative overflow-hidden group border border-border-subtle rounded-2xl p-10 bg-surface-container-lowest/50 opacity-80">
            <div className="absolute top-0 left-0 w-1.5 h-full bg-robinhood-amber"></div>
            <div className="flex justify-between items-center mb-8">
              <h3 className="text-2xl font-bold">Robinhood</h3>
              <span className="px-3 py-1 bg-status-neutral/10 text-status-neutral rounded-full font-bold text-[10px]">COMING SOON</span>
            </div>
            <p className="text-on-surface-variant text-sm md:text-base leading-relaxed">Monitoring institutional settlement layers and retail flow bridges.</p>
          </div>
        </section>

        {/* Transparency / Proof */}
        <section className="mb-32 px-6 md:px-12 bento-grid">
          <div className="col-span-12 lg:col-span-8 bg-white/70 backdrop-blur-md rounded-2xl p-8 md:p-10 shadow-sm border border-border-subtle">
            <h3 className="text-2xl font-black mb-8">Live Execution Log (Sample)</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left font-mono border-collapse">
                <thead className="border-b border-border-subtle text-on-surface-variant">
                  <tr>
                    <th className="pb-6 text-[11px] font-bold uppercase tracking-wider">TIMESTAMP</th>
                    <th className="pb-6 text-[11px] font-bold uppercase tracking-wider">SIGNAL</th>
                    <th className="pb-6 text-[11px] font-bold uppercase tracking-wider">ENTITY</th>
                    <th className="pb-6 text-[11px] font-bold uppercase tracking-wider">STATUS</th>
                    <th className="pb-6 text-[11px] font-bold uppercase tracking-wider">PNL %</th>
                  </tr>
                </thead>
                <tbody className="text-sm">
                  <tr className="border-b border-border-subtle/50 hover:bg-solana-teal/5 transition-colors group">
                    <td className="py-5 font-medium">14:02:11</td>
                    <td className="py-5 text-solana-teal font-bold">SOL/ACCUM</td>
                    <td className="py-5 opacity-70">0x14...3e2</td>
                    <td className="py-5">EXECUTED</td>
                    <td className="py-5 text-status-success font-black text-base">+12.4%</td>
                  </tr>
                  <tr className="border-b border-border-subtle/50 hover:bg-solana-teal/5 transition-colors group">
                    <td className="py-5 font-medium">13:58:04</td>
                    <td className="py-5 text-solana-teal font-bold">SOL/SNIPE</td>
                    <td className="py-5 opacity-70">0x99...ff0</td>
                    <td className="py-5">EXECUTED</td>
                    <td className="py-5 text-status-success font-black text-base">+4.1%</td>
                  </tr>
                  <tr className="hover:bg-solana-teal/5 transition-colors group">
                    <td className="py-5 font-medium">13:45:30</td>
                    <td className="py-5 text-status-warning font-bold">SOL/ROTATE</td>
                    <td className="py-5 opacity-70">0x22...a11</td>
                    <td className="py-5 text-on-surface-variant italic">IGNORED (&lt;80)</td>
                    <td className="py-5 text-on-surface-variant">—</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div className="col-span-12 lg:col-span-4 bg-primary text-on-primary rounded-2xl flex flex-col justify-between shadow-lg p-12">
            <div>
              <h3 className="text-2xl font-bold mb-6">Non-Custodial by Design</h3>
              <p className="text-sm md:text-base text-on-primary/80 leading-relaxed">We never hold your funds. WAKE operates as a middleware between the chain and your local execution environment.</p>
            </div>
            <div className="mt-12 space-y-6">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-on-primary/10 flex items-center justify-center">
                  <span className="material-symbols-outlined text-solana-teal">security</span>
                </div>
                <span className="font-semibold text-sm md:text-base">End-to-End Encryption</span>
              </div>
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-on-primary/10 flex items-center justify-center">
                  <span className="material-symbols-outlined text-solana-teal">hub</span>
                </div>
                <span className="font-semibold text-sm md:text-base">Self-Hosted Execution Node</span>
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
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-6xl mx-auto items-stretch">
            {/* Free */}
            <div className="border border-border-subtle bg-surface-container-lowest rounded-2xl p-10 flex flex-col">
              <span className="text-[11px] font-bold text-on-surface-variant mb-6 text-center uppercase tracking-[0.2em]">Standard</span>
              <div className="text-4xl font-black mb-10 text-center">Free</div>
              <ul className="text-sm md:text-base text-on-surface-variant space-y-5 mb-12 flex-grow">
                <li className="flex gap-3"><span className="text-primary font-bold">/</span> 5m Delayed Signals</li>
                <li className="flex gap-3"><span className="text-primary font-bold">/</span> Basic Wallet Tracking</li>
                <li className="flex gap-3"><span className="text-primary font-bold">/</span> 1 Multi-chain Cluster</li>
              </ul>
              <button 
                onClick={enterWorkspace}
                className="w-full py-4 border border-border-subtle rounded-xl font-bold hover:bg-surface-container-low transition-colors"
              >
                Start Browsing
              </button>
            </div>
            {/* Pro */}
            <div className="border-2 border-primary bg-surface-container-highest rounded-2xl p-10 flex flex-col relative shadow-2xl scale-105 z-10">
              <div className="absolute -top-4 left-1/2 -translate-x-1/2 px-5 py-1.5 bg-primary text-on-primary rounded-full text-[10px] font-black tracking-widest whitespace-nowrap">MOST POPULAR</div>
              <span className="text-[11px] font-bold text-primary/60 mb-6 text-center uppercase tracking-[0.2em]">Operator</span>
              <div className="text-4xl font-black mb-10 text-center">29 USDC <span className="text-lg font-medium opacity-60">/mo</span></div>
              <ul className="text-sm md:text-base text-primary space-y-5 mb-12 flex-grow">
                <li className="flex gap-3 font-bold"><span className="text-status-success">✓</span> REAL-TIME Signal Feed</li>
                <li className="flex gap-3 font-bold"><span className="text-status-success">✓</span> Automated Execution</li>
                <li className="flex gap-3 font-bold"><span className="text-status-success">✓</span> Unlimited Clusters</li>
              </ul>
              <button 
                onClick={enterWorkspace}
                className="w-full py-4 bg-primary text-on-primary rounded-xl font-black shadow-lg shadow-primary/20 hover:opacity-90 transition-opacity"
              >
                Get Pro Access
              </button>
            </div>
            {/* Founding */}
            <div className="border border-border-subtle bg-surface-container-lowest rounded-2xl p-10 flex flex-col">
              <span className="text-[11px] font-bold text-on-surface-variant mb-6 text-center uppercase tracking-[0.2em]">Lifetime</span>
              <div className="text-4xl font-black mb-10 text-center">99 USDC</div>
              <ul className="text-sm md:text-base text-on-surface-variant space-y-5 mb-12 flex-grow">
                <li className="flex gap-3"><span className="text-primary font-bold">/</span> Lifetime Lock-in</li>
                <li className="flex gap-3"><span className="text-primary font-bold">/</span> Priority Beta Features</li>
                <li className="flex gap-3"><span className="text-primary font-bold">/</span> Discord "Founding" Role</li>
              </ul>
              <button 
                onClick={enterWorkspace}
                className="w-full py-4 border border-border-subtle rounded-xl font-bold hover:bg-surface-container-low transition-colors"
              >
                Secure Spot
              </button>
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
                <span className="text-lg font-bold text-primary">How do you handle wallet keys?</span>
                <span 
                  className="material-symbols-outlined transition-transform duration-300"
                  style={{ transform: openFaq === 1 ? 'rotate(180deg)' : 'rotate(0deg)' }}
                >
                  {openFaq === 1 ? 'remove' : 'add'}
                </span>
              </button>
              <div className={`${openFaq === 1 ? 'block' : 'hidden'} px-8 pb-8 text-on-surface-variant leading-relaxed text-sm md:text-base`}>
                WAKE is non-custodial. You can either use our cloud-encrypted vault (powered by Lit Protocol) or run a local execution agent that listens to our signal stream via secure WebSocket.
              </div>
            </div>
            
            {/* FAQ 2 */}
            <div className="border border-border-subtle rounded-2xl overflow-hidden bg-surface-container-lowest">
              <button 
                onClick={() => toggleFaq(2)}
                className="flex justify-between items-center w-full px-8 py-6 text-left group hover:bg-surface-container-low transition-colors"
              >
                <span className="text-lg font-bold text-primary">What is the "Intelligence Score"?</span>
                <span 
                  className="material-symbols-outlined transition-transform duration-300"
                  style={{ transform: openFaq === 2 ? 'rotate(180deg)' : 'rotate(0deg)' }}
                >
                  {openFaq === 2 ? 'remove' : 'add'}
                </span>
              </button>
              <div className={`${openFaq === 2 ? 'block' : 'hidden'} px-8 pb-8 text-on-surface-variant leading-relaxed text-sm md:text-base`}>
                It's a weighted probability (0-100) that a transaction is part of an organized alpha-capture event. It looks at wallet age, capital source (Exchange vs. Bridge), and historical "first-mover" success rates.
              </div>
            </div>
            
            {/* FAQ 3 */}
            <div className="border border-border-subtle rounded-2xl overflow-hidden bg-surface-container-lowest">
              <button 
                onClick={() => toggleFaq(3)}
                className="flex justify-between items-center w-full px-8 py-6 text-left group hover:bg-surface-container-low transition-colors"
              >
                <span className="text-lg font-bold text-primary">When does Robinhood Chain support launch?</span>
                <span 
                  className="material-symbols-outlined transition-transform duration-300"
                  style={{ transform: openFaq === 3 ? 'rotate(180deg)' : 'rotate(0deg)' }}
                >
                  {openFaq === 3 ? 'remove' : 'add'}
                </span>
              </button>
              <div className={`${openFaq === 3 ? 'block' : 'hidden'} px-8 pb-8 text-on-surface-variant leading-relaxed text-sm md:text-base`}>
                Robinhood Chain integration is currently in private Alpha with the founding members. Public Beta for this chain is scheduled for Q4.
              </div>
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="mb-32 px-6 md:px-12">
          <div className="bg-primary-container text-on-primary-container rounded-[2.5rem] p-12 md:p-24 text-center relative overflow-hidden shadow-2xl">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(20,241,149,0.1),transparent)] pointer-events-none"></div>
            <div className="relative z-10">
              <h2 className="text-4xl md:text-6xl leading-[1.1] font-black text-on-primary mb-8 tracking-tighter">Ready for a professional desk?</h2>
              <p className="text-lg md:text-xl text-on-primary/70 max-w-2xl mx-auto mb-14 text-balance">Stop tracking and start executing. Secure your early access spot and begin capturing cross-chain signals today.</p>
              <div className="flex flex-col sm:flex-row gap-5 justify-center">
                <button 
                  onClick={enterWorkspace}
                  className="bg-on-primary text-primary px-12 py-5 rounded-2xl font-bold text-lg hover:scale-[1.03] transition-transform shadow-xl"
                >
                  Join Early Access
                </button>
                <button className="border border-on-primary-container/30 text-on-primary px-12 py-5 rounded-2xl font-bold text-lg hover:bg-on-primary/5 transition-colors">
                  Read the Docs
                </button>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="bg-surface-container-lowest border-t border-border-subtle py-20 px-6 md:px-12">
        <div className="max-w-[1440px] mx-auto grid grid-cols-1 md:grid-cols-12 gap-12">
          <div className="md:col-span-5">
            <div className="flex items-center gap-3 mb-8">
              <img 
                alt="WAKE" 
                className="h-7 w-auto grayscale opacity-80" 
                src="https://lh3.googleusercontent.com/aida/AP1WRLtWod_shvYwZo04JI9qz9KbCkE4ccfvLt5YPoZfWK9_5IWgDMRxVww6XBAGkZRs0T-1jmcBXgmhsCcR8eu3dkshLlD6BnHpBiyrEunns1F0WH2lTlznG7mzTzzj4AeokEA0E_YMu73Zl7jCGS4uT0bRbBz2ViYg97kcTe_MBHntKuHo1vbl-A-yjjaHUil_JfO9AItouKrQCMCDBsCiM7mFfBKz_TwWyqrffxRbNdYPgyTdQ2oShfFx3O4" 
              />
              <span className="text-2xl font-black tracking-tighter opacity-80">WAKE</span>
            </div>
            <p className="text-sm md:text-base text-on-surface-variant max-w-sm leading-relaxed">Operational cross-chain intelligence for professional crypto operators.</p>
          </div>
          <div className="md:col-span-7 grid grid-cols-2 sm:grid-cols-3 gap-8">
            <div>
              <h5 className="text-[11px] font-bold text-on-surface-variant mb-6 uppercase tracking-wider opacity-60">Product</h5>
              <ul className="space-y-4 text-on-surface-variant font-medium text-sm">
                <li><a className="hover:text-primary transition-colors" href="#">Live Feed</a></li>
                <li><a className="hover:text-primary transition-colors" href="#">Chains</a></li>
                <li><a className="hover:text-primary transition-colors" href="#">Pricing</a></li>
              </ul>
            </div>
            <div>
              <h5 className="text-[11px] font-bold text-on-surface-variant mb-6 uppercase tracking-wider opacity-60">Resources</h5>
              <ul className="space-y-4 text-on-surface-variant font-medium text-sm">
                <li><a className="hover:text-primary transition-colors" href="#">API Docs</a></li>
                <li><a className="hover:text-primary transition-colors" href="#">Case Studies</a></li>
                <li><a className="hover:text-primary transition-colors" href="#">Support</a></li>
              </ul>
            </div>
            <div className="col-span-2 sm:col-span-1">
              <h5 className="text-[11px] font-bold text-on-surface-variant mb-6 uppercase tracking-wider opacity-60">Connect</h5>
              <div className="flex gap-4">
                <a className="w-10 h-10 rounded-full border border-border-subtle flex items-center justify-center hover:bg-surface-container transition-colors" href="#">
                  <span className="material-symbols-outlined text-lg">public</span>
                </a>
                <a className="w-10 h-10 rounded-full border border-border-subtle flex items-center justify-center hover:bg-surface-container transition-colors" href="#">
                  <span className="material-symbols-outlined text-lg">alternate_email</span>
                </a>
              </div>
            </div>
          </div>
        </div>
        <div className="max-w-[1440px] mx-auto mt-20 pt-10 border-t border-border-subtle flex flex-col sm:flex-row justify-between items-center gap-6 text-[11px] text-on-surface-variant font-mono opacity-60 tracking-wider">
          <span>© 2024 WAKE OPERATIONAL CENTER. ALL RIGHTS RESERVED.</span>
          <div className="flex gap-8">
            <a className="hover:text-primary" href="#">PRIVACY POLICY</a>
            <a className="hover:text-primary" href="#">TERMS OF SERVICE</a>
          </div>
        </div>
      </footer>

    </div>
  );
}
