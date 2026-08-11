/**
 * On-demand single-episode grab.
 * - Rewatch / off-cursor episode: does NOT move the hunt cursor.
 * - Grab of the current hunt target (next SxxEyy): advances cursor like automation.
 */
import prisma from "@/lib/prisma";
import { normalizeInfoHash } from "@/lib/torrents/infohash";
import { selectSeriesCandidateWithPackPreference, matchesTargetEpisode } from "@/lib/torrents/pack-preference";
import { searchTorrents } from "@/lib/torrents/aggregator";
import { rankResults } from "@/lib/torrents/ranking";
import {
  meetsResolutionFloor,
  normalizeResolutionFloor,
} from "@/lib/torrents/quality";
import type { SearchResponse, TorrentResult } from "@/lib/torrents/types";
import type { ClientConnectionConfig } from "@/lib/clients";
import {
  afterSuccessfulGrab,
  episodeSearchQuery,
  formatEpisodeLabel,
  padEp,
  resolveHuntCursor,
} from "@/lib/library/cursor";
import { checkSendStorage } from "@/lib/library/storage-gate";
import type { StorageOverrideFacts } from "@/lib/library/storage-override";
import {
  getUserClientConfig,
} from "@/lib/clients";
import { resolveSmartSendTarget } from "@/lib/download/smart-target";
import { searchTitleVariants } from "@/lib/search/query-variants";
import { catalogMetadata } from "@/lib/metadata/catalog-identity";
import {
  searchCategoryForMediaType,
  type CatalogSearchCategory,
} from "@/lib/metadata/media-type";
import { runGrabPipeline } from "@/lib/grab/pipeline";
import type {
  GrabPipelineResult,
  PipelineSearchOptions,
  TxClient,
} from "@/lib/grab/types";
import { applySendRetention, sendRetentionToPurpose, type SendRetention } from "@/lib/streaming/send-retention";
import {
  workIdentityFor,
  workKeyFor,
  workKeyMatches,
} from "@/components/title/work-key";

export type OnDemandResult = {
  ok: boolean;
  message: string;
  query: string;
  title?: string;
  savePath?: string | null;
  magnet?: string | null;
  /**
   * The release that was sent, addressable.
   *
   * The pipeline has always known this — it dedupes on it — and threw it away
   * at the boundary. Returning it is what lets a caller open the player on a
   * torrent that started downloading a second ago instead of telling the user
   * to come back later.
   */
  infoHash?: string | null;
  /**
   * Set only when a storage limit refused the grab. @see StorageOverrideFacts —
   * lets the caller offer "raise the cap" or an informed override rather than
   * ending the interaction with a toast.
   */
  storage?: StorageOverrideFacts | null;
  /** True when grab matched hunt cursor and cursor was advanced */
  advanced?: boolean;
  lastEpisode?: string;
  cursorSeason?: number;
  cursorEpisode?: number;
  nextEpisodeHint?: string;
  /**
   * Present ONLY when the fallback ladder was exhausted without a successful
   * send. Lets a UI render an honest, actionable failure (e.g. a "Search
   * manually" button pre-filled with `manualSearchQuery`) instead of flat grey
   * text. `reason` is a coarse machine hint; `message` is the authoritative
   * human sentence.
   *
   * NOTE: this structured field is exposed on the `/api/library/ondemand`
   * route (which spreads the whole result). The title-page caller
   * (`api/title/[workKey]/grab.ts`) currently maps only `{ ok, message, ... }`
   * into its component-owned `TitleGrabResponse`, so the title page sees only
   * `message` until that (component-owned) type is extended to carry this.
   */
  noReleaseFound?: {
    reason: "no_release" | "client_offline" | "send_failed";
    /** Distinct indexer searches actually run this press. */
    searches: number;
    /** Whether a season-pack rung was reached (message honesty). */
    triedSeasonPacks: boolean;
    /** Canonical query to prefill a manual search box, e.g. "Family Guy S01E02". */
    manualSearchQuery: string;
    /**
     * Per-rung yield. Without it a failed press is indistinguishable from a
     * press that fetched hundreds of rows and threw every one away on the
     * work-identity or quality filter — the two need completely different
     * fixes. Ordered as the ladder ran.
     */
    rungs?: RungDiagnostic[];
  };
};

/** What one rung actually fetched and how much of it survived each filter. */
export type RungDiagnostic = {
  kind: RungKind;
  query: string;
  category: LadderCategory;
  /** Seeder floor for the rung — 0 marks the relaxed last resort. */
  minSeeders?: number;
  /** Rows the indexer returned for this rung. */
  fetched: number;
  /** Rows whose work identity matched the show (or one of its aliases). */
  workEligible: number;
  /** Rows that also cleared the resolution floor. */
  qualityEligible: number;
  /** Candidates this rung handed to the pipeline. */
  attempted: number;
};

