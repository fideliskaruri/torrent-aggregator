
import { formatBytes } from "@/lib/format";
import { type StorageLimitKind } from "./storage-format";

const STORAGE_CAP_SETTINGS_HREF = "/settings?tab=folders&focus=cap";

/** The query value `settings/page.tsx` looks for to focus the cap input. */
export const STORAGE_CAP_FOCUS_PARAM = "cap";

function isOverridableLimit(limit: StorageLimitKind | null | undefined): boolean {
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
  /** Size of THIS chosen release only (never other candidates, never the queue). */
  incomingBytes: number | null;
  /** True when `incomingBytes` is an assumed reserve, not a measured size. */
  incomingEstimated?: boolean;
  /** Bytes already promised by queued downloads, counted separately from this download. */
  reservedQueuedBytes?: number | null;
  /** Deep link to the control that changes the cap. */
  settingsHref: string;
  /** The plain refusal text, for surfaces with no room for a dialog. */
  message: string;
}

/** One labelled figure in the dialog's breakdown. */
export interface StorageBreakdownRow {
  key: "used" | "incoming" | "queued" | "cap" | "free" | "left";
  label: string;
  value: string;
}

/** A proportional bar: filled segments plus an optional limit marker, all 0..1. */
export interface StorageBar {
  segments: { key: "used" | "incoming" | "queued"; fraction: number }[];
  /** Where the cap sits along the bar, or null when there is no marker. */
  markerFraction: number | null;
}

export interface StorageOverridePrompt {
  /** Short headline. */
  title: string;
  /** One line under the headline with the number that matters most. */
  summary: string;
  /** Used / This download / Already queued / Cap (or the free-space variant). */
  rows: StorageBreakdownRow[];
  bar: StorageBar | null;
  /** One line of reassurance or caution, after the figures. */
  note: string;
  /** The same facts as one paragraph, for surfaces with no room for the breakdown. */
  body: string;
  /** Consequential action. Must never be the focused default. */
  confirmLabel: string;
  /** The alternative that respects the cap. */
  raiseCapLabel: string;
  raiseCapHref: string;
  cancelLabel: string;
}

/** Claimed bytes for free-space wording: this download plus anything already queued. */
function claimedBytes(facts: StorageOverrideFacts): number | null {
  const incoming = facts.incomingBytes != null && facts.incomingBytes > 0 ? facts.incomingBytes : 0;
  const queued =
    facts.reservedQueuedBytes != null && facts.reservedQueuedBytes > 0 ? facts.reservedQueuedBytes : 0;
  const total = incoming + queued;
  return total > 0 ? total : null;
}

