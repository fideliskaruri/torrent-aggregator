import type { MediaFileInspection, MediaInspectionSummary } from "@/lib/api/catalog-types";

/**
 * What the owner should know about an owned film or episode after Jellyfin read its audio tracks.
 * Only a rejected file (no audio in a language we accept) or a replacement in progress says anything.
 */
export type AudioCheck =
  | { kind: "ok" }
  | { kind: "wrong-audio"; fileId: string; languages: string }
  | { kind: "looking"; fileId: string; languages: string }
  | { kind: "downloading"; fileId: string; languages: string }
  | { kind: "ready"; fileId: string; languages: string; newLanguages: string | null }
  | { kind: "failed"; fileId: string; languages: string };

const displayNames = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" });
  } catch {
    return null;
  }
})();

export function languageName(code: string): string {
  return displayNames?.of(code) ?? code.toUpperCase();
}

export function languageList(codes: readonly string[]): string {
  const names = [...new Set(codes)].map(languageName);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function replacementFor(files: readonly MediaFileInspection[]): MediaFileInspection | undefined {
  return files.find((file) => file.replacement != null);
}

export function audioCheck(owned: MediaInspectionSummary | null | undefined): AudioCheck {
  const files = owned?.mediaFiles ?? [];
  const replacing = replacementFor(files);
  if (replacing?.replacement) {
    const { replacement } = replacing;
    const base = { fileId: replacing.mediaFileId, languages: languageList(replacing.audioLanguages) };
    if (replacement.state === "ready") {
      const fresh = files.find((file) => file.mediaFileId === replacement.mediaFileId);
      return {
        kind: "ready",
        ...base,
        newLanguages: fresh && fresh.audioLanguages.length > 0 ? languageList(fresh.audioLanguages) : null,
      };
    }
    return { kind: replacement.state, ...base };
  }
  if (!owned?.rejectedAudio) return { kind: "ok" };
  const rejected = files.find((file) => file.inspectionState === "rejected");
  if (!rejected) return { kind: "ok" };
  return {
    kind: "wrong-audio",
    fileId: rejected.mediaFileId,
    languages: languageList(owned.rejectedAudio.languages),
  };
}

/** One short line for the state, e.g. "Only Spanish audio". */
export function audioCheckLabel(check: AudioCheck): string | null {
  switch (check.kind) {
    case "ok":
      return null;
    case "wrong-audio":
      return `Only ${check.languages} audio`;
    case "looking":
      return "Looking for another copy";
    case "downloading":
      return "Downloading another copy";
    case "ready":
      return check.newLanguages ? `New copy has ${check.newLanguages} audio` : "New copy is ready";
    case "failed":
      return "Couldn't find another copy";
  }
}

/**
 * Whole-title summary for library cards and download rows. A series names how many episode
 * files have the wrong audio rather than one language line that reads like the whole show.
 */
export function audioCheckSummary(owned: MediaInspectionSummary | null | undefined, series: boolean): AudioCheck & { label: string | null } {
  const check = audioCheck(owned);
  if (!series || check.kind !== "wrong-audio") return { ...check, label: audioCheckLabel(check) };
  const count = (owned?.mediaFiles ?? []).filter((file) => file.inspectionState === "rejected").length;
  return { ...check, label: count > 1 ? `${count} episodes have the wrong audio` : "1 episode has the wrong audio" };
}