/**
 * After a successful send: if the grabbed SxxEyy is the library item's hunt
 * cursor, advance last/next/cursor (same as automation). Off-cursor rewatch
 * leaves the cursor alone.
 *
 * Accepts a db client — either `tx` (inside a transaction) or the top-level
 * prisma client. This lets the cursor advance commit atomically with the
 * GrabJob + DownloadHistory writes when called from the pipeline hook.
 *
 * Exported despite having no other *runtime* caller: it is the seam
 * `scripts/test-ondemand-advance.ts` drives directly, because cursor advance
 * is the one step whose off-by-one is invisible from the outside — a rewatch
 * that quietly moves the cursor and a match that quietly doesn't both look
 * like a successful grab. Do not un-export it.
 */
export async function advanceLibraryItemIfHuntMatch(
  db: TxClient | typeof prisma,
  opts: {
  userId: string;
  watchListItemId: string;
  grabSeason: number;
  grabEpisode: number;
  grabbedTitle: string;
}): Promise<{
  advanced: boolean;
  lastEpisode?: string;
  cursorSeason?: number;
  cursorEpisode?: number;
  nextEpisodeHint?: string;
}> {
  const item = await db.watchListItem.findFirst({
    where: { id: opts.watchListItemId, userId: opts.userId },
  });
  if (!item) {
    return { advanced: false };
  }

  const hunt = resolveHuntCursor({
    title: item.title,
    mediaType: item.mediaType,
    cursorSeason: item.cursorSeason,
    cursorEpisode: item.cursorEpisode,
    fromSeason: item.fromSeason,
    fromEpisode: item.fromEpisode,
    lastEpisode: item.lastEpisode,
    nextEpisodeHint: item.nextEpisodeHint,
  });

  if (
    !hunt.cursor ||
    hunt.cursor.season !== opts.grabSeason ||
    hunt.cursor.episode !== opts.grabEpisode
  ) {
    return { advanced: false };
  }

  const advanced = afterSuccessfulGrab(
    item.title,
    hunt.cursor,
    opts.grabbedTitle,
  );

  await db.watchListItem.update({
    where: { id: item.id },
    data: {
      lastChecked: new Date(),
      latestReleaseTitle: opts.grabbedTitle,
      latestReleaseAt: new Date(),
      lastEpisode: advanced.lastEpisode,
      cursorSeason: advanced.cursorSeason,
      cursorEpisode: advanced.cursorEpisode,
      nextEpisodeHint: advanced.nextEpisodeHint,
      // A grab is a grab, whoever asked for it. Automation resets both of
      // these when it advances the cursor, and an on-demand grab that moved
      // the same cursor must do the same or it quietly disables automation:
      //   - `cursorMisses` left non-zero keeps the item in hunt backoff for
      //     hours even though we just proved releases are findable.
      //   - `seederWaitSince` left set points at the *previous* episode's wait,
      //     so the 6h thin-swarm escape hatch can fire immediately on the new
      //     episode and grab a 0-seeder release that should have been deferred.
      cursorMisses: 0,
      seederWaitSince: null,
      ...(item.fromSeason == null
        ? {
            fromSeason: hunt.cursor.season,
            fromEpisode: hunt.cursor.episode,
          }
        : {}),
    },
  });

  return {
    advanced: true,
    lastEpisode: advanced.lastEpisode,
    cursorSeason: advanced.cursorSeason,
    cursorEpisode: advanced.cursorEpisode,
    nextEpisodeHint: advanced.nextEpisodeHint,
  };
}

// ── On-demand fallback ladder ───────────────────────────────────────────────
// A single episode-shaped search ("Show SxxEyy") is only ONE of the ways an
// indexer names a release, and it structurally hides season packs: EZTV drops
// every pack when the query names an episode (torrents/eztv.ts), and free-text
// indexers never substring-match a pack title against "SxxEyy". So a perfectly
// seedable pack that CONTAINS the episode is invisible to rung 1.
//
// Anime adds two more failure modes the first ladder missed:
//   1. Catalog titles are formal ("Re:ZERO -Starting Life in Another World-")
//      while indexers list "Re Zero" / "ReZERO" / romaji. The formal string
//      returns ZERO hits on Nyaa; the short alias finds dozens.
//   2. TMDB often labels anime as mediaType "tv", which routes Nyaa to Live
//      Action (4_0) instead of Anime (1_0). Dual-category rungs fix that.
//   3. Fansubs number absolutely ("- 01") with no Sxx — selectors must accept
//      season-less episode N when hunting S01EN (see matchesTargetEpisode).
//
// The ladder relaxes one rung at a time and STOPS at the first working send.

