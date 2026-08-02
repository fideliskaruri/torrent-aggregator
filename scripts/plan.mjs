#!/usr/bin/env node
/**
 * Plan tracking, in a database rather than in an agent's memory.
 *
 * Three sessions of agents have now reported this plan as further along than
 * it was, because "what the plan claims" and "what the code does" were held in
 * the same place — prose — and prose has no column that distinguishes a wish
 * from a fact. So this file keeps them apart: `claimed` is whatever the plan
 * document asserts, `state` is only ever written after something was checked,
 * and `evidence` records what the check actually was.
 *
 * `state` starts at `unverified` for everything, including items the plan
 * marks `[x]`. A tick in a document written by the party being graded is not
 * evidence.
 *
 * Usage:
 *   node scripts/plan.mjs seed          # create/reset the item list
 *   node scripts/plan.mjs summary       # counts by phase and state
 *   node scripts/plan.mjs list [phase] [--state=X]
 *   node scripts/plan.mjs set <id> <state> "<evidence>"
 *   node scripts/plan.mjs note <id> "<note>"
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = path.join(ROOT, "docs", "plan.db");

const STATES = new Set([
  "unverified", // never checked
  "done", // checked, and it works
  "partial", // checked, some of it works
  "broken", // checked, and it does not work
  "not-started", // checked, no implementation exists
  "n/a", // deliberately dropped, with a reason in notes
]);

/** Every requirement in the plan, verbatim, with its source line. */
const ITEMS = [
  // ---- Confirmed product model ----
  ["model/navigation", 17, "Primary destinations: Browse, Library, Client, Notifications, Settings."],
  ["model/navigation", 18, "Search remains global; mobile Search opens as a focused full-screen view."],
  ["model/navigation", 19, "Remove Rules, repurpose Activity as Notifications, and remove Compact."],
  ["model/navigation", 20, "Mobile bottom navigation mirrors the five primary destinations."],

  ["model/browse", 24, "Keep a compact featured-title hero; the first row remains visible initially."],
  ["model/browse", 25, "Row order: Continue Watching, Downloaded, Movies, Series, Anime."],
  ["model/browse", 26, "Hide empty personal rows."],
  ["model/browse", 27, "Show downloaded media in its own row and with a badge wherever it reappears."],
  ["model/browse", 28, "Active cards use a compact percentage/progress ring and all cards show type."],
  ["model/browse", 29, "Card selection opens detail and never starts a transfer."],
  ["model/browse", 30, "Desktop cards reveal accessible Quick Play on hover/focus."],
  ["model/browse", 31, "Playable mobile cards show an always-visible 44px Play control."],

  ["model/search", 35, "Tabs: All, Movies, Series, Anime; All is the default."],
  ["model/search", 36, "Use the same cards as Browse."],
  ["model/search", 37, "Remove torrent/release filters from normal Search."],
  ["model/search", 38, "Phase 2 adds Games only with the complete Games journey."],

  ["model/movie-detail", 42, "Above the fold: poster, title, transfer state, year, genres, runtime, rating, short overview, and the best action."],
  ["model/movie-detail", 44, "Not downloaded: Download."],
  ["model/movie-detail", 45, "Downloading: `Downloading N%`, no duplicate Download; show Play if streamable."],
  ["model/movie-detail", 46, "Downloaded: Play plus a clear Downloaded state."],
  ["model/movie-detail", 47, "Add to Library saves the movie and starts its download when storage permits."],
  ["model/movie-detail", 48, "First Download/Add to Library asks quality, remembers it per title, and allows later changes."],
  ["model/movie-detail", 50, "Similar-title suggestions follow the primary content."],

  ["model/series-detail", 54, "Use the movie hierarchy, followed by episodes and similar-title suggestions."],
  ["model/series-detail", 55, "Exact episode rows show Play, Download, progress, failure, and Downloaded."],
  ["model/series-detail", 56, "Download season is one simple action."],
  ["model/series-detail", 57, "Validate season packs against the known episode list and silently fall back."],
  ["model/series-detail", 58, "Never expose providers, pack names, hashes, candidates, or torrent terms."],
  ["model/series-detail", 59, "Keep season transfer state at season scope; do not fake episode progress."],
  ["model/series-detail", 60, "Fetch episode metadata automatically with stable skeleton rows."],
  ["model/series-detail", 61, "Never invent S01E01 before an episode target is known."],

  ["model/play-download", 65, "Play opens one player with one continuous loading state."],
  ["model/play-download", 66, "Exhaust every enabled healthy supported source, relevant alias/category, and viable candidate, rejecting mismatches, incomplete packs, dead swarms, and failed starts automatically."],
  ["model/play-download", 69, "Keep the bounded thorough search open for roughly two minutes with plain phase copy such as Searching, Checking, and Preparing."],
  ["model/play-download", 71, "If exhausted, offer Retry plus Download instead; never manual torrent choice."],
  ["model/play-download", 72, "Configured downloads start immediately with remembered title preferences."],
  ["model/play-download", 73, "Prompt only for cap/reserve override or a true hard stop."],
  ["model/play-download", 74, "Queued, downloading, downloaded/seeding, and failed states never expose a duplicate Download action."],

  ["model/first-use", 79, "Browse and Search work without setup."],
  ["model/first-use", 80, "First Download or Library tracking opens a compact inline folder/cap form on the title page."],
  ["model/first-use", 82, "Reuse folder picker, path-safety checks, settings API, and cap validation."],
  ["model/first-use", 83, "Successful save continues the original action."],
  ["model/first-use", 84, "Errors remain inline and actionable; a toast is never the sole recovery."],

  ["model/library", 88, "Tabs: All, Movies, Series, Anime; All is the default."],
  ["model/library", 89, "Cards open the same detail page and show watching plus update/download state."],
  ["model/library", 91, "Add to Library flow: all existing episodes or future episodes only."],
  ["model/library", 92, "Add to Library flow: required first-use quality, remembered per title."],
  ["model/library", 93, "Add to Library flow: for anime, Subbed, Dubbed, or Either."],
  ["model/library", 94, "New episodes download automatically using the title preferences."],
  ["model/library", 95, "Removing from Library stops tracking but keeps files."],
  ["model/library", 96, "Deletion is separate, confirmed, and supports show/season/episode granularity."],

  ["model/client", 100, "Preserve current useful live-transfer information and controls."],
  ["model/client", 101, "Add All, Movies, Series, and Anime filters."],
  ["model/client", 102, "Group series/anime into one combined-progress row expandable to seasons and episodes; movies remain individual."],

  ["model/notifications", 107, "Quiet inbox: completed downloads and terminal actionable failures only."],
  ["model/notifications", 108, "Retry and release fallback happen before notifying the user."],
  ["model/notifications", 109, "Terminal failure shows a plain explanation and one best recovery action."],
  ["model/notifications", 110, "Completion offers Play first and title details second."],
  ["model/notifications", 111, "Navigation carries an unread count that clears as items are read."],

  ["model/settings", 115, "Normal Settings contains download locations, guided qBittorrent connection, per-drive storage caps, and verbose/diagnostic mode."],
  ["model/settings", 117, "Support a default destination plus optional media-specific destination pools."],
  ["model/settings", 118, "Fill the default drive to its cap, then overflow to ordered alternatives."],
  ["model/settings", 119, "Cap and reserve limits are overridable; physically impossible `wont-fit` is the hard stop."],
  ["model/settings", 121, "qBittorrent setup attempts safe discovery, then gives a field-by-field guide and Test connection."],
  ["model/settings", 123, "Verbose mode reveals Diagnostics with copy/export controls."],
  ["model/settings", 124, "Delete files is available consistently from detail, Client, Library, and a Settings storage manager, always showing affected file counts and size."],

  ["model/states", 129, "Stable final-layout skeletons; independent sections load independently."],
  ["model/states", 130, "User-relevant empty states explain why and offer one next action."],
  ["model/states", 131, "Hide irrelevant optional rows."],
  ["model/states", 132, "Server and hydrated attributes stay identical."],
  ["model/states", 133, "Reduced motion changes transitions/scroll only, never initial markup."],
  ["model/states", 134, "No hydration suppression, client-only blanking, or initially hidden content."],

  // ---- Phase 1A (plan marks all of these [x] except the last) ----
  ["phase-1a", 149, "Repair title, season, and episode acquisition-state reconciliation.", "done"],
  ["phase-1a", 150, "Fix duplicate Download, stale/incorrect labels, and reduced-motion hydration.", "done"],
  ["phase-1a", 151, "Rebuild navigation; remove Compact and Rules.", "done"],
  ["phase-1a", 152, "Compact Browse hero and implement the confirmed row hierarchy.", "done"],
  ["phase-1a", 153, "Add Downloaded/progress/type badges and accessible Quick Play.", "done"],
  ["phase-1a", 154, "Rebuild Search around All/Movies/Series/Anime without torrent filters.", "done"],
  ["phase-1a", 155, "Compact detail layouts and add exact transfer-state actions.", "done"],
  ["phase-1a", 156, "Add automatic episode metadata loading and remove invented S01E01.", "done"],
  ["phase-1a", 158, "Add inline first-use folder/cap setup.", "done"],
  ["phase-1a", 159, "Add per-title quality selection and persistence.", "done"],
  ["phase-1a", 160, "Browser-verify exhaustive Play and Download fallback.", "open"],

  // ---- Phase 1B ----
  ["phase-1b", 194, "Add All/Movies/Series/Anime tabs.", "open"],
  ["phase-1b", 195, "Implement Add to Library questions and per-title preferences.", "open"],
  ["phase-1b", 196, "Automatically download new episodes.", "open"],
  ["phase-1b", 197, "Show watching plus update/download state.", "open"],
  ["phase-1b", 198, "Add stop-tracking and granular confirmed deletion.", "open"],

  // ---- Phase 1C ----
  ["phase-1c", 202, "Add Client filters and expandable show grouping.", "open"],
  ["phase-1c", 203, "Replace Activity with Notifications and unread counts.", "open"],
  ["phase-1c", 204, "Emit completion notices and terminal actionable failures only.", "open"],
  ["phase-1c", 205, "Reorganize Settings around destinations, caps, qBittorrent, diagnostics, and storage management.", "open"],
  ["phase-1c", 207, "Add default-to-overflow drive selection.", "open"],

  // ---- Phase 2 ----
  ["phase-2-games", 211, "Select a game metadata catalog for covers and essential details.", "open"],
  ["phase-2-games", 212, "Add Games to Browse, Search, Library, Client, and Notifications only when its complete flow exists.", "open"],
  ["phase-2-games", 214, "Detail: cover, essential metadata, Download, progress, recovery, Downloaded.", "open"],
  ["phase-2-games", 215, "TorrentFlow does not install or launch games.", "open"],
  ["phase-2-games", 216, "Integrate only acquisition sources/content the user is authorized to download; do not integrate sources primarily used for unauthorized copyrighted distribution.", "open"],

  // ---- Acceptance gates the plan sets for itself ----
  ["acceptance/browser", 224, "Review screenshots at 375, 768, 1280, and 1920 widths."],
  ["acceptance/browser", 225, "Test keyboard navigation, focus restoration, and 44px mobile targets."],
  ["acceptance/browser", 226, "Run reduced/no-preference hydration twice at mobile and desktop sizes."],
  ["acceptance/browser", 227, "Assert no overflow, duplicate actions, contradictory state, or layout shift."],
  ["acceptance/browser", 228, "Inspect screenshots after every major surface; never approve from DOM alone."],
  ["acceptance/browser", 229, "Persist critical browser regressions in repository Playwright scripts for CI."],
];

