/**
 * Page objects for the TorrentFlow journey suite.
 *
 * One place per surface, named locators, small actions. A markup change breaks
 * one method here, not twenty specs. Locators are the exact hooks that exist in
 * the app today (verified against src/**), preferring stable `data-*` attributes.
 */
import type { Locator, Page } from "playwright";

export const ROUTES = {
  home: "/",
  search: "/search",
  client: "/client",
  activity: "/activity",
  settings: "/settings",
  watchlist: "/watchlist",
} as const;

/** qBittorrent-vocabulary states the /client badge renders as a "still downloading" pill. */
export const DOWNLOADING_BADGE_LABELS = [
  "Downloading",
  "Finding files",
  "Verifying",
  "Looking for peers",
  "Queued",
  "Allocating",
];

// ---------------------------------------------------------------------------
// Home / browse rails
// ---------------------------------------------------------------------------
export class HomePage {
  constructor(private page: Page) {}

  async open(base: string): Promise<void> {
    await this.page.goto(`${base}${ROUTES.home}`, { waitUntil: "domcontentloaded" });
    await this.page.locator("[data-browse-board]").first().waitFor({ timeout: 60_000 }).catch(() => {});
  }

  /** A rail card whose action is a local, ready-to-play file — opens the player offline. */
  readyPlayButton(): Locator {
    return this.page.locator('[data-rail-card] ~ * [data-card-action="play"], [data-card-action="play"]');
  }

  /** Poster/title links that navigate to a title detail page. */
  titleLinks(): Locator {
    return this.page.locator('[data-rail-card][data-card-target="title"]');
  }

  async firstTitleHref(): Promise<string | null> {
    const links = this.titleLinks();
    const n = await links.count();
    for (let i = 0; i < Math.min(n, 40); i++) {
      const href = await links.nth(i).getAttribute("href");
      if (href && href.startsWith("/title/")) return href;
    }
    return null;
  }

