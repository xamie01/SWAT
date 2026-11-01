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
      {/* Official Geometric Wake Whale Tail Emblem */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/wake-logo.png"
        alt="Wake Protocol Logo"
        width={40}
        height={40}
        className={`${iconDimensions} shrink-0 object-contain dark:hidden block`}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/wake-logo-white.png"
        alt="Wake Protocol Logo"
        width={40}
        height={40}
        className={`${iconDimensions} shrink-0 object-contain dark:block hidden`}
      />

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
