/**
 * Pre-warm `action: "next"` contract tests.
 *
 * The expensive mistake this guards against: resolving the next episode by
 * scanning torrent *names*, which can never see the successor sitting inside
 * the season pack already playing — so the viewer paid for an indexer search
 * and a second acquisition of bytes already on their disk.
 *
 * Run: npx tsx src/app/api/prewarm/route.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

let failures = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

const source = fs.readFileSync("src/app/api/prewarm/route.ts", "utf8");

const nextAction = source.slice(
  source.indexOf('if (body.action === "next")'),
  source.indexOf('if (body.action === "trigger")'),
);

check("given the current torrent, the in-pack lookup runs before any row-name scan", () => {
  const inPack = nextAction.indexOf("episodeFileInTorrent(current");
  const rowScan = nextAction.indexOf("heldRows");
  assert.ok(inPack >= 0, "the playing torrent's own files are inspected");
  assert.ok(rowScan >= 0);
  assert.ok(inPack < rowScan, "the in-pack answer is reached before the name scan");
});

check("given an in-pack hit, the response returns the same infoHash and an exact file", () => {
  const branch = nextAction.slice(nextAction.indexOf("if (current && inPackPath)"));
  assert.match(branch, /infoHash: current\.hash/);
  assert.match(branch, /filePath: inPackPath/);
  assert.match(branch, /availability: "ready"/);
});

check("given an in-pack hit, no ranking, search or acquisition is invoked first", () => {
  const beforeReturn = nextAction.slice(0, nextAction.indexOf("if (current && inPackPath)"));
  assert.ok(!/getPreRanked/.test(beforeReturn), "no pre-rank lookup before the fast answer");
  assert.ok(!/prewarmNextEpisode/.test(beforeReturn), "no acquisition before the fast answer");
});

check("given an already-known separate torrent, an exact file is returned when it is deterministic", () => {
  assert.match(nextAction, /episodeFileInTorrent\(byEpisode/);
  assert.match(nextAction, /filePath: matchedPath/);
});

check("given an explicit next-episode acquisition, it wins over a speculative pre-rank", () => {
  const acquisitionLookup = nextAction.indexOf("prisma.acquisitionTarget.findFirst");
  const preRankLookup = nextAction.indexOf("getPreRanked(next)");
  assert.ok(acquisitionLookup >= 0, "the current acquisition identifies the canonical work");
  assert.ok(preRankLookup > acquisitionLookup, "user intent is resolved before pre-rank fallback");
  assert.match(nextAction, /const byEpisode =\s*acquired \?\?\s*exact \?\?/);
});

check("episode parsing is reused, never duplicated in the route", () => {
  assert.ok(
    !/S\(\\d/.test(source) && !/\[Ee\]\(\\d/.test(source),
    "the route defines no episode regex of its own",
  );
  assert.match(source, /from "@\/lib\/prewarm\/next-episode-file"/);
});

console.log(
  `\n${failures === 0 ? "prewarm route: all tests passed" : `prewarm route: ${failures} failing`}`,
);
process.exit(failures === 0 ? 0 : 1);