  async titleHrefs(limit = 24): Promise<string[]> {
    const links = this.titleLinks();
    const n = await links.count();
    const out: string[] = [];
    for (let i = 0; i < n && out.length < limit; i++) {
      const href = await links.nth(i).getAttribute("href");
      if (href && href.startsWith("/title/") && !out.includes(href)) out.push(href);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Player overlay
// ---------------------------------------------------------------------------
export class PlayerPage {
  constructor(private page: Page) {}

  overlay(): Locator {
    return this.page.locator("[data-play-overlay]");
  }

  async isOpen(): Promise<boolean> {
    return (await this.overlay().count()) > 0;
  }

  async waitForOpen(timeout = 15_000): Promise<void> {
    await this.overlay().first().waitFor({ state: "visible", timeout });
  }

  async close(): Promise<void> {
    const btn = this.page.locator('[data-play-overlay] button[aria-label="Close"]');
    if (await btn.count()) {
      await btn.first().click({ timeout: 5_000 }).catch(() => {});
    } else {
      await this.page.keyboard.press("Escape").catch(() => {});
    }
    await this.overlay()
      .first()
      .waitFor({ state: "detached", timeout: 8_000 })
      .catch(() => {});
  }

  /** Text a viewer can actually read inside the player (visibility-aware). */
  async visibleText(): Promise<string> {
    const el = this.overlay().first();
    if (!(await el.count())) return "";
    return (await el.innerText().catch(() => "")) ?? "";
  }

  /** Mark the element a journey is about to click so the loader probe can scope to it. */
  async markClicked(target: Locator): Promise<void> {
    await target.evaluate((el) => el.setAttribute("data-jrny-clicked", "1")).catch(() => {});
  }

  /**
   * Install the loader probe BEFORE the Play click. It watches the document with a
   * MutationObserver (childList + subtree + attributes), an `animationstart`
   * listener in the CAPTURE phase (a remount that reuses an identical node still
   * RESTARTS its CSS animation, so this catches churn a node-identity check would
   * miss), and a per-animation-frame visibility sampler (requestAnimationFrame, not
   * a coarse interval, so short flashes are not missed). Measurement ends at the
   * video's first PRESENTED frame via requestVideoFrameCallback (fallback:
   * `playing` + 2 rAF, then a hard cap).
   *
   * A loader is `[data-player-loader]` (preferred — the player agent is adding it),
   * `[data-stream-loading]`, or `.animate-spin`. The swarm chip is EXPLICITLY
   * excluded: it carries role="status" but is a static health dot, not a spinner —
   * counting it (as an earlier probe did) is a false positive. Scope is the player
   * overlay PLUS the one button the journey pressed (`data-jrny-clicked`), so a
   * sibling Download spinner or an unrelated page spinner cannot inflate the count.
   */
  async installLoaderProbe(): Promise<void> {
    await this.page.evaluate(() => {
      const w = window as unknown as { __jrny?: unknown };
      type LoaderRec = { id: number; owner: string; firstAt: number; lastAt: number };
      const S: {
        startedAt: number;
        nodes: Map<Element, LoaderRec>;
        nextId: number;
        peak: number;
        samples: Array<{ t: number; count: number }>;
        animStarts: number;
        animOwners: string[];
        sawLoaderAt: number | null;
        firstFrameAt: number | null;
        firstFrameSource: string;
        readySrc: string;
        loaderHookSeen: boolean;
        sawPlaybackHook: boolean;
        gapBeforeFrame: boolean;
        errorAt: number | null;
        videoReadyAt: number | null;
        lastReadyState: number;
        videoHooked: boolean;
        stop: boolean;
        done: boolean;
      } = {
        startedAt: performance.now(),
        nodes: new Map<Element, LoaderRec>(),
        nextId: 1,
        peak: 0,
        samples: [],
        animStarts: 0,
        animOwners: [],
        sawLoaderAt: null,
        firstFrameAt: null,
        firstFrameSource: "none",
        readySrc: "",
        loaderHookSeen: false,
        sawPlaybackHook: false,
        gapBeforeFrame: false,
        errorAt: null,
        videoReadyAt: null,
        lastReadyState: 0,
        videoHooked: false,
        stop: false,
        done: false,
      };
      w.__jrny = S;
      // Node identity is tracked across the WHOLE document body — NOT just the
      // player subtree. The user's bug IS the handoff: the animated node changes
      // owner from the pressed button's spinner (ButtonBody) to the overlay's
      // spinner (PlayOverlay). Scoping identity to the player would hide exactly
      // that transition, and `peak` cannot see it because sequential replacement
      // never puts two loaders on screen at once. "One loader" means ONE node,
      // continuously, from press to first frame — not merely "never two at once".
      const isLoader = (el: Element): boolean => {
        if (el.closest("[data-swarm-chip]")) return false; // static role=status health dot, not a spinner
        return el.matches("[data-player-loader], [data-stream-loading]") || el.classList.contains("animate-spin");
      };
      const isVisible = (el: Element): boolean => {
        const r = (el as HTMLElement).getBoundingClientRect();
        const cs = getComputedStyle(el as HTMLElement);
        return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
      };
      // Describe WHERE a loader lives so a failure names the owner, not just a count.
      const describeOwner = (el: Element): string => {
        const kind = el.matches("[data-player-loader]")
          ? "data-player-loader"
          : el.matches("[data-stream-loading]")
            ? "data-stream-loading"
            : "animate-spin";
        const pressed = el.closest('[data-jrny-clicked="1"]');
        const action = el.closest("[data-action]");
        const player = el.closest("[data-inline-player], [data-play-overlay]");
        if (player) return `${player.matches("[data-inline-player]") ? "inline-player" : "play-overlay"}:${kind}`;
        if (action) return `${pressed ? "pressed-" : ""}button[data-action=${action.getAttribute("data-action")}]:${kind}`;
        if (pressed) return `pressed-button:${kind}`;
        const host = el.closest("[data-testid],[id]");
        const hostDesc = host ? host.getAttribute("data-testid") || `#${host.id}` : el.tagName.toLowerCase();
        return `${hostDesc}:${kind}`;
      };
      const loaderEls = (): Element[] => {
        const out: Element[] = [];
        document.querySelectorAll("[data-player-loader], [data-stream-loading], .animate-spin").forEach((el) => {
          if (isLoader(el) && isVisible(el)) out.push(el);
        });
        return out;
      };
      const rootsOf = (els: Element[]): Element[] => {
        const set = new Set(els);
        return els.filter((el) => {
          let p: Element | null = el.parentElement;
          while (p) {
            if (set.has(p)) return false;
            p = p.parentElement;
          }
          return true;
        });
      };
      const register = (el: Element, now: number): void => {
        const rec = S.nodes.get(el);
        if (rec) {
          rec.lastAt = now;
        } else {
          S.nodes.set(el, { id: S.nextId++, owner: describeOwner(el), firstAt: now, lastAt: now });
        }
      };
      // Global animationstart (capture): a handoff restarts the animation on a
      // DIFFERENT node, so a second animationstart fires even though peak stays 1.
      document.addEventListener(
        "animationstart",
        (e: Event) => {
          const t = e.target as Element | null;
          if (t && t.nodeType === 1 && isLoader(t) && isVisible(t)) {
            S.animStarts++;
            S.animOwners.push(describeOwner(t));
          }
        },
        true,
      );
      // Attribute/child churn is registered on the next frame tick; the observer
      // just guarantees we re-scan promptly around mutations.
      const mo = new MutationObserver(() => void 0);
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
      const tick = (): void => {
        const now = performance.now() - S.startedAt;
        if (!S.loaderHookSeen && document.querySelector("[data-player-loader]")) S.loaderHookSeen = true;
        if (document.querySelector("[data-inline-player-error], [data-stream-error]") && S.errorAt == null) S.errorAt = now;
        const rs = rootsOf(loaderEls());
        rs.forEach((el) => register(el, now));
        const count = rs.length;
        S.samples.push({ t: Math.round(now), count });
        if (count > S.peak) S.peak = count;
        if (count > 0 && S.sawLoaderAt == null) S.sawLoaderAt = now;
        // First-frame, most-truthful first: prefer an app `data-playback-started`
        // hook (the player agent is adding it); then a real presented frame (rVFC);
        // then the headless-safe readiness proxy (canplay / readyState>=3), because
        // headless-shell buffers and decodes but never COMPOSITES frames.
        if (S.firstFrameAt == null) {
          const pb = document.querySelector("[data-playback-started]");
          if (pb) {
            S.sawPlaybackHook = true;
            const val = (pb.getAttribute("data-playback-started") || "").toLowerCase();
            if (val === "" || val === "true" || val === "1") {
              S.firstFrameAt = now;
              S.firstFrameSource = "hook:data-playback-started";
            }
          }
        }
        const v = document.querySelector("[data-stream-video]") as (HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => void }) | null;
        if (v && !S.videoHooked) {
          S.videoHooked = true;
          try {
            if (typeof v.requestVideoFrameCallback === "function") {
              v.requestVideoFrameCallback(() => {
                if (S.firstFrameAt == null) {
                  S.firstFrameAt = performance.now() - S.startedAt;
                  S.firstFrameSource = "rvfc";
                }
              });
            }
          } catch {
            /* rVFC unsupported — the readiness proxy below covers it */
          }
          const markReady = (src: string) => (): void => {
            if (S.videoReadyAt == null) {
              S.videoReadyAt = performance.now() - S.startedAt;
              if (S.readySrc === "") S.readySrc = src;
            }
          };
          (["canplay", "canplaythrough", "playing"] as const).forEach((ev) => v.addEventListener(ev, markReady(ev), { once: true }));
        }
        if (v) {
          S.lastReadyState = v.readyState;
          if (S.videoReadyAt == null && v.readyState >= 3) {
            S.videoReadyAt = now; // HAVE_FUTURE_DATA === canplay
            if (S.readySrc === "") S.readySrc = "readyState>=3";
          }
        }
        if (S.firstFrameAt == null && S.videoReadyAt != null) {
          S.firstFrameAt = S.videoReadyAt;
          S.firstFrameSource = `proxy:${S.readySrc}`;
        }
        // A drop to 0 before first frame with no error is a real gap (loader → gone).
        if (S.sawLoaderAt != null && S.firstFrameAt == null && S.errorAt == null && count === 0) S.gapBeforeFrame = true;
        if (!S.stop && now < 12000 && S.firstFrameAt == null) requestAnimationFrame(tick);
        else {
          S.done = true;
          mo.disconnect();
        }
      };
      requestAnimationFrame(tick);
    });
  }

  /** Wait until the probe reports a first frame, an error, or it stops on its own. */
  async waitForFirstFrameOrIdle(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const st = await this.page.evaluate(() => {
        const s = (window as unknown as { __jrny?: { firstFrameAt: number | null; errorAt: number | null; done: boolean } }).__jrny;
        return s ? { frame: s.firstFrameAt, err: s.errorAt, done: s.done } : { frame: 0, err: 0, done: true };
      });
      if (st.frame != null || st.err != null || st.done) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Stop the probe and read every measured value. */
  async stopAndReadLoaderProbe(): Promise<{
    uniqueNodes: number;
    peak: number;
    animStarts: number;
    gapBeforeFrame: boolean;
    firstFrameAt: number | null;
    firstFrameSource: string;
    errorAt: number | null;
    sawLoader: boolean;
    loaderHookSeen: boolean;
    sawPlaybackHook: boolean;
    animOwners: string[];
    nodesDetail: Array<{ id: number; owner: string; firstAt: number; lastAt: number }>;
    timeline: string;
  }> {
    return this.page.evaluate(() => {
      const s = (
        window as unknown as {
          __jrny?: {
            stop: boolean;
            nodes: Map<Element, { id: number; owner: string; firstAt: number; lastAt: number }>;
            peak: number;
            animStarts: number;
            animOwners: string[];
            gapBeforeFrame: boolean;
            firstFrameAt: number | null;
            firstFrameSource: string;
            errorAt: number | null;
            sawLoaderAt: number | null;
            loaderHookSeen: boolean;
            sawPlaybackHook: boolean;
            samples: Array<{ count: number }>;
          };
        }
      ).__jrny;
      if (!s) {
        return {
          uniqueNodes: 0,
          peak: 0,
          animStarts: 0,
          gapBeforeFrame: false,
          firstFrameAt: null,
          firstFrameSource: "none",
          errorAt: null,
          sawLoader: false,
          loaderHookSeen: false,
          sawPlaybackHook: false,
          animOwners: [],
          nodesDetail: [],
          timeline: "",
        };
      }
      s.stop = true;
      const nodesDetail = Array.from(s.nodes.values())
        .sort((a, b) => a.firstAt - b.firstAt)
        .map((n) => ({ id: n.id, owner: n.owner, firstAt: Math.round(n.firstAt), lastAt: Math.round(n.lastAt) }));
      return {
        uniqueNodes: s.nodes.size,
        peak: s.peak,
        animStarts: s.animStarts,
        gapBeforeFrame: s.gapBeforeFrame,
        firstFrameAt: s.firstFrameAt == null ? null : Math.round(s.firstFrameAt),
        firstFrameSource: s.firstFrameSource,
        errorAt: s.errorAt == null ? null : Math.round(s.errorAt),
        sawLoader: s.sawLoaderAt != null,
        loaderHookSeen: s.loaderHookSeen,
        sawPlaybackHook: s.sawPlaybackHook,
        animOwners: s.animOwners,
        nodesDetail,
        timeline: s.samples.map((p) => p.count).join(""),
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Title detail page
// ---------------------------------------------------------------------------
export class TitlePage {
  constructor(private page: Page) {}

  async open(base: string, href: string): Promise<void> {
    await this.page.goto(`${base}${href}`, { waitUntil: "domcontentloaded" });
    await this.page.locator("[data-title-detail]").first().waitFor({ timeout: 60_000 }).catch(() => {});
  }

  primary(): Locator {
    return this.page.locator("[data-title-primary]");
  }

  download(): Locator {
    return this.page.locator("[data-title-download]");
  }

  seasonTabs(): Locator {
    return this.page.locator("[data-season-tab]");
  }

  async hasSeasons(): Promise<boolean> {
    return (await this.seasonTabs().count()) > 0;
  }

  async selectedSeasonNumber(): Promise<number | null> {
    // Prefer the deterministic hook: the active tab carries `data-active="true"`
    // (absent on the others), and `data-season-tab` IS the season number — no text
    // parsing, no locale surprises. Fall back to aria-pressed + innerText for
    // builds before the responsive agent's hook landed.
    const active = this.page.locator('[data-season-tab][data-active="true"]').first();
    if (await active.count()) {
      const v = await active.getAttribute("data-season-tab");
      if (v != null && /^\d+$/.test(v.trim())) return Number(v.trim());
    }
    const tabs = this.seasonTabs();
    const n = await tabs.count();
    for (let i = 0; i < n; i++) {
      const pressed = await tabs.nth(i).getAttribute("aria-pressed");
      if (pressed === "true") {
        const hook = await tabs.nth(i).getAttribute("data-season-tab");
        if (hook != null && /^\d+$/.test(hook.trim())) return Number(hook.trim());
        const txt = (await tabs.nth(i).innerText().catch(() => "")) ?? "";
        const m = txt.match(/(\d+)/);
        if (m) return Number(m[1]);
      }
    }
    // Fall back to the first tab if none marked pressed.
    if (n > 0) {
      const txt = (await tabs.first().innerText().catch(() => "")) ?? "";
      const m = txt.match(/(\d+)/);
      if (m) return Number(m[1]);
    }
    return null;
  }

  /** Click the season tab for `n` (deterministic via the `data-season-tab` hook). */
  async selectSeason(n: number): Promise<boolean> {
    const tab = this.page.locator(`[data-season-tab="${n}"]`).first();
    if (!(await tab.count())) return false;
    await tab.click().catch(() => {});
    await this.page
      .locator(`[data-season-tab="${n}"][data-active="true"]`)
      .first()
      .waitFor({ timeout: 4_000 })
      .catch(() => {});
    return true;
  }

  /** The S..E.. the primary action offers, read from its accessible name/subtitle. */
  async primaryEpisodeLabel(): Promise<{ season: number; episode: number } | null> {
    const btn = this.primary();
    if (!(await btn.count())) return null;
    const aria = (await btn.first().getAttribute("aria-label")) ?? "";
    const text = (await btn.first().innerText().catch(() => "")) ?? "";
    const hay = `${aria} ${text}`;
    const m = hay.match(/S(\d{1,2})\s*E(\d{1,3})/i);
    if (!m) return null;
    return { season: Number(m[1]), episode: Number(m[2]) };
  }

  async episodeRows(): Promise<Locator> {
    return this.page.locator("[data-episode-row]");
  }

  // --- Episode-level helpers (J12: "Try again" must not be a byte-identical no-op) ---
  episodeRow(episode: number): Locator {
    return this.page.locator(`[data-episode-row][data-episode="${episode}"]`).first();
  }

  /** The Play/stream action button for an episode (its label becomes "Try again" on error). */
  episodeStreamAction(episode: number): Locator {
    return this.episodeRow(episode).locator('[data-episode-action][data-action="stream"]').first();
  }

  /** The visible per-episode status line (e.g. "Could not get S01E02."). "" when none. */
  async episodeActionStatus(episode: number): Promise<string> {
    const s = this.episodeRow(episode).locator("[data-episode-action-status]").first();
    if (!(await s.count())) return "";
    return ((await s.innerText().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
  }

  /** The episode row's availability classification (the `data-availability` hook). */
  async episodeAvailability(episode: number): Promise<string> {
    return (await this.episodeRow(episode).getAttribute("data-availability")) ?? "(absent)";
  }

  /** The stream button's accessible name + text (so "Try again" vs "Play" is visible). */
  async episodeStreamLabel(episode: number): Promise<string> {
    const b = this.episodeStreamAction(episode);
    if (!(await b.count())) return "";
    const aria = (await b.getAttribute("aria-label").catch(() => "")) ?? "";
    const txt = (await b.innerText().catch(() => "")) ?? "";
    return `${aria} ${txt}`.replace(/\s+/g, " ").trim();
  }
}

// ---------------------------------------------------------------------------
// Downloads / client page
// ---------------------------------------------------------------------------
export interface ApiTorrent {
  hash: string;
  name?: string;
  state: string;
  progress?: number;
  retentionState?: "kept" | "stream" | "prewarm" | "unknown";
}

export class ClientPage {
  constructor(private page: Page) {}

  async open(base: string): Promise<void> {
    await this.page.goto(`${base}${ROUTES.client}`, { waitUntil: "domcontentloaded" });
    await this.page
      .locator("[data-client-table], [data-client-offline], [data-client-engine-error]")
      .first()
      .waitFor({ timeout: 60_000 })
      .catch(() => {});
  }

  /** The server's own view, including the retention classification of each row. */
  async apiTorrents(): Promise<ApiTorrent[]> {
    return this.page.evaluate(async () => {
      try {
        const res = await fetch("/api/client/torrents", { headers: { accept: "application/json" } });
        const body = (await res.json()) as { torrents?: ApiTorrent[] };
        return body.torrents ?? [];
      } catch {
        return [];
      }
    });
  }

  rows(): Locator {
    return this.page.locator("[data-client-torrent]");
  }

  rowByHash(hash: string): Locator {
    return this.page.locator(`[data-client-torrent][data-hash="${hash.toLowerCase()}"]`);
  }

  /** The status label pill for a row, matched against the known vocabulary. */
  async badgeLabelForHash(hash: string, labels: string[]): Promise<string | null> {
    const row = this.rowByHash(hash);
    if (!(await row.count())) return null;
    const text = (await row.first().innerText().catch(() => "")) ?? "";
    for (const label of labels) {
      // Whole-segment match so "Seeding" never matches inside another word.
      const re = new RegExp(`(^|\\n|·|\\s)${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\n|·|\\s|$)`);
      if (re.test(text)) return label;
    }
    return null;
  }

  /** The DOM row's own retention classification (the `data-retention` hook). */
  async domRetentionForHash(hash: string): Promise<string | null> {
    const row = this.rowByHash(hash);
    if (!(await row.count())) return null;
    // The attribute is omitted entirely when retentionState is undefined.
    return (await row.first().getAttribute("data-retention")) ?? "(absent)";
  }

  /** Every rendered row's hash + DOM retention, straight from the row roots. */
  async domRows(): Promise<Array<{ hash: string; retention: string }>> {
    return this.page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-client-torrent]")).map((el) => ({
        hash: (el.getAttribute("data-hash") || "").toLowerCase(),
        retention: el.getAttribute("data-retention") ?? "(absent)",
      })),
    );
  }

  /** The value under the "Downloading" tile of the stat strip. */
  async downloadingStat(): Promise<number | null> {
    return this.page.evaluate(() => {
      // Prefer the dedicated hook: the DOWNLOADING tile mirrors its RAW count into
      // `data-stat-value` (exactly one such node exists), so we never parse
      // formatted text. Fall back to the label+value span pair for older builds.
      const hook = document.querySelector("[data-stat-value]");
      if (hook) {
        const v = Number((hook.getAttribute("data-stat-value") || "").trim());
        if (Number.isFinite(v)) return v;
      }
      const strip = document.querySelector("[data-stat-strip]");
      if (!strip) return null;
      const tiles = Array.from(strip.children) as HTMLElement[];
      for (const tile of tiles) {
        const spans = tile.querySelectorAll("span");
        if (spans.length >= 2 && /downloading/i.test(spans[0].textContent || "")) {
          const v = Number((spans[1].textContent || "").trim());
          return Number.isFinite(v) ? v : null;
        }
      }
      return null;
    });
  }
}

// ---------------------------------------------------------------------------
// Torrent engine API — the exact endpoints the player uses.
// ---------------------------------------------------------------------------
// J4 drives the REAL stream lifecycle (send → stream bytes → releaseStream on
// close) through these endpoints, because the CC fixture is an external magnet,
// not a library item. Pressing Play does the same calls under the hood:
//   • POST /api/torrent/send { retention:"stream" }        (adds the stream)
//   • GET  /api/stream/<hash>/<file>  Range: bytes=…        (selects + pulls)
//   • GET  /api/stream/<hash>?poll=1&file=<file>            (swarm + downloadedRanges)
//   • POST /api/prewarm { action:"foreground", released }   (inline-player.tsx releaseStream)
// downloadedRanges here come straight from the live torrent bitfield — they are
// NOT zeroed like /api/client/torrents, and they survive the player closing.
export interface StreamSample {
  status: number;
  progress: number | null;
  downloadSpeedBps: number | null;
  peers: number | null;
  /** Verified downloaded bytes of the chosen file (sum of downloadedRanges). */
  bytes: number;
  filePath: string | null;
  length: number | null;
}

export class TorrentApi {
  constructor(private page: Page) {}

  /**
   * Repoint the engine's download root to the scratch dir BEFORE adding anything.
   * The scratch DB is a copy of the real dev.db, so its stored baseDownloadPath
   * points at the user's REAL library; a stream would otherwise write there. A
   * minimal body preserves every other setting (the route falls back to existing).
   */
  async setSaveRoot(dir: string): Promise<{ ok: boolean; baseDownloadPath: string | null }> {
    return this.page.evaluate(
      async ({ dir }) => {
        try {
          const res = await fetch("/api/settings/client", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ baseDownloadPath: dir }),
          });
          const body = (await res.json().catch(() => ({}))) as { settings?: { baseDownloadPath?: string | null } };
          return { ok: res.ok, baseDownloadPath: body.settings?.baseDownloadPath ?? null };
        } catch {
          return { ok: false, baseDownloadPath: null };
        }
      },
      { dir },
    );
  }

  /** Add a magnet as a STREAM (retention:"stream") — what pressing Play does. */
  async addStream(magnet: string, name: string): Promise<{ ok: boolean; status: number; retentionState: string | null; message: string; offline: boolean }> {
    return this.page.evaluate(
      async ({ magnet, name }) => {
        try {
          const res = await fetch("/api/torrent/send", {
            method: "POST",
            headers: { "Content-Type": "application/json", accept: "application/json" },
            body: JSON.stringify({ magnet, name, retention: "stream", target: "primary" }),
          });
          const body = (await res.json().catch(() => ({}))) as {
            retentionState?: string;
            message?: string;
            error?: string;
            offline?: boolean;
          };
          return {
            ok: res.ok,
            status: res.status,
            retentionState: body.retentionState ?? null,
            message: body.message || body.error || "",
            offline: body.offline === true,
          };
        } catch (err) {
          return { ok: false, status: 0, retentionState: null, message: String(err), offline: false };
        }
      },
      { magnet, name },
    );
  }

  /** Poll the stream index for swarm health + verified downloadedRanges (NON-zeroed). */
  async streamSample(hash: string, filePath?: string | null): Promise<StreamSample> {
    return this.page.evaluate(
      async ({ hash, filePath }) => {
        const qs = new URLSearchParams({ poll: "1" });
        if (filePath) qs.set("file", filePath);
        try {
          const res = await fetch(`/api/stream/${encodeURIComponent(hash)}?${qs.toString()}`, {
            cache: "no-store",
            headers: { accept: "application/json" },
          });
          const body = (await res.json().catch(() => ({}))) as {
            files?: Array<{ path: string; length: number; index: number; downloadedRanges?: Array<{ start: number; end: number }> }>;
            primaryVideoIndex?: number | null;
            swarm?: { progress?: number | null; downloadSpeedBps?: number | null; peers?: number | null };
          };
          const files = body.files ?? [];
          const primary = typeof body.primaryVideoIndex === "number" ? files[body.primaryVideoIndex] : undefined;
          const chosen = filePath ? files.find((f) => f.path === filePath) : primary ?? files[0];
          const ranges = chosen?.downloadedRanges ?? [];
          const bytes = ranges.reduce((n, r) => n + Math.max(0, r.end - r.start), 0);
          const swarm = body.swarm ?? {};
          return {
            status: res.status,
            progress: typeof swarm.progress === "number" ? swarm.progress : null,
            downloadSpeedBps: typeof swarm.downloadSpeedBps === "number" ? swarm.downloadSpeedBps : null,
            peers: typeof swarm.peers === "number" ? swarm.peers : null,
            bytes,
            filePath: chosen?.path ?? null,
            length: chosen?.length ?? null,
          };
        } catch {
          return { status: 0, progress: null, downloadSpeedBps: null, peers: null, bytes: 0, filePath: null, length: null };
        }
      },
      { hash, filePath: filePath ?? null },
    );
  }

  /** Issue a ranged GET against the byte route to SELECT the file and pull pieces. */
  async pullRange(hash: string, filePath: string, start: number, end: number): Promise<number> {
    return this.page.evaluate(
      async ({ hash, filePath, start, end }) => {
        const segs = filePath
          .split("/")
          .map((s) => encodeURIComponent(s))
          .join("/");
        try {
          const res = await fetch(`/api/stream/${encodeURIComponent(hash)}/${segs}`, {
            headers: { Range: `bytes=${start}-${end}` },
            cache: "no-store",
          });
          const reader = res.body?.getReader();
          let read = 0;
          if (reader) {
            for (let i = 0; i < 12 && read < end - start; i++) {
              const { value, done } = await reader.read();
              if (done) break;
              read += value?.byteLength ?? 0;
            }
            await reader.cancel().catch(() => {});
          }
          return read;
        } catch {
          return 0;
        }
      },
      { hash, filePath, start, end },
    );
  }

  /** Close the player for a stream: releaseForeground + sync → park (deselect). */
  async releaseStream(hash: string): Promise<void> {
    await this.page.evaluate(async ({ hash }) => {
      await fetch("/api/prewarm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "foreground", released: hash }),
      }).catch(() => {});
    }, { hash });
  }

  /** Reconcile foreground/park state without a beacon (belt-and-suspenders sync). */
  async syncPrewarm(): Promise<void> {
    await this.page.evaluate(async () => {
      await fetch("/api/prewarm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "foreground", beacon: false }),
      }).catch(() => {});
    });
  }