function open() {
  return new DatabaseSync(DB_PATH);
}

function seed() {
  const db = open();
  db.exec(`
    CREATE TABLE IF NOT EXISTS item (
      id         INTEGER PRIMARY KEY,
      phase      TEXT NOT NULL,
      plan_line  INTEGER NOT NULL,
      text       TEXT NOT NULL,
      claimed    TEXT,
      state      TEXT NOT NULL DEFAULT 'unverified',
      evidence   TEXT,
      checked_at TEXT,
      notes      TEXT,
      UNIQUE (phase, plan_line)
    );
  `);
  const ins = db.prepare(
    `INSERT INTO item (phase, plan_line, text, claimed) VALUES (?, ?, ?, ?)
     ON CONFLICT (phase, plan_line) DO UPDATE SET text = excluded.text, claimed = excluded.claimed`,
  );
  for (const [phase, line, text, claimed] of ITEMS) {
    ins.run(phase, line, text, claimed ?? null);
  }
  const n = db.prepare(`SELECT COUNT(*) c FROM item`).get().c;
  console.log(`seeded ${ITEMS.length} plan items (${n} rows in ${path.relative(ROOT, DB_PATH)})`);
  db.close();
}

function summary() {
  const db = open();
  const rows = db
    .prepare(
      `SELECT phase, state, COUNT(*) c FROM item GROUP BY phase, state ORDER BY phase, state`,
    )
    .all();
  const phases = [...new Set(rows.map((r) => r.phase))];
  const states = ["done", "partial", "broken", "not-started", "unverified", "n/a"];
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad("phase", 22) + states.map((s) => pad(s, 12)).join("") + "total");
  let totals = Object.fromEntries(states.map((s) => [s, 0]));
  for (const phase of phases) {
    const by = Object.fromEntries(
      rows.filter((r) => r.phase === phase).map((r) => [r.state, r.c]),
    );
    const total = Object.values(by).reduce((a, b) => a + b, 0);
    for (const s of states) totals[s] += by[s] ?? 0;
    console.log(
      pad(phase, 22) + states.map((s) => pad(by[s] ?? "·", 12)).join("") + total,
    );
  }
  const grand = Object.values(totals).reduce((a, b) => a + b, 0);
  console.log(
    pad("TOTAL", 22) + states.map((s) => pad(totals[s], 12)).join("") + grand,
  );
  const lying = db
    .prepare(
      `SELECT COUNT(*) c FROM item WHERE claimed = 'done' AND state NOT IN ('done', 'unverified')`,
    )
    .get().c;
  if (lying) {
    console.log(`\n${lying} item(s) the plan marks [x] that do not hold up.`);
  }
  db.close();
}

