/**
 * The rule for overriding a storage refusal — and the line that must not move.
 *
 * ## The principle
 *
 * The cap is the owner's own setting about their own disk. Enforcing it as a
 * hard refusal with no way forward is the app overruling its user. It is a
 * guardrail, not a wall: the right response to "this would exceed your cap" is
 * to say so honestly and let the owner decide, not to decide for them.
 *
 * ## What is overridable, and what is emphatically not
 *
 *   - **cap** — overridable. The owner set this number; exceeding it costs disk
 *     space they had reserved for themselves. Nothing breaks. They get the real
 *     figures and choose.
 *   - **reserve** — overridable. The release *fits*; it would merely leave the
 *     volume with less than the 500 MB margin this app decided to keep spare.
 *     That margin is the app's opinion, not the drive's limit, so refusing
 *     outright was the app overruling its owner about their own disk.
 *   - **wont-fit** — NOT overridable, ever. The release needs more bytes than
 *     the volume physically has. Consent does not create disk, and a write that
 *     runs the volume to zero can corrupt in-flight files. This is the single
 *     hard stop, and it is drawn at arithmetic rather than at preference.
 *   - **setup** — NOT overridable. There is no cap to exceed yet; the answer is
 *     to finish choosing a folder and a budget.
 *
 * The line moved here once already. `reserve` and `wont-fit` used to be one
 * `free-space` kind that was refused outright, which made a 700 MB episode
 * impossible on a drive with 900 MB free. Keeping the hard stop at "genuinely
 * does not fit" is the whole point of the split; widening it back to "makes the
 * app uncomfortable" would undo it.
 *
 * Keeping this as one exported predicate rather than a conditional in the dialog
 * means a new refusal reason cannot quietly inherit "overridable" by default,
 * and the rule can be tested on its own.
 *
 * ## Play never gets here
 *
 * Streaming reclaims cache and proceeds (see `storage-gate.ts`). This prompt is
 * for Download only — a kept file is a permanent claim on the shelf, so it is
 * the only case where the owner should be asked.
 */
import { formatBytesShort, type StorageLimitKind } from "./storage-format";

/**
 * Where the cap actually lives. `?tab=folders` is the existing deep link for the
 * tab labelled **Downloads**; `focus=cap` asks that screen to put the caret in
 * the cap field so the owner lands on the control, not merely the page.
 */
export const STORAGE_CAP_SETTINGS_HREF = "/settings?tab=folders&focus=cap";

/** The query value `settings/page.tsx` looks for to focus the cap input. */
export const STORAGE_CAP_FOCUS_PARAM = "cap";

/**
 * May the owner be offered "do it anyway" for this refusal?
 *
 * Default-deny by kind, but the deny list is deliberately short: only refusals
 * the machine itself imposes stay absolute. Everything the *app* decided —
 * the cap and the free-space margin — is the owner's to overrule.
 */
export function isOverridableLimit(limit: StorageLimitKind | null | undefined): boolean {
  return limit === "cap" || limit === "reserve";
}

export interface StorageOverrideFacts {
  /** Which limit refused. */
  limit: StorageLimitKind;
  /** Whether the UI may offer to proceed anyway. */
  overridable: boolean;
  usedBytes: number;
  capBytes: number | null;
  /** Free space on the volume, when it could be measured. */
  freeBytes: number | null;
  /** Size of the release, when known. */
  incomingBytes: number | null;
  /** True when `incomingBytes` is an assumed reserve, not a measured size. */
  incomingEstimated?: boolean;
  /** Deep link to the control that changes the cap. */
  settingsHref: string;
  /** The plain refusal text, for surfaces with no room for a dialog. */
  message: string;
}

export interface StorageOverridePrompt {
  title: string;
  /** The real numbers, stated plainly. */
  body: string;
  /** Consequential action. Must never be the focused default. */
  confirmLabel: string;
  /** The alternative that respects the cap. */
  raiseCapLabel: string;
  raiseCapHref: string;
  cancelLabel: string;
}

/**
 * The confirmation copy, built from measured facts rather than adjectives.
 *
 * The owner meets this at a frustrating moment, so it states the numbers and
 * stops. "Are you sure?" without figures is not informed consent.
 *
 * The two overridable refusals are genuinely different situations and must not
 * share one wording. Going over the **cap** costs shelf space the owner set
 * aside and is harmless. Going under the **reserve** eats into the drive's spare
 * room, which is a real (if self-imposed) safety margin — so that variant says
 * what is left afterwards instead of reassuring them that free space is
 * protected, which for that case would be false.
 */
