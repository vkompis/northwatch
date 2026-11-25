// Static GitHub Pages copy (.github/workflows/pages.yml): plain files under a path prefix
const snapshot = process.env.NEXT_PUBLIC_SNAPSHOT === '1';
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // appDir is enabled by default in Next 14 app router; removing invalid key warning
  },
  ...(snapshot ? { output: 'export', basePath, images: { unoptimized: true } } : {}),
  transpilePackages: ['@svalmap/types', '@svalmap/ui', '@svalmap/config', 'maplibre-gl'],
  env: {
    MAP_BASE_URL: process.env.MAP_BASE_URL,
    MAP_ATTRIBUTION: process.env.MAP_ATTRIBUTION,
    NEXT_PUBLIC_MAP_STYLE: process.env.NEXT_PUBLIC_MAP_STYLE || `${basePath}/styles/svalmap-dark.json`,
    NEXT_PUBLIC_MAP_ATTRIBUTION:
      process.env.NEXT_PUBLIC_MAP_ATTRIBUTION ||
      'AIS: BarentsWatch, AISStream, <a href="https://www.digitraffic.fi/en/marine-traffic/" target="_blank" rel="noopener">Fintraffic / digitraffic.fi</a> (<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>) · Events: Global Fishing Watch',
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8787',
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
        ],
      },
    ];
  },
};

// A static export has no server to send these headers
if (snapshot) delete nextConfig.headers;

module.exports = nextConfig;
