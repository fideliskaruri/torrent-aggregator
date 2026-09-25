/**
 * What belongs in the inbox, and what does not.
 *
 * Activity showed everything that had ever happened, which is why it stopped
 * being read: 157 grab jobs and 117 history rows in a modest library, most of
 * them describing machinery doing its job. A feed nobody reads is worse than
 * no feed, because it still costs a nav slot and still implies you are being
 * told things.
 *
 * The rule is that a notification must be *news*, and news is exactly two
 * things:
 *
 *   1. Something you wanted is ready.
 *   2. Something you wanted has failed in a way only you can resolve.
 *
 * Everything else is progress reporting, and progress belongs on the thing
 * making progress — the Downloads page, the title card — not in an inbox.
 *
 * The hard case is failure. A single release failing is not news: the app
 * tries other releases, other sources, other aliases before giving up. Telling
 * the user about each attempt trains them to ignore the count. Only the
 * terminal outcome — nothing left to try — is theirs to act on.
 */

/** The minimum a row needs for this module to decide about it. */
export interface InboxCandidate {
  id: string;
  title: string;
  status: string;
  message: string | null;
  createdAt: string;
  infoHash: string | null;
}

type NotificationKind = "completion" | "failure";

export interface Notification {
  id: string;
  kind: NotificationKind;
  title: string;
  /** Plain language. Never a stack trace, never a provider name. */
  detail: string | null;
  createdAt: string;
  /** Present when the finished file can be opened directly. */
  infoHash: string | null;
}

/**
 * Statuses that mean the user now has the thing they asked for.
 *
 * These two sets are allowlists, and exclusion works by omission. There was a
 * third set here — `NOT_NEWS`, naming `skipped`, `queued`, `searching` and so
 * on — until deleting it turned out to fail no test at all: anything absent
 * from both allowlists already returns null. A guard that cannot fail is not a
 * guard, so it is gone rather than left to imply a protection it never
 * provided. Omission is the mechanism; this comment is the documentation the
 * dead set was standing in for.
 */
const COMPLETED = new Set(["sent", "completed", "downloaded", "done"]);

/** Statuses that mean nothing is left to try. */
const TERMINAL_FAILURE = new Set(["failed", "error", "exhausted"]);

/**
 * Turn a raw row into a notification, or `null` if it is not news.
 *
 * Unknown statuses return `null` rather than being shown. An inbox that
 * displays anything it does not recognise fills up with whatever the next
 * subsystem happens to write, which is how the last one got to 274 rows.
 */
function toNotification(row: InboxCandidate): Notification | null {
  const status = row.status.trim().toLowerCase();

  if (COMPLETED.has(status)) {
    return {
      id: row.id,
      kind: "completion",
      title: row.title,
      detail: null,
      createdAt: row.createdAt,
      infoHash: row.infoHash,
    };
  }

  if (TERMINAL_FAILURE.has(status)) {
    return {
      id: row.id,
      kind: "failure",
      title: row.title,
      detail: plainFailure(row.message),
      createdAt: row.createdAt,
      infoHash: row.infoHash,
    };
  }

  return null;
}

/**
 * A failure the user can act on, in words they did not have to learn.
 *
 * The stored message is written for a maintainer reading logs. "ECONNREFUSED
 * 127.0.0.1:8080" is true and useless: it names a port the user never chose,
 * for a client they may not know they are running. Where a known cause can be
 * recognised it is translated; where it cannot, the raw text is kept rather
 * than replaced with something vague, because a specific unknown message is
 * still more use than "Something went wrong".
 */
function plainFailure(message: string | null): string | null {
  const raw = (message ?? "").trim();
  if (!raw) return "No working release was found.";

  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up/i.test(raw)) {
    return "Could not reach the download client.";
  }
  if (/401|403|unauthor|forbidden/i.test(raw)) {
    return "The download client rejected the credentials in Settings.";
  }
  if (/ENOSPC|no space/i.test(raw)) {
    return "The drive is full.";
  }
  if (/EACCES|EPERM|permission/i.test(raw)) {
    return "The download folder is not writable.";
  }
  if (/no (results|releases|seeds|peers)|not found|nothing/i.test(raw)) {
    return "No working release was found.";
  }
  return raw;
}

/** Newest first, then by id so equal timestamps cannot reorder between renders. */
function sortNotifications(items: readonly Notification[]): Notification[] {
  return [...items].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  );
}

export function buildInbox(rows: readonly InboxCandidate[]): Notification[] {
  const out: Notification[] = [];
  for (const row of rows) {
    const n = toNotification(row);
    if (n) out.push(n);
  }
  return sortNotifications(out);
}

/**
 * What the nav badge shows.
 *
 * Capped, because the badge sits in a 44px tab and "1,247" does not fit — and
 * because the difference between 99 and 1,247 unread changes nothing about
 * what the user does next.
 */
export function badgeText(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? "99+" : String(count);
}

/**
 * Where the nav badge asks for its number.
 *
 * A builder rather than an inline template so the read-mark contract — the
 * timestamp goes to the server, the server counts — is one testable thing
 * instead of a string spread across components.
 */
export function unreadCountUrl(lastReadAt: string | null): string {
  return lastReadAt
    ? `/api/activity/unread?since=${encodeURIComponent(lastReadAt)}`
    : "/api/activity/unread";
}
