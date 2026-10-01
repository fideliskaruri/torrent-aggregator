/**
 * Quality-selection state for the Download flow.
 *
 * Every Download asks which quality to fetch, unless the user has set
 * "always use my preferred quality".
 *
 * Pure and DOM-free.
 */

export const QUALITY_CHOICES = [
  {
    value: 480,
    label: "480p",
    hint: "Minimum 480p. Releases without a stated quality are skipped.",
  },
  {
    value: 720,
    label: "720p",
    hint: "Minimum 720p. Never downloads 480p or an unknown quality.",
  },
  {
    value: 1080,
    label: "1080p",
    hint: "Minimum 1080p. Uses 4K only when no eligible 1080p release exists.",
  },
  {
    value: 2160,
    label: "4K",
    hint: "4K minimum. Lower or unknown qualities are skipped.",
  },
] as const;

export type QualityValue = (typeof QUALITY_CHOICES)[number]["value"];

/** localStorage key. Storing the value makes the preference portable across sessions. */
export const ALWAYS_PREFERRED_KEY = "tf:download:always-preferred";

/** True when the user should be asked which quality to download. */
export function shouldAskForQuality(alwaysPreferred: boolean): boolean {
  return !alwaysPreferred;
}

/**
 * Map any resolution number to the nearest defined quality choice.
 *
 * Settings store `preferredResolution` as an arbitrary integer; the choices
 * are 480/720/1080/2160. A value that does not match exactly (e.g. 1440)
 * snaps to the closest supported step.
 *
 * **Ties resolve downward.** 900 sits exactly 180 from both 720 and 1080, and
 * 1440 exactly 720 from both 1080 and 2160. `<` (rather than `<=`) keeps the
 * earlier — lower — choice, which is the safer default: a quality the swarm is
 * more likely to actually have, rather than one the user may wait forever for.
 */
export function nearestQuality(resolution: number): QualityValue {
  return QUALITY_CHOICES.reduce(
    (prev, curr) =>
      Math.abs(curr.value - resolution) < Math.abs(prev.value - resolution)
        ? curr
        : prev,
    QUALITY_CHOICES[0],
  ).value;
}