/** Distinct indexer searches allowed per press (at most one per rung). */
/**
 * Distinct indexer searches allowed per press.
 *
 * Eight was not enough for anime: with the old alias×category cross-product it
 * spent the whole budget on SxxEyy shapes and never asked for "Show - 01" at
 * all. The rungs are now ordered by shape diversity, and the ceiling is raised
 * so the tail (second alias, remaining categories) is reachable on hard titles.
 */
/** Per-rung indexer page size — anime titles need more than 15 to surface packs. */
const LADDER_SEARCH_LIMIT = 40;

export type RungKind = "exact" | "alt" | "pack" | "absolute" | "relaxed";
export type LadderCategory = CatalogSearchCategory | "all";

type EpisodeRung = {
  kind: RungKind;
  query: string;
  /** Indexer category for this rung (anime vs tv matters on Nyaa). */
  category: LadderCategory;
  filters: PipelineSearchOptions["filters"];
  /** Ordered pick, skipping any candidate key already attempted this press. */
  select: (
    results: TorrentResult[],
    attempted: Set<string>,
  ) => TorrentResult | null;
};

/** Stable identity for cross-rung dedupe: infohash, else magnet, else id. */
function candidateKey(r: TorrentResult): string {
  return normalizeInfoHash(r.infoHash) ?? r.magnet ?? r.id;
}

/**
 * Titles worth searching, formal first then the short forms indexers actually
 * use. Live proof (Re:ZERO): the full TMDB name → 0 hits; "Re Zero S01E01" on
 * anime → seeded Nyaa results.
 *
 * The rule now lives in `@/lib/search/query-variants` so discovery search and
 * the grab ladder share ONE normalizer. Re-exported here for the ladder's own
 * callers and existing imports.
 */
export { searchTitleVariants };

/**
 * Query/identity forms for ONE provider alias.
 *
 * AniList romaji is frequently a full sentence with the short seeded name in
 * front of a comma: "Slime Taoshite 300 Nen, Shiranai Uchi ni Level Max ni
 * Nattemashita". Fansubs seed the head alone, so without the comma-head form
 * the alias is both an unsearchable query and — worse — an identity the alias's
 * own release fails, which silently rejects the release the alias just found.
 *
 * Comma only: splitting on a colon would turn "Re:ZERO -Starting Life-" into
 * the two-letter "Re", a token loose enough to match other shows. The head must
 * still be a real name (two words, six characters) to be kept.
 *
 * Pure — safe for tests.
 */
export function aliasTitleForms(title: string): string[] {
  const out: string[] = [];
  const add = (value: string) => {
    if (!value) return;
    if (out.some((x) => x.toLowerCase() === value.toLowerCase())) return;
    out.push(value);
  };
  for (const variant of searchTitleVariants(title)) add(variant);
  for (const variant of [...out]) {
    const head = (variant.split(",")[0] ?? "").trim();
    if (head.length < 6 || !/\s/.test(head)) continue;
    if (head.toLowerCase() === variant.toLowerCase()) continue;
    for (const headVariant of searchTitleVariants(head)) add(headVariant);
  }
  return out;
}

/** "Show 1x02" — the other common single-episode naming indexers use. */
function altEpisodeQuery(title: string, season: number, episode: number): string {
  return `${title.trim()} ${season}x${padEp(episode)}`;
}

/**
 * "Show S01" — a season-shaped query. This is the ONLY shape that surfaces
 * season packs: an episode-shaped query makes EZTV drop packs and makes
 * free-text indexers miss them. Mirrors season-acquire's seasonSearchQuery.
 */
/**
 * Anime absolute episode: "Show - 01" / "Show - 1". Fansubs almost never use
 * SxxEyy; the dash form is what Nyaa ranks.
 */
function absoluteEpisodeQuery(title: string, episode: number): string {
  return `${title.trim()} - ${padEp(episode)}`;
}

/**
 * Last-resort selector: accept the target episode even with zero seeders (a
 * stalled magnet the engine may still resolve from the DHT), healthiest first.
 * Never returns a pack or a wrong episode. Kept local so the shared
 * pack-preference selector's `seeders > 0` floor stays intact for everyone else.
 */
function selectRelaxedEpisode(
  results: TorrentResult[],
  target: { season: number; episode: number },
): TorrentResult | null {
  const exact = results
    .filter((r) => Boolean(r.magnet))
    .filter((r) => matchesTargetEpisode(r, target))
    .sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0));
  return exact[0] ?? null;
}