  /** The torrent's savePath (NOT zeroed in the client list) — for the scratch-path guard. */
  async savePathOf(hash: string): Promise<string | null> {
    return this.page.evaluate(async ({ hash }) => {
      try {
        const res = await fetch("/api/client/torrents", { headers: { accept: "application/json" } });
        const body = (await res.json()) as { torrents?: Array<{ hash?: string; savePath?: string | null }> };
        const t = (body.torrents ?? []).find((x) => (x.hash || "").toLowerCase() === hash.toLowerCase());
        return t?.savePath ?? null;
      } catch {
        return null;
      }
    }, { hash });
  }

  /** Remove the torrent AND delete its files from disk. */
  async deleteTorrent(hash: string): Promise<boolean> {
    return this.page.evaluate(async ({ hash }) => {
      try {
        const res = await fetch("/api/client/torrents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "delete", hash, deleteFiles: true }),
        });
        return res.ok;
      } catch {
        return false;
      }
    }, { hash });
  }
}

// ---------------------------------------------------------------------------
// Search overlay
// ---------------------------------------------------------------------------
export interface SearchOutcome {
  status: number | null;
  resultCount: number;
  empty: boolean;
  errored: boolean;
}

export class SearchOverlay {
  constructor(private page: Page) {}

  container(): Locator {
    return this.page.locator("[data-search-overlay]");
  }

