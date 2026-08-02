/**
 * Proof that "empty" and "broken" are now distinguishable in the UI.
 *
 * The bug this guards against does not look like a bug: a panel whose fetch
 * rejected used to clear its spinner, render its *empty state*, and tell the
 * user with full confidence that they had no history / no rules / no activity.
 * No error, no retry, nothing to click — the failure was indistinguishable
 * from a true empty result, which is the one thing a data panel must never do.
 *
 * A unit test cannot catch that, because the component is "working" in both
 * cases. So this drives real Edge, forces the API to fail, and asserts on what
 * the user can actually see and do:
 *
 *   1. the error state is shown,
 *   2. the *empty* state is NOT shown (the specific wrong-answer we shipped),
 *   3. a retry control exists,
 *   4. clicking retry really re-requests, and recovers when the API works.
 *
 * Screenshots are written alongside so the states can be eyeballed too.
 *
 * Playwright browser binaries are not downloadable on this network, so this
 * drives the system Edge install via the msedge channel.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const OUT = process.env.SHOT_DIR ?? "qa-screens/error-states";

/** Text that must NOT appear while an error is on screen. */
const CASES = [
  {
    name: "activity",
    route: "/activity",
    api: "**/api/activity*",
    emptyText: "No activity yet",
  },
  {
    name: "rules",
    route: "/rules",
    api: "**/api/rules",
    emptyText: "No rules yet",
  },
  {
    name: "history",
    route: "/history",
    api: "**/api/history*",
    emptyText: "No downloads",
  },
  {
    // The library is the page where a wrong empty state is most expensive: it
    // renders "No items yet" with instructions to go and add something, which
    // reads as *your library is gone*, not *we could not read it*. Before the
    // `useApiQuery` refactor this page ran the same fetch twice and showed the
    // error banner and that empty state simultaneously.
    name: "watchlist",
    route: "/watchlist",
    api: "**/api/watchlist*",
    emptyText: "No items yet",
  },
  {
    // Settings is not a list, and its failure mode is worse than a wrong
    // empty state: a failed load used to fall through to a form pre-filled
    // with *defaults*, so the next Save silently overwrote a working client
    // config with them. The assertion that matters is that no editable form
    // is reachable while the settings are unknown.
    name: "settings",
    route: "/settings",
    api: "**/api/settings/client",
    emptyText: null,
    mustNotRender: "main input",
  },
  {
    // The client page already gets this right structurally — its torrent
    // section is the `else` of the error branch — and it has its own bespoke
    // error panel offering a switch-to-built-in action a generic one could
    // not. This case is a regression guard rather than a fix: it pins the
    // behaviour so a later refactor that flattens that ternary cannot
    // reintroduce "No torrents yet" underneath a failure.
    name: "client",
    route: "/client",
    api: "**/api/client/torrents*",
    emptyText: "No torrents yet",
    errorSelector: "[data-client-engine-error], [data-client-offline]",
    expectApiMessage: false,
    hasRetry: false,
  },
  {
    // The browse home is the one page here whose happy path never touches the
    // browser's network at all: it is server-rendered from one query. Only the
    // two answers that would otherwise put words in the user's mouth — "you
    // have nothing" and a failure disguised as it — are handed to a client
    // island, precisely so there is something able to ask again. That island
    // is what this case drives.
    name: "browse",
    route: "/",
    api: "**/api/browse*",
    emptySelector: "[data-browse-empty]",
    skippedWhen: "[data-browse-board]",
    // A browse payload, not the generic list body: the island reads `rails`,
    // and recovering into a differently-shaped object would prove nothing.
    okBody: { rails: [], generatedAt: new Date().toISOString() },
  },
];

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "msedge", headless: true });
const results = [];
const fail = (c, msg) => results.push({ case: c, ok: false, msg });
const pass = (c, msg) => results.push({ case: c, ok: true, msg });
const skip = (c, msg) => results.push({ case: c, ok: true, skipped: true, msg });