/** A SearchResponse carrying exactly the pinned candidate for the pipeline. */
function pinnedResponse(
  results: TorrentResult[],
  query: string,
): SearchResponse {
  return {
    query,
    results,
    groups: [],
    tookMs: 0,
    sources: [],
    totalCount: results.length,
    page: 1,
    pageSize: Math.max(1, results.length),
    totalPages: results.length ? 1 : 0,
  };
}

function ladderCategories(mediaType: string): LadderCategory[] {
  // searchCategoryForMediaType never returns "all" — only anime|movies|tv.
  const primary: LadderCategory = searchCategoryForMediaType(mediaType) ?? "tv";
  const cats: LadderCategory[] = [primary];
  // Anime indexers (Nyaa) are the right place for a lot of series TMDB labels
  // as plain "tv". Always try anime as a second category for series hunts.
  if (primary !== "anime") cats.push("anime");
  cats.push("all");
  return cats;
}

/**
 * The rungs, in relaxation order.
 *
 * Fast path for ordinary TV (Family Guy etc.) is unchanged at the front:
 *   1 exact SxxEyy · 2 alt 1x02 · 3 season pack
 * on the primary category with the formal catalog title.
 *
 * Then alias + anime/all categories + absolute-episode forms rescue titles
 * whose catalog name does not appear on indexers (Re:ZERO and most anime).
 * Relaxed (0-seeder floor) stays last.
 */