  input(): Locator {
    // Prefer the dedicated overlay hook (`data-search-overlay-input`, the search
    // agent added it) so we can never grab the home hero's search-bar; fall back
    // to the overlay-scoped generic `data-search-input` for builds before it lands.
    // Both attributes live on the same input, so `.first()` is the overlay box.
    return this.page
      .locator('[data-search-overlay-input="true"], [data-search-overlay] [data-search-input="true"]')
      .first();
  }

  resultCards(): Locator {
    return this.page.locator("article[data-torrent-card]");
  }

  async isOpen(): Promise<boolean> {
    return (await this.container().count()) > 0 && (await this.container().first().isVisible());
  }

  async open(): Promise<void> {
    // The header hydrates a beat after first paint, so a cold click can no-op before
    // React attaches the handler (this is why an earlier run opened the overlay in
    // one journey but not another). Wait for an interactive trigger, then retry both
    // the button and the "/" shortcut until the overlay is actually visible.
    const overlay = this.container().first();
    if (await overlay.isVisible().catch(() => false)) return;
    await this.page.locator("[data-search-trigger]").first().waitFor({ state: "attached", timeout: 10_000 }).catch(() => {});
    for (let attempt = 0; attempt < 5; attempt++) {
      const visTrigger = this.page.locator("[data-search-trigger]:visible").first();
      if (await visTrigger.count().catch(() => 0)) {
        await visTrigger.click({ timeout: 3_000 }).catch(() => {});
      } else {
        await this.page.keyboard.press("/").catch(() => {});
      }
      if (await overlay.waitFor({ state: "visible", timeout: 2_500 }).then(() => true).catch(() => false)) return;
      await this.page.keyboard.press("/").catch(() => {});
      if (await overlay.waitFor({ state: "visible", timeout: 1_500 }).then(() => true).catch(() => false)) return;
    }
    // Final, clear failure if it truly never opened.
    await overlay.waitFor({ state: "visible", timeout: 5_000 });
  }

