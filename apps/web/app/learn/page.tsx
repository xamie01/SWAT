'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { SaaSNav } from '../../components/SaaSNav.js';

interface FaqItem {
  id: string;
  category: string;
  title: string;
  badge: string;
  badgeColor: string;
  symptoms: string[];
  rootCause: string;
  resolution: string[];
  actionLink?: { href: string; label: string };
}

const TROUBLESHOOTING_GUIDES: FaqItem[] = [
  // Funding & Vault Issues
  {
    id: 'vault-deposit-delay',
    category: 'funding',
    title: 'Deposit confirmed on explorer but not visible on Dashboard or Vault',
    badge: 'Funding & Vault',
    badgeColor: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    symptoms: [
      'Solscan / Polygonscan shows transaction status Success.',
      'Dashboard balance shows $0.00 or previous float balance.',
    ],
    rootCause:
      'Vault sweeps occur on automated 30-second block ingestion intervals. Token deposits other than native USDC/SOL/POL require contract verification.',
    resolution: [
      'Wait 30-60 seconds for the multi-chain vault indexer to sweep the block confirmation.',
      'Navigate to "Funding & Vault" (/vault) and tap the "Refresh Balances" button.',
      'Verify that you sent funds to your exact designated deposit address shown on /vault and NOT to an operator contract address.',
      'Ensure you deposited supported assets (USDC, SOL on Solana, USDC/POL on Polygon, USDC on Robinhood Chain/Base).',
    ],
    actionLink: { href: '/vault', label: 'Check Vault Balances' },
  },
  {
    id: 'vault-insufficient-float',
    category: 'funding',
    title: 'Error: "Insufficient cash float for trade allocation"',
    badge: 'Execution Guardrail',
    badgeColor: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    symptoms: [
      'Copy trade or LP position deployment rejected.',
      'System log displays "Allocation exceeds available float".',
    ],
    rootCause:
      'Available cash float is lower than your configured position size or deposit amount. Open positions and gas reserve buffers are non-fungible.',
    resolution: [
      'Check your "Available Cash Float" KPI on the Dashboard (/dashboard).',
      'Go to "Risk Settings" (/settings) and lower your "Max Position Size %" or reduce your custom ladder deposit amount.',
      'Deposit additional USDC float in your vault (/vault) to cover active trade allocations.',
    ],
    actionLink: { href: '/vault', label: 'Deposit Float' },
  },
  {
    id: 'vault-zero-gas-warning',
    category: 'funding',
    title: 'Withdrawal or trade rejected: "Native gas balance below threshold"',
    badge: 'Network Gas',
    badgeColor: 'bg-red-500/20 text-red-300 border-red-500/30',
    symptoms: [
      'Swap simulation fails with RPC gas estimation error.',
      'Cannot withdraw tokens back to personal custody.',
    ],
    rootCause:
      'All automated executions require a microscopic reserve buffer of native gas tokens (~0.02 SOL on Solana, ~1 POL on Polygon) to sign network transactions.',
    resolution: [
      'Ensure your vault maintains at least 0.02 SOL on Solana or 1 POL on Polygon.',
      'Deposit a small amount of native SOL/POL to your vault address to replenish gas reserves.',
      'Our engine never uses your trade capital for gas—it uses dedicated native buffers.',
    ],
    actionLink: { href: '/vault', label: 'View Gas Buffers' },
  },

  // Copy Trading Issues
  {
    id: 'copy-master-trade-skipped',
    category: 'copy',
    title: 'Master wallet bought a token, but my account did NOT mirror the buy',
    badge: 'Copy Trading',
    badgeColor: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    symptoms: [
      'Master address acquired a token on-chain.',
      'No corresponding buy order appears in your Open Positions.',
    ],
    rootCause:
      'This is governed by SWAT\'s 5-Layer Safety Protection Matrix. Common triggers include Forward-Only rules, Slippage gates, or Kill Switch.',
    resolution: [
      'Check Forward-Only Status: If the master already held that token before you subscribed, SWAT will NOT buy it. The engine only mirrors fresh positions opened after your subscription timestamp.',
      'Check Slippage Gate: If the token surged rapidly between the master\'s block and your mirror execution, and slippage exceeded your Max Slippage BPS in /settings, SWAT aborted the buy to protect you from buying the top.',
      'Check Emergency Kill Switch: Ensure your Kill Switch is toggled OFF in /settings.',
      'Check Position Size Limits: Ensure the trade size did not exceed your configured "Max Position Size %" or available cash float.',
    ],
    actionLink: { href: '/settings', label: 'Verify Risk Controls' },
  },
  {
    id: 'copy-partial-sell',
    category: 'copy',
    title: 'Master sold their token, but only a fraction of my position was sold',
    badge: 'Lot-Proportional Math',
    badgeColor: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
    symptoms: [
      'Master performed a sell transaction.',
      'You still hold remaining tokens of that asset.',
    ],
    rootCause:
      'SWAT enforces mathematical Lot-Proportional Exit rules. It mirrors the EXACT percentage of the master\'s holding that was trimmed.',
    resolution: [
      'Understand proportional trimming: If the master holds 1,000,000 tokens and sells 250,000 tokens (25% of their bag), SWAT calculates 25% of your mirrored lot and sells exactly that amount.',
      'When the master fully exits 100% of their bag, SWAT automatically closes 100% of your remaining lot.',
      'If you wish to manually dump the entire position at any time, go to "Positions" (/positions) and tap "Exit Market".',
    ],
    actionLink: { href: '/positions', label: 'Manage Open Positions' },
  },
  {
    id: 'copy-quota-exceeded',
    category: 'copy',
    title: 'Error: "QuotaExceededError: master wallet tracking limit reached"',
    badge: 'Tier Quotas',
    badgeColor: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    symptoms: [
      'Attempting to track or mirror a new master returns HTTP 403 / Quota Exceeded.',
    ],
    rootCause:
      'Your account tier limits the number of concurrent active master wallets you can mirror (Free: 1 master, Pro: 5 masters, Ultra: 15 masters).',
    resolution: [
      'Go to "Dashboard" (/dashboard) and remove/unsubscribe from an underperforming master wallet to free up a subscription slot.',
      'Or upgrade to Pro or Ultra tier on the "Billing" page (/billing) for expanded master tracking slots and priority mempool bundles.',
    ],
    actionLink: { href: '/billing', label: 'Upgrade Tier Limits' },
  },

  // LP Protocol Issues
  {
    id: 'lp-out-of-range',
    category: 'lp',
    title: 'My LP Position status changed to "Out of Range" or "Near Edge"',
    badge: 'Concentrated Liquidity',
    badgeColor: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
    symptoms: [
      'Position badge displays amber "Near Edge" or red "Out of Range".',
      'Dynamic fee yield drops to 0% while out of range.',
    ],
    rootCause:
      'The token\'s market price moved outside your configured lower or upper price bounds. In CLMM/DLMM, liquidity only earns fees while trading inside the bin range.',
    resolution: [
      'If "Auto-Rebalance" is ENABLED: The WAKE Autonomous Rebalance Engine will evaluate the economic trigger. It automatically recenters your bins once the projected fee yield exceeds the impermanent loss and gas costs.',
      'If "Auto-Rebalance" is OFF: Go to "My Positions" (/lp/positions) and tap "Rebalance Now" to queue an instant recentering job around current price.',
      'If you believe the price has decoupled permanently, tap "Close" to harvest accumulated fees and redeem liquidity back to float.',
    ],
    actionLink: { href: '/lp/positions', label: 'View LP Positions' },
  },
  {
    id: 'lp-auto-rebalance-delay',
    category: 'lp',
    title: 'Why hasn\'t Auto-Rebalance triggered yet even though price moved?',
    badge: 'Economic Guardrail',
    badgeColor: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
    symptoms: [
      'Price moved near boundary, but no rebalance transaction occurred immediately.',
    ],
    rootCause:
      'WAKE strictly prevents "Fee Erosion Churn". Rebalancing has real friction: swap fees, price impact, and network gas.',
    resolution: [
      'WAKE uses the mathematical theorem: Fee Uplift > Impermanent Loss + Gas/Swap Friction.',
      'If recentering would burn $15 in swap fees to earn only $4 in extra daily yield, WAKE purposefully delays rebalancing until the mathematical advantage is positive.',
      'This algorithmic patience protects your capital from being eaten alive by frequent micro-rebalances.',
    ],
    actionLink: { href: '/lp/positions', label: 'Inspect Position Monitor' },
  },
  {
    id: 'lp-empty-discover',
    category: 'lp',
    title: 'Discover Feed is empty or shows fewer pools than expected',
    badge: 'Rug Shield Filter',
    badgeColor: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
    symptoms: [
      'Navigating to /lp/discover displays 0 pools or limited options.',
    ],
    rootCause:
      'Either an active chain filter has no matching pools, or the pools failed WAKE\'s Rug Shield pre-flight safety audit.',
    resolution: [
      'Tap the "All" chain pill in the filter bar at the top of /lp/discover.',
      'Toggle OFF "Hot New Launches (< 48h)" to see all historical high-liquidity pools.',
      'Remember: WAKE Rug Shield automatically rejects and hides pools with active mint authority, unrevoked freeze authority, or top-10 holder concentration > 50%.',
    ],
    actionLink: { href: '/lp/discover', label: 'Go to Pool Scanner' },
  },

  // Platform & Role Access
  {
    id: 'access-denied-admin',
    category: 'system',
    title: 'Redirected to homepage with "?denied=admin" error',
    badge: 'Role Permission',
    badgeColor: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
    symptoms: [
      'Clicking a link redirects to /?denied=admin.',
    ],
    rootCause:
      'You navigated to an internal operator route (/workspace, /wallets, /signals) designed exclusively for backend cluster operators.',
    resolution: [
      'All retail, Pro, and Ultra features live under /dashboard, /positions, /lp/discover, /lp/copy, /lp/builder, /lp/positions, /vault, /settings, and /billing.',
      'You do NOT need the operator console: full automated trading, LP ladders, and wallet mirroring operate non-custodially from your Dashboard.',
      'If you need operator access for cluster diagnostics, log in with an administrator role account.',
    ],
    actionLink: { href: '/dashboard', label: 'Return to Dashboard' },
  },
];

