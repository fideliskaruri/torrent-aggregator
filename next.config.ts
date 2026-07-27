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
    // Every artwork host the metadata layer can return. A host missing here
    // does not degrade — `next/image` rejects the URL outright and the poster
    // fails, so this list must track `src/lib/metadata/artwork.ts` exactly.
    remotePatterns: [
      { protocol: "https", hostname: "s4.anilist.co" },
      { protocol: "https", hostname: "image.tmdb.org" },
      { protocol: "https", hostname: "static.tvmaze.com" },
      // iTunes artwork is served from is1-ssl … is5-ssl.mzstatic.com, and
      // which one you get for a given asset is not stable.
      { protocol: "https", hostname: "**.mzstatic.com" },
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
