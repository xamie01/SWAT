'use client';

import React from 'react';

interface WakeLogoProps {
  className?: string;
  showText?: boolean;
  size?: 'sm' | 'md' | 'lg';
  textClassName?: string;
}

export function WakeLogo({
  className = '',
  showText = true,
  size = 'md',
  textClassName = '',
}: WakeLogoProps) {
  const iconDimensions = {
    sm: 'w-6 h-6',
    md: 'w-8 h-8',
    lg: 'w-10 h-10',
  }[size];

  const textSize = {
    sm: 'text-base',
    md: 'text-xl',
    lg: 'text-2xl',
  }[size];

  return (
    <div className={`inline-flex items-center gap-2.5 ${className}`}>
      {/* Permanent Vector Whale Fin / Signal Wave Emblem */}
      <svg
        className={`${iconDimensions} shrink-0`}
        viewBox="0 0 40 40"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-label="Wake Protocol Logo"
      >
        <defs>
          <linearGradient id="wakeFinGrad" x1="4" y1="4" x2="36" y2="36" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#14F195" />
            <stop offset="50%" stopColor="#06B6D4" />
            <stop offset="100%" stopColor="#3B82F6" />
          </linearGradient>
          <linearGradient id="wakeAccentGrad" x1="12" y1="20" x2="28" y2="32" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#14F195" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#3B82F6" stopOpacity="0.2" />
          </linearGradient>
        </defs>

        {/* Whale Dorsal Fin / Alpha Wave Geometry */}
        <path
          d="M 6 32 C 14 32 18 25 21 16 C 23 10 26 5 34 4 C 33 13 29 21 24 26 C 19 31 13 32 6 32 Z"
          fill="url(#wakeFinGrad)"
        />
        {/* Trailing Dynamic Water / Speed Arc */}
        <path
          d="M 12 34 C 18 34 23 30 27 24 C 29 21 31 17 33 13"
          stroke="url(#wakeFinGrad)"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        {/* Core Submerged Counter-Accent */}
        <path
          d="M 10 32 C 16 32 20 27 22 20 C 18 24 14 27 10 32 Z"
          fill="url(#wakeAccentGrad)"
        />
      </svg>

      {showText && (
        <span
          className={`font-headline-md font-black tracking-tight text-primary select-none ${textSize} ${textClassName}`}
        >
          Wake Protocol
        </span>
      )}
    </div>
  );
}
