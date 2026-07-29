import type { ReactNode } from 'react';
import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'WAKE | Operational Cross-Chain Intelligence',
  description: 'Operational cross-chain intelligence layer'
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="light">
      <head>
        {/* Tailwind CSS CDN */}
        <script src="https://cdn.tailwindcss.com?plugins=forms,container-queries" async></script>
        
        {/* Custom Tailwind Config */}
        <script dangerouslySetInnerHTML={{
          __html: `
            window.tailwindConfigInit = function() {
              if (window.tailwind) {
                window.tailwind.config = {
                  darkMode: "class",
                  theme: {
                    extend: {
                      "colors": {
                        "on-primary-fixed": "#1c1b1b",
                        "surface-container-high": "#ebe7e6",
                        "tertiary-container": "#1c1b1a",
                        "polymarket-violet": "#8B5CF6",
                        "on-secondary-container": "#626566",
                        "error": "#ba1a1a",
                        "surface-dim": "#ddd9d8",
                        "on-primary-container": "#858383",
                        "background": "#fdf8f8",
                        "inverse-primary": "#c8c6c5",
                        "surface-tint": "#5f5e5e",
                        "on-background": "#1c1b1b",
                        "surface-container-lowest": "#ffffff",
                        "error-container": "#ffdad6",
                        "secondary": "#5c5f60",
                        "secondary-fixed": "#e1e3e4",
                        "on-secondary-fixed-variant": "#454748",
                        "primary-container": "#1c1b1b",
                        "status-error": "#EF4444",
                        "on-tertiary": "#ffffff",
                        "on-secondary-fixed": "#191c1d",
                        "status-warning": "#F59E0B",
                        "on-surface": "#1c1b1b",
                        "on-secondary": "#ffffff",
                        "secondary-fixed-dim": "#c5c7c8",
                        "primary-fixed": "#e5e2e1",
                        "surface-container-highest": "#e5e2e1",
                        "robinhood-amber": "#FFB800",
                        "on-surface-variant": "#444748",
                        "surface-container-low": "#f7f3f2",
                        "inverse-on-surface": "#f4f0ef",
                        "solana-teal": "#14F195",
                        "outline-variant": "#c4c7c7",
                        "tertiary-fixed-dim": "#cac6c3",
                        "inverse-surface": "#313030",
                        "outline": "#747878",
                        "status-success": "#10B981",
                        "tertiary": "#000000",
                        "on-tertiary-fixed-variant": "#484645",
                        "border-subtle": "#E2E8F0",
                        "on-error": "#ffffff",
                        "on-error-container": "#93000a",
                        "surface-variant": "#e5e2e1",
                        "on-primary-fixed-variant": "#474646",
                        "on-tertiary-fixed": "#1c1b1a",
                        "surface": "#fdf8f8",
                        "primary": "#000000",
                        "surface-bright": "#fdf8f8",
                        "on-tertiary-container": "#868381",
                        "surface-container": "#f1edec",
                        "secondary-container": "#e1e3e4",
                        "on-primary": "#ffffff",
                        "status-neutral": "#64748B",
                        "tertiary-fixed": "#e6e1df",
                        "primary-fixed-dim": "#c8c6c5"
                      },
                      "borderRadius": {
                        "DEFAULT": "0.125rem",
                        "lg": "0.25rem",
                        "xl": "0.5rem",
                        "full": "0.75rem",
                        "wake": "0.5rem"
                      },
                      "spacing": {
                        "data-row-height": "48px",
                        "margin-desktop": "32px",
                        "gutter": "24px",
                        "stack-xs": "4px",
                        "container-max": "1440px",
                        "stack-sm": "8px",
                        "stack-md": "16px",
                        "margin-mobile": "16px"
                      },
                      "fontFamily": {
                        "body-md": ["Geist"],
                        "headline-lg": ["Geist"],
                        "mono-data": ["Geist"],
                        "label-caps": ["Geist"],
                        "body-sm": ["Geist"],
                        "headline-md": ["Geist"]
                      },
                      "fontSize": {
                        "body-md": ["15px", {"lineHeight": "24px", "fontWeight": "400"}],
                        "headline-lg": ["28px", {"lineHeight": "36px", "letterSpacing": "-0.02em", "fontWeight": "600"}],
                        "mono-data": ["13px", {"lineHeight": "20px", "letterSpacing": "-0.01em", "fontWeight": "500"}],
                        "label-caps": ["11px", {"lineHeight": "16px", "letterSpacing": "0.08em", "fontWeight": "600"}],
                        "body-sm": ["13px", {"lineHeight": "20px", "fontWeight": "400"}],
                        "headline-md": ["20px", {"lineHeight": "28px", "letterSpacing": "-0.01em", "fontWeight": "600"}]
                      }
                    }
                  }
                };
              }
            };
            if (window.tailwind) {
              window.tailwindConfigInit();
            } else {
              window.addEventListener('load', function() {
                if (window.tailwindConfigInit) window.tailwindConfigInit();
              });
            }
          `
        }} />
        
        {/* Google Fonts */}
        <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&amp;display=swap" rel="stylesheet" />
        <link href="https://fonts.googleapis.com/css2?family=Geist:wght@100..900&amp;display=swap" rel="stylesheet" />
        <link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@100..900&amp;display=swap" rel="stylesheet" />
        
        {/* Custom Styles */}
        <style dangerouslySetInnerHTML={{
          __html: `
            .material-symbols-outlined {
              font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;
              vertical-align: middle;
            }
            .custom-scrollbar::-webkit-scrollbar {
              width: 4px;
              height: 4px;
            }
            .custom-scrollbar::-webkit-scrollbar-track {
              background: transparent;
            }
            .custom-scrollbar::-webkit-scrollbar-thumb {
              background: #e5e2e1;
              border-radius: 10px;
            }
            .custom-scrollbar::-webkit-scrollbar-thumb:hover {
              background: #c8c6c5;
            }
            .mono-font {
              font-family: 'Geist Mono', monospace;
            }
            .bento-grid {
              display: grid;
              grid-template-columns: repeat(12, 1fr);
              grid-gap: 16px;
            }
            .scanline {
              width: 100%;
              height: 2px;
              background: rgba(20, 241, 149, 0.2);
              position: absolute;
              animation: scan 4s linear infinite;
            }
            @keyframes scan {
              0% { top: 0%; }
              100% { top: 100%; }
            }
          `
        }} />
      </head>
      <body style={{ backgroundColor: '#fdf8f8', color: '#1c1b1b', margin: 0, padding: 0 }}>
        {children}
      </body>
    </html>
  );
}