export function capOverridePrompt(facts: StorageOverrideFacts): StorageOverridePrompt {
  const needs =
    facts.incomingBytes != null && facts.incomingBytes > 0
      ? formatBytesShort(facts.incomingBytes)
      : null;

  if (facts.limit === "reserve") {
    const free = facts.freeBytes != null ? formatBytesShort(facts.freeBytes) : "the space";
    const after =
      facts.freeBytes != null && facts.incomingBytes != null && facts.incomingBytes > 0
        ? ` That would leave about ${formatBytesShort(Math.max(0, facts.freeBytes - facts.incomingBytes))} free.`
        : "";
    return {
      title: "This will use most of your free space",
      body:
        `Your drive has ${free} free${needs ? ` and this needs about ${needs}` : ""}. ` +
        `It fits, but it goes into the safety margin this app normally keeps spare.${after} ` +
        `Downloading anyway is fine if you know the drive has room to work in.`,
      confirmLabel: "Download anyway",
      raiseCapLabel: "Change download folder",
      raiseCapHref: facts.settingsHref,
      cancelLabel: "Cancel",
    };
  }

  const used = formatBytesShort(facts.usedBytes);
  const cap = facts.capBytes != null ? formatBytesShort(facts.capBytes) : "your cap";
  // Why the arithmetic looks the way it does. Without this the dialog could
  // read "You are using 0 B of 1 MB" — measured verbatim — which reports a
  // library that is plainly not full as the reason it is full. The release
  // being added is the missing term, and when its size is unknown the app's own
  // reserve is what tipped the balance, so say which of the two it is.
  const reason = needs
    ? facts.incomingEstimated
      ? ` This release does not report its size, so ${needs} is set aside for it.`
      : ` This download needs about ${needs} more.`
    : "";
  return {
    title: "This exceeds your storage cap",
    body:
      `You are using ${used} of ${cap} under the download folder.${reason} ` +
      `Downloading anyway will go over the cap you set — nothing else is deleted, ` +
      `and your free disk space is still protected.`,
    confirmLabel: "Download anyway",
    raiseCapLabel: "Raise the cap",
    raiseCapHref: facts.settingsHref,
    cancelLabel: "Cancel",
  };
}

/**
 * Shape returned by a 507 so the client can render the prompt without guessing.
 * Anything missing degrades to "not overridable", which is the safe direction.
 */
export function storageOverrideFacts(input: {
  limit: StorageLimitKind;
  usedBytes: number;
  capBytes: number | null;
  freeBytes?: number | null;
  incomingBytes: number | null;
  incomingEstimated?: boolean;
  message: string;
}): StorageOverrideFacts {
  return {
    limit: input.limit,
    overridable: isOverridableLimit(input.limit),
    usedBytes: input.usedBytes,
    capBytes: input.capBytes,
    freeBytes: input.freeBytes ?? null,
    incomingBytes: input.incomingBytes,
    incomingEstimated: input.incomingEstimated === true,
    settingsHref: STORAGE_CAP_SETTINGS_HREF,
    message: input.message,
  };
}

/** Narrow an unknown API payload to override facts, or null. */
export function parseStorageOverrideFacts(value: unknown): StorageOverrideFacts | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const limit = v.limit;
  if (limit !== "setup" && limit !== "reserve" && limit !== "wont-fit" && limit !== "cap") {
    return null;
  }
  const num = (x: unknown): number | null =>
    typeof x === "number" && Number.isFinite(x) ? x : null;
  return {
    limit,
    // Never trust a server-sent `overridable` over the rule itself: the rule is
    // what the product guarantees, and it is cheap to re-derive.
    overridable: isOverridableLimit(limit),
    usedBytes: num(v.usedBytes) ?? 0,
    capBytes: num(v.capBytes),
    freeBytes: num(v.freeBytes),
    incomingBytes: num(v.incomingBytes),
    incomingEstimated: v.incomingEstimated === true,
    settingsHref:
      typeof v.settingsHref === "string" && v.settingsHref.startsWith("/settings")
        ? v.settingsHref
        : STORAGE_CAP_SETTINGS_HREF,
    message: typeof v.message === "string" ? v.message : "",
  };
}

/**
 * A send that a storage limit refused.
 *
 * The plain `Error` this replaces threw away the one thing a caller needed:
 * whether the refusal was the owner's own cap (overridable) or the disk's
 * free-space floor (not). Carrying the facts on the error is what lets the UI
 * offer a way forward instead of a toast that names a tab and stops.
 */
export class StorageLimitError extends Error {
  readonly storage: StorageOverrideFacts;

  constructor(message: string, storage: StorageOverrideFacts) {
    super(message);
    this.name = "StorageLimitError";
    this.storage = storage;
  }
}

export type StorageOverrideOutcome<T> =
  | { status: "done"; value: T }
  | { status: "cancelled" };

/**
 * The whole "confirm, don't block" rule, in one place and free of React.
 *
 * Every send surface goes through this rather than growing its own copy, so the
 * guarantees hold everywhere by construction:
 *
 *   1. The first attempt NEVER carries an override. The owner is only ever asked
 *      after a real refusal with real numbers — the app does not pre-emptively
 *      offer to break its own cap.
 *   2. A non-overridable refusal (free space, setup) is rethrown untouched. It
 *      is never turned into a prompt, so there is no path by which the user can
 *      be talked into filling their volume.
 *   3. Cancelling returns `cancelled` and sends nothing. Not an error, not a
 *      retry — the user said no.
 *   4. The retry runs exactly once. If the second attempt is refused too, that
 *      error propagates; the loop cannot be re-entered.
 *
 * Play never reaches any of this: the server-side gate reclaims stream cache and
 * proceeds, so a stream send does not come back as a `StorageLimitError`.
 */
export async function runWithStorageOverride<T>(
  attempt: (opts: { overrideStorageCap: boolean }) => Promise<T>,
  confirm: (facts: StorageOverrideFacts) => Promise<boolean>,
): Promise<StorageOverrideOutcome<T>> {
  try {
    return { status: "done", value: await attempt({ overrideStorageCap: false }) };
  } catch (err) {
    if (!(err instanceof StorageLimitError)) throw err;
    if (!err.storage.overridable) throw err;
    const proceed = await confirm(err.storage);
    if (!proceed) return { status: "cancelled" };
    // Exactly one retry: no recursion, so a server that refuses again surfaces
    // the error rather than re-prompting forever.
    return { status: "done", value: await attempt({ overrideStorageCap: true }) };
  }
}
