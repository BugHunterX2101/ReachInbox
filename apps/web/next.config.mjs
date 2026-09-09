/** @type {import('next').NextConfig} */
const API_URL = process.env.API_INTERNAL_URL ?? "http://localhost:3001";

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    // Same-origin proxy: the browser talks to :3000 only, cookies stay first-party,
    // and /admin/queues (Bull Board, FR-26) is reachable from the dashboard shell.
    return [
      { source: "/api/:path*", destination: `${API_URL}/api/:path*` },
      { source: "/admin/:path*", destination: `${API_URL}/admin/:path*` },
    ];
  },
};

export default nextConfig;
