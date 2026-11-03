'use client';

import React, { useState, useMemo } from 'react';
import Link from 'next/link';
import { SaaSNav } from '../../components/SaaSNav.js';

interface FaqItem {
  id: string;
  category: 'funding' | 'copy' | 'lp' | 'polymarket' | 'security' | 'system';
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
      'Solscan or Polygonscan shows transaction status Success.',
      'Dashboard balance shows $0.00 or previous float balance.',
    ],
    rootCause:
      'Multi-chain vault indexers sweep on 30-second block intervals. Non-native token deposits require token program account verification before float balances update.',
    resolution: [
      'Wait 30-60 seconds for the multi-chain vault indexer to sweep the block confirmation.',
      'Navigate to Funding & Vault (/vault) and tap the "Refresh Balances" button.',
      'Verify that you transferred funds to your designated personal deposit address shown on /vault and NOT to an operator contract address.',
      'Ensure you deposited supported assets (USDC, SOL on Solana; USDC, POL on Polygon; USDC on Robinhood Chain / Base).',
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
      'Available cash float is lower than your configured position size or deposit amount. Active positions and gas reserve buffers are non-fungible.',
    resolution: [
      'Check your "Available Cash Float" KPI on the Dashboard (/dashboard).',
      'Go to Risk Settings (/settings) and lower your "Max Position Size %" or reduce your custom ladder deposit amount.',
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
      'This is governed by WAKE\'s 5-Layer Safety Protection Matrix. Common triggers include Forward-Only timestamp rules, Slippage gates, or Kill Switch.',
    resolution: [
      'Check Forward-Only Status: If the master already held that token before you subscribed, WAKE will NOT buy it. The engine only mirrors fresh positions opened after your subscription timestamp.',
      'Check Slippage Gate: If the token surged rapidly between the master\'s block and your mirror execution, and slippage exceeded your Max Slippage BPS in /settings, WAKE aborted the buy to protect you from buying the top.',
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
      'WAKE enforces mathematical Lot-Proportional Exit rules. It mirrors the EXACT percentage of the master\'s holding that was trimmed.',
    resolution: [
      'Understand proportional trimming: If the master holds 1,000,000 tokens and sells 250,000 tokens (25% of their bag), WAKE calculates 25% of your mirrored lot and sells exactly that amount.',
      'When the master fully exits 100% of their bag, WAKE automatically closes 100% of your remaining lot.',
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
      'Your account tier limits the number of concurrent active master wallets you can mirror (Free: 3 masters, Operator: 25 masters, Ultra / Lifetime: Unlimited masters).',
    resolution: [
      'Go to "Dashboard" (/dashboard) and remove/unsubscribe from an underperforming master wallet to free up a subscription slot.',
      'Or upgrade to Operator (35 USDC/mo), Ultra (150 USDC/mo), or Lifetime (1,999 USDC) on the "Billing" page (/billing) for expanded master tracking slots and sub-second mempool priority.',
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

  // Polymarket Prediction Market Issues
  {
    id: 'polymarket-fak-partial',
    category: 'polymarket',
    title: 'Polymarket order only partially filled or cancelled remainder',
    badge: 'FAK Order Type',
    badgeColor: 'bg-violet-500/20 text-violet-300 border-violet-500/30',
    symptoms: [
      'Copy trade executed on Polymarket condition, but filled size is less than max allocation.',
      'Order log notes "Fill-and-Kill (FAK) remainder cancelled".',
    ],
    rootCause:
      'WAKE uses OrderType.FAK (Fill-And-Kill / Immediate-Or-Cancel) for copy trades. It fills available book liquidity up to your mirror limit price and cancels remaining unfillable size to prevent stale resting limit orders.',
    resolution: [
      'This is an intentional risk safeguard. It protects you from having a resting order filled later at an adverse price after market odds have moved.',
      'If you want higher fill rates, increase your "Mirror Price Tolerance" in /settings from 150 bps to 250 bps.',
    ],
    actionLink: { href: '/settings', label: 'Adjust Polymarket Settings' },
  },

  // Security & Role Issues
  {
    id: 'withdrawal-cooling-period',
    category: 'security',
    title: 'Cannot withdraw immediately: "Withdrawal address in 24h cooling off period"',
    badge: 'Anti-Theft Protocol',
    badgeColor: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
    symptoms: [
      'Submitting a withdrawal request returns a cooling-off timer warning.',
    ],
    rootCause:
      'When you add or update a destination withdrawal wallet address, WAKE locks outbound withdrawals to that new address for exactly 24 hours as an anti-theft safeguard.',
    resolution: [
      'This safeguard prevents compromised accounts from having their vault instantly drained to an attacker address.',
      'Wait for the 24-hour cooling-off window to elapse (timer displayed in /vault).',
      'Confirm the change via the email OTP sent to your registered account.',
    ],
    actionLink: { href: '/vault', label: 'View Cooling Status' },
  },
  {
    id: 'access-denied-admin',
    category: 'system',
    title: 'Redirected to homepage with "?denied=admin" error',
    badge: 'Role Permission',
    badgeColor: 'bg-zinc-500/20 text-zinc-300 border-zinc-500/30',
    symptoms: [
      'Clicking an internal link redirects to /?denied=admin.',
    ],
    rootCause:
      'You navigated to an internal operator route (/workspace, /wallets, /signals) reserved for backend cluster operators.',
    resolution: [
      'All retail, Operator, Ultra, and Lifetime features live under /dashboard, /positions, /lp/discover, /lp/copy, /lp/builder, /lp/positions, /vault, /settings, and /billing.',
      'You do NOT need the operator console: full automated trading, LP ladders, and wallet mirroring operate non-custodially from your Dashboard.',
      'If you need operator access for cluster diagnostics, log in with an administrator role account.',
    ],
    actionLink: { href: '/dashboard', label: 'Return to Dashboard' },
  },
];

interface DocSection {
  id: string;
  chapter: string;
  title: string;
  icon: string;
  badge?: string;
}

const DOC_SECTIONS: DocSection[] = [
  // 1. Getting Started
  { id: 'overview', chapter: '1. Getting Started', title: 'Protocol Overview & Architecture', icon: 'hub' },
  { id: 'wallet-connection', chapter: '1. Getting Started', title: 'Connecting Your Wallet & Identity', icon: 'account_balance_wallet', badge: 'Essential' },
  { id: 'vault-funding', chapter: '1. Getting Started', title: 'Non-Custodial Vaults & Funding', icon: 'savings' },

  // 2. Copy Trading Engine
  { id: 'copy-discovery', chapter: '2. Copy Trading Engine', title: 'Master Discovery & Whale Scoring', icon: 'radar' },
  { id: 'copy-subscribing', chapter: '2. Copy Trading Engine', title: 'Subscribing & Allocation Sizing', icon: 'tune' },
  { id: 'copy-5layer', chapter: '2. Copy Trading Engine', title: 'The 5-Layer Capital Preservation Matrix', icon: 'shield', badge: 'Safety' },
  { id: 'copy-lot-proportional', chapter: '2. Copy Trading Engine', title: 'Mathematical Lot-Proportional Exits', icon: 'calculate' },

  // 3. Polymarket Prediction Markets
  { id: 'polymarket-clob', chapter: '3. Polymarket Predictions', title: 'Binary CTF Tokens & CLOB Mechanics', icon: 'candlestick_chart' },
  { id: 'polymarket-orders', chapter: '3. Polymarket Predictions', title: 'FAK Orders & Mirror Price Bounding', icon: 'lock_clock' },
  { id: 'polymarket-relayer', chapter: '3. Polymarket Predictions', title: 'Gasless Relayer & Builder Fees', icon: 'local_gas_station' },

  // 4. Concentrated Liquidity (LP) Protocol
  { id: 'lp-fundamentals', chapter: '4. Concentrated Liquidity (LP)', title: 'CLMM & DLMM Fundamentals', icon: 'water_drop' },
  { id: 'lp-rug-shield', chapter: '4. Concentrated Liquidity (LP)', title: 'Pre-Flight Rug Shield Audits', icon: 'verified_user' },
  { id: 'lp-builder-guide', chapter: '4. Concentrated Liquidity (LP)', title: 'Master Walkthrough: Building an LP Position', icon: 'architecture', badge: 'Core Guide' },
  { id: 'lp-rebalancer', chapter: '4. Concentrated Liquidity (LP)', title: 'Autonomous Rebalancing & Range States', icon: 'autorenew' },
  { id: 'lp-harvest-close', chapter: '4. Concentrated Liquidity (LP)', title: 'Harvesting Yield & Closing Positions', icon: 'payments' },

  // 5. Security & Risk Architecture
  { id: 'security-zero-custody', chapter: '5. Security & Risk', title: 'Zero-Custody Cryptographic Invariants', icon: 'vpn_key' },
  { id: 'security-antitheft', chapter: '5. Security & Risk', title: 'Anti-Theft Protocol & Email OTP', icon: 'security' },
  { id: 'security-mev', chapter: '5. Security & Risk', title: 'Private MEV Relays (Jito & Flashbots)', icon: 'bolt' },

  // 6. Reference & Troubleshooting
  { id: 'troubleshooting', chapter: '6. Reference', title: 'Interactive Troubleshooting Matrix (FAQ)', icon: 'live_help' },
  { id: 'tiers-quotas', chapter: '6. Reference', title: 'Account Tiers, Quotas & API Specs', icon: 'workspace_premium' },
];

export default function LearnPage() {
  const [activeSectionId, setActiveSectionId] = useState<string>('overview');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [expandedFaq, setExpandedFaq] = useState<string | null>(null);
  const [faqCategoryFilter, setFaqCategoryFilter] = useState<string>('all');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Filter sections when searching
  const filteredSections = useMemo(() => {
    if (!searchQuery.trim()) return DOC_SECTIONS;
    const q = searchQuery.toLowerCase();
    return DOC_SECTIONS.filter(
      (s) => s.title.toLowerCase().includes(q) || s.chapter.toLowerCase().includes(q)
    );
  }, [searchQuery]);

  // Group sections by chapter for sidebar
  const groupedSections = useMemo(() => {
    const map = new Map<string, DocSection[]>();
    filteredSections.forEach((sec) => {
      const list = map.get(sec.chapter) ?? [];
      list.push(sec);
      map.set(sec.chapter, list);
    });
    return map;
  }, [filteredSections]);

  const activeSection = useMemo(() => {
    return DOC_SECTIONS.find((s) => s.id === activeSectionId) ?? DOC_SECTIONS[0];
  }, [activeSectionId]);

  // FAQ filtering
  const filteredFaqs = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return TROUBLESHOOTING_GUIDES.filter((item) => {
      const matchesCategory = faqCategoryFilter === 'all' || item.category === faqCategoryFilter;
      const matchesSearch =
        !q ||
        item.title.toLowerCase().includes(q) ||
        item.rootCause.toLowerCase().includes(q) ||
        item.symptoms.some((s) => s.toLowerCase().includes(q)) ||
        item.resolution.some((r) => r.toLowerCase().includes(q));
      return matchesCategory && matchesSearch;
    });
  }, [searchQuery, faqCategoryFilter]);

  return (
    <div className="bg-background text-on-background min-h-screen antialiased font-sans flex flex-col">
      <SaaSNav />

      {/* Top Docs Sub-Header (Polymarket Docs Style) */}
      <div className="bg-surface-container-low border-b border-border-subtle sticky top-0 z-30 px-4 sm:px-8 py-3">
        <div className="max-w-[1600px] mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="lg:hidden p-2 rounded-lg bg-surface border border-border-subtle text-on-surface flex items-center justify-center"
              aria-label="Toggle Documentation Navigation"
            >
              <span className="material-symbols-outlined text-[20px]">
                {mobileMenuOpen ? 'close' : 'menu'}
              </span>
            </button>
            <div className="flex items-center gap-2">
              <span className="w-7 h-7 rounded-lg bg-primary text-white flex items-center justify-center font-bold text-xs">
                W
              </span>
              <span className="text-xs sm:text-sm font-bold text-primary font-mono tracking-tight">
                WAKE / PROTOCOL DOCS
              </span>
            </div>
            <span className="hidden sm:inline-block text-border-subtle">|</span>
            <div className="hidden sm:flex items-center gap-1.5 text-xs text-on-surface-variant font-mono">
              <span>{activeSection.chapter}</span>
              <span className="text-on-surface-variant/40">/</span>
              <span className="text-primary font-semibold">{activeSection.title}</span>
            </div>
          </div>

          {/* Instant Search Bar */}
          <div className="relative w-full max-w-xs sm:max-w-md">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[18px]">
              search
            </span>
            <input
              type="text"
              placeholder="Search guides, errors, formulas (e.g. 'LP position', 'wallet', 'rebalance')..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-8 py-1.5 bg-surface-container-lowest border border-border-subtle rounded-lg text-xs text-on-surface focus:outline-none focus:border-primary shadow-xs"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-on-surface-variant hover:text-on-surface"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-[1600px] w-full mx-auto flex-1 flex">
        {/* SIDEBAR NAVIGATION (Desktop Sticky + Mobile Drawer) */}
        <aside
          className={`fixed inset-y-0 left-0 z-40 w-72 bg-surface-container-lowest border-r border-border-subtle p-4 transform transition-transform duration-200 ease-in-out lg:translate-x-0 lg:static lg:h-[calc(100vh-100px)] lg:sticky lg:top-[57px] overflow-y-auto ${
            mobileMenuOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full lg:translate-x-0'
          }`}
        >
          <div className="space-y-6 pb-12">
            <div className="flex items-center justify-between lg:hidden pb-3 border-b border-border-subtle">
              <span className="text-xs font-mono font-bold text-primary">TABLE OF CONTENTS</span>
              <button
                onClick={() => setMobileMenuOpen(false)}
                className="p-1 rounded text-on-surface-variant hover:text-on-surface"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>

            {Array.from(groupedSections.entries()).map(([chapter, sections]) => (
              <div key={chapter} className="space-y-1.5">
                <h4 className="text-[10px] font-mono font-bold uppercase tracking-wider text-on-surface-variant px-2.5 py-1">
                  {chapter}
                </h4>
                <div className="space-y-0.5">
                  {sections.map((sec) => {
                    const isActive = activeSectionId === sec.id;
                    return (
                      <button
                        key={sec.id}
                        onClick={() => {
                          setActiveSectionId(sec.id);
                          setMobileMenuOpen(false);
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                        className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center justify-between transition-colors ${
                          isActive
                            ? 'bg-primary text-white font-bold shadow-xs'
                            : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
                        }`}
                      >
                        <div className="flex items-center gap-2 truncate">
                          <span
                            className={`material-symbols-outlined text-[16px] shrink-0 ${
                              isActive ? 'text-white' : 'text-on-surface-variant'
                            }`}
                          >
                            {sec.icon}
                          </span>
                          <span className="truncate">{sec.title}</span>
                        </div>
                        {sec.badge && (
                          <span
                            className={`text-[9px] font-mono uppercase px-1.5 py-0.2 rounded font-bold ${
                              isActive ? 'bg-white/20 text-white' : 'bg-primary/10 text-primary'
                            }`}
                          >
                            {sec.badge}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

            {/* Quick Action Dock */}
            <div className="pt-4 border-t border-border-subtle space-y-2">
              <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-on-surface-variant px-2.5">
                Terminal Quick Links
              </div>
              <div className="grid grid-cols-2 gap-1.5 px-2">
                <Link
                  href="/vault"
                  className="p-2 rounded bg-surface border border-border-subtle text-[11px] font-semibold text-center hover:border-primary transition-colors"
                >
                  Vault Float
                </Link>
                <Link
                  href="/lp/builder"
                  className="p-2 rounded bg-surface border border-border-subtle text-[11px] font-semibold text-center hover:border-primary transition-colors"
                >
                  LP Builder
                </Link>
                <Link
                  href="/lp/copy"
                  className="p-2 rounded bg-surface border border-border-subtle text-[11px] font-semibold text-center hover:border-primary transition-colors"
                >
                  Copy Masters
                </Link>
                <Link
                  href="/settings"
                  className="p-2 rounded bg-surface border border-border-subtle text-[11px] font-semibold text-center hover:border-primary transition-colors"
                >
                  Risk Settings
                </Link>
              </div>
            </div>
          </div>
        </aside>

        {/* MAIN DOCUMENTATION CONTENT */}
        <main className="flex-1 max-w-4xl px-4 sm:px-8 py-6 sm:py-10 space-y-12">
          {/* Breadcrumb Header */}
          <div className="space-y-2 border-b border-border-subtle pb-6">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded bg-surface-container border border-border-subtle text-[11px] font-mono text-on-surface-variant">
              <span>{activeSection.chapter}</span>
              <span>/</span>
              <span className="text-primary font-bold">{activeSection.title}</span>
            </div>
            <h1 className="text-2xl sm:text-4xl font-extrabold text-primary tracking-tight font-headline-lg">
              {activeSection.title}
            </h1>
            <p className="text-xs sm:text-sm text-on-surface-variant leading-relaxed">
              Official institutional implementation specification and user guide for the WAKE Protocol trading and liquidity infrastructure.
            </p>
          </div>

          {/* ========================================================================= */}
          {/* CHAPTER 1: GETTING STARTED                                                */}
          {/* ========================================================================= */}

          {activeSectionId === 'overview' && (
            <article className="space-y-8 leading-relaxed">
              <div className="p-4 rounded-xl bg-blue-500/10 border border-blue-500/20 text-xs text-blue-900 dark:text-blue-200 space-y-1">
                <div className="flex items-center gap-2 font-bold text-blue-400">
                  <span className="material-symbols-outlined text-[18px]">info</span>
                  <span>What is WAKE (SWAT) Protocol?</span>
                </div>
                <p>
                  WAKE is an institutional-grade, cross-chain execution terminal built for sub-second copy trading and autonomous concentrated liquidity management across Solana, Polygon, and EVM chains.
                </p>
              </div>

              <section className="space-y-3">
                <h2 className="text-lg font-bold text-primary">System Architecture at a Glance</h2>
                <p className="text-xs text-on-surface-variant">
                  The protocol decouples key management from automated trade execution through non-custodial smart contract vaults and private mempool execution relays.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
                  <div className="p-4 rounded-xl bg-surface-container-lowest border border-border-subtle space-y-2">
                    <div className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
                      <span className="material-symbols-outlined text-[18px]">bolt</span>
                    </div>
                    <h3 className="text-xs font-bold text-primary font-mono">Sub-Second Execution</h3>
                    <p className="text-[11px] text-on-surface-variant">
                      Direct private RPC relays (Jito bundles on Solana, Flashbots on EVM) guaranteeing zero front-running and MEV protection.
                    </p>
                  </div>

                  <div className="p-4 rounded-xl bg-surface-container-lowest border border-border-subtle space-y-2">
                    <div className="w-8 h-8 rounded-lg bg-purple-500/10 text-purple-400 flex items-center justify-center">
                      <span className="material-symbols-outlined text-[18px]">lock</span>
                    </div>
                    <h3 className="text-xs font-bold text-primary font-mono">Zero-Custody Vaults</h3>
                    <p className="text-[11px] text-on-surface-variant">
                      Smart contract Program-Derived Addresses (PDAs) with <code className="text-primary font-mono">has_one = owner</code> invariants. Only you can withdraw capital.
                    </p>
                  </div>

                  <div className="p-4 rounded-xl bg-surface-container-lowest border border-border-subtle space-y-2">
                    <div className="w-8 h-8 rounded-lg bg-cyan-500/10 text-cyan-400 flex items-center justify-center">
                      <span className="material-symbols-outlined text-[18px]">water_drop</span>
                    </div>
                    <h3 className="text-xs font-bold text-primary font-mono">DLMM / CLMM Liquidity</h3>
                    <p className="text-[11px] text-on-surface-variant">
                      Algorithmic concentrated liquidity ladders with autonomous rebalancing and pre-flight Rug Shield verification.
                    </p>
                  </div>
                </div>
              </section>

              <section className="space-y-3">
                <h2 className="text-lg font-bold text-primary">Multi-Chain Venue Support</h2>
                <div className="border border-border-subtle rounded-xl overflow-hidden">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-surface-container text-on-surface font-mono text-[10px] uppercase">
                      <tr>
                        <th className="p-3">Chain</th>
                        <th className="p-3">Native DEX & Protocols</th>
                        <th className="p-3">Primary Collateral</th>
                        <th className="p-3">Execution Method</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-subtle text-on-surface-variant font-mono text-[11px]">
                      <tr>
                        <td className="p-3 font-bold text-primary">Solana</td>
                        <td className="p-3">Raydium, Meteora DLMM, Orca Whirlpools</td>
                        <td className="p-3">USDC, SOL</td>
                        <td className="p-3">Jito Tip-Protected Bundles</td>
                      </tr>
                      <tr>
                        <td className="p-3 font-bold text-primary">Polygon</td>
                        <td className="p-3">Polymarket CLOB, Uniswap v3</td>
                        <td className="p-3">USDC, POL</td>
                        <td className="p-3">Gasless Relayers & Flashbots</td>
                      </tr>
                      <tr>
                        <td className="p-3 font-bold text-primary">Robinhood / Base</td>
                        <td className="p-3">Uniswap v3, Aerodrome</td>
                        <td className="p-3">USDC, ETH</td>
                        <td className="p-3">Private RPC Aggregators</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>

              <div className="pt-4 flex items-center gap-3">
                <button
                  onClick={() => setActiveSectionId('wallet-connection')}
                  className="px-4 py-2.5 rounded-lg bg-primary text-white text-xs font-bold hover:opacity-90 flex items-center gap-2"
                >
                  <span>Next: Connecting Your Wallet</span>
                  <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                </button>
              </div>
            </article>
          )}

          {activeSectionId === 'wallet-connection' && (
            <article className="space-y-8 leading-relaxed">
              <div className="p-4 rounded-xl bg-purple-500/10 border border-purple-500/20 text-xs text-purple-900 dark:text-purple-200 space-y-1">
                <div className="flex items-center gap-2 font-bold text-purple-400">
                  <span className="material-symbols-outlined text-[18px]">verified_user</span>
                  <span>Non-Custodial Identity Principle</span>
                </div>
                <p>
                  WAKE connects directly to your existing browser wallet (MetaMask, Phantom, Rabby, Coinbase). Connecting your wallet <strong>never</strong> shares your private keys or seed phrase. Connection is used strictly for cryptographic authentication and signing trade authorizations.
                </p>
              </div>

              <section className="space-y-4">
                <h2 className="text-lg font-bold text-primary">Supported Wallet Providers</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="p-3.5 rounded-xl border border-border-subtle bg-surface-container-lowest space-y-1.5">
                    <span className="text-xs font-bold font-mono text-primary flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                      Solana Wallets
                    </span>
                    <p className="text-[11px] text-on-surface-variant">
                      Phantom, Solflare, Backpack. Used for Solana Raydium copy trades, Meteora DLMM ladders, and SOL vault custody.
                    </p>
                  </div>
                  <div className="p-3.5 rounded-xl border border-border-subtle bg-surface-container-lowest space-y-1.5">
                    <span className="text-xs font-bold font-mono text-primary flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-blue-400"></span>
                      EVM & Polygon Wallets
                    </span>
                    <p className="text-[11px] text-on-surface-variant">
                      MetaMask, Rabby, Coinbase Wallet, Rainbow. Used for Polymarket CLOB, Uniswap v3 liquidity, and Polygon/Base assets.
                    </p>
                  </div>
                </div>
              </section>

              <section className="space-y-4">
                <h2 className="text-lg font-bold text-primary">Step-by-Step: Connecting and Linking Your Wallet</h2>
                <ol className="space-y-4 text-xs">
                  <li className="flex items-start gap-3 p-3.5 rounded-xl bg-surface-container-lowest border border-border-subtle">
                    <span className="w-6 h-6 rounded-full bg-primary text-white flex items-center justify-center font-bold text-xs shrink-0">
                      1
                    </span>
                    <div className="space-y-1">
                      <strong className="text-primary block">Click "Connect Wallet" on the Navigation Bar</strong>
                      <p className="text-on-surface-variant text-[11px]">
                        Located on the top right of the terminal. Your browser wallet extension will prompt you to select the account you wish to connect.
                      </p>
                    </div>
                  </li>

                  <li className="flex items-start gap-3 p-3.5 rounded-xl bg-surface-container-lowest border border-border-subtle">
                    <span className="w-6 h-6 rounded-full bg-primary text-white flex items-center justify-center font-bold text-xs shrink-0">
                      2
                    </span>
                    <div className="space-y-1">
                      <strong className="text-primary block">Sign the Cryptographic Proof Challenge</strong>
                      <p className="text-on-surface-variant text-[11px]">
                        WAKE issues a standard authentication challenge: <strong>Sign-In With Ethereum (EIP-4361 / SIWE)</strong> for EVM chains or <strong>Sign-In With Solana (SIWS)</strong> for Solana. This signature contains a one-time nonce and timestamp to prevent replay attacks.
                      </p>
                      <div className="p-2.5 rounded bg-surface font-mono text-[10px] text-on-surface-variant border border-border-subtle mt-1.5">
                        URI: https://app.wakeprotocol.com<br />
                        Version: 1<br />
                        Chain ID: 137 (Polygon) / 101 (Solana)<br />
                        Nonce: 9e480172370b401d82a9...<br />
                        Issued At: 2026-11-03T21:40:00Z
                      </div>
                    </div>
                  </li>

                  <li className="flex items-start gap-3 p-3.5 rounded-xl bg-surface-container-lowest border border-border-subtle">
                    <span className="w-6 h-6 rounded-full bg-primary text-white flex items-center justify-center font-bold text-xs shrink-0">
                      3
                    </span>
                    <div className="space-y-1">
                      <strong className="text-primary block">Multi-Chain Address Linking</strong>
                      <p className="text-on-surface-variant text-[11px]">
                        WAKE unifies your cross-chain trading under one identity. Once logged in, navigate to <strong>Settings → Linked Wallets</strong> to link both your Solana and Polygon addresses to your unified portfolio.
                      </p>
                    </div>
                  </li>
                </ol>
              </section>

              <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-900 dark:text-amber-200 space-y-1">
                <span className="font-bold flex items-center gap-1.5 text-amber-400">
                  <span className="material-symbols-outlined text-[16px]">security</span>
                  Anti-Phishing Security Notice
                </span>
                <p className="text-[11px]">
                  WAKE will NEVER ask you to type your 12 or 24-word recovery phrase, nor will it ask for an unlimited ERC-20 approval on your cold wallet. All automated execution happens inside your isolated non-custodial smart contract vault.
                </p>
              </div>

              <div className="pt-2 flex items-center gap-3">
                <button
                  onClick={() => setActiveSectionId('vault-funding')}
                  className="px-4 py-2.5 rounded-lg bg-primary text-white text-xs font-bold hover:opacity-90 flex items-center gap-2"
                >
                  <span>Next: Non-Custodial Vaults & Funding</span>
                  <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                </button>
              </div>
            </article>
          )}

          {activeSectionId === 'vault-funding' && (
            <article className="space-y-8 leading-relaxed">
              <section className="space-y-3">
                <h2 className="text-lg font-bold text-primary">How WAKE Smart Contract Vaults Work</h2>
                <p className="text-xs text-on-surface-variant">
                  Traditional trading bots require you to export your private key and store it on their cloud servers—putting your entire life savings at risk if their server is breached. WAKE completely eliminates this risk using <strong>zero-custody vault architecture</strong>:
                </p>

                <div className="p-4 rounded-xl bg-surface-container-lowest border border-border-subtle space-y-2 text-xs">
                  <h3 className="font-bold font-mono text-primary flex items-center gap-2">
                    <span className="material-symbols-outlined text-emerald-400 text-[18px]">gavel</span>
                    The On-Chain PDA Contract Guarantee
                  </h3>
                  <p className="text-on-surface-variant text-[11px] leading-relaxed">
                    On Solana, your vault is an Anchor Program-Derived Address seeded deterministically by <code className="bg-surface px-1.5 py-0.5 rounded font-mono text-primary">[b"vault", owner.key()]</code>. The contract program bytecode strictly enforces that <strong>only the owner's cryptographic key can sign a withdrawal</strong>. Even if WAKE's entire backend were compromised, an attacker cannot extract your funds because the smart contract rejects any withdrawal transaction not signed by you.
                  </p>
                </div>
              </section>

              <section className="space-y-4">
                <h2 className="text-lg font-bold text-primary">Step-by-Step: Depositing Float & Gas Buffers</h2>
                <div className="space-y-3 text-xs">
                  <div className="p-4 rounded-xl bg-surface-container-lowest border border-border-subtle space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-primary font-mono">1. Deposit USDC Trading Float</span>
                      <span className="px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 font-mono text-[10px] font-bold">Trading Capital</span>
                    </div>
                    <p className="text-[11px] text-on-surface-variant leading-relaxed">
                      Navigate to <strong>Funding & Vault (/vault)</strong>. Copy your unique multi-chain deposit address. Transfer USDC on Solana or Polygon. This capital represents your "Available Cash Float" from which copy-trade allocations and LP positions are deployed.
                    </p>
                  </div>

                  <div className="p-4 rounded-xl bg-surface-container-lowest border border-border-subtle space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-primary font-mono">2. Deposit Microscopic Native Gas Buffers</span>
                      <span className="px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 font-mono text-[10px] font-bold">Network Gas</span>
                    </div>
                    <p className="text-[11px] text-on-surface-variant leading-relaxed">
                      To execute trades on your behalf in sub-second mempools, your vault requires a tiny reserve buffer of native network gas:
                    </p>
                    <ul className="list-disc pl-5 text-[11px] text-on-surface-variant space-y-1">
                      <li><strong>Solana:</strong> Deposit <strong>0.02 to 0.05 SOL</strong> (~$4-$10) to cover rent and Jito tip fees.</li>
                      <li><strong>Polygon:</strong> Deposit <strong>1 to 2 POL</strong> (~$0.50) to cover state transitions.</li>
                    </ul>
                    <div className="p-2.5 rounded bg-surface border border-border-subtle text-[11px] text-primary">
                      <strong>Important Rule:</strong> WAKE never spends your USDC trade float on transaction fees; it exclusively consumes the isolated native gas buffer.
                    </div>
                  </div>
                </div>
              </section>

              <section className="space-y-3">
                <h2 className="text-lg font-bold text-primary">Withdrawing Your Funds</h2>
                <p className="text-xs text-on-surface-variant">
                  You can withdraw any portion or 100% of your vault balances back to your personal wallet at any time:
                </p>
                <ol className="list-decimal pl-5 text-xs text-on-surface-variant space-y-1.5">
                  <li>Navigate to <strong>Funding & Vault (/vault)</strong>.</li>
                  <li>Click <strong>Withdraw Float</strong>.</li>
                  <li>Select the token (USDC, SOL, POL) and enter the amount.</li>
                  <li>Funds are immediately returned to your verified linked wallet.</li>
                </ol>
              </section>

              <div className="pt-2 flex items-center gap-3">
                <Link
                  href="/vault"
                  className="px-4 py-2.5 rounded-lg bg-primary text-white text-xs font-bold hover:opacity-90 flex items-center gap-2"
                >
                  <span>Open Vault Dashboard</span>
                  <span className="material-symbols-outlined text-[16px]">launch</span>
                </Link>
                <button
                  onClick={() => setActiveSectionId('copy-discovery')}
                  className="px-4 py-2.5 rounded-lg bg-surface border border-border-subtle text-xs font-bold hover:bg-surface-container flex items-center gap-2"
                >
                  <span>Next: Master Discovery</span>
                  <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                </button>
              </div>
            </article>
          )}

          {/* ========================================================================= */}
          {/* CHAPTER 2: COPY TRADING ENGINE                                            */}
          {/* ========================================================================= */}

          {activeSectionId === 'copy-discovery' && (
            <article className="space-y-8 leading-relaxed">
              <section className="space-y-3">
                <h2 className="text-lg font-bold text-primary">Discovering & Scoring Master Whale Wallets</h2>
                <p className="text-xs text-on-surface-variant">
                  WAKE's indexers continuously monitor over 10,000 top-performing on-chain traders across Solana and Polygon, parsing transactions in real-time to compute quantitative risk-adjusted performance scores.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                  <div className="p-3.5 rounded-xl border border-border-subtle bg-surface-container-lowest space-y-1">
                    <span className="text-[10px] font-mono uppercase text-emerald-400 font-bold">Win Rate & Profit Factor</span>
                    <h3 className="text-xs font-bold text-primary">Realized PnL vs Unrealized Drawdown</h3>
                    <p className="text-[11px] text-on-surface-variant">
                      WAKE evaluates settled, realized profit rather than paper gains. Masters holding bag-holder tokens down 90% are penalized algorithmically.
                    </p>
                  </div>

                  <div className="p-3.5 rounded-xl border border-border-subtle bg-surface-container-lowest space-y-1">
                    <span className="text-[10px] font-mono uppercase text-purple-400 font-bold">Sharpe & Sortino Ratios</span>
                    <h3 className="text-xs font-bold text-primary">Downside Volatility Penalization</h3>
                    <p className="text-[11px] text-on-surface-variant">
                      Sortino ratio exclusively measures downside volatility. Traders who take reckless 100x risks to achieve high returns are filtered out.
                    </p>
                  </div>
                </div>
              </section>

              <section className="space-y-3">
                <h2 className="text-lg font-bold text-primary">Wallet Clusters & Insider Detection</h2>
                <p className="text-xs text-on-surface-variant">
                  Whales frequently distribute buys across 5-10 sub-wallets to obscure their identity. WAKE's graph neural indexer groups co-funded wallets into a single <strong>Unified Master Cluster</strong>, allowing you to mirror the cluster's aggregate signals without duplicate risk.
                </p>
              </section>

              <div className="pt-2 flex items-center gap-3">
                <button
                  onClick={() => setActiveSectionId('copy-5layer')}
                  className="px-4 py-2.5 rounded-lg bg-primary text-white text-xs font-bold hover:opacity-90 flex items-center gap-2"
                >
                  <span>Next: The 5-Layer Safety Matrix</span>
                  <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                </button>
              </div>
            </article>
          )}

          {activeSectionId === 'copy-5layer' && (
            <article className="space-y-8 leading-relaxed">
              <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-900 dark:text-emerald-200 space-y-1">
                <div className="flex items-center gap-2 font-bold text-emerald-400">
                  <span className="material-symbols-outlined text-[18px]">verified</span>
                  <span>Institutional Capital Preservation</span>
                </div>
                <p>
                  Most retail copy-trading bots fail because they blindly copy every transaction without risk filtering. WAKE implements a strict 5-layer mathematical filter that runs prior to any order broadcast.
                </p>
              </div>

              <section className="space-y-4">
                <h2 className="text-lg font-bold text-primary">The 5 Core Safety Layers</h2>

                <div className="space-y-3 text-xs">
                  {/* Layer 1 */}
                  <div className="p-4 rounded-xl bg-surface-container-lowest border border-border-subtle space-y-2">
                    <div className="flex items-center gap-2 font-mono font-bold text-primary">
                      <span className="w-5 h-5 rounded bg-primary text-white flex items-center justify-center text-[10px]">1</span>
                      <span>The Forward-Only Execution Guarantee</span>
                    </div>
                    <p className="text-on-surface-variant text-[11px] leading-relaxed">
                      When you subscribe to a master wallet, WAKE timestamps your activation (<code className="bg-surface px-1 py-0.5 rounded font-mono text-primary">T_sub</code>). Any asset already held in the master's portfolio prior to <code className="bg-surface px-1 py-0.5 rounded font-mono text-primary">T_sub</code> is strictly skipped. You will NEVER buy a token that was acquired days ago and is already dumping.
                    </p>
                  </div>

                  {/* Layer 2 */}
                  <div className="p-4 rounded-xl bg-surface-container-lowest border border-border-subtle space-y-2">
                    <div className="flex items-center gap-2 font-mono font-bold text-primary">
                      <span className="w-5 h-5 rounded bg-primary text-white flex items-center justify-center text-[10px]">2</span>
                      <span>Slippage & MEV Clamping (Jito Private Bundles)</span>
                    </div>
                    <p className="text-on-surface-variant text-[11px] leading-relaxed">
                      If the token price surges between the master's block confirmation and your mirror execution, WAKE simulates the price impact. If slippage exceeds your configured threshold in <code className="bg-surface px-1 py-0.5 rounded font-mono text-primary">/settings</code> (e.g. 150 bps), execution is aborted to protect you from buying at the top.
                    </p>
                  </div>

                  {/* Layer 3 */}
                  <div className="p-4 rounded-xl bg-surface-container-lowest border border-border-subtle space-y-2">
                    <div className="flex items-center gap-2 font-mono font-bold text-primary">
                      <span className="w-5 h-5 rounded bg-primary text-white flex items-center justify-center text-[10px]">3</span>
                      <span>Lot-Proportional Mathematical Trimming</span>
                    </div>
                    <p className="text-on-surface-variant text-[11px] leading-relaxed">
                      When a master trims 25% of their holding, WAKE sells exactly 25% of your mirrored lot. When the master fully exits 100%, WAKE closes 100% of your remaining tokens.
                    </p>
                  </div>

                  {/* Layer 4 */}
                  <div className="p-4 rounded-xl bg-surface-container-lowest border border-border-subtle space-y-2">
                    <div className="flex items-center gap-2 font-mono font-bold text-primary">
                      <span className="w-5 h-5 rounded bg-primary text-white flex items-center justify-center text-[10px]">4</span>
                      <span>Autonomous Stop-Loss & Take-Profit Guardrails</span>
                    </div>
                    <p className="text-on-surface-variant text-[11px] leading-relaxed">
                      Even if a master decides to hold a crashing token down to zero, your personal Stop-Loss trigger (e.g. -20%) overrides the master and dumps your position to preserve capital.
                    </p>
                  </div>

                  {/* Layer 5 */}
                  <div className="p-4 rounded-xl bg-surface-container-lowest border border-border-subtle space-y-2">
                    <div className="flex items-center gap-2 font-mono font-bold text-primary">
                      <span className="w-5 h-5 rounded bg-primary text-white flex items-center justify-center text-[10px]">5</span>
                      <span>Emergency Master Kill Switch</span>
                    </div>
                    <p className="text-on-surface-variant text-[11px] leading-relaxed">
                      A single master switch in your top navigation and <code className="bg-surface px-1 py-0.5 rounded font-mono text-primary">/settings</code> that halts all incoming copy orders and cancels resting submissions instantly.
                    </p>
                  </div>
                </div>
              </section>

              <div className="pt-2 flex items-center gap-3">
                <button
                  onClick={() => setActiveSectionId('copy-lot-proportional')}
                  className="px-4 py-2.5 rounded-lg bg-primary text-white text-xs font-bold hover:opacity-90 flex items-center gap-2"
                >
                  <span>Next: Lot-Proportional Exit Math</span>
                  <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                </button>
              </div>
            </article>
          )}

          {activeSectionId === 'copy-lot-proportional' && (
            <article className="space-y-8 leading-relaxed">
              <section className="space-y-3">
                <h2 className="text-lg font-bold text-primary">Mathematical Lot-Proportional Exits</h2>
                <p className="text-xs text-on-surface-variant">
                  One of the biggest flaws in amateur copy-trading systems is selling fixed amounts. If a whale with $500,000 sells $5,000 of a token (1% of their bag), an amateur bot might sell 100% of your $500 position, completely kicking you out of the trade.
                </p>

                <div className="p-4 rounded-xl bg-surface-container-lowest border border-border-subtle space-y-3 text-xs">
                  <h3 className="font-bold font-mono text-primary">The Proportional Exit Formula</h3>
                  <div className="p-3 rounded bg-surface font-mono text-xs text-primary border border-border-subtle">
                    User Sell Amount = User Open Position × (Master Sell Quantity / Master Total Holding Prior to Sell)
                  </div>
                  <div className="space-y-2 text-[11px] text-on-surface-variant">
                    <p><strong>Example Scenario:</strong></p>
                    <ul className="list-disc pl-5 space-y-1">
                      <li>Whale owns 1,000,000 tokens of Asset X.</li>
                      <li>You mirrored with a lot of 10,000 tokens.</li>
                      <li>Whale takes partial profit, selling 200,000 tokens (20% of their holding).</li>
                      <li>WAKE calculates: <code className="font-mono text-primary">10,000 × (200,000 / 1,000,000) = 2,000 tokens</code>.</li>
                      <li>WAKE executes a sell order for exactly 2,000 tokens, leaving you with 8,000 tokens in play.</li>
                    </ul>
                  </div>
                </div>
              </section>

              <div className="pt-2 flex items-center gap-3">
                <button
                  onClick={() => setActiveSectionId('polymarket-clob')}
                  className="px-4 py-2.5 rounded-lg bg-primary text-white text-xs font-bold hover:opacity-90 flex items-center gap-2"
                >
                  <span>Next: Polymarket Prediction Markets</span>
                  <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                </button>
              </div>
            </article>
          )}

          {/* ========================================================================= */}
          {/* CHAPTER 3: POLYMARKET PREDICTION MARKETS                                  */}
          {/* ========================================================================= */}

          {activeSectionId === 'polymarket-clob' && (
            <article className="space-y-8 leading-relaxed">
              <section className="space-y-3">
                <h2 className="text-lg font-bold text-primary">Polymarket Central Limit Order Book (CLOB)</h2>
                <p className="text-xs text-on-surface-variant">
                  Polymarket is the world's largest decentralized prediction market, running on Polygon PoS. WAKE's Polymarket infrastructure tracks top prediction traders and mirrors their trades with sub-second execution.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 text-xs">
                  <div className="p-3.5 rounded-xl border border-border-subtle bg-surface-container-lowest space-y-1.5">
                    <span className="text-[10px] font-mono uppercase text-violet-400 font-bold">Conditional Tokens (CTF)</span>
                    <h3 className="font-bold text-primary">Binary Yes / No Tokenization</h3>
                    <p className="text-[11px] text-on-surface-variant">
                      Each market represents a binary condition. Buying "Yes" at $0.65 implies a 65% market probability. Upon market resolution, winning shares settle at exactly $1.00 USDC, while losing shares settle at $0.00.
                    </p>
                  </div>

                  <div className="p-3.5 rounded-xl border border-border-subtle bg-surface-container-lowest space-y-1.5">
                    <span className="text-[10px] font-mono uppercase text-blue-400 font-bold">Live Order Book Architecture</span>
                    <h3 className="font-bold text-primary">Off-Chain Matching, On-Chain Settlement</h3>
                    <p className="text-[11px] text-on-surface-variant">
                      Polymarket uses an off-chain CLOB with gasless operator matching and atomic Polygon settlement. WAKE maintains live Level 2 WebSocket orderbook streams to ensure sub-millisecond price verification.
                    </p>
                  </div>
                </div>
              </section>

              <section className="space-y-3">
                <h2 className="text-lg font-bold text-primary">Polymarket API Infrastructure</h2>
                <p className="text-xs text-on-surface-variant">
                  WAKE integrates directly with the three official Polymarket protocol APIs:
                </p>
                <ul className="list-disc pl-5 text-xs text-on-surface-variant space-y-1.5">
                  <li><strong>Data API v2 (`/v2/trades`):</strong> Real-time wallet trade feed and historical backfills via cursor pagination.</li>
                  <li><strong>Gamma API (`/markets`):</strong> Condition IDs, question descriptions, resolution status, and tick sizes.</li>
                  <li><strong>CLOB API (REST & WebSocket):</strong> Live order books (`/books`) and EIP-712 Level 2 authenticated order placement.</li>
                </ul>
              </section>

              <div className="pt-2 flex items-center gap-3">
                <button
                  onClick={() => setActiveSectionId('polymarket-orders')}
                  className="px-4 py-2.5 rounded-lg bg-primary text-white text-xs font-bold hover:opacity-90 flex items-center gap-2"
                >
                  <span>Next: FAK Orders & Mirror Price Bounds</span>
                  <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                </button>
              </div>
            </article>
          )}

          {activeSectionId === 'polymarket-orders' && (
            <article className="space-y-8 leading-relaxed">
              <section className="space-y-3">
                <h2 className="text-lg font-bold text-primary">Order Types & Mirror Price Bounding</h2>
                <p className="text-xs text-on-surface-variant">
                  Prediction markets experience extreme liquidity swings when high-impact news breaks. WAKE prevents copy trades from getting trapped using specialized order routing:
                </p>

                <div className="p-4 rounded-xl bg-surface-container-lowest border border-border-subtle space-y-2 text-xs">
                  <h3 className="font-bold font-mono text-primary flex items-center gap-2">
                    <span className="material-symbols-outlined text-purple-400 text-[18px]">flash_on</span>
                    Fill-And-Kill (FAK / Immediate-Or-Cancel)
                  </h3>
                  <p className="text-on-surface-variant text-[11px] leading-relaxed">
                    All copy trades are submitted as <code className="font-mono text-primary">OrderType.FAK</code>. FAK orders execute immediately against resting book liquidity up to your bounded limit price. Any remainder that cannot be filled at that exact price is cancelled instantly. This eliminates the risk of resting limit orders sitting in the book and getting filled hours later at adverse odds.
                  </p>
                </div>

                <div className="p-4 rounded-xl bg-surface-container-lowest border border-border-subtle space-y-2 text-xs">
                  <h3 className="font-bold font-mono text-primary flex items-center gap-2">
                    <span className="material-symbols-outlined text-emerald-400 text-[18px]">straighten</span>
                    Mirror Price Tolerance Bounding
                  </h3>
                  <p className="text-on-surface-variant text-[11px] leading-relaxed">
                    If the master filled "Yes" shares at $0.40, WAKE calculates your maximum allowed price bound:
                  </p>
                  <div className="p-2.5 rounded bg-surface font-mono text-xs text-primary border border-border-subtle">
                    Max Mirror Price = Master Fill Price × (1 + Tolerance BPS) = $0.40 × (1 + 0.015) = $0.406
                  </div>
                  <p className="text-on-surface-variant text-[11px]">
                    If frontrunners or other copy bots pump the ask above $0.406, WAKE aborts the fill immediately, preventing you from overpaying.
                  </p>
                </div>
              </section>

              <div className="pt-2 flex items-center gap-3">
                <button
                  onClick={() => setActiveSectionId('lp-fundamentals')}
                  className="px-4 py-2.5 rounded-lg bg-primary text-white text-xs font-bold hover:opacity-90 flex items-center gap-2"
                >
                  <span>Next: Concentrated Liquidity (LP) Protocol</span>
                  <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                </button>
              </div>
            </article>
          )}

          {/* ========================================================================= */}
          {/* CHAPTER 4: CONCENTRATED LIQUIDITY (LP) PROTOCOL                           */}
          {/* ========================================================================= */}

          {activeSectionId === 'lp-fundamentals' && (
            <article className="space-y-8 leading-relaxed">
              <section className="space-y-3">
                <h2 className="text-lg font-bold text-primary">Understanding Concentrated Liquidity (CLMM & DLMM)</h2>
                <p className="text-xs text-on-surface-variant">
                  Traditional Automated Market Makers (Uniswap v2 / standard XYK) spread your liquidity across the entire price spectrum from zero to infinity (<code className="font-mono text-primary">0 → ∞</code>). In high-volume pairs like SOL/USDC, 99% of that capital sits idle and never earns a dime.
                </p>

                <div className="p-4 rounded-xl bg-surface-container-lowest border border-border-subtle space-y-2 text-xs">
                  <h3 className="font-bold font-mono text-primary flex items-center gap-2">
                    <span className="material-symbols-outlined text-cyan-400 text-[18px]">compress</span>
                    The 10x-50x Capital Efficiency Advantage
                  </h3>
                  <p className="text-on-surface-variant text-[11px] leading-relaxed">
                    In <strong>Concentrated Liquidity Market Makers (CLMM / Meteora DLMM on Solana & Uniswap v3 on Polygon/EVM)</strong>, you deposit capital exclusively within discrete price ranges ("bins" or "ticks"). By concentrating $1,000 within a ±5% interval around current price, you capture the same trading fees as a $50,000 deposit in a traditional pool—yielding 100% to 500%+ annualized fee returns.
                  </p>
                </div>
              </section>

              <div className="pt-2 flex items-center gap-3">
                <button
                  onClick={() => setActiveSectionId('lp-rug-shield')}
                  className="px-4 py-2.5 rounded-lg bg-primary text-white text-xs font-bold hover:opacity-90 flex items-center gap-2"
                >
                  <span>Next: Pre-Flight Rug Shield Audits</span>
                  <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                </button>
              </div>
            </article>
          )}

          {activeSectionId === 'lp-rug-shield' && (
            <article className="space-y-8 leading-relaxed">
              <div className="p-4 rounded-xl bg-blue-500/10 border border-blue-500/20 text-xs text-blue-900 dark:text-blue-200 space-y-1">
                <div className="flex items-center gap-2 font-bold text-blue-400">
                  <span className="material-symbols-outlined text-[18px]">verified</span>
                  <span>Automated Pool Vetting</span>
                </div>
                <p>
                  Providing liquidity on newly launched tokens carries significant risk of malicious developer exploits. WAKE integrates an automated on-chain pre-flight audit engine called <strong>Rug Shield</strong> that screens every pool before it appears on your screen.
                </p>
              </div>

              <section className="space-y-4">
                <h2 className="text-lg font-bold text-primary">The 4 Pre-Flight Security Verifications</h2>

                <div className="space-y-3 text-xs">
                  <div className="p-3.5 rounded-xl bg-surface-container-lowest border border-border-subtle space-y-1">
                    <div className="flex items-center gap-2 font-bold text-primary font-mono">
                      <span className="text-emerald-400">✓</span> Mint Authority Revocation
                    </div>
                    <p className="text-[11px] text-on-surface-variant">
                      Verifies that the token's mint authority address is <code className="bg-surface px-1 py-0.5 rounded font-mono text-primary">null</code>. The creator cannot arbitrarily print billions of new tokens to dilute liquidity providers.
                    </p>
                  </div>

                  <div className="p-3.5 rounded-xl bg-surface-container-lowest border border-border-subtle space-y-1">
                    <div className="flex items-center gap-2 font-bold text-primary font-mono">
                      <span className="text-emerald-400">✓</span> Freeze Authority Revocation
                    </div>
                    <p className="text-[11px] text-on-surface-variant">
                      Confirms the freeze authority is permanently revoked. Malicious creators cannot blacklist or freeze LP accounts from selling or rebalancing.
                    </p>
                  </div>

                  <div className="p-3.5 rounded-xl border border-border-subtle space-y-1">
                    <div className="flex items-center gap-2 font-bold text-primary font-mono">
                      <span className="text-emerald-400">✓</span> Top-10 Holder Concentration Cap (&lt; 50%)
                    </div>
                    <p className="text-[11px] text-on-surface-variant">
                      Audits the ledger balance of the top 10 non-pool wallet addresses. If insiders or deployer wallets control over 50% of the circulating supply, the pool is immediately hidden and blacklisted.
                    </p>
                  </div>

                  <div className="p-3.5 rounded-xl border border-border-subtle space-y-1">
                    <div className="flex items-center gap-2 font-bold text-primary font-mono">
                      <span className="text-emerald-400">✓</span> Permanent Liquidity Lock Verification
                    </div>
                    <p className="text-[11px] text-on-surface-variant">
                      Checks that base LP tokens are locked or burned in verifiable on-chain timelock escrow contracts.
                    </p>
                  </div>
                </div>
              </section>

              <div className="pt-2 flex items-center gap-3">
                <button
                  onClick={() => setActiveSectionId('lp-builder-guide')}
                  className="px-4 py-2.5 rounded-lg bg-primary text-white text-xs font-bold hover:opacity-90 flex items-center gap-2"
                >
                  <span>Next: Master Walkthrough — Building an LP Position</span>
                  <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                </button>
              </div>
            </article>
          )}

          {activeSectionId === 'lp-builder-guide' && (
            <article className="space-y-8 leading-relaxed">
              <div className="p-4 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-xs text-cyan-900 dark:text-cyan-200 space-y-1">
                <div className="flex items-center gap-2 font-bold text-cyan-400">
                  <span className="material-symbols-outlined text-[18px]">school</span>
                  <span>Master Step-by-Step Walkthrough</span>
                </div>
                <p>
                  This comprehensive guide walks you through building and deploying an institutional concentrated liquidity position from scratch using WAKE's LP Builder.
                </p>
              </div>

              {/* STEP 1 */}
              <section className="space-y-3 p-4 rounded-xl bg-surface-container-lowest border border-border-subtle">
                <div className="flex items-center gap-2 font-mono font-bold text-primary text-sm">
                  <span className="w-6 h-6 rounded-full bg-primary text-white flex items-center justify-center text-xs shrink-0">1</span>
                  <span>Select Target Chain and Trading Pair</span>
                </div>
                <p className="text-xs text-on-surface-variant leading-relaxed">
                  Navigate to <strong>LP Builder (/lp/builder)</strong> or click "Deploy" directly from the <strong>Discover Pools (/lp/discover)</strong> scanner.
                </p>
                <ul className="list-disc pl-5 text-xs text-on-surface-variant space-y-1">
                  <li><strong>Chain:</strong> Choose Solana (Meteora DLMM) or Polygon / Base (Uniswap v3).</li>
                  <li><strong>Pair Selection:</strong> Select your pair (e.g. SOL/USDC or high-volatility meme pair). Verify the dynamic fee rate (e.g. 0.25% to 2.00%).</li>
                </ul>
              </section>

              {/* STEP 2 */}
              <section className="space-y-3 p-4 rounded-xl bg-surface-container-lowest border border-border-subtle">
                <div className="flex items-center gap-2 font-mono font-bold text-primary text-sm">
                  <span className="w-6 h-6 rounded-full bg-primary text-white flex items-center justify-center text-xs shrink-0">2</span>
                  <span>Choose Your Liquidity Distribution Shape</span>
                </div>
                <p className="text-xs text-on-surface-variant leading-relaxed">
                  WAKE provides 4 distinct mathematical distribution shapes:
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1 text-xs">
                  <div className="p-3 rounded-lg bg-surface border border-border-subtle space-y-1">
                    <strong className="text-primary font-mono block">1. Spot Shape (Uniform)</strong>
                    <p className="text-[11px] text-on-surface-variant">
                      Even distribution across all bins. Best for stablecoins or low-volatility consolidation channels. Consistent yield across the entire range.
                    </p>
                  </div>
                  <div className="p-3 rounded-lg bg-surface border border-border-subtle space-y-1">
                    <strong className="text-primary font-mono block">2. Curve Shape (Gaussian)</strong>
                    <p className="text-[11px] text-on-surface-variant">
                      Concentrates majority of liquidity directly around current price with tapering edges. Maximizes fee capture while price stays near center.
                    </p>
                  </div>
                  <div className="p-3 rounded-lg bg-surface border border-border-subtle space-y-1">
                    <strong className="text-primary font-mono block">3. Bid-Ask Shape (Asymmetric)</strong>
                    <p className="text-[11px] text-on-surface-variant">
                      Inverted distribution. Concentrates quote token (USDC) below price to buy dips, and base token (SOL) above price to scale out into rallies.
                    </p>
                  </div>
                  <div className="p-3 rounded-lg bg-surface border border-border-subtle space-y-1">
                    <strong className="text-primary font-mono block">4. Ladder Shape (Wide Range)</strong>
                    <p className="text-[11px] text-on-surface-variant">
                      Expansive multi-tier bins. Ideal for high-volatility new token launches where price swings exceed ±50% daily.
                    </p>
                  </div>
                </div>
              </section>

              {/* STEP 3 */}
              <section className="space-y-3 p-4 rounded-xl bg-surface-container-lowest border border-border-subtle">
                <div className="flex items-center gap-2 font-mono font-bold text-primary text-sm">
                  <span className="w-6 h-6 rounded-full bg-primary text-white flex items-center justify-center text-xs shrink-0">3</span>
                  <span>Configure Price Bounds & Bin Step</span>
                </div>
                <p className="text-xs text-on-surface-variant leading-relaxed">
                  Define your active trading boundaries:
                </p>
                <ul className="list-disc pl-5 text-xs text-on-surface-variant space-y-1.5">
                  <li><strong>Lower Price (P_min):</strong> The price floor below which your position stops earning fees and converts 100% to the base token (SOL).</li>
                  <li><strong>Upper Price (P_max):</strong> The price ceiling above which your position converts 100% to the quote token (USDC).</li>
                  <li><strong>Quick Presets:</strong> You can select preset relative widths (e.g. ±5%, ±10%, ±25%) or type exact dollar values.</li>
                  <li><strong>Bin Step:</strong> Expressed in basis points (e.g. 20 bps = 0.20%). Defines the granularity between adjacent liquidity bins.</li>
                </ul>
              </section>

              {/* STEP 4 */}
              <section className="space-y-3 p-4 rounded-xl bg-surface-container-lowest border border-border-subtle">
                <div className="flex items-center gap-2 font-mono font-bold text-primary text-sm">
                  <span className="w-6 h-6 rounded-full bg-primary text-white flex items-center justify-center text-xs shrink-0">4</span>
                  <span>Asset Ratio Balancing & Deposit Amount</span>
                </div>
                <p className="text-xs text-on-surface-variant leading-relaxed">
                  Enter your total intended capital allocation in USDC:
                </p>
                <div className="p-3 rounded-lg bg-surface border border-border-subtle text-[11px] text-on-surface-variant space-y-1">
                  <p><strong>Dual-Sided vs Single-Sided Deposits:</strong></p>
                  <ul className="list-disc pl-5 space-y-0.5">
                    <li>If current price is in the middle of your range: You deposit both tokens in the ratio dictated by the curve shape.</li>
                    <li>If your range is entirely <em>below</em> current price: You deposit 100% USDC (waiting to buy the dip).</li>
                    <li>If your range is entirely <em>above</em> current price: You deposit 100% base token (waiting to sell into strength).</li>
                  </ul>
                  <p className="pt-1 text-primary">WAKE's smart builder automatically calculates the exact token breakdown required.</p>
                </div>
              </section>

              {/* STEP 5 */}
              <section className="space-y-3 p-4 rounded-xl bg-surface-container-lowest border border-border-subtle">
                <div className="flex items-center gap-2 font-mono font-bold text-primary text-sm">
                  <span className="w-6 h-6 rounded-full bg-primary text-white flex items-center justify-center text-xs shrink-0">5</span>
                  <span>Simulate Impermanent Loss & Projected APR</span>
                </div>
                <p className="text-xs text-on-surface-variant leading-relaxed">
                  Before broadcasting any transaction, inspect the live <strong>Pre-Flight Simulation Card</strong>:
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs font-mono">
                  <div className="p-2.5 rounded bg-surface border border-border-subtle">
                    <span className="text-[10px] text-on-surface-variant block uppercase">24h Vol</span>
                    <span className="font-bold text-primary">$4.2M</span>
                  </div>
                  <div className="p-2.5 rounded bg-surface border border-border-subtle">
                    <span className="text-[10px] text-on-surface-variant block uppercase">Fee Tier</span>
                    <span className="font-bold text-emerald-400">0.50%</span>
                  </div>
                  <div className="p-2.5 rounded bg-surface border border-border-subtle">
                    <span className="text-[10px] text-on-surface-variant block uppercase">Projected APR</span>
                    <span className="font-bold text-primary">245.8%</span>
                  </div>
                  <div className="p-2.5 rounded bg-surface border border-border-subtle">
                    <span className="text-[10px] text-on-surface-variant block uppercase">Max IL Risk</span>
                    <span className="font-bold text-amber-400">4.1%</span>
                  </div>
                </div>
              </section>

              {/* STEP 6 */}
              <section className="space-y-3 p-4 rounded-xl bg-surface-container-lowest border border-border-subtle">
                <div className="flex items-center gap-2 font-mono font-bold text-primary text-sm">
                  <span className="w-6 h-6 rounded-full bg-primary text-white flex items-center justify-center text-xs shrink-0">6</span>
                  <span>Atomic Vault Deployment</span>
                </div>
                <p className="text-xs text-on-surface-variant leading-relaxed">
                  Toggle <strong>"Auto-Rebalance"</strong> ON (recommended) to let WAKE's economic friction rebalancer manage range drift automatically. Click <strong>"Deploy Liquidity"</strong>.
                </p>
                <p className="text-[11px] text-on-surface-variant">
                  WAKE's executor submits the multi-hop deposit atomically via your non-custodial vault directly into the DEX contract. Your active ladder instantly appears in <strong>My Positions (/lp/positions)</strong> with real-time fee streaming.
                </p>
              </section>

              <div className="pt-2 flex items-center gap-3">
                <Link
                  href="/lp/builder"
                  className="px-4 py-2.5 rounded-lg bg-primary text-white text-xs font-bold hover:opacity-90 flex items-center gap-2"
                >
                  <span>Launch LP Builder Now</span>
                  <span className="material-symbols-outlined text-[16px]">launch</span>
                </Link>
                <button
                  onClick={() => setActiveSectionId('lp-rebalancer')}
                  className="px-4 py-2.5 rounded-lg bg-surface border border-border-subtle text-xs font-bold hover:bg-surface-container flex items-center gap-2"
                >
                  <span>Next: Autonomous Rebalancing</span>
                  <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                </button>
              </div>
            </article>
          )}

          {activeSectionId === 'lp-rebalancer' && (
            <article className="space-y-8 leading-relaxed">
              <section className="space-y-3">
                <h2 className="text-lg font-bold text-primary">Autonomous Rebalancing & Range States</h2>
                <p className="text-xs text-on-surface-variant">
                  When market price trends strongly in one direction, concentrated positions can fall "Out of Range", halting fee generation. WAKE's Autonomous Rebalancing Engine manages this continuous monitoring cycle.
                </p>

                <div className="space-y-3 text-xs pt-1">
                  <div className="p-3.5 rounded-xl bg-surface-container-lowest border border-border-subtle flex items-start gap-3">
                    <span className="w-3 h-3 rounded-full bg-emerald-400 mt-1 shrink-0"></span>
                    <div className="space-y-1">
                      <strong className="text-primary font-mono">IN RANGE (Active Yield)</strong>
                      <p className="text-[11px] text-on-surface-variant">
                        Spot price is actively trading inside your liquidity bins. Your position is generating dynamic swap fees continuously.
                      </p>
                    </div>
                  </div>

                  <div className="p-3.5 rounded-xl bg-surface-container-lowest border border-border-subtle flex items-start gap-3">
                    <span className="w-3 h-3 rounded-full bg-amber-400 mt-1 shrink-0"></span>
                    <div className="space-y-1">
                      <strong className="text-primary font-mono">NEAR EDGE (Pre-Alert Threshold)</strong>
                      <p className="text-[11px] text-on-surface-variant">
                        Spot price is within 10% of your upper or lower bound. The rebalancer initiates background economic friction calculations.
                      </p>
                    </div>
                  </div>

                  <div className="p-3.5 rounded-xl bg-surface-container-lowest border border-border-subtle flex items-start gap-3">
                    <span className="w-3 h-3 rounded-full bg-red-400 mt-1 shrink-0"></span>
                    <div className="space-y-1">
                      <strong className="text-primary font-mono">OUT OF RANGE (Yield Paused)</strong>
                      <p className="text-[11px] text-on-surface-variant">
                        Spot price has exited the boundary. 100% of your capital has converted to the lagging asset, and fee accrual is paused until price re-enters or the position is rebalanced.
                      </p>
                    </div>
                  </div>
                </div>
              </section>

              <section className="space-y-3">
                <h2 className="text-lg font-bold text-primary">The Mathematical Rebalancing Hurdle</h2>
                <div className="p-4 rounded-xl bg-surface-container-lowest border border-border-subtle space-y-2 text-xs">
                  <h3 className="font-bold font-mono text-primary">Anti-Churn Economic Formula</h3>
                  <div className="p-3 rounded bg-surface font-mono text-xs text-primary border border-border-subtle">
                    Fee Uplift &gt; Impermanent Loss Realization + Swap Slippage + Network Gas
                  </div>
                  <p className="text-[11px] text-on-surface-variant leading-relaxed">
                    Naïve bots rebalance the microsecond price touches a border, burning $10-$20 in swap friction and gas to earn $2 in fees—slowly draining capital. WAKE calculates whether the projected fee earnings over the next 24 hours outweigh the cost of re-centering. If the mathematical advantage is negative, WAKE waits patiently.
                  </p>
                </div>
              </section>

              <div className="pt-2 flex items-center gap-3">
                <button
                  onClick={() => setActiveSectionId('lp-harvest-close')}
                  className="px-4 py-2.5 rounded-lg bg-primary text-white text-xs font-bold hover:opacity-90 flex items-center gap-2"
                >
                  <span>Next: Harvesting Yield & Closing</span>
                  <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                </button>
              </div>
            </article>
          )}

          {activeSectionId === 'lp-harvest-close' && (
            <article className="space-y-8 leading-relaxed">
              <section className="space-y-3">
                <h2 className="text-lg font-bold text-primary">Harvesting Yield & Unwinding Positions</h2>
                <p className="text-xs text-on-surface-variant">
                  All accrued trading fees accumulate in real time on-chain inside the liquidity pool contract:
                </p>

                <div className="space-y-3 text-xs">
                  <div className="p-4 rounded-xl bg-surface-container-lowest border border-border-subtle space-y-1.5">
                    <strong className="text-primary font-mono block">1. Harvesting Fees (Without Closing Position)</strong>
                    <p className="text-[11px] text-on-surface-variant leading-relaxed">
                      Go to <strong>My Positions (/lp/positions)</strong>. On any active ladder, tap <strong>"Harvest"</strong>. The contract claims accumulated trading fees directly into your vault cash float without disturbing your underlying liquidity bins.
                    </p>
                  </div>

                  <div className="p-4 rounded-xl bg-surface-container-lowest border border-border-subtle space-y-1.5">
                    <strong className="text-primary font-mono block">2. Closing Position (Full Liquidity Redemption)</strong>
                    <p className="text-[11px] text-on-surface-variant leading-relaxed">
                      Tap <strong>"Close Position"</strong> on <code className="font-mono text-primary">/lp/positions</code>. WAKE burns your LP bin positions, claims 100% of unclaimed fees, and redeems all underlying principal tokens directly back into your vault float in a single atomic transaction.
                    </p>
                  </div>
                </div>
              </section>

              <div className="pt-2 flex items-center gap-3">
                <button
                  onClick={() => setActiveSectionId('security-antitheft')}
                  className="px-4 py-2.5 rounded-lg bg-primary text-white text-xs font-bold hover:opacity-90 flex items-center gap-2"
                >
                  <span>Next: Security & Anti-Theft Protocol</span>
                  <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                </button>
              </div>
            </article>
          )}

          {/* ========================================================================= */}
          {/* CHAPTER 5: SECURITY & ANTI-THEFT PROTOCOL                                 */}
          {/* ========================================================================= */}

          {activeSectionId === 'security-antitheft' && (
            <article className="space-y-8 leading-relaxed">
              <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-900 dark:text-rose-200 space-y-1">
                <div className="flex items-center gap-2 font-bold text-rose-400">
                  <span className="material-symbols-outlined text-[18px]">lock</span>
                  <span>Defense-in-Depth Withdrawal Security</span>
                </div>
                <p>
                  WAKE protects user capital with a multi-layered anti-theft security architecture designed to prevent account takeover and unauthorized fund exfiltration.
                </p>
              </div>

              <section className="space-y-3">
                <h2 className="text-lg font-bold text-primary">The 3-Step Anti-Theft Withdrawal Safeguard</h2>
                <div className="space-y-3 text-xs">
                  <div className="p-4 rounded-xl bg-surface-container-lowest border border-border-subtle space-y-1.5">
                    <strong className="text-primary font-mono block">1. 24-Hour Cooling-Off Window</strong>
                    <p className="text-[11px] text-on-surface-variant leading-relaxed">
                      Whenever a new destination wallet address is added or modified in your account profile, all outbound withdrawals to that address are locked for exactly 24 hours. If an unauthorized session attempts to redirect your funds, you have a full 24-hour window to freeze your account.
                    </p>
                  </div>

                  <div className="p-4 rounded-xl bg-surface-container-lowest border border-border-subtle space-y-1.5">
                    <strong className="text-primary font-mono block">2. Out-of-Band Single-Use Email OTP</strong>
                    <p className="text-[11px] text-on-surface-variant leading-relaxed">
                      Initiating an address modification or major withdrawal triggers a 6-digit numeric verification code sent to your registered email. Codes expire in 10 minutes, enforce a 60-second cooldown between resends, and clamp brute-force attempts to a maximum of 5 tries.
                    </p>
                  </div>

                  <div className="p-4 rounded-xl bg-surface-container-lowest border border-border-subtle space-y-1.5">
                    <strong className="text-primary font-mono block">3. Cryptographic Signature Ownership Proof</strong>
                    <p className="text-[11px] text-on-surface-variant leading-relaxed">
                      You cannot link an arbitrary withdrawal address by simply pasting a public key string. You must connect the destination wallet and sign a cryptographic proof (SIWE / SIWS) verifying that you control the private key of the destination.
                    </p>
                  </div>
                </div>
              </section>

              <div className="pt-2 flex items-center gap-3">
                <button
                  onClick={() => setActiveSectionId('troubleshooting')}
                  className="px-4 py-2.5 rounded-lg bg-primary text-white text-xs font-bold hover:opacity-90 flex items-center gap-2"
                >
                  <span>Next: Interactive Troubleshooting Matrix</span>
                  <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                </button>
              </div>
            </article>
          )}

          {activeSectionId === 'security-mev' && (
            <article className="space-y-8 leading-relaxed">
              <section className="space-y-3">
                <h2 className="text-lg font-bold text-primary">Private MEV Relays (Jito & Flashbots)</h2>
                <p className="text-xs text-on-surface-variant">
                  Public blockchain mempools are infested with predatory MEV bots that frontrun and sandwich retail trades. WAKE completely bypasses public mempools:
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 text-xs">
                  <div className="p-4 rounded-xl bg-surface-container-lowest border border-border-subtle space-y-1.5">
                    <h3 className="font-bold text-primary font-mono flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                      Solana: Jito Block Engine Bundles
                    </h3>
                    <p className="text-[11px] text-on-surface-variant">
                      Trades are bundled directly to trusted Jito-Solana validators with an explicit micro-tip. Your transaction is either executed atomically at the head of the block or dropped entirely—never sandwiched.
                    </p>
                  </div>

                  <div className="p-4 rounded-xl bg-surface-container-lowest border border-border-subtle space-y-1.5">
                    <h3 className="font-bold text-primary font-mono flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-blue-400"></span>
                      EVM: Flashbots Private RPC
                    </h3>
                    <p className="text-[11px] text-on-surface-variant">
                      On Polygon and EVM chains, orders route through private builder endpoints that keep your transaction invisible to the public mempool until block inclusion.
                    </p>
                  </div>
                </div>
              </section>

              <div className="pt-2 flex items-center gap-3">
                <button
                  onClick={() => setActiveSectionId('troubleshooting')}
                  className="px-4 py-2.5 rounded-lg bg-primary text-white text-xs font-bold hover:opacity-90 flex items-center gap-2"
                >
                  <span>Next: Troubleshooting Matrix</span>
                  <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                </button>
              </div>
            </article>
          )}

          {/* ========================================================================= */}
          {/* CHAPTER 6: TROUBLESHOOTING & REFERENCE                                    */}
          {/* ========================================================================= */}

          {activeSectionId === 'troubleshooting' && (
            <article className="space-y-8 leading-relaxed">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-bold text-primary font-headline-md">
                      Interactive Troubleshooting & Issue Resolution Matrix
                    </h2>
                    <p className="text-xs text-on-surface-variant">
                      Click any issue below to inspect root causes, symptoms, and step-by-step verified resolutions.
                    </p>
                  </div>
                  <span className="text-xs font-mono text-on-surface-variant hidden sm:inline">
                    {filteredFaqs.length} Guide(s) Found
                  </span>
                </div>

                {/* Category Filter Pills */}
                <div className="flex items-center gap-2 overflow-x-auto no-scrollbar py-1">
                  {[
                    { id: 'all', label: 'All Issues' },
                    { id: 'funding', label: 'Funding & Vault' },
                    { id: 'copy', label: 'Copy Trading' },
                    { id: 'lp', label: 'LP Protocol' },
                    { id: 'polymarket', label: 'Polymarket' },
                    { id: 'security', label: 'Security' },
                  ].map((cat) => (
                    <button
                      key={cat.id}
                      onClick={() => setFaqCategoryFilter(cat.id)}
                      className={`px-3 py-1 rounded-lg text-xs font-mono font-bold transition-colors shrink-0 ${
                        faqCategoryFilter === cat.id
                          ? 'bg-primary text-white'
                          : 'bg-surface-container border border-border-subtle text-on-surface-variant hover:text-on-surface'
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* FAQ Accordion List */}
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
                        <span
                          className={`material-symbols-outlined text-[20px] text-on-surface-variant shrink-0 transition-transform ${
                            isOpen ? 'rotate-180' : ''
                          }`}
                        >
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
                                className="px-4 py-2 rounded-lg bg-primary text-white text-xs font-bold hover:opacity-90 inline-flex items-center gap-1.5 shadow-xs"
                              >
                                <span>{faq.actionLink.label}</span>
                                <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                              </Link>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </article>
          )}

          {activeSectionId === 'tiers-quotas' && (
            <article className="space-y-8 leading-relaxed">
              <section className="space-y-3">
                <h2 className="text-lg font-bold text-primary">Account Tiers, Quotas & API Specs</h2>
                <p className="text-xs text-on-surface-variant">
                  WAKE enforces distinct execution priority tiers and capacity limits to protect sub-second mempool latency for active subscribers.
                </p>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
                  {/* Operator */}
                  <div className="p-4 rounded-xl border border-border-subtle bg-surface-container-lowest space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono font-bold uppercase text-primary">Operator</span>
                      <span className="px-2 py-0.5 rounded bg-primary/10 text-primary font-mono text-[10px] font-bold">Standard</span>
                    </div>
                    <div className="text-xl font-bold font-mono text-primary">35 USDC <span className="text-xs font-normal text-on-surface-variant font-sans">/ mo</span></div>
                    <ul className="text-xs text-on-surface-variant space-y-1.5 font-mono pt-2 border-t border-border-subtle">
                      <li>✓ 25 Master Wallets</li>
                      <li>✓ Jito Priority Relays</li>
                      <li>✓ Automated LP Rebalancing</li>
                      <li>✓ 30-Day Trade Depth</li>
                    </ul>
                    <Link
                      href="/billing?selected=operator"
                      className="w-full block py-2 text-center text-xs font-bold bg-primary text-white rounded-lg hover:opacity-90"
                    >
                      Select Operator
                    </Link>
                  </div>

                  {/* Ultra Whale */}
                  <div className="p-4 rounded-xl border border-purple-500/40 bg-surface-container-lowest space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono font-bold uppercase text-purple-400">Ultra Whale</span>
                      <span className="px-2 py-0.5 rounded bg-purple-500/20 text-purple-400 font-mono text-[10px] font-bold">Priority</span>
                    </div>
                    <div className="text-xl font-bold font-mono text-primary">150 USDC <span className="text-xs font-normal text-on-surface-variant font-sans">/ mo</span></div>
                    <ul className="text-xs text-on-surface-variant space-y-1.5 font-mono pt-2 border-t border-border-subtle">
                      <li>✓ Unlimited Master Wallets</li>
                      <li>✓ Dedicated Webhook Streams</li>
                      <li>✓ Sub-Second Priority Fan-Out</li>
                      <li>✓ 730-Day Backfill Depth</li>
                    </ul>
                    <Link
                      href="/billing?selected=ultra"
                      className="w-full block py-2 text-center text-xs font-bold border border-purple-500 text-purple-400 hover:bg-purple-500 hover:text-white rounded-lg transition-colors"
                    >
                      Select Ultra
                    </Link>
                  </div>

                  {/* Lifetime */}
                  <div className="p-4 rounded-xl border-2 border-amber-500/40 bg-surface-container-lowest space-y-3 relative shadow-xs">
                    <span className="absolute -top-2.5 right-4 px-2 py-0.5 rounded bg-amber-500 text-white text-[9px] font-bold uppercase tracking-wider">
                      Best Value
                    </span>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono font-bold uppercase text-amber-500">Lifetime Pass</span>
                      <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 font-mono text-[10px] font-bold">Perpetual</span>
                    </div>
                    <div className="text-xl font-bold font-mono text-primary">1,999 USDC <span className="text-xs font-normal text-on-surface-variant font-sans">one-time</span></div>
                    <ul className="text-xs text-on-surface-variant space-y-1.5 font-mono pt-2 border-t border-border-subtle">
                      <li>✓ Permanent Ultra Access Forever</li>
                      <li>✓ Zero Recurring Monthly Fees</li>
                      <li>✓ Private Core Telegram Access</li>
                      <li>✓ All Future Protocol Chains</li>
                    </ul>
                    <Link
                      href="/billing?selected=lifetime"
                      className="w-full block py-2 text-center text-xs font-bold bg-amber-500 text-white rounded-lg hover:opacity-90"
                    >
                      Secure Lifetime Spot
                    </Link>
                  </div>
                </div>
              </section>

              <div className="pt-2 flex items-center gap-3">
                <Link
                  href="/billing"
                  className="px-4 py-2.5 rounded-lg bg-primary text-white text-xs font-bold hover:opacity-90 flex items-center gap-2"
                >
                  <span>Go to Billing Management</span>
                  <span className="material-symbols-outlined text-[16px]">launch</span>
                </Link>
              </div>
            </article>
          )}
        </main>
      </div>
    </div>
  );
}
