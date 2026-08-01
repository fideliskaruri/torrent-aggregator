/**
 * Settings simplicity and progressive-disclosure browser gate.
 *
 * Run against an already-running server:
 *   node scripts/probes/settings-simplicity.mjs --base http://127.0.0.1:3218
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const baseArg = process.argv.indexOf("--base");
const BASE =
  (baseArg >= 0 ? process.argv[baseArg + 1] : null) ||
  process.env.PLAYWRIGHT_BASE_URL ||
  "http://127.0.0.1:3000";
const OUT = resolve(
  process.env.SHOT_DIR ?? "qa-screens/settings-audit/after",
);
const WIDTHS = [320, 390, 768, 1440];

mkdirSync(OUT, { recursive: true });

const failures = [];
function check(condition, message, detail = "") {
  if (condition) {
    console.log(`  ok  ${message}`);
    return;
  }
  const suffix = detail ? `: ${detail}` : "";
  failures.push(`${message}${suffix}`);
  console.error(`FAIL  ${message}${suffix}`);
}

function writableSettings(settings) {
  return {
    clientType: settings.clientType,
    externalClientType: settings.externalClientType,
    host: settings.host,
    username: settings.username ?? "",
    category: settings.category,
    savePath: settings.savePath,
    baseDownloadPath: settings.baseDownloadPath,
    maxStorageGb: settings.maxStorageGb,
    verboseDiagnostics: settings.verboseDiagnostics,
    preferredResolution: settings.preferredResolution,
    automationIntervalMinutes: settings.automationIntervalMinutes,
    defaultRetentionPolicy: settings.defaultRetentionPolicy,
    categories: settings.categories,
    pathRules: settings.pathRules,
  };
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: "dark",
  deviceScaleFactor: 1,
});
const page = await context.newPage();
let original = null;

try {
  const response = await page.goto(`${BASE}/settings`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  check(response?.status() === 200, "Settings returns HTTP 200");
  await page.waitForTimeout(1200);

  const api = await page.request.get(`${BASE}/api/settings/client`);
  const payload = await api.json();
  original = payload.settings;
  check(Boolean(original), "Settings API returned current values");

  const advanced = page.locator("[data-advanced-settings]");
  check((await advanced.count()) === 0, "Advanced is collapsed by default");
  check(
    (await page.locator("[data-external-client-fields]").count()) ===
      (original?.clientType !== "builtin" || original?.externalClientType ? 1 : 0),
    "External fields reflect only an explicit saved external choice",
  );

  const initialCount = await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0" &&
        element.getAttribute("aria-hidden") !== "true" &&
        element.tabIndex !== -1
      );
    };
    return Array.from(
      document.querySelectorAll(
        "[data-settings-form] input, [data-settings-form] select, [data-settings-form] textarea, [data-settings-form] button, [data-settings-form] [role='checkbox']",
      ),
    ).filter(
      (element) =>
        visible(element) &&
        !element.matches("[data-settings-save], [data-settings-discard]") &&
        element.id !== "advanced-settings" &&
        !element.closest("[data-external-client-fields]"),
    ).length;
  });
  console.log(`  info initial visible controls: ${initialCount}`);
  check(
    initialCount >= 5 && initialCount <= 8,
    "Basic Settings has 5–8 visible controls",
    `found ${initialCount}`,
  );

  const externalToggle = page.getByRole("checkbox", {
    name: /Use another download app/i,
  });
  if ((await externalToggle.getAttribute("aria-checked")) === "true") {
    await externalToggle.click();
  }
  check(
    (await page.locator("[data-external-client-fields]").count()) === 0,
    "External connection fields are hidden when the choice is off",
  );
  await externalToggle.click();
  check(
    (await page.locator("[data-external-client-fields]").count()) === 1,
    "External connection fields appear after the explicit choice",
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(600);

  await page.locator("#advanced-settings").click();
  check((await advanced.count()) === 1, "Advanced disclosure opens");
  const renderedSettingsText = await page.locator("main").innerText();
  check(
    !/\b(ephemeral|prewarm|seeder gate|retention policy|baseDownloadPath|RunLock|swarm measurement)\b/i.test(
      renderedSettingsText,
    ),
    "Settings uses outcome language instead of subsystem terms",
  );

  const unlabeled = await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const name = (element) => {
      if (element.getAttribute("aria-label")?.trim()) return true;
      if (element.getAttribute("aria-labelledby")?.trim()) return true;
      if (element.id && document.querySelector(`label[for="${CSS.escape(element.id)}"]`)) {
        return true;
      }
      return Boolean(element.closest("label"));
    };
    return Array.from(
      document.querySelectorAll(
        "[data-settings-form] input, [data-settings-form] select, [data-settings-form] textarea",
      ),
    )
      .filter((element) => visible(element) && !name(element))
      .map((element) => `${element.tagName.toLowerCase()}#${element.id}`);
  });
  check(
    unlabeled.length === 0,
    "Every Settings field has an accessible label",
    unlabeled.join(", "),
  );

  if (original) {
    const nextTiming = original.automationIntervalMinutes === 30 ? "120" : "30";
    await page.locator("#automation-timing").selectOption(nextTiming);
    await page.getByRole("checkbox", {
      name: /Show detailed playback diagnostics/i,
    }).click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByRole("status").filter({ hasText: /Changes saved/i }).waitFor();

    await page.reload({ waitUntil: "networkidle" });
    await page.locator("#advanced-settings").click();
    check(
      (await page.locator("#automation-timing").inputValue()) === nextTiming,
      "Advanced timing value round-trips through save and reload",
    );
    check(
      (await page
        .getByRole("checkbox", {
          name: /Show detailed playback diagnostics/i,
        })
        .getAttribute("aria-checked")) ===
        String(!original.verboseDiagnostics),
      "Advanced diagnostics value round-trips through save and reload",
    );
    const afterSave = (
      await (await page.request.get(`${BASE}/api/settings/client`)).json()
    ).settings;
    const preservedKeys = [
      "clientType",
      "externalClientType",
      "host",
      "username",
      "savePath",
      "baseDownloadPath",
      "preferredResolution",
      "defaultRetentionPolicy",
      "categories",
      "pathRules",
    ];
    const changedUnexpectedly = preservedKeys.filter(
      (key) => JSON.stringify(afterSave?.[key]) !== JSON.stringify(original?.[key]),
    );
    check(
      changedUnexpectedly.length === 0,
      "Saving Advanced preserves every unrelated form value",
      changedUnexpectedly.join(", "),
    );

    const restored = await page.request.put(`${BASE}/api/settings/client`, {
      data: writableSettings(original),
    });
    check(restored.ok(), "Probe restored original Settings values");
    original = null;
    await page.reload({ waitUntil: "networkidle" });
  }

  await page.setViewportSize({ width: 320, height: 700 });
  await page.locator("#advanced-settings").click();
  const focusTarget = page.locator("#new-category");
  await focusTarget.focus();
  await focusTarget.evaluate((element) =>
    element.scrollIntoView({ block: "center", behavior: "instant" }),
  );
  await page.waitForTimeout(100);
  const focusClearance = await page.evaluate(() => {
    const active = document.activeElement;
    const nav = document.querySelector("[data-mobile-nav]");
    if (!active) return null;
    const control = active.getBoundingClientRect();
    const bottom = nav?.getBoundingClientRect().top ?? window.innerHeight;
    return { top: control.top, bottom: control.bottom, safeBottom: bottom };
  });
  check(
    Boolean(
      focusClearance &&
        focusClearance.top >= 0 &&
        focusClearance.bottom <= focusClearance.safeBottom,
    ),
    "Focused mobile field clears fixed navigation",
    JSON.stringify(focusClearance),
  );

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width <= 390 ? 844 : 900 });
    await page.goto(`${BASE}/settings`, {
      waitUntil: "networkidle",
      timeout: 90_000,
    });
    await page.waitForTimeout(700);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    check(overflow <= 1, `${width}px has no horizontal overflow`, `+${overflow}px`);
    const file = resolve(OUT, `settings-${width}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`  shot ${file}`);
  }
} finally {
  if (original) {
    try {
      await page.request.put(`${BASE}/api/settings/client`, {
        data: writableSettings(original),
      });
      console.log("  restore original Settings after failure");
    } catch (error) {
      failures.push(`could not restore Settings: ${error.message}`);
    }
  }
  await context.close();
  await browser.close();
}

console.log(
  failures.length
    ? `\nsettings-simplicity: ${failures.length} FAILED`
    : "\nsettings-simplicity: all checks passed",
);
process.exit(failures.length ? 1 : 0);
