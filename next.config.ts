import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "s4.anilist.co" },
      { protocol: "https", hostname: "image.tmdb.org" },
    ],
  },
  // Allow server-side fetches to external torrent indexers & metadata APIs
  serverExternalPackages: [
    "@libsql/client",
    "@prisma/client",
    "better-sqlite3",
    "playwright",
    "webtorrent",
  ],
};

export default nextConfig;
