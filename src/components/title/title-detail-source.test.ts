import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/components/title/title-detail.tsx", "utf8");

assert.match(
  source,
  /const extrasDescribeActiveSeason =[\s\S]*extras\.season === activeSeason/,
);
assert.match(source, /const episodeExtras = extrasDescribeActiveSeason \? extras : null/);
assert.match(source, /meta: episodeExtras\?\.episodes \?\? \[\]/);
assert.match(
  source,
  /const extrasPending = extrasRequestPending\(\{/,
);
assert.match(source, /requestedSeason: extrasSeason,/);
assert.match(source, /extrasSeason=\{activeSeason\}/);
assert.match(
  source,
  /resolvedPrimary\.kind === "discover"\s*\?\s*resolvedPrimary\s*:/,
);
assert.match(source, /titleActionButtonLabel\(primary, primaryStatus\)/);
// The settled signal must actually be threaded from the query to the panel;
// without it, an unauthorized (settled, empty, error-free) answer reads as a
// request that never started.
assert.match(source, /settled: extrasSettled,/);
assert.match(source, /extrasSettled=\{extrasSettled\}/);
assert.match(source, /\bextrasSettled,\r?\n\s*\}\);/);
// The mismatch must never be loading on its own: gating it on a pending
// request is what stops a null/different extras season from pinning the
// episode skeleton forever.
assert.doesNotMatch(
  source,
  /\(activeSeason != null && !episodeExtras && !extrasError\)/,
);
assert.match(
  source,
  /busy=\{rows\.length === 0 && refreshing && season != null && season !== payload\.season\}/,
);
assert.match(source, /const handleSeasonChange = useCallback\(\s*\(nextSeason: number\) => \{/);
assert.doesNotMatch(source, /url\.searchParams\.set\("s", String\(nextSeason\)\)/);
assert.match(source, /writeRememberedSeasonCookie\(props\.workKey, nextSeason\)/);
assert.match(source, /removeLegacySeasonFromLocation\(\)/);
assert.match(source, /url\.searchParams\.delete\("s"\)/);
assert.match(source, /onSeasonChange=\{handleSeasonChange\}/);
assert.match(
  source,
  /if \(primary\.kind === "discover"\) \{\s*void refetchExtras\(\);[\s\S]*requestAction\(/,
);
assert.match(source, /data-action-kind=\{primary\.kind\}/);

// Durable manual-season persistence (BUG: Season 2 pick reset to Season 9
// after leaving through an ordinary link). The cookie is written ONLY from
// the manual season handler above, never from resume/watch-cursor logic, and
// is threaded into the detail fetch as a plain "remembered" query param
// rather than duplicated into localStorage.
assert.match(
  source,
  /import \{[\s\S]*?nextRememberedSeasonCookieValue,\s*readRememberedSeason,\s*REMEMBERED_SEASON_COOKIE_NAME,\s*\} from "@\/lib\/title\/remembered-season"/,
);
assert.match(
  source,
  /if \(props\.rememberedSeason != null\) \{\s*params\.set\("remembered", String\(props\.rememberedSeason\)\);/,
);
assert.doesNotMatch(source, /localStorage/);

// BUG-SEASON-SPA-PERSISTENCE: the browser cookie is the live fallback a stale
// router payload cannot provide.
assert.match(
  source,
  /import \{\s*resolveInitialSeason,\s*resolveSeasonOnPropsChange,\s*\} from "\.\/season-persistence"/,
);
assert.match(source, /cookieSeason,/);
assert.match(source, /previousWorkKey: previousWorkKey\.current/);

// The hidden title page must not keep polling and re-rendering beneath theatre
// playback. The overlay close handler performs one explicit refetch instead.
assert.match(source, /refreshMs: transferPoll && !playing \? 2_500 : 0/);
assert.match(
  source,
  /progress\?session=\$\{transferPollSession\}/,
  "each transfer poll session must have a fresh query identity",
);
assert.match(
  source,
  /if \(!progressSettled \|\| progressError \|\| !progress\) return;/,
  "failed progress requests must not publish retained data",
);
assert.match(source, /setCurrentProgress\(null\);/);
assert.match(source, /const titleTransfer = progress\?\.transfer \?\? payload\.transfer;/);
assert.match(source, /offersDownload\(titleTransfer\)/);
assert.match(source, /if \(!streaming\) startTransferPoll\(\);/);
assert.match(source, /setPlaying\(null\);\s*refetch\(\);/);

console.log("PASS title detail treats stale season extras as loading and persists season in cookies");
