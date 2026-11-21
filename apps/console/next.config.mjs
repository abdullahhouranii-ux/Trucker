// The staff console. Nothing here is public: every page is kept out of caches, frames,
// search results and referrers.
/** @type {import('next').NextConfig} */
const nextConfig = {
  // Review builds can run beside an existing local server without replacing its output.
  distDir: process.env.TRUCKER_NEXT_BUILD_DIR || '.next',
  poweredByHeader: false,
  reactStrictMode: true,
  // Shared styles and form components are imported from the web application's sources.
  // Proof-of-delivery files pass through a server action: up to 10 files of 10 MB (slice 18b).
  experimental: { externalDir: true, serverActions: { bodySizeLimit: '105mb' } },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
    ];
  },
};

export default nextConfig;