function list(args) {
  const db = open();
  const stateArg = args.find((a) => a.startsWith("--state="));
  const phase = args.find((a) => !a.startsWith("--"));
  const where = [];
  const params = [];
  if (phase) {
    where.push("phase LIKE ?");
    params.push(`${phase}%`);
  }
  if (stateArg) {
    where.push("state = ?");
    params.push(stateArg.slice("--state=".length));
  }
  const sql = `SELECT id, phase, plan_line, state, claimed, text, evidence FROM item ${
    where.length ? `WHERE ${where.join(" AND ")}` : ""
  } ORDER BY phase, plan_line`;
  for (const r of db.prepare(sql).all(...params)) {
    const flag = r.claimed === "done" && r.state !== "done" && r.state !== "unverified" ? " <- plan claims done" : "";
    console.log(`${String(r.id).padStart(3)} [${r.state.padEnd(11)}] ${r.phase}:${r.plan_line}${flag}`);
    console.log(`     ${r.text}`);
    if (r.evidence) console.log(`     evidence: ${r.evidence}`);
  }
  db.close();
}

function set(args) {
  const [id, state, ...rest] = args;
  if (!STATES.has(state)) {
    console.error(`state must be one of: ${[...STATES].join(", ")}`);
    process.exit(1);
  }
  const evidence = rest.join(" ");
  if (state !== "unverified" && !evidence) {
    console.error("a state change needs evidence — that is the entire point");
    process.exit(1);
  }
  const db = open();
  db.prepare(
    `UPDATE item SET state = ?, evidence = ?, checked_at = datetime('now') WHERE id = ?`,
  ).run(state, evidence || null, Number(id));
  const r = db.prepare(`SELECT phase, plan_line, state FROM item WHERE id = ?`).get(Number(id));
  console.log(`${id} -> ${r.state}  (${r.phase}:${r.plan_line})`);
  db.close();
}

