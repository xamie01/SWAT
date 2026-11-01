'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import WorkspaceView from './views/WorkspaceView';
import CommandCenterView from './views/CommandCenterView';
import SignalsView from './views/SignalsView';
import WalletIntelView from './views/WalletIntelView';
import HealthView from './views/HealthView';
import RiskExecutionView from './views/RiskExecutionView';
import AttributionView from './views/AttributionView';
import LpView from './views/LpView';

type Tab = 'workspace' | 'command_center' | 'signals' | 'wallet_intel' | 'health' | 'risk_execution' | 'attribution' | 'lp_liquidity';

export default function WorkspaceShell() {
  const [activeTab, setActiveTab] = useState<Tab>('workspace');
  const [utcTime, setUtcTime] = useState('00:00:00 UTC');

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
      case 'lp_liquidity': return 'LP Liquidity & Copy';
      default: return 'WAKE';
    }
  };

  const navItems = [
    { id: 'workspace' as Tab, label: 'Workspace', icon: 'grid_view' },
    { id: 'command_center' as Tab, label: 'Command Center', icon: 'terminal' },
    { id: 'signals' as Tab, label: 'Signals', icon: 'sensors' },
    { id: 'wallet_intel' as Tab, label: 'Wallet Intel', icon: 'account_balance_wallet' },
    { id: 'lp_liquidity' as Tab, label: 'LP Liquidity', icon: 'water_drop' },
    { id: 'health' as Tab, label: 'Health', icon: 'monitor_heart' },
    { id: 'risk_execution' as Tab, label: 'Risk/Execution', icon: 'security' },
    { id: 'attribution' as Tab, label: 'Attribution', icon: 'assessment' },
  ];

  return (
    <div className="bg-background text-on-surface min-h-screen relative overflow-hidden font-sans">
      {/* SIDEBAR */}
      <aside className="fixed left-0 top-0 h-full w-[240px] flex flex-col z-50 bg-surface border-r border-outline-variant">
        <Link href="/" className="p-4 flex items-center gap-3 hover:opacity-80 transition-opacity">
          <img 
            alt="WAKE Whale Fin Logo" 
            className="w-8 h-8 object-contain" 
            src="https://lh3.googleusercontent.com/aida/AP1WRLtbiJamaZZC7KwG5HAC1bnTyrrpCooabzkx-afw4Hp3qnVeDYAxIj9CLKbXPMe92O_IlprpgSWFQtrJZtapEqhgnCmjmkhv1LuJYEAbn2qfgPjlfX3MnBwrz-NwtXz4Z-EEAR3Se7g1jQv9ih8wMXyH5w_5ItNZkzn3ToFuhTgeAt6kCATuziBpGQsuYGlz4yx3GgwHDVkghvJpYolBYA_-A1cOUIGqWivShnnDEsXeOA5JXcwqWUD4se4" 
          />
          <div>
            <h1 className="text-headline-md font-bold text-primary leading-none">WAKE</h1>
            <p className="text-[10px] font-bold text-on-surface-variant leading-none uppercase tracking-wider mt-1">Operational Intel</p>
          </div>
        </Link>
        
        <nav className="mt-6 flex-1 px-3 space-y-1">
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
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
        
        <div className="p-4 border-t border-outline-variant bg-surface-container-low">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-white">
              <span className="material-symbols-outlined text-sm">person</span>
            </div>
            <div className="overflow-hidden">
              <p className="text-xs font-bold truncate leading-none">Operator_72</p>
              <p className="text-[10px] text-on-surface-variant uppercase tracking-wider mt-1">Certified Level 4</p>
            </div>
          </div>
        </div>
      </aside>

      {/* TOP NAVIGATION */}
      <header className="fixed top-0 right-0 w-[calc(100%-240px)] flex justify-between items-center px-6 md:px-8 h-16 z-40 bg-surface border-b border-outline-variant">
        <div className="flex items-center gap-8">
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold text-primary">{getTitle()}</span>
            <span className="px-2 py-0.5 rounded bg-surface-container-high text-[10px] font-bold uppercase text-on-surface-variant border border-outline-variant tracking-wider">
              Sandbox
            </span>
          </div>
          <div className="hidden md:flex items-center gap-6 text-on-surface-variant text-xs">
            <span className="font-mono">{utcTime}</span>
            <div className="h-3 w-px bg-outline-variant"></div>
            <span>All Chains</span>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="relative cursor-pointer">
            <span className="material-symbols-outlined p-2 text-on-surface-variant hover:text-primary transition-colors">notifications</span>
            <div className="absolute top-2 right-2 w-2 h-2 bg-status-error rounded-full ring-2 ring-surface"></div>
          </div>
          <span className="material-symbols-outlined p-2 text-on-surface-variant hover:text-primary transition-colors cursor-pointer">settings</span>
        </div>
      </header>

      {/* MAIN VIEW CANVAS */}
      <main className="ml-[240px] pt-16 h-screen overflow-y-auto custom-scrollbar bg-surface-container-low">
        {activeTab === 'workspace' && <WorkspaceView />}
        {activeTab === 'command_center' && <CommandCenterView />}
        {activeTab === 'signals' && <SignalsView />}
        {activeTab === 'wallet_intel' && <WalletIntelView />}
        {activeTab === 'lp_liquidity' && <LpView />}
        {activeTab === 'health' && <HealthView />}
        {activeTab === 'risk_execution' && <RiskExecutionView />}
        {activeTab === 'attribution' && <AttributionView />}
      </main>
    </div>
  );
}
