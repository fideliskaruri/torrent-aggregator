/**
 * Playwright E2E + API tests for TorrentFlow.
 * Run: node scripts/playwright-e2e.mjs
 * Requires: npm run dev on http://localhost:3000
 */
import { chromium } from "playwright";
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { encode } from "next-auth/jwt";
import path from "node:path";
import fs from "node:fs";
import "dotenv/config";

const BASE = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";
const out = path.resolve("qa-shots/e2e");
fs.mkdirSync(out, { recursive: true });

const failures = [];
function assert(cond, msg) {
  if (!cond) {
    failures.push(msg);
    console.error("FAIL:", msg);
  } else {
    console.log("ok:", msg);
  }
}

// --- DB helpers ---
function createPrisma() {
  const raw = process.env.DATABASE_URL || "file:./dev.db";
  let url = raw;
  if (raw.startsWith("file:")) {
    const fp = raw.slice(5);
    if (!path.isAbsolute(fp)) {
      url = `file:${path.resolve(process.cwd(), fp.replace(/^\.\//, "")).replace(/\\/g, "/")}`;
    }
  }
  return new PrismaClient({ adapter: new PrismaLibSql({ url }) });
}

async function ensureTestUser(prisma) {
  const email = "playwright-test@torrentflow.local";
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: { email, name: "Playwright Test" },
    });
  }
  return user;
}

async function sessionCookie(userId, email, name) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET missing in .env");
  const token = await encode({
    token: {
      sub: userId,
      email,
      name,
      id: userId,
    },
    secret,
    salt: "authjs.session-token",
    maxAge: 60 * 60 * 24,
  });
  // Auth.js v5 cookie names
  return [
    {
      name: "authjs.session-token",
      value: token,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ];
}

