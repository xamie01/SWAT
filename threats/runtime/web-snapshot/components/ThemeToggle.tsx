'use client';

import React from 'react';
import { useTheme } from './ThemeProvider.js';

interface ThemeToggleProps {
  className?: string;
  showLabel?: boolean;
}

export function ThemeToggle({ className = '', showLabel = false }: ThemeToggleProps) {
  const { theme, toggleTheme, isMounted } = useTheme();

  if (!isMounted) {
    return (
      <div
        className={`w-7 h-7 rounded border border-border-subtle bg-surface-container flex items-center justify-center opacity-40 ${className}`}
        aria-hidden="true"
      >
        <span className="material-symbols-outlined text-[16px]">dark_mode</span>
      </div>
    );
  }

  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      onClick={toggleTheme}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className={`inline-flex items-center justify-center gap-1.5 p-1.5 rounded border border-border-subtle hover:border-border-prominent bg-surface-container-lowest/80 hover:bg-surface-container text-on-surface transition-all duration-200 select-none group shadow-xs ${className}`}
    >
      <span
        className={`material-symbols-outlined text-[16px] transition-transform duration-300 group-hover:rotate-45 ${
          isDark ? 'text-amber-400' : 'text-crimson-signal'
        }`}
      >
        {isDark ? 'light_mode' : 'dark_mode'}
      </span>
      {showLabel && (
        <span className="text-[10px] font-mono font-medium uppercase tracking-wider text-on-surface-variant group-hover:text-on-surface">
          {isDark ? 'LIGHT' : 'DARK'}
        </span>
      )}
    </button>
  );
}
