'use client';

import { useState } from 'react';
import Discover from '../../lp/discover/page.js';
import Whales from '../../lp/whales/page.js';
import Builder from '../../lp/builder/page.js';
import Positions from '../../lp/positions/page.js';

/** One implementation for standalone and workspace LP surfaces: no alternate authority or economics. */
export default function LpView() {
  const [tab, setTab] = useState<'discover' | 'whales' | 'builder' | 'positions'>('discover');
  return <section className="p-6 space-y-6">
    <p role="status" className="text-xs text-on-surface-variant">Recorded LP observations and paper planning only. Runtime provider and live execution acceptance are unavailable.</p>
    <nav className="flex gap-3" aria-label="LP workspace sections">
      {(['discover', 'whales', 'builder', 'positions'] as const).map(value => <button key={value}
        onClick={() => setTab(value)} aria-pressed={tab === value} className="px-3 py-2 border rounded capitalize">{value}</button>)}
    </nav>
    {tab === 'discover' ? <Discover /> : tab === 'whales' ? <Whales /> : tab === 'builder' ? <Builder /> : <Positions />}
  </section>;
}
