import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: process.cwd(),
  experimental: {
    staleTimes: {
      dynamic: 0,
    },
  },
  async headers() {
    if (process.env.VERCEL_ENV !== 'preview' || process.env.ASK_STAGING_ENABLED !== 'true') return [];
    return [{ source: '/:path*', headers: [
      { key: 'X-Robots-Tag', value: 'noindex, follow' },
      { key: 'Cache-Control', value: 'private, no-store, max-age=0' },
      { key: 'CDN-Cache-Control', value: 'no-store' },
      { key: 'Vercel-CDN-Cache-Control', value: 'no-store' },
    ] }];
  },
  async rewrites() {
    return {
      beforeFiles: [
        // /blocks is handled in proxy.ts: its filters exceed Vercel's
        // 16-condition limit for a single has/missing routing rule.
        {
          source: '/txs',
          destination: '/txs/latest',
          missing: ['cursor', 'cursor_idx', 'cursor_id', 'direction', 'page', 'type', 'flow_type', 'pool', 'min_zec'].map((key) => ({
            type: 'query' as const,
            key,
          })),
        },
      ],
      afterFiles: [
        {
          source: '/sitemap-:slug.xml',
          destination: '/sitemaps/:slug',
        },
      ],
      fallback: [],
    };
  },
  async redirects() {
    return [
      {
        source: '/:path*',
        has: [{ type: 'host', value: 'crosslink\\.cipherscan\\.app' }],
        destination: 'https://crosslink.zecblock.com/:path*',
        permanent: true,
      },
      // Preserve each network while redirecting legacy brand hostnames.
      {
        source: '/:path*',
        has: [{ type: 'host', value: '(?:www\\.)?cipherscan\\.app' }],
        destination: 'https://zecblock.com/:path*',
        permanent: true,
      },
      {
        source: '/:path*',
        has: [{ type: 'host', value: 'www\\.zecblock\\.com' }],
        destination: 'https://zecblock.com/:path*',
        permanent: true,
      },
      // Ask was renamed Zift; shared #r= research links keep their fragment.
      { source: '/ask', destination: '/zift', permanent: true },
      {
        source: '/migration',
        destination: '/ironwood',
        permanent: true,
      },
      {
        source: '/swap',
        destination: 'https://cipherswap.app/',
        permanent: true,
      },
      {
        source: '/flows',
        destination: '/crosschain',
        permanent: true,
      },
      // Incoming query parameters (pool, flow_type, min_zec, cursor) are appended.
      {
        source: '/txs/shielded',
        destination: '/txs?type=shielded',
        permanent: true,
      },
      {
        source: '/tools/privacy-check',
        destination: '/tools/blend-check',
        permanent: true,
      },
      {
        source: '/privacy-stats',
        destination: '/privacy',
        permanent: true,
      },
      {
        source: '/privacy/risks',
        destination: '/privacy-risks',
        permanent: true,
      },
      {
        source: '/blend-check',
        destination: '/tools/blend-check',
        permanent: true,
      },
    ];
  },
  webpack: (config, { isServer }) => {
    // Add WASM support
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
      layers: true,
    };

    // Handle .wasm files
    config.module.rules.push({
      test: /\.wasm$/,
      type: 'webassembly/async',
    });

    // Ignore .wasm files in node_modules for client-side
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,
      };
    }

    return config;
  },
};

export default nextConfig;