  /** Type a query and resolve once the app has answered (results, empty, or error). */
  async search(query: string): Promise<SearchOutcome> {
    const waitResponse = this.page
      .waitForResponse((r) => r.url().includes("/api/search"), { timeout: 30_000 })
      .catch(() => null);
    await this.input().fill(query);
    const resp = await waitResponse;
    const status = resp ? resp.status() : null;
    // Let the list settle after the response.
    await this.page
      .locator("[data-results-list], [data-results-empty]")
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    const resultCount = await this.resultCards().count();
    const empty = (await this.page.locator("[data-results-empty]").count()) > 0;
    const errored = status != null && status >= 400;
    return { status, resultCount, empty, errored };
  }

  async expandFirstReleases(): Promise<number> {
    const expander = this.page.locator('[data-action="expand-releases"]').first();
    if (!(await expander.count())) return 0;
    await expander.click();
    await this.page.locator("[data-release-row]").first().waitFor({ timeout: 5_000 }).catch(() => {});
    return this.page.locator("[data-release-row]").count();
  }

  async releaseRowTexts(): Promise<string[]> {
    const rows = this.page.locator("[data-release-row]");
    const n = await rows.count();
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const t = ((await rows.nth(i).innerText().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
      out.push(t);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Layout / geometry measurement helpers (shared by responsive + no-shift specs)
// ---------------------------------------------------------------------------

export interface ResponsiveAudit {
  scrollWidth: number;
  innerWidth: number;
  horizontalOverflowPx: number;
  narrowText: Array<{ text: string; width: number; lines: number }>;
  smallControls: Array<{ label: string; w: number; h: number }>;
}

/**
 * Measure the three responsive failure modes on the current page:
 *  - horizontal scroll (documentElement.scrollWidth > viewport width),
 *  - a multi-word text leaf squeezed under 120px and wrapping into 3+ lines
 *    (the "one word per line" episode-row bug),
 *  - an interactive control smaller than the 44x44 mobile touch target.
 */
export async function auditResponsive(page: Page, viewportWidth: number, checkTouchTargets: boolean): Promise<ResponsiveAudit> {
  return page.evaluate(
    ({ vw, checkTouch }) => {
      const scrollWidth = document.documentElement.scrollWidth;
      const innerWidth = window.innerWidth;

      // Narrow, multi-word text leaves that have wrapped into many lines.
      const narrowText: Array<{ text: string; width: number; lines: number }> = [];
      const leaves = Array.from(document.querySelectorAll("p, span, a, div, h1, h2, h3, li")) as HTMLElement[];
      for (const el of leaves) {
        const text = (el.textContent || "").trim();
        if (text.length < 12 || !text.includes(" ")) continue;
        // leaf-ish: no element children carrying their own text
        const hasElementText = Array.from(el.children).some((c) => (c.textContent || "").trim().length > 0);
        if (hasElementText) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2 || 16;
        const lines = Math.round(r.height / lineHeight);
        const longestWord = text.split(/\s+/).reduce((m, w) => Math.max(m, w.length), 0);
        // Squeezed: under 120px, wrapped to 3+ lines, and not simply one very long word.
        if (r.width < 120 && lines >= 3 && longestWord < text.length) {
          narrowText.push({ text: text.slice(0, 60), width: Math.round(r.width), lines });
        }
      }

      const smallControls: Array<{ label: string; w: number; h: number }> = [];
      if (checkTouch) {
        const controls = Array.from(
          document.querySelectorAll('button, a[href], input, select, [role="button"], [role="checkbox"]'),
        ) as HTMLElement[];
        for (const el of controls) {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          if (r.width === 0 || r.height === 0) continue;
          if (cs.visibility === "hidden" || cs.display === "none") continue;
          if (el.getAttribute("tabindex") === "-1" && el.getAttribute("aria-hidden") === "true") continue;
          if (r.width < 44 || r.height < 44) {
            const label = (
              el.getAttribute("aria-label") ||
              (el.textContent || "").trim().slice(0, 24) ||
              el.tagName.toLowerCase()
            ).slice(0, 30);
            smallControls.push({ label, w: Math.round(r.width), h: Math.round(r.height) });
          }
        }
      }

      const dedupeSmall = Array.from(new Map(smallControls.map((c) => [`${c.label}:${c.w}x${c.h}`, c])).values());
      return {
        scrollWidth,
        innerWidth,
        horizontalOverflowPx: scrollWidth - innerWidth,
        narrowText: narrowText.slice(0, 12),
        smallControls: dedupeSmall.slice(0, 20),
      };
    },
    { vw: viewportWidth, checkTouch: checkTouchTargets },
  );
}

export async function boxOf(locator: Locator): Promise<{ w: number; h: number } | null> {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) return null;
  return { w: Math.round(box.width * 100) / 100, h: Math.round(box.height * 100) / 100 };
}
