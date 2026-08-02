/**
 * Inbox rules.
 *
 * Run: npx tsx src/app/notifications/inbox.test.ts
 *
 * The cases that matter are all about what is *excluded*. An inbox is defined
 * by its silence — anything that shows everything is a log, and the page this
 * replaces was a log with 274 rows in it.
 */
import assert from "node:assert/strict";
import {
  badgeText,
  buildInbox,
  plainFailure,
  recoveryFor,
  sortNotifications,
  toNotification,
  unreadCount,
  type InboxCandidate,
  type Notification,
} from "./inbox";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL  ${name}`);
    console.error(`      ${(error as Error).message}`);
  }
}

const row = (over: Partial<InboxCandidate> = {}): InboxCandidate => ({
  id: "1",
  title: "Severance S01E01",
  status: "sent",
  message: null,
  createdAt: "2026-08-02T10:00:00.000Z",
  infoHash: null,
  ...over,
});

check("only two things are news", () => {
  const cases: { status: string; kind: string | null }[] = [
    { status: "sent", kind: "completion" },
    { status: "completed", kind: "completion" },
    { status: "downloaded", kind: "completion" },
    { status: "done", kind: "completion" },
    { status: "failed", kind: "failure" },
    { status: "error", kind: "failure" },
    { status: "exhausted", kind: "failure" },
    // The machine talking to itself.
    { status: "skipped", kind: null },
    { status: "queued", kind: null },
    { status: "searching", kind: null },
    { status: "sending", kind: null },
    { status: "running", kind: null },
    // Anything unrecognised stays out. This is the rule that stops the inbox
    // refilling the moment another subsystem invents a status.
    { status: "reticulating", kind: null },
    { status: "", kind: null },
  ];
  for (const c of cases) {
    const n = toNotification(row({ status: c.status }));
    assert.equal(n?.kind ?? null, c.kind, `status "${c.status}"`);
  }
});

check("status matching does not care about case or padding", () => {
  assert.equal(toNotification(row({ status: "  SENT " }))?.kind, "completion");
  assert.equal(toNotification(row({ status: "Failed" }))?.kind, "failure");
  assert.equal(toNotification(row({ status: " Skipped " })), null);
});

check("skipped rows are the loudest silence", () => {
  // Automation skips every title it checks and finds nothing new, which is
  // most checks, most of the time. This library had 26 of them.
  const rows = Array.from({ length: 26 }, (_, i) =>
    row({ id: `s${i}`, status: "skipped" }),
  );
  assert.deepEqual(buildInbox(rows), []);
});

check("a failure explains itself without naming machinery", () => {
  const cases: { raw: string | null; plain: string }[] = [
    { raw: null, plain: "No working release was found." },
    { raw: "   ", plain: "No working release was found." },
    {
      raw: "connect ECONNREFUSED 127.0.0.1:8080",
      plain: "Could not reach the download client.",
    },
    { raw: "socket hang up", plain: "Could not reach the download client." },
    {
      raw: "Request failed with status 403 Forbidden",
      plain: "The download client rejected the credentials in Settings.",
    },
    { raw: "ENOSPC: no space left on device", plain: "The drive is full." },
    {
      raw: "EACCES: permission denied, open '/downloads/x.mkv'",
      plain: "The download folder is not writable.",
    },
    { raw: "no seeds available", plain: "No working release was found." },
  ];
  for (const c of cases) {
    assert.equal(plainFailure(c.raw), c.plain, JSON.stringify(c.raw));
  }
});

check("an unrecognised message is kept, not replaced with a shrug", () => {
  // A specific unknown message is still more use to the person who has to fix
  // it than "Something went wrong".
  const odd = "tracker returned a malformed bencode response";
  assert.equal(plainFailure(odd), odd);
});

check("a failure offers exactly one way out", () => {
  const failure = (message: string | null): Notification =>
    toNotification(row({ status: "failed", message }))!;

  assert.deepEqual(recoveryFor(failure("ECONNREFUSED 127.0.0.1:8080")), {
    label: "Open settings",
    href: "/settings",
  });
  assert.deepEqual(recoveryFor(failure("ENOSPC")), {
    label: "Open settings",
    href: "/settings",
  });
  assert.deepEqual(recoveryFor(failure("no seeds")), {
    label: "Try again",
    href: "/search",
  });
  // A completion is not a problem, so it is not offered a remedy.
  assert.equal(recoveryFor(toNotification(row({ status: "sent" }))!), null);
});

check("newest first, and stable when timestamps tie", () => {
  const items = buildInbox([
    row({ id: "b", createdAt: "2026-08-01T00:00:00.000Z" }),
    row({ id: "c", createdAt: "2026-08-03T00:00:00.000Z" }),
    row({ id: "a", createdAt: "2026-08-03T00:00:00.000Z" }),
  ]);
  assert.deepEqual(
    items.map((i) => i.id),
    ["a", "c", "b"],
    "ties break by id so the list cannot reshuffle between renders",
  );
  // Sorting twice must not change anything.
  assert.deepEqual(
    sortNotifications(items).map((i) => i.id),
    items.map((i) => i.id),
  );
});

check("unread counts what arrived since you last looked", () => {
  const items = buildInbox([
    row({ id: "old", createdAt: "2026-08-01T00:00:00.000Z" }),
    row({ id: "new", createdAt: "2026-08-03T00:00:00.000Z" }),
  ]);
  assert.equal(unreadCount(items, null), 2, "never opened means all unread");
  assert.equal(unreadCount(items, "2026-08-02T00:00:00.000Z"), 1);
  assert.equal(unreadCount(items, "2026-08-04T00:00:00.000Z"), 0);
  // Reading at the exact instant of an item counts it as read: the user was
  // looking at the page when it arrived.
  assert.equal(unreadCount(items, "2026-08-03T00:00:00.000Z"), 0);
});

check("the badge fits the tab it lives in", () => {
  assert.equal(badgeText(0), null, "zero is not a badge, it is an absence");
  assert.equal(badgeText(-3), null);
  assert.equal(badgeText(1), "1");
  assert.equal(badgeText(99), "99");
  // "1,247" does not fit a 44px tab, and the difference between 99 and 1,247
  // changes nothing about what the user does next.
  assert.equal(badgeText(100), "99+");
  assert.equal(badgeText(1247), "99+");
});

check("a realistic feed collapses to almost nothing", () => {
  // Proportions taken from this repository's own database: 157 grab jobs and
  // 117 history rows, of which the great majority are not news.
  const rows: InboxCandidate[] = [
    ...Array.from({ length: 26 }, (_, i) => row({ id: `sk${i}`, status: "skipped" })),
    ...Array.from({ length: 40 }, (_, i) => row({ id: `f${i}`, status: "failed" })),
    ...Array.from({ length: 77 }, (_, i) => row({ id: `s${i}`, status: "sent" })),
    ...Array.from({ length: 12 }, (_, i) => row({ id: `q${i}`, status: "queued" })),
  ];
  const inbox = buildInbox(rows);
  assert.equal(inbox.length, 117, "only completions and terminal failures");
  assert.equal(inbox.filter((n) => n.kind === "completion").length, 77);
  assert.equal(inbox.filter((n) => n.kind === "failure").length, 40);
  assert.equal(
    inbox.some((n) => n.kind !== "completion" && n.kind !== "failure"),
    false,
  );
});

if (failures > 0) {
  console.error(`\n${failures} inbox test(s) failed.`);
  process.exit(1);
}
console.log("\nAll inbox tests passed.");