export default function LearnPage() {
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [expandedFaq, setExpandedFaq] = useState<string | null>(null);

  const categories = [
    { id: 'all', label: 'All Topics', icon: 'apps' },
    { id: 'quickstart', label: 'Quick Start', icon: 'rocket_launch' },
    { id: 'copy', label: 'Copy Trading', icon: 'content_copy' },
    { id: 'lp', label: 'LP Protocol', icon: 'water_drop' },
    { id: 'funding', label: 'Vault & Float', icon: 'account_balance_wallet' },
    { id: 'risk', label: 'Risk Controls', icon: 'shield' },
    { id: 'troubleshooting', label: 'Troubleshooting (FAQ)', icon: 'build' },
  ];

  const filteredFaqs = TROUBLESHOOTING_GUIDES.filter((item) => {
    const matchesCategory =
      activeCategory === 'all' ||
      activeCategory === 'troubleshooting' ||
      item.category === activeCategory;
    const query = searchQuery.toLowerCase().trim();
    const matchesSearch =
      !query ||
      item.title.toLowerCase().includes(query) ||
      item.rootCause.toLowerCase().includes(query) ||
      item.symptoms.some((s) => s.toLowerCase().includes(query)) ||
      item.resolution.some((r) => r.toLowerCase().includes(query));
    return matchesCategory && matchesSearch;
  });

  return (
    <div className="bg-background text-on-background min-h-screen antialiased font-sans">
      <SaaSNav />

      <main className="max-w-[1440px] mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-8">
        {/* Hero Header */}
        <div className="bg-surface-container-low border border-border-subtle rounded-2xl p-6 sm:p-8 relative overflow-hidden shadow-sm">
          <div className="max-w-3xl space-y-3 relative z-10">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/20 border border-primary/30 text-primary text-xs font-mono font-bold uppercase tracking-wider">
              <span className="material-symbols-outlined text-[16px]">school</span>
              <span>WAKE Academy & Master Documentation</span>
            </div>
            <h1 className="text-2xl sm:text-4xl font-extrabold text-primary tracking-tight font-headline-lg">
              Everything You Can Achieve on SWAT & How to Navigate Any Challenge
            </h1>
            <p className="text-xs sm:text-sm text-on-surface-variant leading-relaxed">
              Step-by-step master guides to cross-chain copy trading, concentrated liquidity ladders (CLMM/DLMM), mathematical lot-proportional exits, zero-custody vaults, and an interactive troubleshooting matrix.
            </p>

            {/* Interactive Search Bar */}
            <div className="pt-2">
              <div className="relative max-w-xl">
                <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-on-surface-variant text-[20px]">
                  search
                </span>
                <input
                  type="text"
                  placeholder="Search any issue, error code, or feature (e.g. 'rebalance', 'quota', 'slippage', 'forward-only')..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-11 pr-4 py-3 bg-surface-container-lowest border border-border-subtle rounded-xl text-xs sm:text-sm text-on-surface focus:outline-none focus:border-primary shadow-xs"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs text-on-surface-variant hover:text-on-surface"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Category Pills (Touch Scrollable) */}
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar scroll-smooth py-1 border-b border-border-subtle pb-3">
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveCategory(c.id)}
              className={`px-3.5 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-all shrink-0 whitespace-nowrap active:scale-95 ${
                activeCategory === c.id
                  ? 'bg-primary text-white shadow-xs'
                  : 'bg-surface-container border border-border-subtle text-on-surface-variant hover:text-on-surface'
              }`}
            >
              <span className="material-symbols-outlined text-[16px]">{c.icon}</span>
              <span>{c.label}</span>
            </button>
          ))}
        </div>

        {/* SECTION 1: QUICK START */}
        {(activeCategory === 'all' || activeCategory === 'quickstart') && (
          <section className="space-y-4">
            <div className="flex items-center gap-2.5">
              <span className="w-8 h-8 rounded-lg bg-primary/20 text-primary flex items-center justify-center font-bold text-sm">
                1
              </span>
              <div>
                <h2 className="text-lg font-bold text-primary font-headline-md">
                  Platform Architecture & The 3-Step Quick Start
                </h2>
                <p className="text-xs text-on-surface-variant">
                  Get up and running in under 2 minutes with non-custodial automation.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5 space-y-3">
                <div className="w-10 h-10 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20 flex items-center justify-center">
                  <span className="material-symbols-outlined text-[20px]">account_balance_wallet</span>
                </div>
                <h3 className="text-sm font-bold text-primary">Step 1: Deposit Float</h3>
                <p className="text-xs text-on-surface-variant leading-relaxed">
                  Navigate to <strong>Funding & Vault</strong> (/vault). Send USDC and a tiny buffer of native gas (0.02 SOL or 1 POL) to your dedicated multi-chain vault address. Your keys remain non-custodial.
                </p>
                <Link href="/vault" className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline">
                  Go to Vault →
                </Link>
              </div>

              <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5 space-y-3">
                <div className="w-10 h-10 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center justify-center">
                  <span className="material-symbols-outlined text-[20px]">content_copy</span>
                </div>
                <h3 className="text-sm font-bold text-primary">Step 2: Choose Strategy</h3>
                <p className="text-xs text-on-surface-variant leading-relaxed">
                  Pick your path: Subscribe to a top verified trader on <strong>Copy Masters</strong> (/lp/copy), or deploy concentrated yield ladders on <strong>Discover Pools</strong> (/lp/discover).
                </p>
                <Link href="/lp/copy" className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline">
                  Browse Masters →
                </Link>
              </div>

              <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5 space-y-3">
                <div className="w-10 h-10 rounded-lg bg-purple-500/10 text-purple-400 border border-purple-500/20 flex items-center justify-center">
                  <span className="material-symbols-outlined text-[20px]">bolt</span>
                </div>
                <h3 className="text-sm font-bold text-primary">Step 3: Automated Execution</h3>
                <p className="text-xs text-on-surface-variant leading-relaxed">
                  Once armed, SWAT executes with millisecond latency via private RPC relays (Jito bundles on Solana, Flashbots on EVM), enforcing lot-proportional exits and autonomous rebalancing.
                </p>
                <Link href="/settings" className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline">
                  Configure Risk Controls →
                </Link>
              </div>
            </div>
          </section>
        )}

        {/* SECTION 2: COPY TRADING */}
        {(activeCategory === 'all' || activeCategory === 'copy') && (
          <section className="space-y-4">
            <div className="flex items-center gap-2.5">
              <span className="w-8 h-8 rounded-lg bg-primary/20 text-primary flex items-center justify-center font-bold text-sm">
                2
              </span>
              <div>
                <h2 className="text-lg font-bold text-primary font-headline-md">
                  Cross-Chain Copy Trading: Mathematical Guarantees
                </h2>
                <p className="text-xs text-on-surface-variant">
                  How SWAT protects your capital when mirroring master whale wallets.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5 space-y-3">
                <div className="flex items-center gap-2 text-primary font-bold text-sm">
                  <span className="material-symbols-outlined text-[18px]">verified</span>
                  <span>The Forward-Only Execution Guarantee</span>
                </div>
                <p className="text-xs text-on-surface-variant leading-relaxed">
                  Traditional copy-bots blindly purchase everything a master wallet holds the moment you subscribe—frequently dumping your money into tokens bought weeks ago that are already up 500% and about to crash.
                </p>
                <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-300 space-y-1">
                  <span className="font-bold">How SWAT Protects You:</span>
                  <p className="text-[11px] text-amber-200/80 leading-relaxed">
                    SWAT timestamps your subscription. Any token the master already owns is strictly skipped. Your capital only enters brand new positions opened AFTER your subscription was activated.
                  </p>
                </div>
              </div>

              <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5 space-y-3">
                <div className="flex items-center gap-2 text-primary font-bold text-sm">
                  <span className="material-symbols-outlined text-[18px]">pie_chart</span>
                  <span>Lot-Proportional Exits</span>
                </div>
                <p className="text-xs text-on-surface-variant leading-relaxed">
                  When a master wallet scales out of a position, SWAT matches their exact proportion against your specific lot rather than an arbitrary dollar threshold.
                </p>
                <div className="p-3 bg-surface-container-low border border-border-subtle rounded-lg text-xs font-mono space-y-1 text-on-surface">
                  <p className="text-[11px] text-on-surface-variant">Example Math:</p>
                  <p>Master holds 100,000 $XYZ → Sells 20,000 (20% exit)</p>
                  <p className="text-emerald-400">→ SWAT automatically sells exactly 20% of your mirrored lot.</p>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* SECTION 3: LP PROTOCOL & CONCENTRATED LIQUIDITY */}
        {(activeCategory === 'all' || activeCategory === 'lp') && (
          <section className="space-y-4">
            <div className="flex items-center gap-2.5">
              <span className="w-8 h-8 rounded-lg bg-primary/20 text-primary flex items-center justify-center font-bold text-sm">
                3
              </span>
              <div>
                <h2 className="text-lg font-bold text-primary font-headline-md">
                  WAKE Liquidity Protocol: Concentrated Yield & Autonomous Rebalancing
                </h2>
                <p className="text-xs text-on-surface-variant">
                  Deploy active bins on Meteora DLMM, Raydium CLMM, and Uniswap v3 with Rug Shield protection.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5 space-y-2.5">
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-emerald-400">Security Gate</span>
                <h3 className="text-sm font-bold text-primary">Rug Shield Pre-Flight</h3>
                <p className="text-xs text-on-surface-variant leading-relaxed">
                  Before any pool appears on the Discover Feed, WAKE verifies:
                </p>
                <ul className="text-[11px] text-on-surface-variant space-y-1 list-disc pl-4">
                  <li>Mint Authority Revoked (deployer cannot print tokens)</li>
                  <li>Freeze Authority Disabled (accounts cannot be blacklisted)</li>
                  <li>Top-10 Holders own &lt; 50% of circulating supply</li>
                  <li>Liquidity locked or burned (&gt; 90%)</li>
                </ul>
              </div>

              <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5 space-y-2.5">
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-primary">Ladder Builder</span>
                <h3 className="text-sm font-bold text-primary">Distribution Curves</h3>
                <p className="text-xs text-on-surface-variant leading-relaxed">
                  Shape liquidity density based on market regime:
                </p>
                <ul className="text-[11px] text-on-surface-variant space-y-1 list-disc pl-4">
                  <li><strong>Spot:</strong> Uniform liquidity across the whole price range.</li>
                  <li><strong>Volatility Curve:</strong> Gaussian bell-curve centered on spot price for 5x fee capture.</li>
                  <li><strong>Bid-Ask:</strong> Outlying edge-density for spread arbitrage.</li>
                </ul>
              </div>

              <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5 space-y-2.5">
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-400">Autonomous Rebalancer</span>
                <h3 className="text-sm font-bold text-primary">Economic Rebalancing</h3>
                <p className="text-xs text-on-surface-variant leading-relaxed">
                  Unlike dumb bots that rebalance on every tick and incinerate capital in swap fees, WAKE computes:
                </p>
                <div className="p-2 rounded bg-surface-container font-mono text-[10px] text-emerald-400">
                  Fee Uplift &gt; Impermanent Loss + Gas Cost
                </div>
                <p className="text-[11px] text-on-surface-variant leading-relaxed">
                  It only triggers when recentering yields net positive equity.
                </p>
              </div>
            </div>
          </section>
        )}

        {/* SECTION 4: RISK MANAGEMENT & KILL SWITCH */}
        {(activeCategory === 'all' || activeCategory === 'risk') && (
          <section className="space-y-4">
            <div className="flex items-center gap-2.5">
              <span className="w-8 h-8 rounded-lg bg-primary/20 text-primary flex items-center justify-center font-bold text-sm">
                4
              </span>
              <div>
                <h2 className="text-lg font-bold text-primary font-headline-md">
                  Risk Management & The Emergency Kill Switch
                </h2>
                <p className="text-xs text-on-surface-variant">
                  Absolute capital control with deterministic circuit breakers.
                </p>
              </div>
            </div>

            <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5 sm:p-6 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-status-error text-[20px]">power_settings_new</span>
                    <h3 className="text-sm font-bold text-primary">Emergency Kill Switch</h3>
                  </div>
                  <p className="text-xs text-on-surface-variant leading-relaxed">
                    Located in <strong>Risk Settings</strong> (/settings). Toggling the Kill Switch ON instantly halts all outgoing transaction submissions, cancels pending queue jobs, and stops all automated mirrors across Solana and EVM.
                  </p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-primary text-[20px]">tune</span>
                    <h3 className="text-sm font-bold text-primary">Slippage & Allocation Bounds</h3>
                  </div>
                  <p className="text-xs text-on-surface-variant leading-relaxed">
                    Set your <strong>Max Slippage BPS</strong> (e.g. 50 BPS = 0.5%). If price moves more than this threshold between signal detection and execution, SWAT rejects the transaction rather than suffering adverse price impact.
                  </p>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* SECTION 5: INTERACTIVE PROBLEM RESOLUTION MATRIX (FAQ) */}
        {(activeCategory === 'all' || activeCategory === 'troubleshooting') && (
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="w-8 h-8 rounded-lg bg-primary/20 text-primary flex items-center justify-center font-bold text-sm">
                  5
                </span>
                <div>
                  <h2 className="text-lg font-bold text-primary font-headline-md">
                    Interactive Troubleshooting & Issue Resolution Matrix
                  </h2>
                  <p className="text-xs text-on-surface-variant">
                    Click any issue below to inspect root causes, diagnostic checks, and step-by-step solutions.
                  </p>
                </div>
              </div>
              <span className="text-xs font-mono text-on-surface-variant hidden sm:inline">
                {filteredFaqs.length} Guide(s) Found
              </span>
            </div>

            <div className="space-y-3">
              {filteredFaqs.map((faq) => {
                const isOpen = expandedFaq === faq.id;
                return (
                  <div
                    key={faq.id}
                    className="bg-surface-container-lowest border border-border-subtle rounded-xl overflow-hidden transition-all shadow-xs"
                  >
                    <button
                      onClick={() => setExpandedFaq(isOpen ? null : faq.id)}
                      className="w-full p-4 sm:p-5 text-left flex items-start sm:items-center justify-between gap-3 hover:bg-surface-container-low transition-colors"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase border ${faq.badgeColor}`}>
                            {faq.badge}
                          </span>
                          <span className="text-xs sm:text-sm font-bold text-on-surface">
                            {faq.title}
                          </span>
                        </div>
                      </div>
                      <span className={`material-symbols-outlined text-[20px] text-on-surface-variant shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}>
                        expand_more
                      </span>
                    </button>

                    {isOpen && (
                      <div className="p-4 sm:p-5 pt-0 border-t border-border-subtle space-y-4 bg-surface-container-lowest">
                        {/* Symptoms */}
                        <div className="space-y-1 pt-3">
                          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-on-surface-variant">
                            Observed Symptoms:
                          </span>
                          <ul className="text-xs text-on-surface-variant list-disc pl-4 space-y-0.5">
                            {faq.symptoms.map((sym, idx) => (
                              <li key={idx}>{sym}</li>
                            ))}
                          </ul>
                        </div>

                        {/* Root Cause */}
                        <div className="p-3 rounded-lg bg-surface-container-low border border-border-subtle text-xs space-y-1">
                          <span className="text-[10px] font-mono font-bold uppercase text-primary block">
                            Root Cause:
                          </span>
                          <p className="text-on-surface leading-relaxed">{faq.rootCause}</p>
                        </div>

                        {/* Resolution Steps */}
                        <div className="space-y-1.5">
                          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-emerald-400">
                            Step-by-Step Resolution:
                          </span>
                          <ol className="text-xs text-on-surface list-decimal pl-4 space-y-1.5 leading-relaxed">
                            {faq.resolution.map((step, idx) => (
                              <li key={idx}>{step}</li>
                            ))}
                          </ol>
                        </div>

                        {/* Action Link */}
                        {faq.actionLink && (
                          <div className="pt-2">
                            <Link
                              href={faq.actionLink.href}
                              className="px-4 py-2 rounded-lg bg-primary text-white text-xs font-semibold hover:opacity-90 transition-opacity inline-flex items-center gap-1.5"
                            >
                              <span>{faq.actionLink.label}</span>
                              <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
                            </Link>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* SECTION 6: TIERS & QUOTA COMPARISON */}
        {(activeCategory === 'all' || activeCategory === 'quickstart') && (
          <section className="space-y-4">
            <div className="flex items-center gap-2.5">
              <span className="w-8 h-8 rounded-lg bg-primary/20 text-primary flex items-center justify-center font-bold text-sm">
                6
              </span>
              <div>
                <h2 className="text-lg font-bold text-primary font-headline-md">
                  Account Tiers, Capacities & Quotas
                </h2>
                <p className="text-xs text-on-surface-variant">
                  Understanding what your tier unlocks.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-on-surface uppercase font-mono">Free Tier</h3>
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-surface-container text-on-surface-variant">
                    Starter
                  </span>
                </div>
                <div className="text-xl font-extrabold text-primary font-mono">$0</div>
                <ul className="text-xs text-on-surface-variant space-y-1.5 font-mono pt-2 border-t border-border-subtle">
                  <li>• 1 Active Master Wallet</li>
                  <li>• 5 Token Backfills / Day</li>
                  <li>• Standard Mempool Relays</li>
                  <li>• Manual LP Ladder Builder</li>
                </ul>
              </div>

              <div className="bg-surface-container-lowest border border-primary/40 rounded-xl p-5 space-y-3 relative shadow-xs">
                <span className="absolute -top-2.5 right-4 px-2 py-0.5 rounded bg-primary text-white text-[9px] font-bold uppercase tracking-wider">
                  Popular
                </span>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-primary uppercase font-mono">Pro Trader</h3>
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-primary/20 text-primary">
                    PRO
                  </span>
                </div>
                <div className="text-xl font-extrabold text-primary font-mono">$49 / mo</div>
                <ul className="text-xs text-on-surface-variant space-y-1.5 font-mono pt-2 border-t border-border-subtle">
                  <li>• 5 Active Master Wallets</li>
                  <li>• 50 Token Backfills / Day</li>
                  <li>• Priority Jito & Flashbots Bundles</li>
                  <li>• Autonomous LP Rebalancing</li>
                </ul>
              </div>

              <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-purple-400 uppercase font-mono">Ultra Whale</h3>
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-purple-500/20 text-purple-400">
                    ULTRA
                  </span>
                </div>
                <div className="text-xl font-extrabold text-primary font-mono">$199 / mo</div>
                <ul className="text-xs text-on-surface-variant space-y-1.5 font-mono pt-2 border-t border-border-subtle">
                  <li>• 15 Active Master Wallets</li>
                  <li>• Unlimited Token Backfills</li>
                  <li>• Sub-millisecond Execution Slices</li>
                  <li>• Dedicated Whale Indexer Streams</li>
                  <li>• Pro Concierge Support</li>
                </ul>
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
