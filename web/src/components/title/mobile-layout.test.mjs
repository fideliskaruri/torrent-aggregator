// Run alongside the web suite: node --test src/components/title/mobile-layout.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const title = source("./title-detail.tsx");
const episodes = source("./episode-list.tsx");
const library = source("./library-controls.tsx");

test("mobile hero stacks its content and keeps acquire controls full-width until md", () => {
  assert.match(title, /grid grid-cols-1 items-end[^"]+md:grid-cols-\[168px_minmax\(0,1fr\)\]/);
  assert.match(title, /grid w-full min-w-0 grid-cols-1[^"]+md:flex/);
  assert.match(title, /relative w-full min-w-0 md:w-auto md:min-w-\[9rem\]/);
  assert.match(title, /relative w-full min-w-0 md:w-auto md:min-w-\[8rem\]/);
  assert.doesNotMatch(title, /col-span-2 flex flex-col/);
});

test("episode captions reclaim thumbnail and action width without truncating mobile dates", () => {
  assert.match(episodes, /data-episode-still\s+className="[^"]*w-16[^"]*sm:w-full"/);
  assert.match(episodes, /data-episode-name[\s\S]*?className="line-clamp-2 break-words[^"]*sm:truncate"/);
  assert.doesNotMatch(episodes, /pr-14/);
  assert.match(episodes, /!unaired && "pb-14 sm:pb-3"/);
  assert.match(episodes, /className="mt-1 block break-words[^"]*sm:hidden"/);
});

test("library questions use one mobile modal with an accessible title and focus return", () => {
  assert.match(library, /useMediaQuery\("\(max-width: 767px\)"\)/);
  assert.match(library, /<Dialog open=\{asking\} onOpenChange=\{setAsking\}>/);
  assert.match(library, /data-add-library-dialog/);
  assert.match(library, /<DialogTitle[^>]*>Add to library<\/DialogTitle>/);
  assert.match(library, /onCloseAutoFocus=/);
  assert.match(library, /addButtonRef\.current\.focus\(\)/);
  assert.match(library, /asking \? questionPanel : null/);
  assert.match(library, /!isMobile && option\.hint/);
  assert.match(library, /grid grid-cols-1 gap-2 md:flex md:items-center/);
});

test("title article reserves mobile navigation and safe-area clearance", () => {
  assert.match(title, /<article[^>]+pb-\[calc\(var\(--mobile-nav-h\)\+env\(safe-area-inset-bottom\)\+1rem\)\][^>]+md:pb-0/);
});

test("layout changes retain memoized cards, populated rows and cookie season selection", () => {
  assert.match(episodes, /const EpisodeCard = memo\(EpisodeCardImpl/);
  assert.match(title, /busy=\{rows\.length === 0 && refreshing/);
  assert.match(title, /writeRememberedSeasonCookie/);
  assert.match(title, /preserveCurrentSeason: manualSeasonSelection\.current/);
});
