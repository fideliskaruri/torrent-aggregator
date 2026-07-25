import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const nextConfig: NextConfig = {
  // Pin the workspace root: this repo can sit inside a parent folder that also
  // has a lockfile, and Next would otherwise trace files from that parent.
  turbopack: {
    root: dirname(fileURLToPath(import.meta.url)),
  },
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