/** "This download: X. Already queued: Y." — figures stay separate so a 1 GB pick never looks like 45 GB. */
function downloadAndQueueCopy(facts: StorageOverrideFacts): string {
  const parts: string[] = [];
  if (facts.incomingBytes != null && facts.incomingBytes > 0) {
    const size = formatBytes(facts.incomingBytes) ?? "Unknown size";
    parts.push(
      facts.incomingEstimated
        ? `This download: ${size} (size unknown).`
        : `This download: ${size}.`,
    );
  }
  if (facts.reservedQueuedBytes != null && facts.reservedQueuedBytes > 0) {
    parts.push(`Already queued: ${formatBytes(facts.reservedQueuedBytes) ?? "Unknown size"}.`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function positive(value: number | null | undefined): number {
  return value != null && Number.isFinite(value) && value > 0 ? value : 0;
}

function incomingValue(facts: StorageOverrideFacts): string {
  const size = formatBytes(positive(facts.incomingBytes)) ?? "Unknown size";
  return facts.incomingEstimated ? `about ${size}` : size;
}

function downloadAndQueueRows(facts: StorageOverrideFacts): StorageBreakdownRow[] {
  const rows: StorageBreakdownRow[] = [];
  if (positive(facts.incomingBytes) > 0) {
    rows.push({ key: "incoming", label: "This download", value: incomingValue(facts) });
  }
  if (positive(facts.reservedQueuedBytes) > 0) {
    rows.push({
      key: "queued",
      label: "Already queued",
      value: formatBytes(positive(facts.reservedQueuedBytes)) ?? "Unknown size",
    });
  }
  return rows;
}

function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function capOverridePrompt(facts: StorageOverrideFacts): StorageOverridePrompt {
  const incoming = positive(facts.incomingBytes);
  const queued = positive(facts.reservedQueuedBytes);
  if (facts.limit === "reserve") {
    const free = facts.freeBytes != null ? (formatBytes(facts.freeBytes) ?? "Unknown size") : "the space";
    const claim = claimedBytes(facts);
    const after =
      facts.freeBytes != null && claim != null
        ? ` That would leave about ${formatBytes(Math.max(0, facts.freeBytes - claim)) ?? "Unknown size"} free.`
        : "";
    const freeBytes = positive(facts.freeBytes);
    const left = facts.freeBytes != null && claim != null ? Math.max(0, facts.freeBytes - claim) : null;
    const rows: StorageBreakdownRow[] = [
      ...(facts.freeBytes != null ? [{ key: "free" as const, label: "Free on drive", value: free }] : []),
      ...downloadAndQueueRows(facts),
      ...(left != null
        ? [{ key: "left" as const, label: "Left after", value: formatBytes(left) ?? "Unknown size" }]
        : []),
    ];
    const bar: StorageBar | null =
      freeBytes > 0 && incoming + queued > 0
        ? {
            segments: [
              { key: "incoming", fraction: clampFraction(incoming / freeBytes) },
              { key: "queued", fraction: clampFraction(queued / freeBytes) },
            ].filter((segment) => segment.fraction > 0) as StorageBar["segments"],
            markerFraction: null,
          }
        : null;
    return {
      title: "Low on free space",
      summary: left != null ? `About ${formatBytes(left) ?? "Unknown size"} would be left free.` : "It fits, with little room to spare.",
      rows,
      bar,
      note: "It fits, but dips into the spare margin TorrentFlow normally keeps.",
      body:
        `Your drive has ${free} free.${downloadAndQueueCopy(facts)} ` +
        `It fits, but it goes into the safety margin this app normally keeps spare.${after} ` +
        `Downloading anyway is fine if you know the drive has room to work in.`,
      confirmLabel: "Download anyway",
      raiseCapLabel: "Change download folder",
      raiseCapHref: facts.settingsHref,
      cancelLabel: "Cancel",
    };
  }

  const used = formatBytes(facts.usedBytes) ?? "Unknown size";
  const cap = facts.capBytes != null ? (formatBytes(facts.capBytes) ?? "Unknown size") : "your cap";
  // Count current use, this download, and queued reservations separately.
  const usedBytes = positive(facts.usedBytes);
  const capBytes = facts.capBytes != null && facts.capBytes > 0 ? facts.capBytes : null;
  const total = usedBytes + incoming + queued;
  const scale = Math.max(total, capBytes ?? 0);
  const over = capBytes != null ? total - capBytes : null;
  const bar: StorageBar | null =
    scale > 0
      ? {
          segments: (
            [
              { key: "used", fraction: clampFraction(usedBytes / scale) },
              { key: "incoming", fraction: clampFraction(incoming / scale) },
              { key: "queued", fraction: clampFraction(queued / scale) },
            ] as StorageBar["segments"]
          ).filter((segment) => segment.fraction > 0),
          markerFraction: capBytes != null ? clampFraction(capBytes / scale) : null,
        }
      : null;
  return {
    title: "Over your storage cap",
    summary:
      over != null && over > 0
        ? `Downloading this puts you ${formatBytes(over) ?? "Unknown size"} over the cap.`
        : "Downloading this goes over the cap you set.",
    rows: [
      { key: "used", label: "Used", value: used },
      ...downloadAndQueueRows(facts),
      { key: "cap", label: "Cap", value: cap },
    ],
    bar,
    note: "Nothing gets deleted, and free disk space stays protected.",
    body:
      `You are using ${used} of ${cap} under the download folder.${downloadAndQueueCopy(facts)} ` +
      `Downloading anyway will go over the cap you set. Nothing else is deleted, ` +
      `and your free disk space is still protected.`,
    confirmLabel: "Download anyway",
    raiseCapLabel: "Raise the cap",
    raiseCapHref: facts.settingsHref,
    cancelLabel: "Cancel",
  };
}

/** Narrow an unknown API payload to override facts, or null. */
export function parseStorageOverrideFacts(value: unknown): StorageOverrideFacts | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const limit = v.limit;
  if (
    limit !== "setup" &&
    limit !== "reserve" &&
    limit !== "wont-fit" &&
    limit !== "cap" &&
    limit !== "inventory"
  ) {
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
    reservedQueuedBytes: num(v.reservedQueuedBytes),
    settingsHref:
      typeof v.settingsHref === "string" && v.settingsHref.startsWith("/settings")
        ? v.settingsHref
        : STORAGE_CAP_SETTINGS_HREF,
    message: typeof v.message === "string" ? v.message : "",
  };
}

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

export async function runWithStorageOverride<T>(
  attempt: (opts: { overrideStorageCap: boolean }) => Promise<T>,
  confirm: (facts: StorageOverrideFacts) => Promise<boolean>,
  answerSetup?: () => Promise<boolean>,
): Promise<StorageOverrideOutcome<T>> {
  try {
    return { status: "done", value: await attempt({ overrideStorageCap: false }) };
  } catch (err) {
    if (!(err instanceof StorageLimitError)) throw err;
    if (err.storage.limit === "setup" && answerSetup) {
      if (!(await answerSetup())) return { status: "cancelled" };
      return runWithStorageOverride(attempt, confirm);
    }
    if (!err.storage.overridable) throw err;
    const proceed = await confirm(err.storage);
    if (!proceed) return { status: "cancelled" };
    // Exactly one retry: no recursion, so a server that refuses again surfaces
    // the error rather than re-prompting forever.
    return { status: "done", value: await attempt({ overrideStorageCap: true }) };
  }
}

