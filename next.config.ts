import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const nextConfig: NextConfig = {
  // Build into an alternate directory when NEXT_DIST_DIR is set.
  //
  // This exists for one reason: `next build` has no `--distDir` flag, so a
  // verification build has no way to avoid writing into `.next` — the exact
  // directory the running production server is serving from. Rebuilding into
  // it while the owner is using the app swaps chunks out from under live page
  // loads. The pre-commit gate therefore sets NEXT_DIST_DIR and this line is
  // what makes that isolation real; without it the gate silently clobbers the
  // live build.
  //
  // Deliberately NOT accompanied by `typescript.ignoreBuildErrors` or
  // `eslint.ignoreDuringBuilds`. An earlier version of this block carried both,
  // which meant any build run with NEXT_DIST_DIR set skipped type and lint
  // checking entirely — a verification build that verifies less than a normal
  // one is worse than no verification. Directory isolation is safe; disabling
  // the compiler is not.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Pin the workspace root: this repo can sit inside a parent folder that also
  // has a lockfile, and Next would otherwise trace files from that parent.
  turbopack: {
    root: dirname(fileURLToPath(import.meta.url)),
  },
  outputFileTracingExcludes: {
    "*": [
      "**/.sessions/**",
      "**/.e2e-instant-play/**",
      "**/downloads/**",
      "**/qa-screens/**",
      "**/qa-shots/**",
      "**/snapshots/**",
    ],
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
  async headers() {
    return [
      {
        // The worker file must never be served from the HTTP cache: a stale
        // copy keeps an old routing policy alive long after it was replaced.
        // `Service-Worker-Allowed: /` keeps the scope at the app root even if
        // the file is ever moved out of the root.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
  // Allow server-side fetches to external torrent indexers & metadata APIs
  serverExternalPackages: [
    "@libsql/client",
    "@prisma/client",
    "webtorrent",
  ],
};

export default nextConfig;