for (const c of CASES) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  });
  const page = await context.newPage();

  // Count requests so "retry actually refetches" is measured, not assumed.
  let calls = 0;
  let broken = true;
  await page.route(c.api, async (route) => {
    calls += 1;
    if (broken) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Simulated backend failure" }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(c.okBody ?? { items: [], rules: [] }),
      });
    }
  });

  try {
    await page.goto(`${BASE}${c.route}`, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });

    // Generous: this runs against a dev server, where the first hit on a route
    // pays for an on-demand compile that can outlast a default timeout. A
    // flake here would look exactly like the regression we are testing for,
    // so the wait is sized to remove that ambiguity.
    const errorState = page.locator(c.errorSelector ?? "[data-error-state]");
    let mounted = true;
    try {
      await errorState.first().waitFor({ state: "visible", timeout: 90_000 });
    } catch (err) {
      // Distinguish "the error state is broken" from "this page never got the
      // chance to fail". Browse is server-rendered and only hands off to its
      // client island when there is nothing to show, so against a populated
      // database the forced 500 is never requested: `loadBrowsePayload` calls
      // `buildBrowsePayload` in-process, which route interception cannot reach.
      //
      // That precondition is ambient, so this must not be a hard failure — a
      // gate that goes red on data alone gets ignored. It must not be a silent
      // pass either. It is reported as a counted SKIP naming the precondition.
      if (c.skippedWhen && (await page.locator(c.skippedWhen).count())) {
        skip(
          c.name,
          `page rendered "${c.skippedWhen}" — the fetching island only mounts on an empty library, so this case needs an empty DB to assert against`,
        );
        mounted = false;
      } else {
        throw err;
      }
    }
    if (!mounted) continue;
    pass(c.name, "error state visible on failed load");

    // The regression that shipped: failure rendered as a confident empty state.
    if (c.emptyText || c.emptySelector) {
      const emptyShown = c.emptySelector
        ? Boolean(await page.locator(c.emptySelector).count())
        : await page
            .getByText(c.emptyText, { exact: false })
            .isVisible()
            .catch(() => false);
      if (emptyShown) {
        fail(
          c.name,
          `empty state ("${c.emptyText ?? c.emptySelector}") shown while errored`,
        );
      } else {
        pass(c.name, "empty state correctly suppressed while errored");
      }
    }

    // For forms: nothing editable may be reachable while the data is unknown.
    if (c.mustNotRender) {
      const editable = await page.locator(c.mustNotRender).count();
      if (editable > 0) {
        fail(
          c.name,
          `${editable} editable "${c.mustNotRender}" rendered while errored — a save could overwrite unread data`,
        );
      } else {
        pass(c.name, `nothing matching "${c.mustNotRender}" reachable while errored`);
      }
    }

    // The API's own message is more actionable than a status code.
    if (c.expectApiMessage !== false) {
      const errText = (await errorState.first().innerText()).toLowerCase();
      if (errText.includes("simulated backend failure")) {
        pass(c.name, "surfaces the API's error message");
      } else {
        fail(c.name, `error text lacks API message: ${errText.slice(0, 120)}`);
      }
    }

    await page.screenshot({
      path: join(OUT, `${c.name}-error.png`),
      fullPage: true,
    });

    // Retry must exist and must actually re-request. A few panels (the client
    // page) deliberately offer a different recovery action instead, so the
    // requirement is opt-out per case rather than silently skipped.
    const retry = page.getByRole("button", { name: /try again|retry/i });
    if (c.hasRetry === false) {
      pass(c.name, "no retry expected for this panel");
    } else if (!(await retry.count())) {
      fail(c.name, "no retry control offered");
    } else {
      const before = calls;
      broken = false;
      await retry.first().click();
      await page.waitForTimeout(1500);
      if (calls > before) {
        pass(c.name, `retry re-requested (${before} -> ${calls})`);
      } else {
        fail(c.name, "retry did not issue a new request");
      }

      // And the error must clear once the API works again.
      const stillErrored = await errorState
        .first()
        .isVisible()
        .catch(() => false);
      if (stillErrored) {
        fail(c.name, "error state persisted after a successful retry");
      } else {
        pass(c.name, "recovered after successful retry");
        await page.screenshot({
          path: join(OUT, `${c.name}-recovered.png`),
          fullPage: true,
        });
      }
    }
  } catch (err) {
    fail(c.name, `threw: ${err.message}`);
  } finally {
    await context.close();
  }
}

await browser.close();

let failed = 0;
let skipped = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  else if (r.skipped) skipped += 1;
  const label = r.ok ? (r.skipped ? "SKIP" : "PASS") : "FAIL";
  console.log(`${label}  ${r.case.padEnd(9)} ${r.msg}`);
}
const assertions = results.length - skipped;
console.log(
  failed
    ? `\n${failed} of ${results.length} checks FAILED`
    : `\nALL GREEN — ${assertions}/${assertions} checks passed${
        skipped ? ` (${skipped} skipped — precondition not met, see SKIP above)` : ""
      }`,
);
console.log(`Screenshots: ${OUT}`);
process.exit(failed ? 1 : 0);
