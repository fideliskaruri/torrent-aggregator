import type { Capabilities } from "@/lib/capabilities";

/**
 * The quiet line under a title the database doesn't know yet. Like every
 * control on the page it is chosen by capability and names only what the
 * viewer can do here: Download (none while the title is unreleased or in
 * cinemas) and Add to library. Requesters can't manage the library, so they
 * get no line; their way in is the Request control in the hero.
 */
export function libraryHint({
  known,
  gated,
  caps,
}: {
  /** `TitleDetailPayload.known`: did anything in the database know this work? */
  known: boolean;
  /** Unreleased or still in cinemas, so the page offers no Download. */
  gated: boolean;
  caps: Pick<Capabilities, "canDownload" | "canManage">;
}): string | null {
  if (known || !caps.canManage) return null;
  return caps.canDownload && !gated
    ? "Not in your library yet. Download it or add it to your library to keep track of it here."
    : "Not in your library yet. Add it to your library to keep track of it here.";
}