function buildEpisodeRungs(
  title: string,
  season: number,
  episode: number,
  mediaType: string,
  extraTitles: readonly string[] = [],
  minimumResolution: number | null = null,
): EpisodeRung[] {
  const target = { season, episode };
  const packPreferred = (results: TorrentResult[], attempted: Set<string>) =>
    selectSeriesCandidateWithPackPreference(
      results.filter((r) => !attempted.has(candidateKey(r))),
      target,
    );
  const relaxedSelect = (results: TorrentResult[], attempted: Set<string>) =>
    selectRelaxedEpisode(
      results.filter((r) => !attempted.has(candidateKey(r))),
      target,
    );

  const titles = searchTitleVariants(title);
  const primaryTitle = titles[0] ?? title.trim();
  // Real provider aliases (AniList romaji/native — "Tensei Shitara Slime Datta
  // Ken" for the English "That Time I Got Reincarnated as a Slime") are
  // genuinely different names that no punctuation-normalization of the English
  // title can ever reach, so without injecting them here an anime episode grab
  // searches only a name indexers never carry and finds nothing despite hundreds
  // of seeded releases (BUG-010). Their variants join the alias pool below the
  // canonical title. Empty by default → ordinary TV ladders are unchanged.
  const seenAlias = new Set<string>([primaryTitle.toLowerCase()]);
  const injectedAliases = extraTitles
    .flatMap((t) => aliasTitleForms(t))
    .filter((t) => {
      const k = t.toLowerCase();
      return seenAlias.has(k) ? false : (seenAlias.add(k), true);
    });
  const aliases = rankAliases([
    ...titles.filter((t) => t.toLowerCase() !== primaryTitle.toLowerCase()),
    ...injectedAliases,
  ]);

  // A *rescue* alias is one that changes the name, not just its punctuation:
  // "Re ZERO" for "Re:ZERO -Starting Life in Another World-". "FamilyGuy" for
  // "Family Guy" is the same token with a space removed, and must not push the
  // season pack — the universal rescue — down the ladder for ordinary TV.
  const squash = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const primarySquashed = squash(primaryTitle);
  const rescues = aliases.filter(
    (a) =>
      squash(a) !== primarySquashed || a.length <= primaryTitle.length * 0.6,
  );
  const spellings = aliases.filter((a) => !rescues.includes(a));
  const bestAlias = rescues[0] ?? null;
  const secondAlias = rescues[1] ?? spellings[0] ?? null;

  const cats = ladderCategories(mediaType);
  const primaryCat = cats[0] ?? "tv";
  const animeCat: LadderCategory | null = cats.includes("anime") ? "anime" : null;
  const extraCats = cats.filter((c) => c !== primaryCat && c !== "anime");

  const rungs: EpisodeRung[] = [];
  // The budget is spent per (query, category); asking the same thing twice is a
  // rung the user paid for and learned nothing from.
  // The budget is spent per distinct SEARCH — same query, same category AND
  // the same filters. Keying on (query, category) alone silently deleted the
  // relaxed minSeeders:0 rung whenever it re-asked an earlier rung's query,
  // which is exactly the thin-swarm anime case the rung exists for.
  const seen = new Set<string>();
  const push = (
    kind: RungKind,
    query: string,
    category: LadderCategory | null,
    filters: PipelineSearchOptions["filters"],
    select: EpisodeRung["select"] = packPreferred,
  ) => {
    if (!category) return;
    const key = `${category}::${query.toLowerCase()}::${JSON.stringify(filters ?? null)}`;
    if (seen.has(key)) return;
    seen.add(key);
    rungs.push({ kind, query, category, filters, select });
  };

  const epFilters = { hasMagnet: true, minSeeders: 1, season, episode };
  const absFilters = { hasMagnet: true, minSeeders: 1, episode };
  const exact = (t: string | null, cat: LadderCategory | null) =>
    t && push("exact", episodeSearchQuery(t, season, episode), cat, epFilters);
  const alt = (t: string | null, cat: LadderCategory | null) =>
    t && push("alt", altEpisodeQuery(t, season, episode), cat, epFilters);
  const absolute = (t: string | null, cat: LadderCategory | null) => {
    // "Show - 01" numbers episodes from the start of the show, so it is only
    // the same episode as SxxEyy while we are hunting season one.
    if (!t || season !== 1) return;
    push("absolute", absoluteEpisodeQuery(t, episode), cat, absFilters);
  };
  const qualityAbsolute = (
    t: string | null,
    cat: LadderCategory | null,
  ) => {
    if (!t || season !== 1 || minimumResolution == null) return;
    push(
      "absolute",
      `${absoluteEpisodeQuery(t, episode)} ${minimumResolution}p`,
      cat,
      absFilters,
    );
  };
  const commonQualityAbsolute = (
    t: string | null,
    cat: LadderCategory | null,
  ) => {
    if (!t || season !== 1 || minimumResolution != null) return;
    push(
      "absolute",
      `${absoluteEpisodeQuery(t, episode)} 1080p`,
      cat,
      absFilters,
    );
  };

  // The canonical query always leads: ordinary TV resolves on it.
  exact(primaryTitle, primaryCat);

  if (bestAlias) {
    // Anime-shaped title. The catalog string is frequently a zero-hit query
    // (measured on Re:ZERO), so the rescue name comes second rather than after
    // the whole formal-title sweep, and the dash form has to land inside the
    // budget instead of behind an alias×category cross-product.
    exact(bestAlias, animeCat);
    exact(bestAlias, primaryCat);
    absolute(bestAlias, animeCat);
    // Old anime singles are routinely pushed out of the first result page by
    // current seasons and batches. When Download has a hard quality floor,
    // naming that quality in one query narrows the indexer before pagination
    // instead of fetching 40 broad hits and filtering the wanted release out
    // afterward. The normal absolute rung still runs first, so this costs
    // nothing when the broad query already succeeds.
    qualityAbsolute(bestAlias, animeCat);
    // Stream keeps no hard floor, but the same season-one alias needs a common
    // 1080p narrowing hint so the old exact single can surface without making
    // lower-quality results ineligible.
    commonQualityAbsolute(bestAlias, animeCat);
    alt(primaryTitle, primaryCat);
    absolute(bestAlias, primaryCat);
  } else {
    // Ordinary TV: the classic relaxation order, untouched. A season pack is
    // the universal rescue and must not queue behind anime-only shapes.
    alt(primaryTitle, primaryCat);
    exact(primaryTitle, animeCat);
    absolute(primaryTitle, animeCat);
  }

  // Whatever name and category are left.
  exact(secondAlias, animeCat);
  exact(secondAlias, primaryCat);
  absolute(secondAlias, animeCat);
  for (const cat of extraCats) {
    exact(bestAlias ?? primaryTitle, cat);
    absolute(bestAlias ?? primaryTitle, cat);
  }
  push(
    "relaxed",
    episodeSearchQuery(bestAlias ?? primaryTitle, season, episode),
    animeCat ?? primaryCat,
    { hasMagnet: true, minSeeders: 0, season, episode },
    relaxedSelect,
  );

  return rungs;
}

/**
 * Aliases in the order indexers actually reward.
 *
 * Punctuation is the enemy: `Re:ZERO` is one colon away from matching nothing,
 * while `Re ZERO` is what Nyaa ranks. Short names beat long formal ones, which
 * is the whole reason the ladder has aliases at all; space-separated names beat
 * compacted ones (`ReZERO`); and word-jamming artifacts left behind by stripping
 * a colon (`Star WarsThe Clone Wars`) rank below the readable form.
 */
