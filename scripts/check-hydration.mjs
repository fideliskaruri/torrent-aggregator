/**
 * Hydration probe: does the server-rendered markup match what React builds on
 * the client?
 *
 * The defect this exists for: `initial={reduceMotion ? false : {...}}` in a
 * framer-motion component. `useReducedMotion()` cannot know the client's
 * preference during SSR, so it returns false there and may return true in the
 * browser. The two renders then disagree about the element's style attribute
 * and React logs a hydration mismatch.
 *
 * A mismatch is only observable in the browser console, so this drives a real
 * Chromium and reads console + page errors. Reduced-motion and no-preference
 * are both run twice, because hydration errors are sensitive to timing and a
 * single green pass proves very little.
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE ?? "http://127.0.0.1:3000";
const ROUTES = ["/", "/search", "/downloads", "/notifications", "/watchlist", "/settings"];

/** React's hydration complaints, plus the generic error boundary text. */
const HYDRATION_PATTERNS = [
  /hydrat/i,
  /did not match/i,
  /server rendered html/i,
  /text content does not match/i,
];

async function probe(browser, { motion, pass }) {
  const context = await browser.newContext({
    reducedMotion: motion,
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  const findings = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error" && msg.type() !== "warning") return;
    findings.push({ kind: `console.${msg.type()}`, text: msg.text() });
  });
  page.on("pageerror", (err) => {
    findings.push({ kind: "pageerror", text: err.message });
  });
  page.on("response", (res) => {
    if (res.status() >= 500) {
      findings.push({ kind: "http5xx", text: `${res.status()} ${res.url()}` });
    }
  });

  const results = [];
  for (const route of ROUTES) {
    findings.length = 0;
    await page.goto(`${BASE}${route}`, {
      waitUntil: "networkidle",
      timeout: 45_000,
    });
    // Hydration errors surface after React attaches; give it a beat.
    await page.waitForTimeout(1200);

    const hydration = findings.filter((f) =>
      HYDRATION_PATTERNS.some((re) => re.test(f.text)),
    );
    results.push({
      route,
      motion,
      pass,
      hydration,
      other: findings.filter((f) => !hydration.includes(f)),
    });
  }

  await context.close();
  return results;
}

const browser = await chromium.launch();
const all = [];
for (const motion of ["reduce", "no-preference"]) {
  for (const pass of [1, 2]) {
    all.push(...(await probe(browser, { motion, pass })));
  }
}
await browser.close();

let failed = 0;
for (const r of all) {
  const tag = `${r.route} [${r.motion} pass${r.pass}]`;
  if (r.hydration.length) {
    failed++;
    console.log(`HYDRATION  ${tag}`);
    for (const f of r.hydration) console.log(`    ${f.kind}: ${f.text.slice(0, 200)}`);
  } else {
    console.log(`ok         ${tag}`);
  }
  for (const f of r.other) {
    console.log(`    (other) ${f.kind}: ${f.text.slice(0, 160)}`);
  }
}

console.log(
  failed === 0
    ? `\nNO HYDRATION MISMATCH — ${all.length} route/motion/pass combinations`
    : `\n${failed} HYDRATION FAILURES of ${all.length}`,
);
process.exit(failed === 0 ? 0 : 1);
