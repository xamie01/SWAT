import type { NextConfig } from 'next';
import path from 'node:path';

const BACKEND_API_INTERNAL_URL =
  process.env.BACKEND_API_INTERNAL_URL ||
  process.env.INTERNAL_API_URL ||
  'http://75.119.151.184:3001';

const BACKEND_LP_INTERNAL_URL =
  process.env.BACKEND_LP_INTERNAL_URL ||
  process.env.INTERNAL_LP_URL ||
  'http://75.119.151.184:3010';

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
