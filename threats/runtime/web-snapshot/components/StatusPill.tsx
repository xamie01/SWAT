'use client';

import React from 'react';

export type StreamState = 'connected' | 'reconnecting' | 'offline';

export interface StatusPillProps {
  state: StreamState;
  reconnectAttempts?: number;
}

export function StatusPill({ state, reconnectAttempts = 0 }: StatusPillProps) {
  if (state === 'connected') {
    return (
      <div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-status-success/10 border border-status-success/30 text-xs font-mono text-status-success tracking-tight">
        <span className="w-2 h-2 rounded-full bg-status-success animate-pulse" />
        <span>STREAM LIVE</span>
      </div>
    );
  }

  if (state === 'reconnecting') {
    return (
      <div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-status-warning/10 border border-status-warning/30 text-xs font-mono text-status-warning tracking-tight">
        <span className="w-2 h-2 rounded-full bg-status-warning animate-ping" />
        <span>RECONNECTING {reconnectAttempts > 0 ? `(${reconnectAttempts})` : ''}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-status-error/10 border border-status-error/30 text-xs font-mono text-status-error tracking-tight">
      <span className="w-2 h-2 rounded-full bg-status-error" />
      <span>OFFLINE</span>
    </div>
  );
}