export function rankAliases(aliases: string[]): string[] {
  const cost = (t: string) =>
    // When both provider-native and Romaji names exist, fansub/indexer release
    // names overwhelmingly use the Latin spelling. Keep native-script aliases
    // as fallbacks, but do not let their shorter character count push the
    // searchable Romaji name behind them.
    (/[a-z]/i.test(t) ? 0 : 4) +
    (/[:;,]/.test(t) ? 2 : 0) +
    (/\s/.test(t) ? 0 : 1) +
    (/\p{Ll}\p{Lu}/u.test(t) ? 0.5 : 0) +
    Math.min(t.length, 60) / 12;
  return [...aliases].sort((a, b) => cost(a) - cost(b));
}

export function episodeReleaseMatchesWork(
  release: TorrentResult,
  titles: readonly string[],
): boolean {
  const identity = workIdentityFor(release.title, release.metadata ?? null);
  return titles.some((title) => {
    const key = workKeyFor(title, null);
    return Boolean(key) && workKeyMatches(key, identity.name, identity.year);
  });
}

export async function grabSingleEpisode(opts: {
  userId: string;
  workId?: string | null;
  showTitle: string;
  mediaType: string;
  season: number;
  episode: number;
  /**
   * Genuinely-different provider names for this work (AniList romaji/native and
   * other verified aliases). Fed into the fallback ladder so anime — whose
   * English catalog title indexers rarely carry — is searched under the name
   * fansubs actually use (BUG-010). Optional; ordinary TV passes none.
   */
  aliases?: readonly string[];
  /** Minimum output height for kept downloads. */
  preferredResolution?: number | null;
  /** Optional library item id for GrabJob externalId + hunt-cursor advance */
  watchListItemId?: string | null;
  /** "stream" = reclaimable cache; "keep" = permanent download. */
  retention?: SendRetention;
  /**
   * Hashes reclamation must never touch — the stream the viewer is watching
   * right now, when the caller knows it.
   */
  protectHashes?: readonly string[];
  /**
   * The owner was shown the real figures and chose to exceed their own cap.
   * Honoured for the cap only — never for the free-space floor.
   */
  overrideStorageCap?: boolean;
  /** Test seam — bypass getUserClientConfig with a pinned client config. */
  _config?: ClientConnectionConfig;
  /** Test seam — override the per-rung aggregator search. */
  _searchFn?: typeof searchTorrents;
  /** Test seam — override the client send (forwarded to the pipeline). */
  _sendFn?: typeof import("@/lib/clients").sendToClient;
  /** Test seam — override Prisma (forwarded to the pipeline + synth skip row). */
  _prisma?: typeof prisma;
}): Promise<OnDemandResult> {
  const season = Math.max(1, Math.trunc(opts.season) || 1);
  const episode = Math.max(1, Math.trunc(opts.episode) || 1);
  const query = episodeSearchQuery(opts.showTitle, season, episode);

  const config = opts._config ?? (await getUserClientConfig(opts.userId));
  if (!config) {
    return {
      ok: false,
      query,
      message: "No client configured",
    };
  }

  const label = formatEpisodeLabel(season, episode);
  const minimumResolution =
    (opts.retention ?? "keep") === "keep"
      ? normalizeResolutionFloor(opts.preferredResolution)
      : null;
  const searchFn = opts._searchFn ?? searchTorrents;
  const db = opts._prisma ?? prisma;
  const rungs = buildEpisodeRungs(
    opts.showTitle,
    season,
    episode,
    opts.mediaType,
    opts.aliases ?? [],
    minimumResolution,
  );
  const acceptedWorkTitles = [
    opts.showTitle,
    ...(opts.aliases ?? []),
  ].flatMap((title) => aliasTitleForms(title));

  let cursorAdvance: Awaited<
    ReturnType<typeof advanceLibraryItemIfHuntMatch>
  > = { advanced: false };

  // Memoize by (query + category + filters) so two rungs that resolve to the
  // same search never double-hit the indexers, and so `searchMemo.size` is an
  // honest count of DISTINCT searches for both the exhausted message and the
  // search cap.
  const searchMemo = new Map<string, Promise<SearchResponse>>();
  const attempted = new Set<string>();
  let sendAttempts = 0;
  let triedPacks = false;
  let lastFailure: GrabPipelineResult | null = null;
  let winner: { result: GrabPipelineResult; rung: EpisodeRung } | null = null;
  const diagnostics: RungDiagnostic[] = [];

  const runRungSearch = (rung: EpisodeRung): Promise<SearchResponse> | null => {
    const key = `${rung.query}|${rung.category}|${JSON.stringify(rung.filters)}`;
    const existing = searchMemo.get(key);
    if (existing) return existing;
    const p = searchFn({
      query: rung.query,
      category: rung.category,
      limit: LADDER_SEARCH_LIMIT,
      // `limit` caps what the aggregator fetches; `pageSize` caps what it
      // RETURNS. Left at its 15-row default, 25 of the 40 rows this rung paid
      // for were discarded before the selector ever saw them — and on anime the
      // one matching fansub release is routinely outside the first 15.
      pageSize: LADDER_SEARCH_LIMIT,
      enrich: false,
      skipCache: true,
      background: false,
      filters: rung.filters,
    });
    searchMemo.set(key, p);
    return p;
  };

  ladder: for (const rung of rungs) {
    const searchPromise = runRungSearch(rung);
    if (!searchPromise) continue;
    if (rung.kind === "pack") triedPacks = true;
    const rawSearchResp = await searchPromise;
    const workEligibleResults = rawSearchResp.results.filter((result) =>
      episodeReleaseMatchesWork(result, acceptedWorkTitles),
    );
    const floorEligibleResults =
      minimumResolution == null
        ? workEligibleResults
        : workEligibleResults.filter((result) =>
            meetsResolutionFloor(result.title, minimumResolution),
          );
    const searchResp =
      opts.preferredResolution == null
        ? { ...rawSearchResp, results: floorEligibleResults }
        : {
            ...rawSearchResp,
            results: rankResults(
              [...floorEligibleResults],
              rung.query,
              opts.preferredResolution,
              rung.category,
            ),
          };

    const diag: RungDiagnostic = {
      kind: rung.kind,
      query: rung.query,
      category: rung.category,
      minSeeders: rung.filters?.minSeeders,
      fetched: rawSearchResp.results.length,
      workEligible: workEligibleResults.length,
      qualityEligible: floorEligibleResults.length,
      attempted: 0,
    };
    diagnostics.push(diag);

    while (true) {
      const candidate = rung.select(searchResp.results, attempted);
      if (!candidate?.magnet) break; // nothing (more) to try this rung
      attempted.add(candidateKey(candidate));
      sendAttempts += 1;
      diag.attempted += 1;

      // Pin the chosen candidate into the pipeline: with `_searchFn` returning
      // exactly this release, the pipeline never re-searches (so it can't hit
      // its own no-candidate skip branch and write a stray Activity row) and
      // sends only this one torrent. The RECORDED query stays canonical so
      // Activity shows what the user asked for, not the relaxed rung shape.
      const res = await runGrabPipeline({
        userId: opts.userId,
        workId: opts.workId ?? null,
        search: {
          query,
          category: rung.category,
          limit: 1,
          enrich: false,
          skipCache: true,
          background: false,
          filters: rung.filters,
        },
        config,
        fallbackTitle: opts.showTitle,
        grabJobKind: "ondemand",
        externalId: opts.watchListItemId ?? null,
        purpose: sendRetentionToPurpose(opts.retention, opts.watchListItemId),
        minimumResolution,
        downloadHistoryPrefix: `On-demand ${label}`,
        // `checkStorageBudget` below honours the override, but the engine runs
        // its own storage check when the payload reaches it. Both have to know,
        // or a confirmed over-cap grab passes here and is refused there.
        addPayload: { overrideStorageCap: opts.overrideStorageCap === true },
        selectCandidate: () => candidate,
        async checkStorageBudget(cand, target) {
          const root =
            config.baseDownloadPath?.trim() ||
            target.savePath ||
            config.savePath?.trim() ||
            process.cwd();
          // Play reclaims before it refuses; Download still obeys the cap.
          const space = await checkSendStorage({
            userId: opts.userId,
            config,
            root,
            incomingBytes: cand.sizeBytes ?? null,
            retention: opts.retention ?? "keep",
            // The candidate itself is never collateral: reclaiming a stalled
            // allocation to make room for that same allocation would delete the
            // request out from under the request.
            protectHashes: [
              ...(opts.protectHashes ?? []),
              ...(cand.infoHash ? [cand.infoHash] : []),
            ],
            overrideCap: opts.overrideStorageCap === true,
          });
          return space.ok
            ? { ok: true as const }
            : { ok: false as const, message: space.message, storage: space.override };
        },
        resolveTarget(cfg, cand) {
          const t = resolveSmartSendTarget(cfg, {
            name: cand.title,
            source: cand.source,
            searchCategory: rung.category,
            metadata: catalogMetadata({
              mediaType: opts.mediaType,
              title: opts.showTitle,
            }),
          });
          return { category: t.category, savePath: t.savePath };
        },
        async onSuccess(tx, cand) {
          if (opts.watchListItemId) {
            cursorAdvance = await advanceLibraryItemIfHuntMatch(tx, {
              userId: opts.userId,
              watchListItemId: opts.watchListItemId,
              grabSeason: season,
              grabEpisode: episode,
              grabbedTitle: cand.title,
            });
          }
        },
        _searchFn: (async () =>
          pinnedResponse([candidate], query)) as typeof searchTorrents,
        _sendFn: opts._sendFn,
        _prisma: opts._prisma,
      });

      if (res.status === "sent" || res.status === "already_active") {
        winner = { result: res, rung };
        break ladder;
      }
      lastFailure = res;
      // Offline is environmental, not a search problem — more rungs won't help.
      if (res.offline) break ladder;
      // Otherwise (dedupe / viability / storage / send) fall through to this
      // rung's next-best candidate, then to the next rung. THIS is the
      // single-candidate gap fix: one bad pick no longer ends the attempt.
    }
  }

  const searches = searchMemo.size;

  // ── Success ──────────────────────────────────────────────────────────────
  if (winner) {
    const res = winner.result;
    await applySendRetention({
      userId: opts.userId,
      config,
      infoHash: normalizeInfoHash(res.candidate?.infoHash),
      retention: opts.retention ?? "keep",
      watchListItemId: opts.watchListItemId,
    });
    if (res.status === "already_active") {
      return {
        ok: true,
        query,
        message: res.message,
        title: res.candidate?.title,
        magnet: res.candidate?.magnet,
        infoHash: normalizeInfoHash(res.candidate?.infoHash),
      };
    }
    // Honestly label the provenance when we had to relax to win.
    const notes: string[] = [];
    if (cursorAdvance.advanced) notes.push(`advanced past ${label}`);
    if (winner.rung.kind === "pack") notes.push("from season pack");
    if (winner.rung.kind === "relaxed") notes.push("low-seed release");
    const message = notes.length
      ? `${res.message} · ${notes.join(" · ")}`
      : res.message;
    return {
      ok: true,
      message,
      query,
      title: res.candidate?.title,
      savePath: res.target?.savePath,
      magnet: res.candidate?.magnet,
      infoHash: normalizeInfoHash(res.candidate?.infoHash),
      advanced: cursorAdvance.advanced,
      lastEpisode: cursorAdvance.lastEpisode,
      cursorSeason: cursorAdvance.cursorSeason,
      cursorEpisode: cursorAdvance.cursorEpisode,
      nextEpisodeHint: cursorAdvance.nextEpisodeHint,
    };
  }

  // ── Exhausted: a candidate WAS attempted but every send failed ────────────
  // The pipeline already wrote a GrabJob for each real attempt, so we add NO
  // synthetic row here — we just surface the last failure's message plus a
  // coarse machine-readable reason for the UI.
  if (sendAttempts > 0 && lastFailure) {
    const reason: "client_offline" | "send_failed" = lastFailure.offline
      ? "client_offline"
      : "send_failed";
    return {
      ok: false,
      query,
      message: lastFailure.message,
      title: lastFailure.candidate?.title,
      savePath: lastFailure.target?.savePath,
      magnet: lastFailure.candidate?.magnet,
      storage: lastFailure.storage ?? null,
      noReleaseFound: {
        reason,
        searches,
        triedSeasonPacks: triedPacks,
        manualSearchQuery: query,
        rungs: diagnostics,
      },
    };
  }

  // ── Exhausted: NOTHING was ever selectable (the reported-bug path) ────────
  // No pipeline call happened, so nothing is in Activity yet. Write EXACTLY ONE
  // honest skip row — not one per rung. Do NOT push the user to "search
  // manually": the title page already *is* the search, and a dead CTA that
  // opens the same indexer path is noise (user report on Re:ZERO S01E01).
  const quality = minimumResolution == null ? "" : ` at ${minimumResolution}p or higher`;
  // "N searches" reads as "N indexers/pages" and made an exhausted press sound
  // like a coverage problem. What the ladder actually varies is the SHAPE of
  // the question (name, numbering form, category, seeder floor), so say that.
  const message = `Couldn't find a working release for ${label}${quality} after ${searches} distinct query shape${
    searches === 1 ? "" : "s"
  }${triedPacks ? " (including season packs)" : ""}. Try again in a bit — another eligible release may show up.`;
  await db.grabJob.create({
    data: {
      userId: opts.userId,
      title: opts.showTitle,
      query,
      status: "skipped",
      message,
      kind: "ondemand",
      externalId: opts.watchListItemId ?? null,
    },
  });
  return {
    ok: false,
    query,
    message,
    noReleaseFound: {
      reason: "no_release",
      searches,
      triedSeasonPacks: triedPacks,
      manualSearchQuery: query,
      rungs: diagnostics,
    },
  };
}
