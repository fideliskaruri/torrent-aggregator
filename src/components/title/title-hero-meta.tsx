/**
 * The hero's metadata furniture — the streaming-detail (Trakt/SIMKL "SILO"
 * style) header pieces, split out as pure helpers plus thin presentational
 * components.
 *
 * Two rules shape this file:
 *
 *  - **Never fabricate.** Every helper returns `null` for an absent input and
 *    the components omit the row/line entirely rather than printing a
 *    placeholder, a `0`, or an empty parenthesis. A score with no votes drops
 *    the `(votes)`; a title with no genres renders no chip strip.
 *  - **No locale-dependent output.** This mounts in a client component that is
 *    also server-rendered, so a `toLocaleDateString()` would risk a hydration
 *    mismatch (the server and the browser can disagree on month names and
 *    order). The month table below is fixed, so "2023-05-04" is always
 *    "May 4, 2023" on both sides.
 */
import { factsLine } from "@/lib/utils";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * "2023-05-04" → "May 4, 2023". Accepts a bare `YYYY-MM-DD` or a full ISO
 * string (only the leading date is read). Returns null for anything that is
 * not a real calendar date, so a malformed value omits the row rather than
 * printing "NaN" or "Invalid Date".
 */
export function formatReleaseDate(
  iso: string | null | undefined,
): string | null {
  if (!iso) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

/**
 * The TMDB score, with its vote count in parentheses when there is one.
 *
 * TMDB reports `0` for an unrated title and `null`/`0` votes for a score
 * nobody has cast on, so a `0.0` is treated as *not rated* (absent) and a
 * missing count drops the "(votes)" rather than printing "(0)" or "()".
 */
export function tmdbScore(
  rating: number | null | undefined,
  voteCount: number | null | undefined,
): string | null {
  if (rating == null || rating <= 0) return null;
  const score = rating.toFixed(1);
  return voteCount != null && voteCount > 0
    ? `${score} (${voteCount})`
    : score;
}

/**
 * The trailing fact after the year: "3 Seasons" for a series, the runtime for
 * a film. Null when neither is known.
 */
export function seasonRuntimeLabel(input: {
  isSeries: boolean;
  seasonCount: number | null | undefined;
  runtimeLabel?: string | null;
}): string | null {
  if (input.isSeries) {
    const n = input.seasonCount;
    if (n == null || n <= 0) return null;
    return `${n} Season${n === 1 ? "" : "s"}`;
  }
  const runtime = input.runtimeLabel?.trim();
  return runtime ? runtime : null;
}

/**
 * The four-digit year of a release date, e.g. "2024-02-27" → 2024. Null for a
 * missing or malformed date. Used only as a *fallback* for the meta line's year
 * when the payload carries no explicit `year` — the date is real, so this is a
 * derivation, not a fabrication.
 */
export function releaseYear(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const match = /^(\d{4})-\d{2}-\d{2}/.exec(iso.trim());
  if (!match) return null;
  return Number(match[1]);
}

export interface HeroMetaInput {
  rating: number | null | undefined;
  voteCount: number | null | undefined;
  year: number | null | undefined;
  isSeries: boolean;
  seasonCount: number | null | undefined;
  runtimeLabel?: string | null;
  /** Who supplied {@link rating}. See `ratingSource` on `TitleExtrasPayload`. */
  ratingSource?: "tmdb" | "anilist" | "tvmaze" | "itunes" | null;
}

/**
 * The badge that labels the score, named for whoever actually supplied it.
 *
 * Absent means TMDB: that was the only provider when this line was written, so
 * every existing caller keeps its badge. A keyless install is served by AniList,
 * TVmaze or iTunes, and each is credited by name rather than borrowing TMDB's.
 */
export function ratingBadgeLabel(
  source: HeroMetaInput["ratingSource"],
): string {
  switch (source) {
    case "anilist":
      return "ANILIST";
    case "tvmaze":
      return "TVMAZE";
    case "itunes":
      return "ITUNES";
    default:
      return "TMDB";
  }
}

/**
 * The whole rating/meta line *after* the "TMDB" badge:
 * `{score} · {year} · {N Seasons|runtime}`, with any absent piece dropped.
 * The badge itself is rendered separately (only when {@link tmdbScore} is
 * present), and the line begins with the score so the badge reads as its
 * label.
 */
export function metaLine(input: HeroMetaInput): string {
  return factsLine([
    tmdbScore(input.rating, input.voteCount),
    input.year ? String(input.year) : null,
    seasonRuntimeLabel(input),
  ]);
}

// ---------------------------------------------------------------------------
// Presentational
// ---------------------------------------------------------------------------

/** The rating/meta line under the title, with the small "TMDB" text badge. */
export function RatingMetaLine(input: HeroMetaInput) {
  const score = tmdbScore(input.rating, input.voteCount);
  const line = metaLine(input);
  if (!line) return null;
  return (
    <div
      data-title-meta-line
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] text-[var(--text-secondary)]"
    >
      {score ? (
        <span
          data-title-tmdb-badge
          className="rounded-[calc(var(--radius)-3px)] border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]"
        >
          {ratingBadgeLabel(input.ratingSource)}
        </span>
      ) : null}
      <span className="tabular-nums">{line}</span>
    </div>
  );
}

/** Genre pills. Renders nothing when there are no genres to show. */
export function GenreChips({ genres }: { genres: string[] }) {
  const list = genres.filter((g) => g.trim().length > 0);
  if (list.length === 0) return null;
  return (
    <ul data-title-genres className="mt-4 flex flex-wrap gap-2">
      {list.map((genre) => (
        <li
          key={genre}
          className="rounded-full border border-[var(--border)] px-2.5 py-1 text-[12px] text-[var(--text-secondary)]"
        >
          {genre}
        </li>
      ))}
    </ul>
  );
}

/**
 * The compact metadata list in the hero's right column. One row per known
 * field; the whole block is omitted when none are present.
 */
export function HeroMetaList({
  originalLanguage,
  releaseDate,
  certification,
}: {
  originalLanguage: string | null | undefined;
  releaseDate: string | null | undefined;
  certification: string | null | undefined;
}) {
  const rows: { label: string; value: string }[] = [];
  if (originalLanguage) {
    rows.push({ label: "Language", value: originalLanguage });
  }
  const formattedDate = formatReleaseDate(releaseDate);
  if (formattedDate) {
    rows.push({ label: "Release Date", value: formattedDate });
  }
  if (certification) {
    rows.push({ label: "Rating", value: certification });
  }
  if (rows.length === 0) return null;
  return (
    <dl data-title-metalist className="space-y-2 text-[13px]">
      {rows.map((row) => (
        <div key={row.label} className="flex gap-2">
          <dt className="shrink-0 text-[var(--text-tertiary)]">{row.label}:</dt>
          <dd className="min-w-0 text-[var(--text-secondary)]">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
