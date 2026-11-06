'use client';

import React from 'react';

export function LoadingSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="w-full space-y-3 animate-pulse" role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-12 bg-surface-container-high/60 rounded border border-border-subtle"
        />
      ))}
    </div>
  );
}

export function EmptyCard({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-8 text-center flex flex-col items-center justify-center">
      <div className="w-12 h-12 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant mb-4">
        <span className="material-symbols-outlined text-2xl">inbox</span>
      </div>
      <h3 className="font-headline-md text-lg font-semibold text-primary mb-1">{title}</h3>
      <p className="text-body-sm text-on-surface-variant max-w-md mb-6">{description}</p>
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          className="bg-primary text-white px-5 py-2 rounded-lg text-sm font-semibold hover:opacity-90 transition-opacity"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export function ErrorBanner({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="bg-status-error/10 border border-status-error/30 rounded-lg p-4 flex items-center justify-between text-status-error text-body-sm"
    >
      <div className="flex items-center gap-3">
        <span className="material-symbols-outlined text-xl">error</span>
        <span>{message}</span>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="px-3 py-1 bg-status-error text-white text-xs font-semibold rounded hover:opacity-90 transition-opacity"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function ChainBadge({ chain }: { chain: string }) {
  const norm = chain.toLowerCase();
  if (norm.includes('solana')) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono font-medium bg-[#14F195]/10 text-[#0E9F6E] dark:text-[#14F195] border border-[#14F195]/30">
        <span className="w-1.5 h-1.5 rounded-full bg-[#14F195]" />
        SOLANA
      </span>
    );
  }
  if (norm.includes('robinhood')) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono font-medium bg-[#FFB800]/10 text-[#B45309] dark:text-[#FFB800] border border-[#FFB800]/30">
        <span className="w-1.5 h-1.5 rounded-full bg-[#FFB800]" />
        ROBINHOOD 4663
      </span>
    );
  }
  if (norm.includes('polymarket') || norm.includes('polygon')) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono font-medium bg-[#8B5CF6]/10 text-[#6D28D9] dark:text-[#8B5CF6] border border-[#8B5CF6]/30">
        <span className="w-1.5 h-1.5 rounded-full bg-[#8B5CF6]" />
        POLYMARKET
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono font-medium bg-surface-container-high text-on-surface-variant border border-border-subtle">
      {chain.toUpperCase()}
    </span>
  );
}

export function TierBadge({ tier }: { tier: string }) {
  const t = tier.toLowerCase();
  if (t === 'lifetime') {
    return (
      <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-500/10 text-amber-600 border border-amber-500/40">
        ★ LIFETIME PASS
      </span>
    );
  }
  if (t === 'ultra') {
    return (
      <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-purple-500/10 text-purple-600 border border-purple-500/40">
        ULTRA
      </span>
    );
  }
  if (t === 'operator') {
    return (
      <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-blue-500/10 text-blue-600 border border-blue-500/40">
        OPERATOR
      </span>
    );
  }
  return (
    <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-surface-container-high text-on-surface-variant border border-border-subtle">
      FREE
    </span>
  );
}
