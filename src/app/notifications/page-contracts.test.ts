/**
 * Contracts that live in page source rather than in a pure function.
 *
 * Run: npx tsx src/app/notifications/page-contracts.test.ts
 *
 * Three of these guard a defect where a *comment* and the *code* disagreed —
 * a redirect documented as permanent that issued a temporary one, copy naming
 * a filter the code does not apply, and help text for keys nothing binds. That
 * class of bug is invisible to behavioural tests because every individual piece
 * works; only the promise is false. So the promise is what is asserted here.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path: string) => fs.readFileSync(path, "utf8");

const activityRedirect = read("src/app/activity/page.tsx");
const clientRedirect = read("src/app/client/page.tsx");
const aboutSource = read("src/app/about/page.tsx");
const notificationsSource = read("src/app/notifications/page.tsx");
const rulesSource = read("src/app/rules/page.tsx");
const shortcutsSource = read("src/hooks/use-keyboard-shortcuts.ts");

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL  ${name}`);
    console.error(`      ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log("\nlegacy redirects");

for (const [route, source, target] of [
  ["/activity", activityRedirect, "NOTIFICATIONS_HREF"],
  ["/client", clientRedirect, "DOWNLOADS_HREF"],
] as const) {
  check(`${route} redirects permanently, as its comment promises`, () => {
    assert.match(
      source,
      /import \{ permanentRedirect \} from "next\/navigation";/,
      "must import permanentRedirect",
    );
    assert.match(
      source,
      new RegExp(`permanentRedirect\\(${target}\\)`),
      "must call permanentRedirect with the renamed route",
    );
    assert.doesNotMatch(
      source,
      /(?<!permanent)[^a-zA-Z]redirect\(/,
      "a temporary redirect() must not survive beside the permanent promise",
    );
    assert.match(source, /permanent/i, "the contract stays documented");
  });
}

console.log("\nnotifications copy");

check("the inbox is not advertised as 'All activity'", () => {
  assert.doesNotMatch(
    notificationsSource,
    /All activity/,
    "buildInbox filters to completions and terminal failures, so 'All activity' is untrue",
  );
  assert.match(notificationsSource, />\s*Inbox\s*</);
  assert.match(notificationsSource, /Download log/);
});

check("the description names what the inbox actually keeps", () => {
  assert.match(
    notificationsSource,
    /Finished downloads and failures that need you/,
  );
  assert.doesNotMatch(notificationsSource, /Recent sends and automation outcomes/);
});

check("older activity is fetched from the server, not just re-revealed", () => {
  assert.match(notificationsSource, /activityPageUrl\(/);
  assert.match(notificationsSource, /nextCursor/);
  assert.match(notificationsSource, /olderActivityAction\(/);
  assert.match(
    notificationsSource,
    /Could not load older activity/,
    "a failed older-page fetch must say so rather than silently doing nothing",
  );
});

console.log("\nabout keyboard documentation");

check("documented shortcuts are all bound somewhere", () => {
  assert.doesNotMatch(
    aboutSource,
    /Copy magnet/,
    "`m` is not bound by any shortcut handler",
  );
  assert.doesNotMatch(
    aboutSource,
    /Send to client<\/dd>/,
    "`s` outside the g-prefix is not bound by any shortcut handler",
  );
});

check("the g-navigation list still matches the shortcut handler", () => {
  for (const key of ["h", "s", "w", "c", "a", "r", "d", "t"]) {
    assert.match(
      shortcutsSource,
      new RegExp(`e\\.key === "${key}"`),
      `g ${key} must be bound`,
    );
  }
  assert.match(
    aboutSource,
    /h browse · s search · w watchlist · c downloads · a notifications · r rules · d download log · t settings/,
  );
  assert.match(aboutSource, /j \/ k/, "j/k is bound in search results");
  assert.match(aboutSource, /Focus search/, "`/` is bound globally");
});

console.log("\nrules mutations report failure");

check("PATCH toggle checks the response before reloading", () => {
  const toggle = rulesSource.match(
    /async function toggle\(id: string, enabled: boolean\) \{[\s\S]*?\n  \}/,
  )?.[0];
  assert.ok(toggle, "toggle() must exist");
  assert.match(toggle, /if \(!res\.ok\)/, "the response must be checked");
  assert.match(toggle, /toast\.error\(/, "a failure must be shown");
  assert.match(
    toggle,
    /return;[\s\S]*?\}\s*\n\s*void load\(\);/,
    "a failed toggle must not fall through to reloading stale state",
  );
  assert.match(toggle, /catch \{[\s\S]*?toast\.error\("Network error"\)/);
});

check("DELETE checks the response before claiming the rule is gone", () => {
  const remove = rulesSource.match(
    /async function confirmRemove\(\) \{[\s\S]*?\n  \}/,
  )?.[0];
  assert.ok(remove, "confirmRemove() must exist");
  assert.match(remove, /if \(!res\.ok\)/);
  assert.match(remove, /toast\.error\(/);
  assert.doesNotMatch(
    remove,
    /if \(!res\.ok\)[\s\S]*?setPendingRemove\(null\)[\s\S]*?return;/,
    "the confirm dialog must not close on a failed delete",
  );
  const success = remove.indexOf('toast.success("Rule deleted")');
  const guard = remove.indexOf("if (!res.ok)");
  assert.ok(
    guard >= 0 && guard < success,
    "success is only announced after the response is known to be ok",
  );
});

check("every rules mutation checks res.ok", () => {
  const mutations = rulesSource.match(
    /method: "(POST|PATCH|DELETE)"/g,
  ) ?? [];
  const guards = rulesSource.match(/if \(!res\.ok\)/g) ?? [];
  assert.ok(
    guards.length >= mutations.filter((m) => !m.includes("POST\"")).length,
    `found ${mutations.length} mutations but only ${guards.length} response checks`,
  );
  assert.doesNotMatch(
    rulesSource,
    /await fetch\(\s*"\/api\/rules",\s*\{\s*\n\s*method: "PATCH",[\s\S]{0,200}\}\);\s*\n\s*void load\(\);/,
    "no mutation may reload without checking the response first",
  );
});

if (failures) {
  console.error(`\nFAIL ${failures} notifications/rules page contract(s)`);
  process.exit(1);
}
console.log("\nPASS notifications and rules page contracts");
