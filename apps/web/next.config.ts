import type { NextConfig } from 'next';
import path from 'node:path';

import { resolveBackendTarget } from './lib/backend-target';

const BACKEND_API_INTERNAL_URL = resolveBackendTarget('api');
const BACKEND_LP_INTERNAL_URL = resolveBackendTarget('lp');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: process.env.VERCEL
    ? path.resolve(__dirname, '.')
    : path.resolve(__dirname, '../../'),
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'Content-Security-Policy', value: "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'" },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'no-referrer' }
    ] }];
  },
  async rewrites() {
    const apiTarget = BACKEND_API_INTERNAL_URL.replace(/\/+$/, '');
    const lpTarget = BACKEND_LP_INTERNAL_URL.replace(/\/+$/, '');
    return [
      {
        source: '/v1/lp/:path*',
        destination: `${lpTarget}/v1/lp/:path*`
      },
      {
        source: '/v1/:path*',
        destination: `${apiTarget}/v1/:path*`
      }
    ];
  },
  webpack: (config) => {
    config.resolve = config.resolve || {};
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
      '.mjs': ['.mts', '.mjs']
    };
    config.resolve.fallback = {
      ...config.resolve.fallback,
      '@x402/evm': false,
      '@x402/evm/upto/client': false,
      '@x402/evm/exact/client': false,
      '@coinbase/cdp-sdk': false,
    };
    config.externals = [...(config.externals || []), '@x402/evm', '@coinbase/cdp-sdk'];
    return config;
  }
};

export default nextConfig;