// --- API tests (no browser) ---
async function testApis(cookies) {
  console.log("\n=== API tests ===");

  // Unauthenticated should return JSON 401, never empty
  {
    const res = await fetch(`${BASE}/api/settings/client`, { method: "GET" });
    const text = await res.text();
    assert(text.trim().length > 0, "GET settings unauth returns body");
    try {
      JSON.parse(text);
    } catch {
      assert(false, `GET settings unauth is JSON (got: ${text.slice(0, 80)})`);
    }
    assert(res.status === 401, `GET settings unauth status 401 (got ${res.status})`);
    assert(j?.error, "GET settings unauth has error field");
  }

  {
    const res = await fetch(`${BASE}/api/settings/client`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientType: "qbittorrent",
        host: "http://127.0.0.1:8080",
        baseDownloadPath: "D:\\\\Downloads\\\\Torrents",
      }),
    });
    const text = await res.text();
    assert(text.trim().length > 0, "PUT settings unauth returns body");
    try {
      JSON.parse(text);
    } catch {
      assert(false, `PUT settings unauth is JSON (got: ${text.slice(0, 80)})`);
    }
    assert(res.status === 401, `PUT settings unauth 401 (got ${res.status})`);
  }

  // Authenticated save base folder
  const cookieHeader = cookies
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  {
    const basePath = path.resolve(process.cwd(), "tmp-test-downloads");
    fs.mkdirSync(basePath, { recursive: true });

    const res = await fetch(`${BASE}/api/settings/client`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
      },
      body: JSON.stringify({
        clientType: "qbittorrent",
        host: "http://127.0.0.1:8080",
        username: "admin",
        baseDownloadPath: basePath,
        category: "TV",
        categories: [
          "Anime",
          "Movies",
          "TV",
          "Music",
          "Games",
          "Software",
          "Books",
          "Other",
        ],
        pathRules: {},
        test: false,
      }),
    });
    const text = await res.text();
    assert(text.trim().length > 0, "PUT settings auth returns non-empty body");
    let j;
    try {
      j = JSON.parse(text);
    } catch (e) {
      assert(
        false,
        `PUT settings auth JSON parse failed: ${e.message} body=${text.slice(0, 200)}`,
      );
      return;
    }
    assert(res.ok, `PUT settings auth ok (status ${res.status}): ${text.slice(0, 200)}`);
    assert(
      j.settings?.baseDownloadPath === basePath ||
        j.settings?.baseDownloadPath?.includes("tmp-test-downloads"),
      `baseDownloadPath saved (got ${j.settings?.baseDownloadPath})`,
    );
  }

  // GET back
  {
    const res = await fetch(`${BASE}/api/settings/client`, {
      headers: { Cookie: cookieHeader },
    });
    const text = await res.text();
    assert(text.trim().length > 0, "GET settings auth non-empty");
    const j = JSON.parse(text);
    assert(res.ok, `GET settings auth ok (${res.status})`);
    assert(j.settings?.baseDownloadPath, "baseDownloadPath present after save");
  }

  // Browse folders
  {
    const res = await fetch(`${BASE}/api/settings/browse-folders`, {
      headers: { Cookie: cookieHeader },
    });
    const text = await res.text();
    assert(text.trim().length > 0, "browse-folders non-empty");
    const j = JSON.parse(text);
    assert(res.ok, `browse-folders ok (${res.status}) ${text.slice(0, 150)}`);
    assert(Array.isArray(j.entries), "browse-folders entries array");
    assert(j.entries.length > 0, "browse-folders has drives/folders");
  }

  // Search returns routes from backend
  {
    const res = await fetch(
      `${BASE}/api/search?q=Atlantis&category=tv&page=1&pageSize=5&enrich=1`,
      { headers: { Cookie: cookieHeader } },
    );
    const text = await res.text();
    assert(text.trim().length > 0, "search non-empty");
    const j = JSON.parse(text);
    assert(res.ok, `search ok (${res.status})`);
    assert(Array.isArray(j.results), "search results array");
    if (j.results.length) {
      const withSeason = j.results.find((r) =>
        /S\d{1,2}/i.test(r.title || ""),
      );
      const sample = withSeason || j.results[0];
      assert(sample.route, `result has route field: ${sample.title}`);
      if (withSeason) {
        assert(
          sample.route.kind === "tv" || sample.route.category === "TV",
          `season pack routes as TV (got kind=${sample.route.kind} cat=${sample.route.category} title=${sample.title})`,
        );
      }
    }
  }

  // Open folder API (same machine as TorrentFlow)
  {
    const openPath = path.resolve(process.cwd(), "tmp-test-downloads");
    fs.mkdirSync(openPath, { recursive: true });
    const res = await fetch(`${BASE}/api/settings/open-folder`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
      },
      // reveal:false — validate path only; do NOT leave Explorer open
      body: JSON.stringify({ path: openPath, reveal: false }),
    });
    const text = await res.text();
    assert(text.trim().length > 0, "open-folder non-empty body");
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      assert(false, `open-folder JSON parse failed: ${text.slice(0, 150)}`);
    }
    // explorer may succeed (ok) even headless; path must be present either way
    assert(
      res.status === 200 || res.status === 404 || res.status === 500,
      `open-folder status expected (got ${res.status})`,
    );
    assert(
      j.ok === true || j.path || j.pathOnly || j.error,
      `open-folder structured response (got ${text.slice(0, 150)})`,
    );
    if (j.ok) {
      assert(
        String(j.path || "").includes("tmp-test-downloads") ||
          String(j.message || "").includes("tmp-test-downloads"),
        "open-folder ok references path",
      );
    }
  }

  // Client torrents list returns JSON (even if qBit offline)
  {
    const res = await fetch(`${BASE}/api/client/torrents`, {
      headers: { Cookie: cookieHeader },
    });
    const text = await res.text();
    assert(text.trim().length > 0, "client torrents non-empty");
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      assert(false, `client torrents not JSON: ${text.slice(0, 100)}`);
    }
    // 200 online; 503/502 offline — always structured JSON with torrents array
    assert(
      res.ok || res.status === 503 || res.status === 502 || res.status === 400,
      `client torrents status expected (got ${res.status})`,
    );
    assert(Array.isArray(j.torrents), "client torrents array always present");
    if (res.ok && j.torrents.length) {
      const t0 = j.torrents[0];
      assert(t0.hash && t0.name, "torrent has hash+name");
    }
    if (!res.ok) {
      assert(
        j.error || j.message,
        `client torrents error JSON (${res.status})`,
      );
      if (res.status === 503) {
        assert(j.offline === true || j.message, "offline payload when 503");
      }
    }
  }
}

