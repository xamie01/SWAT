import type { NextConfig } from 'next';
import path from 'node:path';

const sanitizeUrl = (url: string | undefined, fallback: string) => {
  let target = (!url || url.includes('[SENSITIVE]') || !url.startsWith('http')) ? fallback : url;
  // INF-04 / WEB-04: Upgrade remote non-loopback rewrite destinations to HTTPS in production
  if (process.env.NODE_ENV === 'production' && target.startsWith('http://')) {
    if (!target.includes('localhost') && !target.includes('127.0.0.1')) {
      target = target.replace(/^http:\/\//, 'https://');
    }
  }
  return target;
};

const BACKEND_API_INTERNAL_URL = sanitizeUrl(
  process.env.BACKEND_API_INTERNAL_URL || process.env.INTERNAL_API_URL,
  process.env.NODE_ENV === 'production' ? 'https://75.119.151.184:3001' : 'http://localhost:3001'
);

const BACKEND_LP_INTERNAL_URL = sanitizeUrl(
  process.env.BACKEND_LP_INTERNAL_URL || process.env.INTERNAL_LP_URL,
  process.env.NODE_ENV === 'production' ? 'https://75.119.151.184:3010' : 'http://localhost:3010'
);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: process.env.VERCEL
    ? path.resolve(__dirname, '.')
    : path.resolve(__dirname, '../../'),
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
    return config;
  }
};

export default nextConfig;
