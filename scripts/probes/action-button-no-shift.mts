/**
 * PROOF: the search card's Stream/Download buttons surface status/error INLINE
 * in a reserved slot with ZERO layout shift.
 *
 * Why a bundle-and-serve harness instead of `/search`:
 *   The real search page needs live indexer + catalog network to produce any
 *   card, which is not available here. Instead we bundle the *real* TorrentCard
 *   with esbuild in PRODUCTION mode (minified, NODE_ENV=production), serve it
 *   with the production-compiled app CSS from `.next/static`, and drive it with
 *   Playwright. It is a production build of the actual component — never
 *   `next dev` — which is the property under test.
 *
 * The probe:
 *   1. renders a card with the primary (built-in) client so Download is enabled,
 *   2. measures the card bounding-box height with NO message,
 *   3. stubs POST /api/torrent/send to fail, clicks Download,
 *   4. waits for the error to render in the button's reserved slot,
 *   5. asserts the card height is UNCHANGED and the message text is present.
 *
 * Serves on PORT (default 3100) — never binds 3000.
 *
 * Run: node node_modules/.bin/tsx scripts/probes/action-button-no-shift.mts
 */
import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const PORT = Number(process.env.PORT ?? 3100);
if (PORT === 3000) {
  throw new Error("This probe must not bind port 3000.");
}

// ---------------------------------------------------------------------------
// 1. Locate the production-compiled CSS (proves the real app styling is used).
// ---------------------------------------------------------------------------
function findAppCss(): string {
  const dir = path.join(root, ".next", "static", "chunks");
  const cssFiles = readdirSync(dir)
    .filter((f) => f.endsWith(".css"))
    .map((f) => path.join(dir, f));
  if (cssFiles.length === 0) {
    throw new Error(
      "No compiled CSS under .next/static/chunks — run `npm run build` first.",
    );
  }
  // Largest file is the global stylesheet with all utilities.
  cssFiles.sort(
    (a, b) => readFileSync(b).length - readFileSync(a).length,
  );
  return readFileSync(cssFiles[0], "utf8");
}
const appCss = findAppCss();

// ---------------------------------------------------------------------------
// 2. Bundle the REAL TorrentCard (production/minified) via an in-memory entry.
//    PlayOverlay is stubbed — the probe clicks Download, never opens a player,
//    so pulling the media stack in adds nothing but weight.
// ---------------------------------------------------------------------------
const entry = /* tsx */ `
import React from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { TorrentCard } from "@/components/search/torrent-card";
import type { TorrentResult } from "@/lib/torrents/types";

const torrent: TorrentResult = {
  id: "probe-1",
  title: "Probe Release 2024 1080p WEB-DL x264",
  magnet: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Probe",
  infoHash: "0123456789abcdef0123456789abcdef01234567",
  sizeBytes: 2_400_000_000,
  seeders: 42,
  leechers: 3,
  source: "nyaa",
  sourceUrl: "https://example.invalid/probe",
  tags: ["1080p", "WEB-DL"],
  publishedAt: new Date().toISOString(),
  route: {
    kind: "movies",
    category: "Movies",
    confidence: "high",
    savePath: null,
    relativePath: "Movies/Probe Release",
  },
};

function App() {
  return React.createElement(
    "div",
    { id: "harness", style: { width: 760, padding: 24, boxSizing: "border-box" } },
    React.createElement(TorrentCard, {
      torrent,
      index: 0,
      showPoster: true,
      showRoute: true,
    }),
    React.createElement(Toaster, { position: "bottom-right" }),
  );
}

createRoot(document.getElementById("root")!).render(
  React.createElement(App),
);
`;

const bundle = await build({
  stdin: {
    contents: entry,
    resolveDir: root,
    loader: "tsx",
    sourcefile: "probe-entry.tsx",
  },
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  write: false,
  logLevel: "silent",
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  banner: {
    js: "window.process = window.process || { env: { NODE_ENV: 'production' } };",
  },
  alias: {
    "@": path.join(root, "src"),
    // Player is never opened in this probe; stub keeps the bundle lean.
    "@/components/browse/play-overlay": path.join(
      root,
      "scripts",
      "probes",
      "stubs",
      "play-overlay.tsx",
    ),
  },
});
const bundleJs = bundle.outputFiles[0].text;