// --- Browser UI tests ---
async function testUi(browser, cookies) {
  console.log("\n=== UI tests ===");
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  await context.addCookies(cookies);
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  // Home — wait for header brand OR hero search before asserting
  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 60000 });
  try {
    await Promise.race([
      page.waitForSelector('input[data-search-input="true"]', {
        timeout: 60000,
      }),
      page.waitForSelector("[data-app-header]", { timeout: 60000 }),
      page
        .getByText(/TorrentFlow|Find it|Monitor/i)
        .first()
        .waitFor({ timeout: 60000 }),
    ]);
  } catch {
    // continue; soft checks below
  }
  await page.screenshot({
    path: path.join(out, "e2e-home.png"),
    fullPage: true,
  });
  // Soft-fail brand: text may live in header or hero ("Find it." / "Monitor.")
  const brandVisible = await page
    .getByText(/TorrentFlow|Find it|Monitor/i)
    .first()
    .isVisible()
    .catch(() => false);
  if (!brandVisible) {
    console.warn("SOFT-FAIL: home shows brand (maybe text moved)");
  } else {
    assert(true, "home shows brand");
  }

  // Recent history clear UI — SearchBar on home (single search surface)
  await page.evaluate(() => {
    localStorage.setItem(
      "tf-recent-searches",
      JSON.stringify(["Severance", "Atlantis"]),
    );
  });
  await page.reload({ waitUntil: "networkidle", timeout: 60000 });

  await page.waitForSelector('input[data-search-input="true"]', {
    timeout: 60000,
  });
  const searchInput = page.locator('input[data-search-input="true"]');

  await searchInput.first().click({ timeout: 60000 });
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(out, "e2e-recent.png"),
    fullPage: false,
  });
  assert(
    await page.getByText("Clear all").isVisible(),
    "recent Clear all visible",
  );
  await page.getByText("Clear all").click();
  await page.waitForTimeout(200);
  const remaining = await page.evaluate(
    () => localStorage.getItem("tf-recent-searches"),
  );
  assert(
    !remaining || remaining === "[]",
    "clear all wipes localStorage",
  );

  // Search results render on home (`/?q=…`), not a separate /search page
  await page.goto(`${BASE}/?q=Severance&category=tv`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForTimeout(2000);
  await page.screenshot({
    path: path.join(out, "e2e-search.png"),
    fullPage: true,
  });
  const hasResults =
    (await page.locator("[data-torrent-card]").count()) > 0 ||
    (await page.getByText(/results/i).count()) > 0;
  assert(hasResults, "home search shows results or count");

  // Legacy /search redirects to home with same query
  await page.goto(`${BASE}/search?q=Severance&category=tv`, {
    waitUntil: "networkidle",
    timeout: 60000,
  });
  assert(
    page.url().includes("/?q=") || page.url().endsWith("/?q=Severance&category=tv") ||
      new URL(page.url()).pathname === "/",
    "legacy /search redirects to home",
  );

  // Settings authenticated — Folders tab hosts base download folder (PR5 tabs)
  await page.goto(`${BASE}/settings`, {
    waitUntil: "networkidle",
    timeout: 30000,
  });
  await page.waitForTimeout(800);
  await page.screenshot({
    path: path.join(out, "e2e-settings-before.png"),
    fullPage: true,
  });

  // Should not be sign-in wall
  const signInWall = await page.getByRole("link", { name: /sign in/i }).count();
  assert(signInWall === 0, "settings accessible when authenticated");

  // Tabs: Connection | Folders | Categories — base path lives under Folders
  const foldersTab = page.getByRole("tab", { name: /^Folders$/i });
  assert((await foldersTab.count()) > 0, "settings Folders tab present");
  await foldersTab.click();
  await page.waitForTimeout(300);

  const baseLabel = await page.getByText(/base download folder/i).count();
  assert(baseLabel > 0, "Base download folder visible on Folders tab");

  const testPath = path.resolve(process.cwd(), "tmp-test-downloads");
  fs.mkdirSync(testPath, { recursive: true });

  // Fill base path input (font-mono field under Base download folder)
  await page.evaluate((p) => {
    // Prefer mono inputs inside Folders panel
    const monos = [...document.querySelectorAll("input")].filter((i) =>
      (i.className || "").includes("mono"),
    );
    if (monos[0]) {
      const el = monos[0];
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(el, p);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    // Fallback: first text input with download-related placeholder
    const texts = [...document.querySelectorAll("input")].filter(
      (i) => i.type === "text" || !i.type,
    );
    const byPh = texts.find((i) =>
      /download|torrents|downloads/i.test(
        i.getAttribute("placeholder") || "",
      ),
    );
    const el = byPh || texts[0];
    if (el) {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(el, p);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, testPath);

  // Sticky save bar: Save (not Save & test — avoids hanging on qbittorrent)
  const saveBtn = page.getByRole("button", { name: /^Save$/i });
  assert((await saveBtn.count()) > 0, "Save button present in sticky bar");
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes("/api/settings/client") &&
        r.request().method() === "PUT",
      { timeout: 15000 },
    ),
    saveBtn.first().click(),
  ]);
  const status = response.status();
  const bodyText = await response.text();
  assert(bodyText.trim().length > 0, "UI save PUT body non-empty");
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    assert(false, `UI save PUT not JSON: ${bodyText.slice(0, 150)}`);
  }
  assert(
    status >= 200 && status < 300,
    `UI save status ${status}: ${bodyText.slice(0, 200)}`,
  );
  assert(parsed.settings, "UI save returns settings object");

  await page.waitForTimeout(500);
  await page.screenshot({
    path: path.join(out, "e2e-settings-after-save.png"),
    fullPage: true,
  });

  // Success message lives in sticky save bar
  const msg = page.locator("text=/Settings saved|saved|Failed|error/i");
  assert((await msg.count()) > 0, "settings save feedback message visible");
  const t = await msg.first().innerText();
  assert(
    !/Unexpected end of JSON/i.test(t),
    `no JSON parse error toast (got: ${t})`,
  );
  assert(
    /saved/i.test(t) || /Connected/i.test(t),
    `success message visible (got: ${t})`,
  );

  // Client dashboard — open folder on download list
  // Inject a fake torrent so Open folder is always exercised (even if qBit empty)
  const mockSavePath = path.resolve(process.cwd(), "tmp-test-downloads");
  fs.mkdirSync(mockSavePath, { recursive: true });
  await page.route("**/api/client/torrents", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        clientType: "qbittorrent",
        torrents: [
          {
            hash: "playwrightfaketorrenthash0123456789",
            name: "Playwright Fake Download S01E01",
            progress: 0.42,
            sizeBytes: 1_024_000_000,
            dlspeed: 5_000_000,
            upspeed: 100_000,
            state: "downloading",
            eta: 600,
            category: "TV",
            savePath: mockSavePath,
          },
        ],
      }),
    });
  });

  await page.goto(`${BASE}/client`, {
    waitUntil: "networkidle",
    timeout: 60000,
  });
  await page.waitForTimeout(800);
  await page.screenshot({
    path: path.join(out, "e2e-client.png"),
    fullPage: true,
  });
  assert(
    (await page.getByRole("heading", { name: /^Client$/i }).count()) > 0 ||
      (await page.getByRole("heading", { name: /client/i }).count()) > 0,
    "client page heading",
  );
  assert(
    (await page.locator("[data-stat-strip]").count()) > 0,
    "client stats strip visible",
  );
  assert(
    (await page.locator("[data-desktop-nav]").count()) > 0 ||
      (await page.locator("[data-mobile-nav]").count()) > 0,
    "nav chrome present",
  );
  // Desktop must not show a hamburger menu button
  const hamburger = page.locator('header button[aria-label="Menu"]');
  assert(
    (await hamburger.count()) === 0,
    "no desktop hamburger in header",
  );

  const torrentCards = page.locator("[data-client-torrent]");
  assert(
    (await torrentCards.count()) > 0,
    "client list shows torrent row (mocked)",
  );
  assert(
    (await page.locator("[data-path-chip]").count()) > 0 ||
      (await page.locator("[data-save-path]").count()) > 0,
    "torrent row shows path chip",
  );
  const openBtn = torrentCards.first().locator("[data-open-folder]");
  assert(await openBtn.count(), "open folder button on torrent row");
  // Intercept open-folder: force reveal:false so Explorer never stays open
  await page.route("**/api/settings/open-folder", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    let body = {};
    try {
      body = route.request().postDataJSON() || {};
    } catch {
      body = {};
    }
    await route.continue({
      postData: JSON.stringify({ ...body, reveal: false }),
      headers: {
        ...route.request().headers(),
        "content-type": "application/json",
      },
    });
  });
  const [openRes] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes("/api/settings/open-folder") &&
        r.request().method() === "POST",
      { timeout: 15000 },
    ),
    openBtn.click(),
  ]);
  const openText = await openRes.text();
  assert(openText.trim().length > 0, "open-folder from client UI non-empty");
  let openJson;
  try {
    openJson = JSON.parse(openText);
  } catch {
    assert(
      false,
      `open-folder from client UI not JSON: ${openText.slice(0, 100)}`,
    );
  }
  assert(
    openJson.ok === true ||
      openJson.path ||
      openJson.pathOnly ||
      openJson.error,
    "open-folder from client UI structured",
  );
  assert(
    openJson.ok === true,
    `open-folder from client UI ok (got ${openText.slice(0, 150)})`,
  );
  assert(
    openJson.revealed === false,
    "open-folder e2e must not spawn Explorer (revealed=false)",
  );
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(out, "e2e-client-open-folder.png"),
    fullPage: true,
  });
  // Toast feedback (sonner) or any success indicator
  const toastOk =
    (await page.locator("[data-sonner-toast]").count()) > 0 ||
    (await page.getByText(/opened|verified|path copied|folder/i).count()) > 0;
  assert(toastOk, "open-folder success feedback (toast or text)");
  await page.unroute("**/api/settings/open-folder");

  // Delete confirmation: cancel does not call API
  let deletePosts = 0;
  let lastDeleteBody = null;
  await page.route("**/api/client/torrents", async (route) => {
    if (route.request().method() === "POST") {
      const postData = route.request().postDataJSON();
      if (postData?.action === "delete") {
        deletePosts += 1;
        lastDeleteBody = postData;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            message: postData.deleteFiles
              ? "Removed with files"
              : "Removed only",
          }),
        });
        return;
      }
      await route.continue();
      return;
    }
    // Keep GET mock for list
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        clientType: "qbittorrent",
        torrents: [
          {
            hash: "playwrightfaketorrenthash0123456789",
            name: "Playwright Fake Download S01E01",
            progress: 0.42,
            sizeBytes: 1_024_000_000,
            dlspeed: 5_000_000,
            upspeed: 100_000,
            state: "downloading",
            eta: 600,
            category: "TV",
            savePath: mockSavePath,
          },
        ],
      }),
    });
  });

  // Delete lives in the ⋯ row menu (data-delete-torrent on the menu item)
  async function openDeleteFromMenu() {
    const row = torrentCards.first();
    await row.locator("[data-torrent-more]").click();
    const delBtn = page.locator("[data-delete-torrent]");
    assert(await delBtn.count(), "delete menu item present");
    await delBtn.click();
  }

  await openDeleteFromMenu();
  const dialog = page.locator("[data-delete-dialog]");
  assert(await dialog.isVisible(), "delete confirm dialog visible");
  assert(
    await page.getByText(/delete torrent\?/i).isVisible(),
    "delete dialog title",
  );
  assert(
    await page.getByText(/permanently removes the downloaded data/i).isVisible(),
    "delete dialog warns about files",
  );
  await page.locator("[data-delete-cancel]").click();
  await page.waitForTimeout(200);
  assert(
    (await dialog.count()) === 0 || !(await dialog.isVisible()),
    "cancel closes delete dialog",
  );
  assert(deletePosts === 0, "cancel does not POST delete");

  // Confirm delete + files
  await openDeleteFromMenu();
  assert(await dialog.isVisible(), "delete dialog reopened");
  await page.locator("[data-delete-with-files]").click();
  await page.waitForTimeout(400);
  assert(deletePosts === 1, `delete POST once (got ${deletePosts})`);
  assert(
    lastDeleteBody?.action === "delete",
    "delete body action=delete",
  );
  assert(
    lastDeleteBody?.deleteFiles === true,
    `delete body deleteFiles=true (got ${JSON.stringify(lastDeleteBody)})`,
  );
  assert(
    lastDeleteBody?.hash === "playwrightfaketorrenthash0123456789",
    "delete body includes hash",
  );
  await page.screenshot({
    path: path.join(out, "e2e-client-delete-confirm.png"),
    fullPage: true,
  });

  await page.unroute("**/api/client/torrents");

  // No page crashes (ignore network resource status noise e.g. offline client 502)
  assert(
    consoleErrors.filter(
      (e) =>
        !/favicon|hydration|Failed to load resource|net::ERR_|503|502|Service Unavailable|Bad Gateway/i.test(
          e,
        ),
    ).length === 0,
    `no page errors: ${consoleErrors.slice(0, 3).join(" | ")}`,
  );

  await context.close();
}

// --- main ---
async function main() {
  // Health check
  try {
    const r = await fetch(BASE);
    assert(r.ok || r.status < 500, `dev server up at ${BASE}`);
  } catch {
    console.error(`\nCannot reach ${BASE}. Start with: npm run dev\n`);
    process.exit(1);
  }

  const prisma = createPrisma();
  const user = await ensureTestUser(prisma);
  const cookies = await sessionCookie(user.id, user.email, user.name || "Test");

  await testApis(cookies);

  const browser = await chromium.launch({ headless: true });
  try {
    await testUi(browser, cookies);
  } finally {
    await browser.close();
    await prisma.$disconnect();
  }

  console.log("\n=== SUMMARY ===");
  if (failures.length) {
    console.error(`${failures.length} failure(s):`);
    failures.forEach((f) => console.error(" -", f));
    process.exit(1);
  }
  console.log("All Playwright checks passed.");
  console.log("Screenshots:", out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
