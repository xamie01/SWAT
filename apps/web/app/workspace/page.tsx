'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { WakeLogo } from '../../components/WakeLogo.js';
import WorkspaceView from './views/WorkspaceView';
import CommandCenterView from './views/CommandCenterView';
import SignalsView from './views/SignalsView';
import WalletIntelView from './views/WalletIntelView';
import HealthView from './views/HealthView';
import RiskExecutionView from './views/RiskExecutionView';
import AttributionView from './views/AttributionView';

type Tab = 'workspace' | 'command_center' | 'signals' | 'wallet_intel' | 'health' | 'risk_execution' | 'attribution';

export default function WorkspaceShell() {
  const [activeTab, setActiveTab] = useState<Tab>('workspace');
  const [utcTime, setUtcTime] = useState('00:00:00 UTC');
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const hours = String(now.getUTCHours()).padStart(2, '0');
      const minutes = String(now.getUTCMinutes()).padStart(2, '0');
      const seconds = String(now.getUTCSeconds()).padStart(2, '0');
      setUtcTime(`${hours}:${minutes}:${seconds} UTC`);
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  const getTitle = () => {
    switch (activeTab) {
      case 'workspace': return 'Workspace';
      case 'command_center': return 'Command Center';
      case 'signals': return 'Signals Review';
      case 'wallet_intel': return 'Wallet Intelligence';
      case 'health': return 'Health Telemetry';
      case 'risk_execution': return 'Risk & Execution';
      case 'attribution': return 'Performance & Attribution';
      default: return 'WAKE';
    }
  };

  const navItems = [
    { id: 'workspace' as Tab, label: 'Workspace', icon: 'grid_view' },
    { id: 'command_center' as Tab, label: 'Command Center', icon: 'terminal' },
    { id: 'signals' as Tab, label: 'Signals', icon: 'sensors' },
    { id: 'wallet_intel' as Tab, label: 'Wallet Intel', icon: 'account_balance_wallet' },
    { id: 'health' as Tab, label: 'Health', icon: 'monitor_heart' },
    { id: 'risk_execution' as Tab, label: 'Risk/Execution', icon: 'security' },
    { id: 'attribution' as Tab, label: 'Attribution', icon: 'assessment' },
  ];

  return (
    <div className="bg-background text-on-surface min-h-screen relative overflow-hidden font-sans">
      {/* MOBILE BACKDROP OVERLAY */}
      {mobileSidebarOpen && (
        <div
          onClick={() => setMobileSidebarOpen(false)}
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm md:hidden animate-fade-in"
        />
      )}

      {/* SIDEBAR */}
      <aside className={`fixed left-0 top-0 h-full w-[240px] flex flex-col z-50 bg-surface border-r border-outline-variant transition-transform duration-200 ${
        mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
      }`}>
        <div className="p-4 flex items-center justify-between border-b border-outline-variant/30">
          <Link href="/" className="hover:opacity-85 transition-opacity">
            <WakeLogo size="sm" />
          </Link>
          <button
            onClick={() => setMobileSidebarOpen(false)}
            className="md:hidden p-1 text-on-surface-variant hover:text-primary rounded-lg"
          >
            <span className="material-symbols-outlined text-xl">close</span>
          </button>
        </div>
        
        <nav className="mt-4 flex-1 px-3 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  setActiveTab(item.id);
                  setMobileSidebarOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-3 py-2 text-[13px] font-medium rounded-lg transition-all ${
                  isActive 
                    ? 'text-primary font-bold border-l-2 border-primary bg-surface-container-high' 
                    : 'text-secondary hover:text-primary hover:bg-surface-container-low'
                }`}
              >
                <span className="material-symbols-outlined text-[20px]">{item.icon}</span>
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        
        <div className="p-3 border-t border-outline-variant bg-surface-container-low space-y-2">
          <Link
            href="/admin/portfolio"
            className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-lg bg-surface-container hover:bg-surface-container-high text-primary transition-colors"
          >
            <span className="material-symbols-outlined text-base">hub</span>
            <span>Trading Matrix</span>
          </Link>
          <div className="flex items-center gap-3 px-1 pt-1">
            <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center text-white">
              <span className="material-symbols-outlined text-xs">person</span>
            </div>
            <div className="overflow-hidden">
              <p className="text-xs font-bold truncate leading-none">Operator Console</p>
              <p className="text-[10px] text-on-surface-variant uppercase tracking-wider mt-0.5">Admin Verified</p>
            </div>
          </div>
        </div>
      </aside>

      {/* TOP NAVIGATION */}
      <header className="fixed top-0 right-0 w-full md:w-[calc(100%-240px)] flex justify-between items-center px-4 sm:px-6 md:px-8 h-16 z-40 bg-surface border-b border-outline-variant">
        <div className="flex items-center gap-3 sm:gap-6">
          <button
            type="button"
            onClick={() => setMobileSidebarOpen(true)}
            className="md:hidden p-1.5 text-on-surface-variant hover:text-primary rounded-lg hover:bg-surface-container transition-colors"
            aria-label="Open sidebar"
          >
            <span className="material-symbols-outlined text-2xl">menu</span>
          </button>
          <div className="flex items-center gap-2">
            <span className="text-base sm:text-lg font-bold text-primary truncate max-w-[150px] sm:max-w-none">{getTitle()}</span>
            <span className="hidden xs:inline-block px-2 py-0.5 rounded bg-surface-container-high text-[10px] font-bold uppercase text-on-surface-variant border border-outline-variant tracking-wider">
              Live
            </span>
          </div>
          <div className="hidden lg:flex items-center gap-6 text-on-surface-variant text-xs">
            <span className="font-mono">{utcTime}</span>
            <div className="h-3 w-px bg-outline-variant"></div>
            <span>All Chains</span>
          </div>
        </div>
        
        <div className="flex items-center gap-2 sm:gap-4">
          <Link
            href="/admin/portfolio"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-surface-container hover:bg-surface-container-high text-primary border border-border-subtle transition-colors"
          >
            <span className="material-symbols-outlined text-sm">hub</span>
            <span className="hidden sm:inline">Fleet Matrix</span>
          </Link>
        </div>
      </header>

      {/* MAIN VIEW CANVAS */}
      <main className="ml-0 md:ml-[240px] pt-16 h-screen overflow-y-auto custom-scrollbar bg-surface-container-low">
        {activeTab === 'workspace' && <WorkspaceView />}
        {activeTab === 'command_center' && <CommandCenterView />}
        {activeTab === 'signals' && <SignalsView />}
        {activeTab === 'wallet_intel' && <WalletIntelView />}
        {activeTab === 'health' && <HealthView />}
        {activeTab === 'risk_execution' && <RiskExecutionView />}
        {activeTab === 'attribution' && <AttributionView />}
      </main>
    </div>
  );
}