function note(args) {
  const [id, ...rest] = args;
  const db = open();
  db.prepare(`UPDATE item SET notes = ? WHERE id = ?`).run(rest.join(" "), Number(id));
  console.log(`noted ${id}`);
  db.close();
}

function mark(args) {
  // Address by phase:line, never by row id. Ids are an implementation detail
  // and guessing one silently records evidence against the wrong requirement —
  // which is the same class of error this file exists to prevent.
  const [ref, state, ...rest] = args;
  const [phase, line] = ref.split(":");
  if (!phase || !line) {
    console.error("reference must be phase:line, e.g. model/browse:27");
    process.exit(1);
  }
  if (!STATES.has(state)) {
    console.error(`state must be one of: ${[...STATES].join(", ")}`);
    process.exit(1);
  }
  const evidence = rest.join(" ");
  if (state !== "unverified" && !evidence) {
    console.error("a state change needs evidence — that is the entire point");
    process.exit(1);
  }
  const db = open();
  const row = db
    .prepare(`SELECT id, text FROM item WHERE phase = ? AND plan_line = ?`)
    .get(phase, Number(line));
  if (!row) {
    console.error(`no such item: ${ref}`);
    process.exit(1);
  }
  db.prepare(
    `UPDATE item SET state = ?, evidence = ?, checked_at = datetime('now') WHERE id = ?`,
  ).run(state, evidence || null, row.id);
  console.log(`${ref} -> ${state}`);
  db.close();
}

