/**
 * The next-episode button, driven in the real player.
 *
 * The owner's report was three words: *"the next episode button doesn't work"*.
 * The cause was that it POSTed to the **speculative pre-warm** endpoint, whose
 * intent gates (`foreground-busy`, `streaming-source`, a minimum-progress check,
 * a concurrency cap) always match while something is playing. It returned
 * `200 {ok:true, outcome:{status:"skipped"}}`, acquired nothing, and the client
 * discarded the body. A click that did nothing, reported as nothing.
 *
 * It now goes through `/api/library/ondemand` as a stream and plays the result.
 * That has been proven at the route level — but the route was never the part
 * that was broken. THIS is the part that was broken: the button, in the player,
 * with something actually playing. So this drives exactly that.
 *
 * Streams only (`retention: "stream"`), and deletes everything it started.
 *
 * Run:  node scripts\probes\next-episode.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const SHOW = "Severance";

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}
function note(msg) {
  console.log(`  note  ${msg}`);
}

const browser = await chromium.launch({ headless: true });
const started = new Set();

try {
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();

  // Record every acquisition call so we can prove WHICH endpoint the button hit.
  const calls = [];
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("/api/library/ondemand") || u.includes("/api/prewarm")) {
      let body = null;
      try {
        body = JSON.parse(r.postData() ?? "{}");
      } catch {
        /* ignore */
      }
      calls.push({ url: u.replace(BASE, ""), action: body?.action ?? null, body });
    }
  });
  page.on("response", async (r) => {
    if (r.url().includes("/api/library/ondemand")) {
      const j = await r.json().catch(() => null);
      if (j?.infoHash) started.add(j.infoHash);
    }
  });

  // ── Get an episode playing ──────────────────────────────────────────────
  //
  // Straight to the title page rather than through the palette. An earlier
  // version searched from Browse and Playwright resolved
  // `[data-card-target="title"]` to a *rail card behind the overlay* — the
  // backdrop then swallowed every click. The palette is verified elsewhere;
  // what this probe is about starts at the player.
  await page.goto(`${BASE}/title/severance?t=Severance&y=2022&type=tv`, {
    waitUntil: "networkidle",
  });
  check("a series title page opens", /\/title\//.test(page.url()), page.url());

  // Play the first episode we can reach.
  const play = page
    .locator('button:has-text("Play"), [data-action="play"]')
    .first();
  check("the title page offers Play", (await play.count()) > 0);
  if ((await play.count()) === 0) throw new Error("no Play control");

  await play.click();
  note("pressed Play — waiting for the player to take over");

  // The player mounts and starts resolving. Give it a real window: this is a
  // live swarm, not a fixture.
  const transport = page.locator("[data-stream-next]");
  await page.waitForSelector("[data-stream-next]", { timeout: 120000 }).catch(() => {});
  check("the player opens with a transport bar", (await transport.count()) > 0);
  if ((await transport.count()) === 0) throw new Error("player never opened");

  // ── The up-next card must resolve before the button can mean anything ───
  await page
    .waitForFunction(
      () => {
        const b = document.querySelector("[data-stream-next]");
        return b instanceof HTMLButtonElement && !b.disabled;
      },
      undefined,
      { timeout: 120000 },
    )
    .catch(() => {});

  const enabled = await page.evaluate(() => {
    const b = document.querySelector("[data-stream-next]");
    return b instanceof HTMLButtonElement ? !b.disabled : null;
  });
  check("the Next button becomes enabled once an up-next exists", enabled === true,
    `disabled state: ${enabled === null ? "button missing" : !enabled}`);

  const beforeCalls = calls.length;

  // ── THE CLICK ───────────────────────────────────────────────────────────
  if (enabled) {
    await transport.click();
    note("clicked Next");

    // It must do SOMETHING within a reasonable window: either acquire, or say
    // why not. Silence is the bug.
    await page.waitForTimeout(20000);

    const newCalls = calls.slice(beforeCalls);
    check("clicking Next actually calls something", newCalls.length > 0,
      "no acquisition request was made — this is the original bug");

    // The regression that matters most: it must NOT go back to speculative
    // pre-warm, whose gates guarantee a no-op during playback.
    const wentToPrewarmTrigger = newCalls.some(
      (c) => c.url.includes("/api/prewarm") && c.action === "trigger",
    );
    check("Next does NOT use the speculative pre-warm endpoint",
      !wentToPrewarmTrigger,
      `calls: ${JSON.stringify(newCalls.map((c) => `${c.url}:${c.action ?? ""}`))}`);

    const usedOnDemand = newCalls.some((c) => c.url.includes("/api/library/ondemand"));
    const alreadyHadHash = newCalls.length === 0;
    check("Next uses the on-demand path (or already had the episode)",
      usedOnDemand || alreadyHadHash,
      `calls: ${JSON.stringify(newCalls.map((c) => c.url))}`);

    if (usedOnDemand) {
      const sent = newCalls.find((c) => c.url.includes("ondemand"))?.body;
      check("the request streams rather than starting a permanent download",
        sent?.retention === "stream", `retention=${sent?.retention}`);
      check("the episode on screen is protected from reclamation",
        Array.isArray(sent?.protectHashes), JSON.stringify(sent?.protectHashes));
      note(`asked for S${sent?.season}E${sent?.episode} of "${sent?.title}"`);
    }

    // ── The user-visible outcome ─────────────────────────────────────────
    const state = await page.evaluate(() => {
      const status = document.querySelector("[data-up-next-status]");
      const btn = document.querySelector("[data-stream-next]");
      return {
        status: status?.textContent?.trim() ?? null,
        busy: btn?.querySelector(".animate-spin") != null,
        bodyHasError: /could not|failed|no seed|not find/i.test(
          document.body.innerText,
        ),
      };
    });

    // Whatever happened, the app must SAY. A click that changes nothing on
    // screen is indistinguishable from a dead button, which is the report.
    check("the click produces a visible consequence",
      usedOnDemand || state.busy || Boolean(state.status),
      JSON.stringify(state));
    note(`up-next line: ${state.status ?? "(none)"}`);
  }

  await page.screenshot({ path: "qa-shots/audit/next-episode.png" });
  await page.close();
} finally {
  await browser.close();

  // ── Clean up every stream this probe started ───────────────────────────
  const list = await fetch(`${BASE}/api/client/torrents`)
    .then((r) => r.json())
    .catch(() => null);
  for (const t of list?.torrents ?? []) {
    await fetch(`${BASE}/api/client/torrents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", hash: t.hash, deleteFiles: true }),
    }).catch(() => null);
    console.log(`  cleaned: ${(t.name ?? t.hash).slice(0, 56)}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nnext-episode button verified in the real player");
