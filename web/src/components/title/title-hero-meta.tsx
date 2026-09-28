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
import { Star } from "lucide-react";
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
 * The trailing fact after the year: "3 seasons" for a series, the runtime for
 * a film. Null when neither is known.
 */
function seasonRuntimeLabel(input: {
  isSeries: boolean;
  seasonCount: number | null | undefined;
  runtimeLabel?: string | null;
}): string | null {
  if (input.isSeries) {
    const n = input.seasonCount;
    if (n == null || n <= 0) return null;
    return `${n} season${n === 1 ? "" : "s"}`;
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
  ratingSource?: "tmdb" | "anilist" | "tvmaze" | "itunes" | "cinemeta" | null;
}

/**
 * The badge that labels the score, named for whoever actually supplied it.
 *
 * Absent means TMDB: that was the only provider when this line was written, so
 * every existing caller keeps its badge. A keyless install is served by AniList,
 * TVmaze, iTunes or Cinemeta (IMDb scores), and each is credited by name rather
 * than borrowing TMDB's. An unknown provider string is printed as-is — never
 * relabelled TMDB.
 */
function ratingBadgeLabel(
  source: HeroMetaInput["ratingSource"] | (string & {}),
): string {
  switch (source) {
    case "anilist":
      return "AniList";
    case "tvmaze":
      return "TVmaze";
    case "itunes":
      return "iTunes";
    case "cinemeta":
      // Cinemeta scores are IMDb ratings.
      return "IMDb";
    case "tmdb":
      return "TMDB";
    default: {
      // Unknown provider strings from the wire stay named, never claimed as TMDB.
      const raw = typeof source === "string" ? source.trim() : "";
      return raw ? raw : "TMDB";
    }
  }
}

// ---------------------------------------------------------------------------
// Presentational
// ---------------------------------------------------------------------------

/**
 * The rating/meta line under the title: a labelled score chip ("8.2 AniList")
 * followed by `{year} · {N seasons|runtime}`. The score is never shown bare, so
 * it cannot be mistaken for an age rating or an episode count.
 */
export function RatingMetaLine(input: HeroMetaInput) {
  const score =
    input.rating != null && input.rating > 0 ? input.rating.toFixed(1) : null;
  const facts = factsLine([
    input.year ? String(input.year) : null,
    seasonRuntimeLabel(input),
  ]);
  if (!score && !facts) return null;
  const source = ratingBadgeLabel(input.ratingSource);
  const votes =
    input.voteCount != null && input.voteCount > 0
      ? `, ${input.voteCount.toLocaleString("en-US")} votes`
      : "";
  return (
    <div
      data-title-meta-line
      className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13px] text-[var(--text-secondary)]"
    >
      {score ? (
        <span
          data-title-tmdb-badge
          role="img"
          title={`Rated ${score} out of 10 on ${source}${votes}`}
          aria-label={`Rated ${score} out of 10 on ${source}${votes}`}
          className="inline-flex h-7 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_60%,transparent)] px-2.5 text-[12px]"
        >
          <Star className="h-3 w-3 fill-[var(--accent)] text-[var(--accent)]" aria-hidden />
          <span className="font-semibold tabular-nums text-[var(--text)]">{score}</span>
          <span className="text-[var(--text-tertiary)]">{source}</span>
        </span>
      ) : null}
      {facts ? <span className="tabular-nums">{facts}</span> : null}
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
 * "ja" to "Japanese". The provider hands over an ISO 639 code; a person reads a
 * language name. The locale is pinned to English so the output never depends
 * on the browser. An unknown code is shown upper-cased rather than dropped.
 */
export function languageName(code: string | null | undefined): string | null {
  const raw = code?.trim();
  if (!raw) return null;
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(raw);
    if (name && name.toLowerCase() !== raw.toLowerCase()) return name;
  } catch {
    // Not a valid language tag; fall through.
  }
  return raw.toUpperCase();
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
  const language = languageName(originalLanguage);
  if (language) {
    rows.push({ label: "Language", value: language });
  }
  const formattedDate = formatReleaseDate(releaseDate);
  if (formattedDate) {
    rows.push({ label: "Released", value: formattedDate });
  }
  if (certification) {
    rows.push({ label: "Age rating", value: certification });
  }
  if (rows.length === 0) return null;
  return (
    <dl
      data-title-metalist
      className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]"
    >
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-[var(--text-tertiary)]">{row.label}</dt>
          <dd className="min-w-0 text-[var(--text)]">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