/**
 * The next thing worth doing, chosen by the database rather than by memory.
 *
 * Autopilot asks this after every idle. Deriving the next step from verified
 * state is the whole safety property: an agent that picks its own next task
 * from recollection will drift toward the parts it enjoys and away from the
 * parts it has already convinced itself are finished, which is how eleven
 * Phase 1A items came to be ticked while one of them had no code at all.
 *
 * Order is deliberate. Unverified items come before unbuilt ones, because
 * building on an unchecked foundation is how the last three sessions produced
 * work that had to be thrown away.
 */
function next() {
  const db = open();
  const pick =
    db
      .prepare(
        `SELECT id, phase, plan_line, text, state, claimed FROM item
         WHERE state = 'unverified' AND claimed = 'done'
         ORDER BY phase, plan_line LIMIT 1`,
      )
      .get() ??
    db
      .prepare(
        `SELECT id, phase, plan_line, text, state, claimed FROM item
         WHERE state = 'unverified' ORDER BY phase, plan_line LIMIT 1`,
      )
      .get() ??
    db
      .prepare(
        `SELECT id, phase, plan_line, text, state, claimed FROM item
         WHERE state IN ('not-started', 'broken', 'partial')
         ORDER BY phase, plan_line LIMIT 1`,
      )
      .get();

  if (!pick) {
    console.log("PLAN COMPLETE — every item verified done or n/a");
    db.close();
    return;
  }
  const remaining = db
    .prepare(
      `SELECT COUNT(*) c FROM item WHERE state NOT IN ('done', 'n/a')`,
    )
    .get().c;
  const verb = pick.state === "unverified" ? "VERIFY" : "BUILD";
  console.log(`${verb} ${pick.phase}:${pick.plan_line}`);
  console.log(pick.text);
  if (pick.state === "unverified" && pick.claimed === "done") {
    console.log("(the plan marks this [x] — check it, do not trust it)");
  }
  console.log(`${remaining} item(s) still outstanding`);
  db.close();
}

/**
 * A reviewable text view of the database.
 *
 * The database is the source of truth, but a binary blob produces no useful
 * diff, and "trust me, the numbers moved" is the register this project is
 * trying to get out of. Regenerating this on each commit means a reviewer can
 * see which claim changed and what evidence was offered for it.
 */
function exportMd() {
  const db = open();
  const rows = db
    .prepare(
      `SELECT phase, plan_line, text, claimed, state, evidence FROM item
       ORDER BY phase, plan_line`,
    )
    .all();
  const counts = {};
  for (const r of rows) counts[r.state] = (counts[r.state] ?? 0) + 1;

  const out = [
    "# Plan status",
    "",
    "<!-- GENERATED by `node scripts/plan.mjs export`. Edit the database, not this file. -->",
    "",
    "`state` is only written after something was checked; `claimed` is what the",
    "plan document asserts. Where they disagree, the plan is wrong.",
    "",
    ...Object.entries(counts)
      .sort()
      .map(([k, v]) => `- **${k}**: ${v}`),
    "",
  ];
  let phase = null;
  for (const r of rows) {
    if (r.phase !== phase) {
      phase = r.phase;
      out.push("", `## ${phase}`, "");
    }
    const flag =
      r.claimed === "done" && !["done", "unverified"].includes(r.state)
        ? " **← plan claims done**"
        : "";
    out.push(`- \`${r.state}\` — ${r.text}${flag}`);
    if (r.evidence) out.push(`  - evidence: ${r.evidence}`);
  }
  const file = path.join(ROOT, "docs", "plan-status.md");
  fs.writeFileSync(file, `${out.join("\n")}\n`);
  console.log(`wrote ${path.relative(ROOT, file)} (${rows.length} items)`);
  db.close();
}

const [cmd, ...rest] = process.argv.slice(2);
const commands = { seed, summary, list, set, mark, note, next, export: exportMd };
if (!cmd) {
  summary();
} else if (commands[cmd]) {
  commands[cmd](rest);
} else {
  console.error(`unknown command: ${cmd}`);
  process.exit(1);
}
