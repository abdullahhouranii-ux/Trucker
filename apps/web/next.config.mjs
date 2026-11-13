// The site is served under a language prefix. The bare address goes to English until
// language negotiation is designed (not decided: see docs/delivery/WEB_FOUNDATION_SLICE_3.md).
/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async redirects() {
    return [{ source: '/', destination: '/en', permanent: false }];
  },
};

export default nextConfig;