const html = `<!doctype html>
<html data-density="compact">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=1024" />
    <style>${appCss}</style>
    <style>body{margin:0;background:var(--bg,#0b0b0f)}</style>
  </head>
  <body>
    <div id="root"></div>
    <script>${bundleJs}</script>
  </body>
</html>`;

// ---------------------------------------------------------------------------
// 3. Serve the harness. /api/settings/client is answered so the primary client
//    resolves to the built-in engine (Download enabled). /api/torrent/send is
//    left to Playwright to fail, exercising the sendToClient catch/error path.
// ---------------------------------------------------------------------------
const server = createServer((req, res) => {
  if (req.url?.startsWith("/api/settings/client")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        settings: { clientType: "builtin", categories: [], pathRules: {} },
        defaults: { categories: [] },
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));

const browser = await chromium.launch();
let exitCode = 0;
try {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 900 },
  });

  // Force the send endpoint to fail — this is the error path the fix must
  // surface INLINE without moving anything.
  await page.route("**/api/torrent/send", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, message: "Send failed: client offline" }),
    }),
  );

  await page.goto(`http://127.0.0.1:${PORT}/`, {
    waitUntil: "domcontentloaded",
  });

  const card = page.locator("[data-torrent-card]");
  await card.waitFor({ state: "visible", timeout: 20_000 });
  const download = page.locator('[data-action="download"]');
  await download.waitFor({ state: "visible", timeout: 20_000 });

  const heightOf = async () =>
    Math.round(((await card.boundingBox())?.height ?? -1) * 100) / 100;

  // Reserved slot is present but blank before any interaction.
  const before = await heightOf();
  const slotBefore = await page
    .locator('[data-action="download"]')
    .locator("xpath=following-sibling::span[@data-action-status]")
    .innerText();

  await page.waitForTimeout(150);
  await download.click();

  // Wait for the error to land in the Download button's reserved slot.
  const errSlot = page
    .locator('[data-action="download"]')
    .locator("xpath=following-sibling::span[@data-action-status]");
  await errSlot
    .filter({ hasText: "Send failed" })
    .waitFor({ state: "visible", timeout: 10_000 });

  const messageText = (await errSlot.innerText()).trim();
  const variant = await errSlot.getAttribute("data-action-status-variant");
  const after = await heightOf();

  // Measure a couple more frames to be sure nothing settles late.
  await page.waitForTimeout(400);
  const afterSettled = await heightOf();

  const shift = Math.abs(after - before);
  const shiftSettled = Math.abs(afterSettled - before);
  const messagePresent = messageText.includes("Send failed");
  const withinSlot = messageText.length > 0 && variant === "error";

  console.log(
    JSON.stringify(
      {
        port: PORT,
        cardHeightBefore: before,
        cardHeightAfterError: after,
        cardHeightAfterSettled: afterSettled,
        layoutShiftPx: shift,
        layoutShiftSettledPx: shiftSettled,
        slotTextBefore: slotBefore,
        messageText,
        messageVariant: variant,
        messagePresentInReservedSlot: messagePresent && withinSlot,
      },
      null,
      2,
    ),
  );

  const failures: string[] = [];
  if (before <= 0) failures.push("card height not measured before message");
  if (slotBefore.trim() !== "")
    failures.push(`reserved slot was not blank before: "${slotBefore}"`);
  if (shift !== 0)
    failures.push(`card height changed on error: ${before} -> ${after}`);
  if (shiftSettled !== 0)
    failures.push(
      `card height changed after settle: ${before} -> ${afterSettled}`,
    );
  if (!messagePresent)
    failures.push(`error message not found in slot: "${messageText}"`);
  if (!withinSlot)
    failures.push("message not rendered as an error inside the reserved slot");

  if (failures.length > 0) {
    exitCode = 1;
    console.error("\nPROBE FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
  } else {
    console.log(
      `\nPROBE PASSED: height ${before}px == ${afterSettled}px (0 shift); ` +
        `error "${messageText}" rendered in the Download button's reserved slot.`,
    );
  }
} catch (err) {
  exitCode = 1;
  console.error("PROBE ERROR:", err);
} finally {
  await browser.close();
  server.close();
}

process.exit(exitCode);
