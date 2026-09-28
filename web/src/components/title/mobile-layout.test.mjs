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

test("library questions use one modal on every width with an accessible title and focus return", () => {
  assert.match(library, /useMediaQuery\("\(max-width: 767px\)"\)/);
  assert.match(library, /<Dialog open=\{asking\} onOpenChange=\{setAsking\}>/);
  assert.match(library, /data-add-library-dialog/);
  assert.match(library, /<DialogTitle[^>]*>Add to library<\/DialogTitle>/);
  assert.match(library, /onCloseAutoFocus=/);
  assert.match(library, /addButtonRef\.current\.focus\(\)/);
  // Inline on desktop, the panel pushed the poster down and doubled the add button.
  assert.doesNotMatch(library, /asking \? questionPanel : null/);
  // Options are styled radios with the hint on its own line, not a native select
  // with the hint glued on after a dash.
  assert.doesNotMatch(library, /<select/);
  assert.match(library, /type="radio"/);
  assert.doesNotMatch(library, / — \$\{option\.hint\}/);
  assert.match(library, /grid grid-cols-1 gap-2 sm:flex/);
});

test("title page relies on the shell's single mobile-nav + safe-area clearance", () => {
  // `.app-main` reserves the fixed bottom nav, the home-indicator inset and
  // air below md; the article padding it again only doubled the dead space.
  const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
  assert.match(
    css,
    /@media \(max-width: 767\.98px\) \{\s*\.app-main \{\s*padding-bottom: calc\(var\(--mobile-nav-h\) \+ var\(--safe-bottom\) \+ 1rem\);/,
  );
  assert.match(title, /<article aria-labelledby="title-heading" className="flex min-w-0 grow flex-col">/);
});

test("layout changes retain memoized cards, populated rows and cookie season selection", () => {
  assert.match(episodes, /const EpisodeCard = memo\(EpisodeCardImpl/);
  assert.match(title, /busy=\{rows\.length === 0 && refreshing/);
  assert.match(title, /writeRememberedSeasonCookie/);
  assert.match(title, /preserveCurrentSeason: manualSeasonSelection\.current/);
});
