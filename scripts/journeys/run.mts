/**
 * TorrentFlow user-journey suite — specs that read like user stories.
 *
 * Run:  npm run test:journeys
 *
 * Each journey encodes ONE real, user-reported bug and fails LOUDLY with the
 * value it measured when the bug is present. RED means "the bug is here"; GREEN
 * means "the app behaves"; BLOCKED means a precondition could not be met offline
 * (e.g. the search indexers are unreachable) so the journey honestly did not run
 * rather than pretend to pass.
 *
 * Report mode (default) always exits 0 and prints the RED/GREEN table. Set
 * JOURNEY_GATE=1 (or pass --gate) to turn RED into a non-zero exit for CI once
 * the bugs are fixed.
 *
 * Gate stage: pass a base URL as argv[2] —
 *   node scripts/journeys/run.mts http://127.0.0.1:3400
 * — to run against an already-running server (the pre-commit gate boots one on
 * :3400 against a COPY of dev.db and owns DB safety). In that mode we skip
 * booting our own dev server and exit non-zero on any RED, like the sibling
 * probes (responsive-audit / console-errors / loader-continuity).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser, Locator, Page } from "playwright";

import {
  Suite,
  startDevServer,
  launchBrowser,
  warmRoutes,
  cleanupScratchDb,
  artifactsDir,
  sleep,
  assertNotLiveDatabase,
  assertSafeSaveDir,
  MeasuredFailure,
  Blocked,
  type JourneyResult,
  type JourneyContext,
} from "./lib/harness.mjs";
import {
  ROUTES,
  DOWNLOADING_BADGE_LABELS,
  HomePage,
  PlayerPage,
  TitlePage,
  ClientPage,
  TorrentApi,
  SearchOverlay,
  auditResponsive,
  boxOf,
} from "./lib/pages.mjs";

// The app's own "is this state a download?" test, mirrored so the journey judges
// by the same rule the UI does. (src/app/client/page.tsx)
const isDownloadingState = (s: string) => /down|meta|stalledDL|allocat|queuedDL|checking/i.test(s);
const isDownloadRetention = (r?: string) => r !== "stream" && r !== "prewarm";

// A permanently-seeded, Creative Commons WebTorrent-project fixture (legal to
// redistribute — Big Buck Bunny, Blender Foundation, CC-BY). J4 adds it as a
// STREAM to get genuine in-flight bytes, measures, then bounds + deletes it. The
// magnet carries public trackers and the webtorrent.io web seed so the engine can
// pull real bytes whether or not P2P peers answer.
const FIXTURE = {
  name: "Big Buck Bunny (CC-BY fixture)",
  infoHash: "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c",
  magnet:
    "magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny" +
    "&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce" +
    "&tr=udp%3A%2F%2Fexplodie.org%3A6969" +
    "&tr=udp%3A%2F%2Ftracker.empire-js.us%3A1337" +
    "&tr=wss%3A%2F%2Ftracker.btorrent.xyz" +
    "&tr=wss%3A%2F%2Ftracker.openwebtorrent.com" +
    "&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F",
} as const;

interface Discovery {
  hasReadyPlay: boolean;
  playSource: string;
  titleHrefs: string[];
  firstTitle: string | null;
  seriesHref: string | null;
  /** A film (movie) whose hero shows BOTH Play and Download — for J8's pending-button test. */
  filmHref: string | null;
  /** The title whose file is already on disk (its hero shows Resume/Play) — J1 Path C. */
  readyTitleHref: string | null;
  /** Family Guy (or any series in the library) — J12's "Try again" no-op repro. */
  familyGuyHref: string | null;
}

/** Learn what the copied library actually contains so specs target real content. */
async function discover(browser: Browser, base: string): Promise<Discovery> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const out: Discovery = { hasReadyPlay: false, playSource: "none", titleHrefs: [], firstTitle: null, seriesHref: null, filmHref: null, readyTitleHref: null, familyGuyHref: null };
  try {
    const home = new HomePage(page);
    await home.open(base);
    if ((await home.readyPlayButton().count()) > 0) {
      out.hasReadyPlay = true;
      out.playSource = "home ready-to-play rail";
    }
    out.titleHrefs = await home.titleHrefs(24);
    out.firstTitle = out.titleHrefs[0] ?? null;
    // J12 targets the user's exact repro: Family Guy S01E02 has no seeded torrent,
    // so its "Try again" re-runs an identical failing search and cannot progress.
    out.familyGuyHref = out.titleHrefs.find((h) => /family-guy/i.test(h)) ?? null;

    // A builtin torrent Play button on /client also opens the player.
    if (!out.hasReadyPlay) {
      const client = new ClientPage(page);
      await client.open(base);
      if ((await page.locator("[data-client-play]").count()) > 0) {
        out.hasReadyPlay = true;
        out.playSource = "/client Play button";
      }
    }

    // First series (has season tabs). Prefer the continue-watching / ready-play
    // card's own title (the series the user is mid-watch on — the exact case the
    // "Play S06E01 over a Season 1 list" bug describes), then scan browse rails.
    const candidates: string[] = [];
    // The ready-to-play rail action sits on (or inside) a title card; walk up to
    // the enclosing title link to learn WHICH title is the on-disk one. That is
    // the title whose hero shows Resume/Play — the surface J1 Path C presses.
    const playAction = page.locator('[data-card-action="play"]').first();
    if (await playAction.count()) {
      const href = await playAction
        .evaluate((el) => {
          const card = el.closest('[data-card-target="title"], [data-rail-card]');
          return card?.getAttribute("href") ?? null;
        })
        .catch(() => null);
      if (href && href.startsWith("/title/")) {
        out.readyTitleHref = href;
        candidates.push(href);
      }
    }
    for (const h of out.titleHrefs) if (!candidates.includes(h)) candidates.push(h);
    const tp = new TitlePage(page);
    for (const href of candidates.slice(0, 24)) {
      await tp.open(base, href);
      const seasons = await tp.hasSeasons();
      if (seasons && !out.seriesHref) out.seriesHref = href;
      // A film shows a Download button on its hero and has no season tabs — the
      // surface J8 needs (a Play/Download that goes pending in place).
      if (!seasons && !out.filmHref && (await tp.download().count()) > 0) out.filmHref = href;
      if (out.seriesHref && out.filmHref) break;
    }
    // Explicit fallbacks the user named — films that show both Play and Download.
    if (!out.filmHref) {
      for (const slug of ["/title/dune", "/title/the-odyssey"]) {
        await tp.open(base, slug);
        if ((await tp.download().count()) > 0) {
          out.filmHref = slug;
          break;
        }
      }
    }
  } catch (err) {
    console.warn(`  [discover] ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await ctx.close().catch(() => {});
  }
  return out;
}

/** Open the real player overlay via whatever offline path exists. */
async function openAnyPlayer(page: Page, base: string): Promise<boolean> {
  const home = new HomePage(page);
  await home.open(base);
  const rp = home.readyPlayButton().first();
  if (await rp.count()) {
    await rp.scrollIntoViewIfNeeded().catch(() => {});
    await rp.click({ timeout: 8_000 }).catch(async () => {
      await rp.click({ force: true, timeout: 8_000 }).catch(() => {});
    });
    if (await waitOverlay(page)) return true;
  }
  // Fallback: /client builtin Play.
  const client = new ClientPage(page);
  await client.open(base);
  const cp = page.locator("[data-client-play]").first();
  if (await cp.count()) {
    await cp.click({ timeout: 8_000 }).catch(() => {});
    if (await waitOverlay(page)) return true;
  }
  return false;
}

async function waitOverlay(page: Page): Promise<boolean> {
  return page
    .locator("[data-play-overlay]")
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
}

type LoaderReading = Awaited<ReturnType<PlayerPage["stopAndReadLoaderProbe"]>>;

/**
 * Press one button with the loader probe already armed, then let it run to the
 * first presented frame (or an error / cap). The probe is installed BEFORE the
 * click so the button spinner and the button→overlay handoff are both observed.
 */
async function measureLoaderPath(
  page: Page,
  player: PlayerPage,
  target: Locator,
  timeoutMs: number,
): Promise<LoaderReading> {
  await player.markClicked(target);
  await player.installLoaderProbe();
  await target.click({ timeout: 8_000 }).catch(async () => {
    await target.click({ force: true, timeout: 8_000 }).catch(() => {});
  });
  await player.waitForFirstFrameOrIdle(timeoutMs);
  return player.stopAndReadLoaderProbe();
}

/** Build a human transition string: which node held the loader, in order, with gaps. */
function describeTransition(r: LoaderReading): string {
  if (r.nodesDetail.length === 0) return "no loader node observed";
  const parts = r.nodesDetail.map((n) => `#${n.id} ${n.owner}@[${n.firstAt}..${n.lastAt}]ms`);
  const gaps: string[] = [];
  for (let i = 1; i < r.nodesDetail.length; i++) {
    const prev = r.nodesDetail[i - 1];
    const cur = r.nodesDetail[i];
    const gap = cur.firstAt - prev.lastAt;
    gaps.push(gap >= 0 ? `+${gap}ms gap` : `${-gap}ms overlap`);
  }
  return parts.join("  →  ") + (gaps.length ? `  (handoff: ${gaps.join(", ")})` : "");
}

/**
 * Turn a probe reading into a verdict. The PRIMARY defect is identity handoff:
 * `uniqueNodes > 1` from press to first frame means the user watched one spinner die
 * and a different one be born — that is the bug, and `peak` never sees it because the
 * replacement is sequential. `peak===0` / no loader is NEVER a pass (proved nothing).
 */
function judgeLoader(
  label: string,
  r: LoaderReading,
): { line: string; red: string | null; blocked: boolean } {
  const frameSrc = r.firstFrameAt == null ? "none" : `${r.firstFrameAt}ms (${r.firstFrameSource})`;
  const hook = r.loaderHookSeen ? "data-player-loader" : "fallback(.animate-spin/data-stream-loading)";
  const detail =
    `nodes=${r.uniqueNodes} peak=${r.peak} animStarts=${r.animStarts} gap=${r.gapBeforeFrame} ` +
    `firstFrame=${frameSrc} loaderHook=${hook} err=${r.errorAt ?? "none"} counts=[${r.timeline}]`;
  if (!r.sawLoader || r.peak === 0) {
    return { line: `${label}: PROBE SAW NO LOADER (${detail})`, red: null, blocked: true };
  }
  const problems: string[] = [];
  if (r.uniqueNodes > 1) problems.push(`${r.uniqueNodes} distinct loader nodes press→frame (identity handoff)`);
  if (r.animStarts > 1) problems.push(`${r.animStarts} animationstarts (a different node's animation restarted)`);
  if (r.peak > 1) problems.push(`${r.peak} loaders on screen at once`);
  if (r.gapBeforeFrame) problems.push(`loader blinked to 0 before first frame`);
  if (problems.length) {
    return {
      line: `${label}: RED ${detail}\n        transition: ${describeTransition(r)}`,
      red: `${label}: ${problems.join("; ")} — transition: ${describeTransition(r)} [${detail}]`,
      blocked: false,
    };
  }
  return { line: `${label}: OK (one loader node throughout) ${detail}`, red: null, blocked: false };
}

function registerJourneys(suite: Suite, base: string, discovery: Discovery): void {
  // -----------------------------------------------------------------------
  // J1 — ONE LOADER
  // -----------------------------------------------------------------------
  suite.add({
    name: "J1 one-loader",
    bug: "From Play to first frame: exactly ONE loader node, continuously visible, one animation, never two at once — on the on-disk rail path, the grab-first path, AND the title-page Resume path (the /title/dune repro).",
    run: async (ctx: JourneyContext) =>
      ctx.withPage({}, async (page) => {
        const player = new PlayerPage(page);
        const lines: string[] = [];
        const reds: string[] = [];
        let ran = 0;

        // Path A — already-on-disk Play (home ready-to-play rail): one continuous
        // overlay loader from click to first painted frame.
        if (discovery.hasReadyPlay) {
          const home = new HomePage(page);
          await home.open(ctx.base);
          const rp = home.readyPlayButton().first();
          if (await rp.count()) {
            const verdict = judgeLoader("on-disk", await measureLoaderPath(page, player, rp, 9_000));
            lines.push(verdict.line);
            if (verdict.red) reds.push(verdict.red);
            if (!verdict.blocked) ran++;
          } else {
            lines.push("on-disk: no ready-play button — skipped");
          }
        } else {
          lines.push("on-disk: no ready-play source — skipped");
        }

        // Path B — grab-first Play (a search result that is NOT on disk): this is
        // where the button-spinner → overlay-loader handoff lives.
        {
          const home = new HomePage(page);
          await home.open(ctx.base);
          const overlay = new SearchOverlay(page);
          const opened = await overlay.open().then(() => true).catch(() => false);
          if (!opened) {
            lines.push("grab-first: search overlay would not open — skipped");
          } else {
            const outcome = await overlay.search("the office");
            if (outcome.errored || outcome.resultCount === 0) {
              lines.push(`grab-first: search returned ${outcome.resultCount} results (status ${outcome.status}) — skipped`);
            } else {
              const play = overlay.resultCards().first().locator('[data-action="play"]').first();
              if ((await play.count()) && !(await play.isDisabled().catch(() => false))) {
                const verdict = judgeLoader("grab-first", await measureLoaderPath(page, player, play, 9_000));
                lines.push(verdict.line);
                if (verdict.red) reds.push(verdict.red);
                if (!verdict.blocked) ran++;
              } else {
                lines.push("grab-first: first result Play disabled/absent — skipped");
              }
            }
          }
        }

        // Path C — title-page Resume with the file already on disk (the probe's
        // repro: /title/dune Resume). This is a DIFFERENT mount than the home rail
        // (Path A): the hero button's OWN spinner hands the loader off to the
        // PlayOverlay's spinner. Because node identity is tracked across
        // document.body, that sequential handoff surfaces as uniqueNodes>1 / a
        // second animationstart even though the two spinners never share the
        // screen — `peak` stays 1 and would be blind to it. (Live-build probe on
        // /title/dune: peak=1-glyph but nodes=3, animationstarts=2.)
        {
          const raw = [
            discovery.readyTitleHref,
            discovery.filmHref,
            discovery.firstTitle,
            ...discovery.titleHrefs.slice(0, 12),
            "/title/dune",
            "/title/the-odyssey",
          ];
          const candidates: string[] = [];
          for (const h of raw) if (h && !candidates.includes(h)) candidates.push(h);
          let measuredTitle = false;
          const skips: string[] = [];
          for (const href of candidates) {
            const tp = new TitlePage(page);
            await tp.open(ctx.base, href);
            const primary = tp.primary().first();
            // The hero renders only after the title payload resolves; [data-title-detail]
            // (the shell) appears first, so wait for the primary itself before reading it.
            await primary.waitFor({ state: "visible", timeout: 12_000 }).catch(() => {});
            if (!(await primary.count())) { skips.push(`${href}:no-hero`); continue; }
            if (await primary.isDisabled().catch(() => false)) { skips.push(`${href}:disabled`); continue; }
            const label = `${(await primary.innerText().catch(() => "")) ?? ""} ${
              (await primary.getAttribute("aria-label").catch(() => "")) ?? ""
            }`.replace(/\s+/g, " ").trim();
            // The readyTitleHref IS the on-disk item — press it regardless. For the
            // other candidates, skip only a PURE grab hero (Get/Download/Add with no
            // Resume/Play/Continue/Watch), which is Path B's surface, not the on-disk
            // player mount this path exists to probe.
            const isReady = href === discovery.readyTitleHref;
            if (!isReady && /\b(get|download|add)\b/i.test(label) && !/\b(resume|play|continue|watch)\b/i.test(label)) {
              skips.push(`${href}:grab("${label.slice(0, 20)}")`);
              continue;
            }
            await sleep(700); // let the title page hydrate, mirroring the probe's settle
            const verdict = judgeLoader(
              `title-resume(${href} "${label.slice(0, 18) || "icon"}")`,
              await measureLoaderPath(page, player, primary, 12_000),
            );
            lines.push(verdict.line);
            if (verdict.red) reds.push(verdict.red);
            if (verdict.blocked) { skips.push(`${href}:no-loader`); continue; }
            ran++;
            measuredTitle = true;
            break;
          }
          if (!measuredTitle) {
            lines.push(`title-resume: could not exercise a title hero mount — skipped [tried: ${skips.slice(0, 8).join(", ")}]`);
          }
        }

        ctx.log(lines.join(" | "));
        if (reds.length) throw new MeasuredFailure(`ONE LOADER violated — ${reds.join(" ;; ")}`, reds.join(" ;; ").slice(0, 40));
        if (ran === 0) throw new Blocked(`no loader path could run offline (${lines.join(" | ")})`);
        return lines.join(" | ");
      }),
  });

  // -----------------------------------------------------------------------
  // J2 — NO MECHANISM COPY
  // -----------------------------------------------------------------------
  suite.add({
    name: "J2 no-mechanism-copy",
    bug: 'Player never shows "Checking whether", "Getting it ready", "Resolving timeline", "Remuxing", "peers", or a raw Windows path.',
    run: async (ctx: JourneyContext) =>
      ctx.withPage({}, async (page) => {
        if (!discovery.hasReadyPlay) throw new Blocked("no ready-to-play source in the copied library");
        const opened = await openAnyPlayer(page, ctx.base);
        if (!opened) throw new Blocked("Play did not open the player overlay offline");
        const player = new PlayerPage(page);
        const banned = ["Checking whether", "Getting it ready", "Resolving timeline", "Remuxing", "peers"];
        const seen = new Set<string>();
        let sample = "";
        // Copy can be transient during load — sample repeatedly and accumulate.
        for (let i = 0; i < 12; i++) {
          const text = await player.visibleText();
          if (text) sample = text.replace(/\s+/g, " ").trim().slice(0, 200);
          for (const b of banned) if (text.includes(b)) seen.add(b);
          if (/[A-Za-z]:\\\\|[A-Za-z]:\\[^\s]/.test(text)) seen.add("<raw-windows-path>");
          await sleep(300);
        }
        if (seen.size > 0) {
          throw new MeasuredFailure(
            `NO MECHANISM COPY: player showed forbidden copy [${[...seen].join(", ")}] — visible text: "${sample}"`,
            [...seen].join(", "),
          );
        }
        return `no mechanism copy; player text sample="${sample.slice(0, 80)}"`;
      }),
  });

  // -----------------------------------------------------------------------
  // J3 — STREAM IS NOT A DOWNLOAD
  // -----------------------------------------------------------------------
  suite.add({
    name: "J3 stream-not-a-download",
    bug: "A Play-only (stream/prewarm) torrent must not be badged Downloading nor counted in the DOWNLOADING stat.",
    run: async (ctx: JourneyContext) =>
      ctx.withPage({}, async (page) => {
        const client = new ClientPage(page);
        await client.open(ctx.base);
        const torrents = await client.apiTorrents();
        if (torrents.length === 0) throw new Blocked("no torrents in the copied library to classify");
        const streams = torrents.filter((t) => t.retentionState === "stream" || t.retentionState === "prewarm");
        if (streams.length === 0) {
          throw new Blocked(
            `copied library has ${torrents.length} torrents but none classified stream/prewarm — nothing was Play-only to check`,
          );
        }
        const offenders: string[] = [];
        for (const t of streams) {
          const badge = await client.badgeLabelForHash(t.hash, DOWNLOADING_BADGE_LABELS);
          if (badge) offenders.push(`${t.hash.slice(0, 8)}[api:${t.retentionState}] badged "${badge}"`);
        }
        // DOM cross-check on the live `data-retention` hook: what the USER sees.
        // A row the markup itself labels stream/prewarm must never carry a
        // Downloading badge — independent of the API's own classification.
        const domRows = await client.domRows();
        const domStreams = domRows.filter((r) => r.retention === "stream" || r.retention === "prewarm");
        for (const r of domStreams) {
          if (offenders.some((o) => o.startsWith(r.hash.slice(0, 8)))) continue;
          const badge = await client.badgeLabelForHash(r.hash, DOWNLOADING_BADGE_LABELS);
          if (badge) offenders.push(`${r.hash.slice(0, 8)}[dom:${r.retention}] badged "${badge}"`);
        }
        const stat = await client.downloadingStat();
        const downloadDownloading = torrents.filter((t) => isDownloadRetention(t.retentionState) && isDownloadingState(t.state)).length;
        ctx.log(`streams=${streams.length} domStreams=${domStreams.length} offenders=${offenders.length} stat=${stat} downloadDownloading=${downloadDownloading}`);
        if (offenders.length > 0) {
          throw new MeasuredFailure(
            `STREAM IS NOT A DOWNLOAD: ${offenders.length} Play-only torrent(s) shown as downloading: ${offenders.join("; ")}`,
            String(offenders.length),
          );
        }
        if (stat != null && stat > downloadDownloading) {
          throw new MeasuredFailure(
            `DOWNLOADING stat counts stream torrents: stat=${stat} but only ${downloadDownloading} download-retention rows are downloading`,
            `${stat}>${downloadDownloading}`,
          );
        }
        return `checked ${streams.length} stream torrent(s); none badged/counted as downloading (stat=${stat})`;
      }),
  });

  // -----------------------------------------------------------------------
  // J4 — STREAM STOPS ON CLOSE
  // -----------------------------------------------------------------------
  suite.add({
    name: "J4 stream-stops-on-close",
    bug: "Closing the player must stop a stream torrent pulling bytes into storage without the user's consent.",
    run: async (ctx: JourneyContext) =>
      ctx.withPage({}, async (page) => {
        // --- SAFETY: re-assert scratch DB + scratch save path immediately before we
        //     add a REAL, seeded torrent. If either points at the user's data, abort.
        assertNotLiveDatabase();
        const saveRoot = assertSafeSaveDir(ctx.downloadDir);
        ctx.log(`safety OK — scratch DB verified; DOWNLOAD_DIR=${saveRoot} (temp, not .e2e-instant-play)`);

        await page.goto(ctx.base, { waitUntil: "domcontentloaded" });
        const api = new TorrentApi(page);
        const hash = FIXTURE.infoHash;
        let downloaded = 0;

        // Repoint the engine's download root to the scratch dir BEFORE adding —
        // the scratch DB inherited the user's REAL baseDownloadPath, and a stream
        // resolves its save path from that. Then verify the persisted value is safe.
        const repoint = await api.setSaveRoot(saveRoot);
        if (!repoint.ok || !repoint.baseDownloadPath) {
          throw new Blocked(`could not repoint the download root to the scratch dir (ok=${repoint.ok}); refusing to add a torrent that might write to the real library`);
        }
        assertSafeSaveDir(repoint.baseDownloadPath);
        ctx.log(`repointed baseDownloadPath -> ${repoint.baseDownloadPath} (scratch)`);

        try {
          const add = await api.addStream(FIXTURE.magnet, FIXTURE.name);
          if (!add.ok) {
            throw new Blocked(
              `could not add the CC fixture stream (HTTP ${add.status}${add.offline ? ", offline" : ""}): ${add.message || "no detail"}`,
            );
          }
          ctx.log(`added fixture as stream (retentionState=${add.retentionState ?? "?"})`);

          // 1) Wait for metadata — needs live peers/webseed. None ⇒ networking blocked.
          let file: { path: string; length: number } | null = null;
          let lastPeers: number | null = null;
          const metaDeadline = Date.now() + 45_000;
          while (Date.now() < metaDeadline) {
            const s = await api.streamSample(hash);
            lastPeers = s.peers;
            if (s.status === 200 && s.filePath && (s.length ?? 0) > 0) {
              file = { path: s.filePath, length: s.length as number };
              break;
            }
            await sleep(1_500);
          }
          if (!file) {
            throw new Blocked(
              `fixture metadata never arrived within 45s (peers=${lastPeers ?? "?"}) — P2P/webseed networking appears blocked for this run; cannot prove storage-without-consent`,
            );
          }
          ctx.log(`metadata ready: file="${file.path}" length=${(file.length / 1e6).toFixed(1)}MB`);

          // savePath guard — the engine's OWN record of where bytes land must be scratch.
          const sp = await api.savePathOf(hash);
          if (sp) {
            const resolvedSp = assertSafeSaveDir(sp);
            ctx.log(`torrent savePath=${resolvedSp} (verified under scratch root)`);
          }

          // 2) OPEN phase: pull bytes (ranged GETs = what the open player does) and
          //    confirm `downloaded` STRICTLY increases. downloadedRanges here are the
          //    live torrent bitfield — NOT the zeroed /api/client/torrents figures.
          const openStart = Date.now();
          const openBytes0 = (await api.streamSample(hash, file.path)).bytes;
          let openBytes = openBytes0;
          let cursor = 0;
          const chunk = 2 * 1024 * 1024;
          const openDeadline = Date.now() + 30_000;
          while (Date.now() < openDeadline) {
            await api.pullRange(hash, file.path, cursor, Math.min(file.length - 1, cursor + chunk - 1));
            cursor = cursor + chunk >= file.length - 1 ? 0 : cursor + chunk;
            await sleep(1_500);
            openBytes = (await api.streamSample(hash, file.path)).bytes;
            if (openBytes - openBytes0 >= 512 * 1024) break;
          }
          const openClimb = openBytes - openBytes0;
          const openSec = (Date.now() - openStart) / 1000;
          const openSample = await api.streamSample(hash, file.path);
          downloaded = openBytes;
          if (openClimb < 256 * 1024) {
            throw new Blocked(
              `no observable in-flight bytes while streaming (Δ=${(openClimb / 1024).toFixed(0)}KB in ${openSec.toFixed(0)}s, peers=${openSample.peers ?? "?"}, speed=${openSample.downloadSpeedBps ? (openSample.downloadSpeedBps / 1024).toFixed(0) + "KB/s" : "?"}) — needs a live seeder/webseed; the probe proved nothing`,
            );
          }
          ctx.log(
            `OPEN: downloaded climbed +${(openClimb / 1e6).toFixed(2)}MB in ${openSec.toFixed(0)}s (~${(openClimb / 1024 / Math.max(openSec, 0.001)).toFixed(0)}KB/s, peers=${openSample.peers ?? "?"})`,
          );

          // 3) CLOSE: exactly what inline-player.tsx releaseStream() posts, then reconcile.
          //    Intended behaviour (builtin-engine.ts:1863/1880 parkBuiltinStreamTorrent;
          //    inline-player.tsx:2024 "continuing to fetch it spends their storage
          //    without consent"): a STREAM is an evictable cache and must STOP pulling
          //    pieces on close. A parked stream may let a couple already-requested pieces
          //    land (<~1MB) then goes flat; "keeps climbing" 4–8s later is the bug.
          await api.releaseStream(hash);
          await api.syncPrewarm();
          const t2 = (await api.streamSample(hash, file.path)).bytes;
          await sleep(4_000);
          const t3 = (await api.streamSample(hash, file.path)).bytes;
          await sleep(4_000);
          const s4 = await api.streamSample(hash, file.path);
          const t4 = s4.bytes;
          downloaded = Math.max(downloaded, t4);
          const closeClimb = t4 - t2;
          const tailClimb = t4 - t3; // still pulling 4–8s AFTER close?
          ctx.log(
            `CLOSE: t2=${(t2 / 1e6).toFixed(2)}MB t3=${(t3 / 1e6).toFixed(2)}MB t4=${(t4 / 1e6).toFixed(2)}MB (closeΔ=+${(closeClimb / 1e6).toFixed(2)}MB, tailΔ=+${(tailClimb / 1e6).toFixed(2)}MB/4s, speed=${s4.downloadSpeedBps ? (s4.downloadSpeedBps / 1024).toFixed(0) + "KB/s" : "0"})`,
          );

          const TAIL_LIMIT = 1024 * 1024; // 1MB over the final 4s window (in-flight already drained by t3)
          if (tailClimb > TAIL_LIMIT) {
            throw new MeasuredFailure(
              `STREAM KEPT DOWNLOADING AFTER CLOSE: +${(tailClimb / 1e6).toFixed(2)}MB in the 4s AFTER releaseStream (total +${(closeClimb / 1e6).toFixed(2)}MB post-close, speed=${s4.downloadSpeedBps ? (s4.downloadSpeedBps / 1024).toFixed(0) + "KB/s" : "?"}) — storage without consent; expected the stream to park (builtin-engine.ts:1880 parkBuiltinStreamTorrent)`,
              `+${(tailClimb / 1e6).toFixed(2)}MB/4s`,
            );
          }
          return `stream parked on close: pulled +${(openClimb / 1e6).toFixed(2)}MB while open, then +${(tailClimb / 1e6).toFixed(2)}MB/4s after close (≤1MB in-flight slack); total ${(downloaded / 1e6).toFixed(1)}MB — asserts intended stop-on-close (builtin-engine.ts:1863)`;
        } finally {
          // Bound the download HARD: remove torrent + delete its files even if an
          // assertion threw. Then a guarded sweep of the scratch root (defence in depth;
          // harness stop() also rm's this dir). NEVER outside the guarded scratch path.
          await api.deleteTorrent(hash).catch(() => {});
          try {
            const safe = assertSafeSaveDir(saveRoot);
            for (const entry of fs.readdirSync(safe)) fs.rmSync(path.join(safe, entry), { recursive: true, force: true });
          } catch {
            /* harness stop() rm's leechDir regardless */
          }
          ctx.log(`cleanup: removed fixture torrent ${hash} + deleted files (kept ≤ ${(downloaded / 1e6).toFixed(1)}MB)`);
        }
      }),
  });

  // -----------------------------------------------------------------------
  // J5 — RESPONSIVE
  // -----------------------------------------------------------------------
  suite.add({
    name: "J5 responsive",
    bug: "No horizontal scroll; no text squeezed <120px into one-word-per-line; 44x44 touch targets on mobile — across all routes.",
    run: async (ctx: JourneyContext) => {
      const viewports = [
        { w: 320, h: 800, mobile: true },
        { w: 390, h: 844, mobile: true },
        { w: 768, h: 1024, mobile: false },
        { w: 1440, h: 900, mobile: false },
      ];
      const routes: Array<{ name: string; url: string }> = [
        { name: "home", url: ROUTES.home },
        { name: "search", url: ROUTES.search },
        { name: "client", url: ROUTES.client },
        { name: "activity", url: ROUTES.activity },
        { name: "settings", url: ROUTES.settings },
        { name: "watchlist", url: ROUTES.watchlist },
      ];
      if (discovery.firstTitle) routes.push({ name: "title", url: discovery.firstTitle });

      const overflow: string[] = [];
      const narrow: string[] = [];
      const small: string[] = [];
      let checks = 0;
      let firstFailShot: string | undefined;

      for (const vp of viewports) {
        const context = await ctx.browser.newContext({ viewport: { width: vp.w, height: vp.h } });
        const page = await context.newPage();
        try {
          for (const route of routes) {
            await page.goto(`${ctx.base}${route.url}`, { waitUntil: "domcontentloaded" }).catch(() => {});
            await sleep(700);
            const audit = await auditResponsive(page, vp.w, vp.mobile);
            checks++;
            if (audit.horizontalOverflowPx > 1) {
              overflow.push(`${route.name}@${vp.w}: scrollWidth ${audit.scrollWidth} > ${audit.innerWidth} (+${audit.horizontalOverflowPx}px)`);
            }
            if (audit.narrowText.length > 0) {
              const worst = audit.narrowText[0];
              narrow.push(`${route.name}@${vp.w}: "${worst.text}" in ${worst.width}px over ${worst.lines} lines (+${audit.narrowText.length - 1} more)`);
            }
            if (vp.mobile && audit.smallControls.length > 0) {
              const worst = audit.smallControls[0];
              small.push(`${route.name}@${vp.w}: "${worst.label}" ${worst.w}x${worst.h}px (+${audit.smallControls.length - 1} more)`);
            }
            if ((audit.horizontalOverflowPx > 1 || audit.narrowText.length || (vp.mobile && audit.smallControls.length)) && !firstFailShot) {
              firstFailShot = path.join(artifactsDir, `J5-${route.name}-${vp.w}.png`);
              await page.screenshot({ path: firstFailShot }).catch(() => {});
            }
          }
        } finally {
          await context.close().catch(() => {});
        }
      }

      const problems = [...overflow, ...narrow, ...small];
      ctx.log(`ran ${checks} route×viewport checks; ${overflow.length} overflow, ${narrow.length} narrow-text, ${small.length} small-control`);
      if (problems.length > 0) {
        const measured = `${overflow.length} h-scroll / ${narrow.length} squeezed-text / ${small.length} tiny-tap over ${checks} checks`;
        throw new MeasuredFailure(`RESPONSIVE: ${measured}. First offenders → ${problems.slice(0, 4).join(" | ")}${firstFailShot ? ` [shot: ${firstFailShot}]` : ""}`, measured);
      }
      return `clean across ${checks} route×viewport combinations`;
    },
  });

  // -----------------------------------------------------------------------
  // J6 — SEARCH RELEASES ARE DISTINGUISHABLE
  // -----------------------------------------------------------------------
  suite.add({
    name: "J6 search-releases-distinguishable",
    bug: "Expanded release rows must not all read identical text (e.g. 12 rows all '1080p · WEB-DL').",
    run: async (ctx: JourneyContext) =>
      ctx.withPage({}, async (page) => {
        const home = new HomePage(page);
        await home.open(ctx.base);
        const overlay = new SearchOverlay(page);
        await overlay.open().catch(() => {
          throw new Blocked("search overlay would not open");
        });
        const outcome = await overlay.search("the office");
        if (outcome.errored || outcome.resultCount === 0) {
          throw new Blocked(`search API returned status=${outcome.status}, ${outcome.resultCount} results (indexers offline) — cannot compare releases`);
        }
        const n = await overlay.expandFirstReleases();
        if (n < 2) throw new Blocked(`only ${n} release row(s) — need ≥2 to compare`);
        const texts = await overlay.releaseRowTexts();
        const distinct = new Set(texts.map((t) => t.trim())).size;
        ctx.log(`releases=${texts.length} distinct=${distinct} first="${texts[0]}"`);
        if (distinct <= 1) {
          throw new MeasuredFailure(
            `SEARCH RELEASES: ${texts.length} release rows but only ${distinct} distinct label — all read "${texts[0]}"`,
            `${distinct}/${texts.length}`,
          );
        }
        return `${distinct} distinct labels across ${texts.length} release rows`;
      }),
  });

  // -----------------------------------------------------------------------
  // J7 — RESULT TITLE CLOSES OVERLAY; INNER PLAY DOES NOT
  // -----------------------------------------------------------------------
  suite.add({
    name: "J7 result-click-closes-overlay",
    bug: "Clicking a result title closes the overlay and navigates; clicking Play/Download inside it does NOT close it.",
    run: async (ctx: JourneyContext) =>
      ctx.withPage({}, async (page) => {
        const home = new HomePage(page);
        await home.open(ctx.base);
        const overlay = new SearchOverlay(page);
        await overlay.open().catch(() => {
          throw new Blocked("search overlay would not open");
        });
        const outcome = await overlay.search("the office");
        if (outcome.errored || outcome.resultCount === 0) {
          throw new Blocked(`search API returned status=${outcome.status}, ${outcome.resultCount} results (indexers offline) — no result to click`);
        }
        // Part A: title click must close overlay AND navigate.
        const titleLink = overlay.resultCards().first().locator('[data-card-target="title"]').first();
        const href = (await titleLink.getAttribute("href").catch(() => null)) ?? "(none)";
        // The card's action buttons overlay the centre of this full-card anchor;
        // click a top-left corner so we hit the title, not a Play/Download button.
        await titleLink.click({ position: { x: 8, y: 8 } });
        // Wait for the REAL post-condition (soft navigation), not a fixed delay —
        // dev-mode route compilation can make the first /title/ navigation take a
        // few seconds, and a fixed sleep would false-RED on that latency.
        let navigated = true;
        await page.waitForURL("**/title/**", { timeout: 10_000 }).catch(() => {
          navigated = false;
        });
        const stillOpenAfterTitle = await overlay.isOpen();
        const url = page.url();
        if (stillOpenAfterTitle) {
          throw new MeasuredFailure(`overlay stayed OPEN after clicking a result title (href=${href}, url=${url})`, "overlay-open");
        }
        if (!navigated || !/\/title\//.test(url)) {
          throw new MeasuredFailure(
            `clicking a result title closed the overlay but did NOT navigate (href=${href}, url=${url}) — the title link's navigation was swallowed`,
            url,
          );
        }
        // Part B: inner Play must NOT close the overlay.
        await home.open(ctx.base);
        await overlay.open();
        const outcome2 = await overlay.search("the office");
        if (outcome2.resultCount === 0) return `title-click closed+navigated; (inner-play not re-checked: results vanished)`;
        const play = overlay.resultCards().first().locator('[data-action="play"]').first();
        if (await play.count()) {
          await play.click().catch(() => {});
          await sleep(700);
          if (!(await overlay.isOpen())) {
            throw new MeasuredFailure(`overlay CLOSED after clicking inner Play — should stay open`, "closed-on-play");
          }
        }
        return `title-click closed+navigated to ${url}; inner Play kept overlay open`;
      }),
  });

  // -----------------------------------------------------------------------
  // J8 — NO LAYOUT SHIFT ON ACTION
  // -----------------------------------------------------------------------
  suite.add({
    name: "J8 no-layout-shift-on-action",
    bug: "A Play/Download button must not change size while pending (loading state lives inside the button).",
    run: async (ctx: JourneyContext) =>
      ctx.withPage({}, async (page) => {
        const href = discovery.filmHref ?? discovery.firstTitle;
        if (!href) throw new Blocked("no title page discovered to exercise a pending button");
        const title = new TitlePage(page);
        await title.open(ctx.base, href);
        await title.primary().first().waitFor({ timeout: 15_000 }).catch(() => {});
        // The Download (keep) button is the ideal pending-in-place surface, but it
        // only appears once the hero's primary.kind resolves from an initial "get"
        // to "play"/"stream" (showDownload = primary.kind !== "get"), so poll briefly
        // rather than race that flip.
        let btn = title.download();
        const dlDeadline = Date.now() + 6_000;
        while ((await btn.count()) === 0 && Date.now() < dlDeadline) {
          await sleep(300);
          btn = title.download();
        }
        if (!(await btn.count())) {
          const primary = title.primary();
          const kind = (await primary.first().getAttribute("data-action-kind").catch(() => null)) ?? "";
          // A "get" primary IS the download — it too goes pending in place.
          if (kind === "get") btn = primary;
          else throw new Blocked(`no pending-in-place action on ${href} (primary kind="${kind}", no Download button after 6s — needs a film like /title/dune)`);
        }
        const target = btn.first();
        if (await target.isDisabled().catch(() => false)) throw new Blocked("action button is disabled — cannot trigger pending");
        const box0 = await boxOf(target);
        if (!box0) throw new Blocked("could not measure the button box");
        await target.click({ noWaitAfter: true }).catch(() => {});
        // Sample the box tightly while it is (hopefully) pending.
        let maxDW = 0;
        let maxDH = 0;
        let sawPending = false;
        for (let i = 0; i < 20; i++) {
          const busy = (await target.getAttribute("aria-busy").catch(() => null)) === "true";
          if (busy) sawPending = true;
          const b = await boxOf(target);
          if (b) {
            maxDW = Math.max(maxDW, Math.abs(b.w - box0.w));
            maxDH = Math.max(maxDH, Math.abs(b.h - box0.h));
          }
          await sleep(60);
        }
        ctx.log(`box0=${box0.w}x${box0.h} maxΔ=${maxDW.toFixed(1)}x${maxDH.toFixed(1)} sawPending=${sawPending}`);
        if (maxDW > 2 || maxDH > 2) {
          throw new MeasuredFailure(
            `NO LAYOUT SHIFT: button resized while acting — base ${box0.w}x${box0.h}, drifted by ${maxDW.toFixed(1)}x${maxDH.toFixed(1)}px`,
            `${maxDW.toFixed(1)}x${maxDH.toFixed(1)}`,
          );
        }
        return `button held ${box0.w}x${box0.h} (max drift ${maxDW.toFixed(1)}x${maxDH.toFixed(1)}px, pending=${sawPending})`;
      }),
  });

  // -----------------------------------------------------------------------
  // J9 — DEFAULT SEASON / RESUME IS SANE
  // -----------------------------------------------------------------------
  suite.add({
    name: "J9 default-season-sane",
    bug: "The episode the primary action offers must belong to the season the episode list is showing (no 'Play S06E01' over a Season 1 list).",
    run: async (ctx: JourneyContext) =>
      ctx.withPage({}, async (page) => {
        if (!discovery.seriesHref) throw new Blocked("no series with season tabs found in the copied library");
        const title = new TitlePage(page);
        await title.open(ctx.base, discovery.seriesHref);
        const selected = await title.selectedSeasonNumber();
        const ep = await title.primaryEpisodeLabel();
        ctx.log(`selectedSeason=${selected} primaryEpisode=${ep ? `S${ep.season}E${ep.episode}` : "none"}`);
        if (ep == null) throw new Blocked("primary action does not name an S..E.. to compare");
        if (selected == null) throw new Blocked("could not read the selected/visible season");
        if (ep.season !== selected) {
          throw new MeasuredFailure(
            `DEFAULT SEASON: primary offers S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")} but the episode list is showing Season ${selected}`,
            `S${ep.season} vs season ${selected}`,
          );
        }
        return `primary S${ep.season}E${ep.episode} matches shown Season ${selected}`;
      }),
  });

  // -----------------------------------------------------------------------
  // J10 — NO DEAD ENDS
  // -----------------------------------------------------------------------
  suite.add({
    name: "J10 no-dead-ends",
    bug: "After a playback failure, closing the player and pressing Play again must work (Play never becomes inert).",
    run: async (ctx: JourneyContext) =>
      ctx.withPage({}, async (page) => {
        if (!discovery.hasReadyPlay) throw new Blocked("no ready-to-play source in the copied library");
        const home = new HomePage(page);
        await home.open(ctx.base);
        if (!(await home.readyPlayButton().count())) throw new Blocked("no ready-to-play button on the home page");

        // Attempt 1: open via whatever offline path works, let the stream attempt
        // run (offline it will error), then close.
        const opened1 = await openAnyPlayer(page, ctx.base);
        if (!opened1) throw new Blocked("player did not open on the first attempt (offline)");
        const player = new PlayerPage(page);
        // Give any failure state a moment to surface.
        await sleep(2_500);
        const erroredFirst = (await page.locator("[data-stream-error]").count()) > 0;
        await player.close();
        await sleep(800);

        // Attempt 2: press Play again — it must reopen (Play must not go inert).
        const opened2 = await openAnyPlayer(page, ctx.base);
        const reopened = opened2;
        ctx.log(`erroredFirst=${erroredFirst} reopened=${reopened}`);
        if (!reopened) {
          throw new MeasuredFailure(`DEAD END: Play did not reopen the player after a prior failure+close`, "no-reopen");
        }
        return `replay worked after ${erroredFirst ? "an errored" : "a"} first attempt (2 opens)`;
      }),
  });

  // -----------------------------------------------------------------------
  // J11 — SHARED SENDING SPINNER (press Play; Download must not spin too)
  // -----------------------------------------------------------------------
  suite.add({
    name: "J11 shared-sending-spinner",
    bug: "Play and Download share one 'sending' flag, so pressing Play spins BOTH buttons (torrent-card / title-result-card).",
    run: async (ctx: JourneyContext) =>
      ctx.withPage({}, async (page) => {
        const home = new HomePage(page);
        await home.open(ctx.base);
        const overlay = new SearchOverlay(page);
        await overlay.open().catch(() => {
          throw new Blocked("search overlay would not open");
        });
        const outcome = await overlay.search("the office");
        if (outcome.errored || outcome.resultCount === 0) {
          throw new Blocked(`search returned status=${outcome.status}, ${outcome.resultCount} results — no card to test`);
        }
        const card = overlay.resultCards().first();
        const play = card.locator('[data-action="play"]').first();
        const download = card.locator('[data-action="download"]').first();
        if (!(await play.count()) || !(await download.count())) throw new Blocked("first result lacks both Play and Download");
        if (await play.isDisabled().catch(() => false)) throw new Blocked("Play is disabled on the first result — cannot trigger sending");

        // Mark both buttons, then arm a per-frame sampler BEFORE pressing Play so a
        // one-frame spinner flash on Download is still caught.
        await play.evaluate((el) => el.setAttribute("data-jrny-play", "1")).catch(() => {});
        await download.evaluate((el) => el.setAttribute("data-jrny-dl", "1")).catch(() => {});
        await page.evaluate(() => {
          const S: { start: number; dlSpinAt: number | null; dlDisabledAt: number | null; playSpinAt: number | null; stop: boolean } = {
            start: performance.now(),
            dlSpinAt: null,
            dlDisabledAt: null,
            playSpinAt: null,
            stop: false,
          };
          (window as unknown as { __jrnyDl?: unknown }).__jrnyDl = S;
          const vis = (el: Element | null): boolean => {
            if (!el) return false;
            const r = (el as HTMLElement).getBoundingClientRect();
            const cs = getComputedStyle(el as HTMLElement);
            return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
          };
          const tick = (): void => {
            const now = performance.now() - S.start;
            const dl = document.querySelector('[data-jrny-dl="1"]');
            const pl = document.querySelector('[data-jrny-play="1"]');
            if (S.dlSpinAt == null && vis(dl ? dl.querySelector(".animate-spin") : null)) S.dlSpinAt = now;
            if (S.playSpinAt == null && vis(pl ? pl.querySelector(".animate-spin") : null)) S.playSpinAt = now;
            if (S.dlDisabledAt == null && dl && (dl as HTMLButtonElement).disabled) S.dlDisabledAt = now;
            if (!S.stop && now < 3000) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        await play.click({ timeout: 8_000 }).catch(async () => {
          await play.click({ force: true, timeout: 8_000 }).catch(() => {});
        });
        await sleep(3_000);
        const res = await page.evaluate(() => {
          const s = (window as unknown as { __jrnyDl?: { stop: boolean; dlSpinAt: number | null; playSpinAt: number | null; dlDisabledAt: number | null } }).__jrnyDl;
          if (!s) return { dlSpinAt: null, playSpinAt: null, dlDisabledAt: null };
          s.stop = true;
          return { dlSpinAt: s.dlSpinAt, playSpinAt: s.playSpinAt, dlDisabledAt: s.dlDisabledAt };
        });
        ctx.log(
          `playSpinAt=${res.playSpinAt == null ? "none" : Math.round(res.playSpinAt) + "ms"} dlSpinAt=${res.dlSpinAt == null ? "none" : Math.round(res.dlSpinAt) + "ms"} dlDisabledAt=${res.dlDisabledAt == null ? "none" : Math.round(res.dlDisabledAt) + "ms"}`,
        );
        if (res.dlSpinAt != null) {
          throw new MeasuredFailure(
            `SHARED SENDING: pressed only Play but the Download button showed a spinner at t=${Math.round(res.dlSpinAt)}ms (Play spinner at ${res.playSpinAt == null ? "none" : Math.round(res.playSpinAt) + "ms"})`,
            `dl-spin@${Math.round(res.dlSpinAt)}ms`,
          );
        }
        return `Download stayed idle after pressing Play (playSpin=${res.playSpinAt == null ? "none" : Math.round(res.playSpinAt) + "ms"}, dlDisabled=${res.dlDisabledAt == null ? "no" : "yes@" + Math.round(res.dlDisabledAt) + "ms"})`;
      }),
  });

  // -----------------------------------------------------------------------
  // J12 — RETRY IS NOT A NO-OP ("Try again" on a failed episode)
  // -----------------------------------------------------------------------
  // User report + DB evidence: Family Guy S01E02 shows "Try again" and fails
  // every time. Three identical GrabJob rows (status "skipped", message "No
  // seeded torrent for S01E02"); the search runs skipCache:true, so "Try again"
  // re-runs a byte-identical live search GUARANTEED to fail identically, and
  // episodeActionStatusText() renders a STATIC "Could not get S01E02." for any
  // error. Contract (user-visible, not internals): pressing "Try again" must
  // either succeed or CHANGE its outcome — never reproduce a byte-identical
  // failure with no new information. Expected RED until the fallback-ladder fix
  // lands; a real defect with DB evidence behind it is worth more than a green.
  suite.add({
    name: "J12 retry-not-a-noop",
    bug: 'Pressing "Try again" on a failed episode (Family Guy S01E02) re-runs an identical failing search and shows byte-identical failure text — a retry must progress, not no-op.',
    run: async (ctx: JourneyContext) =>
      ctx.withPage({}, async (page) => {
        const href = discovery.familyGuyHref ?? "/title/family-guy";
        const title = new TitlePage(page);
        await title.open(ctx.base, href);
        if (!(await page.locator("[data-title-detail]").count())) {
          throw new Blocked(`Family Guy (or a series) not in the copied library (tried ${href})`);
        }
        // The user's repro is Season 1, Episode 2 — make sure S1 is showing.
        if (await title.hasSeasons()) await title.selectSeason(1);
        const EP = 2;
        const row = title.episodeRow(EP);
        await row.waitFor({ state: "visible", timeout: 12_000 }).catch(() => {});
        if (!(await row.count())) throw new Blocked(`S01E0${EP} row not present on ${href}`);
        const streamBtn = title.episodeStreamAction(EP);
        if (!(await streamBtn.count())) throw new Blocked(`S01E0${EP} has no Play/stream action to retry`);

        const player = new PlayerPage(page);
        // One atomic read of every user-visible signal for the row.
        const snap = () =>
          page.evaluate((ep) => {
            const r = document.querySelector(`[data-episode-row][data-episode="${ep}"]`);
            if (!r) return null;
            const status = (r.querySelector("[data-episode-action-status]")?.textContent || "").replace(/\s+/g, " ").trim();
            const stream = r.querySelector('[data-episode-action][data-action="stream"]');
            const label = `${stream?.getAttribute("aria-label") || ""} ${stream?.textContent || ""}`.replace(/\s+/g, " ").trim();
            const avail = r.getAttribute("data-availability") || "(absent)";
            const actions = Array.from(r.querySelectorAll("[data-episode-action]"));
            const kinds = actions.map((a) => a.getAttribute("data-action-kind") || a.getAttribute("data-action") || "?").sort();
            return { status, label, avail, kinds, count: actions.length };
          }, EP);

        type Snap = { status: string; label: string; avail: string; kinds: string[]; count: number };
        const isErrored = (s: Snap | null): boolean =>
          !!s && (/try again/i.test(s.label) || /could ?n.?o?t|no seed|unavailable/i.test(s.status));
        const grabResp = () =>
          page
            .waitForResponse((r) => /\/api\/(title\/.+\/grab|torrent\/send|search)/i.test(r.url()), { timeout: 15_000 })
            .then(() => true)
            .catch(() => false);

        // 1) Reach a failure to retry. If already errored (persisted grab jobs),
        //    use that; otherwise press Play once and wait for the failure.
        let pre = (await snap()) as Snap | null;
        if (!isErrored(pre)) {
          if (await streamBtn.isDisabled().catch(() => false)) throw new Blocked(`S01E0${EP} Play is disabled — cannot trigger a grab`);
          const firstResp = grabResp();
          await streamBtn.click({ timeout: 8_000 }).catch(async () => {
            await streamBtn.click({ force: true, timeout: 8_000 }).catch(() => {});
          });
          await firstResp;
          const deadline = Date.now() + 30_000;
          for (;;) {
            pre = (await snap()) as Snap | null;
            if (isErrored(pre)) break;
            if (await player.isOpen()) {
              await player.close().catch(() => {});
              throw new Blocked(`S01E0${EP} played successfully — no failure to retry (the app worked here)`);
            }
            if (Date.now() > deadline) throw new Blocked(`S01E0${EP} did not reach a failure within 30s — cannot exercise "Try again"`);
            await sleep(700);
          }
        }
        if (!pre) throw new Blocked(`could not read S01E0${EP} row state`);

        // 2) Press "Try again" and wait for the retry to actually run and settle.
        const t0 = Date.now();
        const retryRespP = grabResp();
        await streamBtn.click({ timeout: 8_000 }).catch(async () => {
          await streamBtn.click({ force: true, timeout: 8_000 }).catch(() => {});
        });
        const settleBy = Date.now() + 20_000;
        let sawPending = false;
        for (;;) {
          const busy = (await streamBtn.getAttribute("aria-busy").catch(() => null)) === "true";
          if (busy) sawPending = true;
          if (await player.isOpen()) break;
          if (sawPending && !busy) break;
          if (Date.now() > settleBy) break;
          await sleep(300);
        }
        const sawRetryResp = await retryRespP;
        await sleep(800);
        const retryMs = Date.now() - t0;
        const opened = await player.isOpen();
        if (opened) await player.close().catch(() => {});
        const post = (await snap()) as Snap | null;
        if (!post) throw new Blocked(`S01E0${EP} row vanished after retry`);

        const sig = (s: Snap): string => JSON.stringify(s);
        const before = sig(pre);
        const after = sig(post);
        const progressed = opened || before !== after;
        ctx.log(
          `retry@${retryMs}ms sawResp=${sawRetryResp} sawPending=${sawPending} opened=${opened} | before=${before} | after=${after}`,
        );
        if (!progressed) {
          throw new MeasuredFailure(
            `RETRY IS A NO-OP: "Try again" on S01E0${EP} reproduced a byte-identical failure — status unchanged ("${post.status}"), ` +
              `label unchanged ("${post.label}"), availability unchanged (${post.avail}), same ${post.count} action(s); ` +
              `no success and no new information (retry took ${retryMs}ms; ${sawRetryResp ? "a search DID re-run" : "no search response observed"}).`,
            `noop:"${post.status}"`,
          );
        }
        return `retry progressed: ${opened ? "playback started" : "outcome changed (before≠after)"} at ${retryMs}ms`;
      }),
  });
}

function printTable(results: JourneyResult[]): void {
  const headers = ["#", "Journey", "RED/GREEN", "Measured value", "Detail"];
  const rows = results.map((r, i) => [
    String(i + 1),
    r.name,
    r.outcome,
    r.measured.slice(0, 34),
    r.detail.slice(0, 80),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)));
  const pad = (s: string, w: number) => (s.length >= w ? s : s + " ".repeat(w - s.length));
  const line = (cells: string[]) => cells.map((c, i) => pad(c ?? "", widths[i])).join("  ");
  console.log("\n" + line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(line(row));

  const tally = results.reduce<Record<string, number>>((a, r) => ((a[r.outcome] = (a[r.outcome] ?? 0) + 1), a), {});
  console.log(`\nTotals: ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(", ")}`);
}

async function main(): Promise<void> {
  console.log("TorrentFlow user-journey suite");

  // A base URL as argv[2] means "run against this already-running server" — the
  // pre-commit gate boots one on :3400 against a COPY of dev.db and owns DB
  // safety. In that mode we skip booting our own dev server and exit non-zero on
  // any RED, like the sibling probes. `--gate` / JOURNEY_GATE keep the same exit
  // behaviour when we DO boot the built-in server.
  const arg2 = process.argv[2];
  const externalBase = arg2 && /^https?:\/\//i.test(arg2) ? arg2.replace(/\/+$/, "") : null;

  let server: Awaited<ReturnType<typeof startDevServer>> | null = null;
  let gateDownloadDir: string | null = null;
  let base: string;
  let downloadDir: string;
  if (externalBase) {
    base = externalBase;
    // J4 repoints THIS server's baseDownloadPath at a throwaway temp dir and
    // asserts the resolved save dir is under it; provide one so the guard has a
    // safe target even though we did not boot the server ourselves.
    gateDownloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-journeys-gate-dl-"));
    downloadDir = gateDownloadDir;
    console.log(`  external base: ${base} (gate mode — DB safety owned by the gate)`);
  } else {
    server = await startDevServer();
    base = server.base;
    downloadDir = server.downloadDir;
    console.log(`  dev server: ${base} (scratch DB)`);
  }

  let browser: Browser | null = null;
  let results: JourneyResult[] = [];
  try {
    await warmRoutes(base, Object.values(ROUTES));
    browser = await launchBrowser();
    console.log("  discovering content in the copied library…");
    const discovery = await discover(browser, base);
    console.log(
      `  discovery: readyPlay=${discovery.hasReadyPlay} (${discovery.playSource}), titles=${discovery.titleHrefs.length}, series=${discovery.seriesHref ?? "none"}, film=${discovery.filmHref ?? "none"}, readyTitle=${discovery.readyTitleHref ?? "none"}, familyGuy=${discovery.familyGuyHref ?? "none"}`,
    );
    const suite = new Suite(browser, base, downloadDir);
    registerJourneys(suite, base, discovery);
    results = await suite.run();
    printTable(results);

    const reportPath = path.join(artifactsDir, "report.json");
    fs.writeFileSync(reportPath, JSON.stringify({ base, discovery, results }, null, 2));
    console.log(`\nArtifacts + report: ${artifactsDir}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.stop();
    cleanupScratchDb();
    if (gateDownloadDir) {
      try {
        fs.rmSync(gateDownloadDir, { recursive: true, force: true });
      } catch {
        /* best effort — a leftover temp dir is harmless */
      }
    }
  }

  const reds = results.filter((r) => r.outcome === "RED").length;
  const errors = results.filter((r) => r.outcome === "ERROR").length;
  // External base ⇒ we are the gate's last stage, so a RED must fail the gate.
  const gate = externalBase != null || process.env.JOURNEY_GATE === "1" || process.argv.includes("--gate");
  if (gate && reds > 0) process.exit(1);
  if (errors > 0) process.exit(2);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
