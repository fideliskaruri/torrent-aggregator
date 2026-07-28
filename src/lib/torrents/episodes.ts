export interface EpisodeInfo {
  season?: number;
  episode?: number;
  /** Normalized label like S02E05 or Ep 12 */
  label: string | null;
  isBatch: boolean;
  isSeasonPack: boolean;
  /**
   * True for multi-season ranges (S01-S10, Seasons 1-3).
   * Path rules: multi-season → show root only; single season → Season N.
   */
  isMultiSeason?: boolean;
}

/**
 * Parse season/episode markers from torrent titles.
 * Supports long-running anime (4-digit absolute ep numbers, e.g. One Piece 1170)
 * and hybrid forms (EP1233 S23, S023E01).
 */
/**
 * A run of season numbers: a range (`S01-S05`, `Seasons 1 – 3`) or a list
 * (`Season 1 + 2`, `Seasons 1 & 2`, `Seasons 1, 2, 3`, `Seasons 1 and 2`).
 *
 * Scene and fansub naming is not consistent about the separator, and getting
 * this wrong is not cosmetic: an undetected multi-season pack is filed under
 * `Season 01`, and every season inside it then lands in the wrong folder.
 * `[EMBER] Solo Leveling (2024-2025) (Season 1 + 2)` is the case that showed
 * it — a `+` where the pattern only accepted a dash.
 *
 * `(?!\d)` stops the trailing number swallowing part of a resolution or year,
 * so `Season 1, 2024` and `S01 - 1080p` stay single-season.
 *
 * British naming: `Series N` is the same thing as `Season N` (Top Gear, Doctor
 * Who, Sherlock all publish "Series 22" for what US indexers call "Season 22").
 * The spelled-out word therefore accepts `Serie(s)` as an alias — but only the
 * word, never the bare letter `S`, so `S22` is not confused with anything else.
 *
 * Exported so `smart-category.ts` scores and strips the exact same shape;
 * two regexes that drift apart would classify and file a torrent differently.
 */
export const SEASON_RANGE_RE =
  /\bS(?:easons?|eries)?\s*\d{1,3}(?:\s*(?:[-–—~+&,]|\band\b|\bto\b|\bplus\b)\s*(?:S(?:easons?|eries)?\s*)?\d{1,3}(?!\d))+/i;

export function parseEpisode(title: string): EpisodeInfo {
  const t = title;

  const multiSeason = t.match(SEASON_RANGE_RE);
  if (multiSeason) {
    const nums = (multiSeason[0].match(/\d{1,3}/g) ?? []).map((n) =>
      parseInt(n, 10),
    );
    const from = nums[0];
    const to = nums[nums.length - 1];
    const multi = nums.some((n) => n !== from);
    return {
      // Keep "from" for labels; path nesting uses isMultiSeason to skip Season folder
      season: from,
      episode: undefined,
      label: multi
        ? `S${pad(from)}-S${pad(to)} pack`
        : `S${pad(from)} pack`,
      isBatch: true,
      isSeasonPack: true,
      isMultiSeason: multi,
    };
  }

  // Multi-season list without dashes: "Season 1 2 3 4 5" / "Seasons 01 02 03"
  // (≥3 season numbers → multi pack at show root)
  const multiList = t.match(
    /\b(?:Seasons?|Series)\s+(\d{1,3}(?:\s+\d{1,3}){2,})\b/i,
  );
  if (multiList) {
    const nums = multiList[1].match(/\d{1,3}/g)?.map((n) => parseInt(n, 10)) ?? [];
    if (nums.length >= 3) {
      const from = nums[0];
      const to = nums[nums.length - 1];
      return {
        season: from,
        episode: undefined,
        label: `S${pad(from)}-S${pad(to)} pack`,
        isBatch: true,
        isSeasonPack: true,
        isMultiSeason: true,
      };
    }
  }

  if (/\b(complete|batch|season\s*pack|seasons?\s*\d+\s*[-–]\s*\d+)\b/i.test(t)) {
    const seasonPack = t.match(/\bS(?:eason)?\s*(\d{1,3})\b/i);
    return {
      season: seasonPack ? parseInt(seasonPack[1], 10) : undefined,
      episode: undefined,
      label: seasonPack
        ? `S${pad(parseInt(seasonPack[1], 10))} pack`
        : "Batch",
      isBatch: true,
      isSeasonPack: true,
      isMultiSeason: false,
    };
  }

  // S01E05 / s1e5 / S023E01 (up to 3-digit season, 4-digit episode)
  const se = t.match(/\bS(\d{1,3})\s*E(\d{1,4})\b/i);
  if (se) {
    const season = parseInt(se[1], 10);
    const episode = parseInt(se[2], 10);
    return {
      season,
      episode,
      label: `S${pad(season)}E${pad(episode)}`,
      isBatch: false,
      isSeasonPack: false,
      isMultiSeason: false,
    };
  }

  // 1x05
  const x = t.match(/\b(\d{1,2})x(\d{1,4})\b/i);
  if (x) {
    const season = parseInt(x[1], 10);
    const episode = parseInt(x[2], 10);
    return {
      season,
      episode,
      label: `S${pad(season)}E${pad(episode)}`,
      isBatch: false,
      isSeasonPack: false,
      isMultiSeason: false,
    };
  }

  // Hybrid: EP1233 S23 / Ep 1233 Season 23 (absolute ep + season marker)
  const epThenS = t.match(
    /\b(?:episode|ep)\s*\.?\s*(\d{1,4})\b[\s._-]*\bS(?:eason)?\s*(\d{1,3})\b/i,
  );
  if (epThenS) {
    const episode = parseInt(epThenS[1], 10);
    const season = parseInt(epThenS[2], 10);
    return {
      season,
      episode,
      label: `S${pad(season)} Ep ${episode}`,
      isBatch: false,
      isSeasonPack: false,
      isMultiSeason: false,
    };
  }

  // Hybrid: S23 EP1233 / Season 23 Ep 05
  const sThenEp = t.match(
    /\bS(?:eason)?\s*(\d{1,3})\b[\s._-]*(?:episode|ep)\s*\.?\s*(\d{1,4})\b/i,
  );
  if (sThenEp) {
    const season = parseInt(sThenEp[1], 10);
    const episode = parseInt(sThenEp[2], 10);
    return {
      season,
      episode,
      label: `S${pad(season)} Ep ${episode}`,
      isBatch: false,
      isSeasonPack: false,
      isMultiSeason: false,
    };
  }

  // Episode 12 / Ep 12 / E12 / EP1170 (anime-style, up to 4 digits)
  // Prefer "EP"/"Ep"/"Episode" over bare "E" to avoid eating words; bare E still matched
  const ep = t.match(/\b(?:episode|ep|e)\s*\.?\s*(\d{1,4})\b/i);
  if (ep) {
    // Optional trailing/nearby season: "... EP1170 ... S23" already handled above;
    // also catch "E05 of Season 2" style when S appears elsewhere
    const looseSeason = t.match(/\bS(?:eason)?\s*(\d{1,3})\b/i);
    const episode = parseInt(ep[1], 10);
    if (looseSeason) {
      const season = parseInt(looseSeason[1], 10);
      return {
        season,
        episode,
        label: `S${pad(season)} Ep ${episode}`,
        isBatch: false,
        isSeasonPack: false,
        isMultiSeason: false,
      };
    }
    return {
      episode,
      label: `Ep ${episode}`,
      isBatch: false,
      isSeasonPack: false,
      isMultiSeason: false,
    };
  }

  // - 1170 [ or - 1170 ( common anime absolute numbering.
  // A container extension counts as the end of the title: "One Piece - 1170.mkv"
  // is the same numbering, and refusing it split one episode across groups.
  const dash = t.match(
    /[-–]\s*(\d{1,4})\s*(?:\.(?:mkv|mp4|avi|m4v|ts)\s*$|[[(]|$)/i,
  );
  if (dash) {
    const episode = parseInt(dash[1], 10);
    // Allow long-running shows (One Piece 1000+); reject pure years handled elsewhere
    if (episode > 0 && episode < 10000 && !(episode >= 1900 && episode <= 2100)) {
      // Nearby season marker: "One Piece - 1170 S23"
      const looseSeason = t.match(/\bS(?:eason)?\s*(\d{1,3})\b/i);
      if (looseSeason) {
        const season = parseInt(looseSeason[1], 10);
        return {
          season,
          episode,
          label: `S${pad(season)} Ep ${episode}`,
          isBatch: false,
          isSeasonPack: false,
          isMultiSeason: false,
        };
      }
      return {
        episode,
        label: `Ep ${episode}`,
        isBatch: false,
        isSeasonPack: false,
        isMultiSeason: false,
      };
    }
  }

  // Fansub absolute numbering with no separator: "[HatSubs] One Piece 1170 (WEB 1080p)".
  // Gated on the leading "[Group]" tag because that prefix is the anime release
  // convention; without it a bare number is far more likely to be part of the
  // title ("Blade Runner 2049", "Akira 1988"). Years are rejected regardless,
  // and a leading zero is required for 1-2 digit numbers so "[Group] Movie 4K"
  // style noise cannot become episode 4.
  if (/^\s*\[[^\]]+\]/.test(t)) {
    const afterTag = t.replace(/^\s*\[[^\]]+\]\s*/, "");
    const bare = afterTag.match(/\s(\d{3,4})(?=\s|$|[[(.])/);
    if (bare) {
      const episode = parseInt(bare[1], 10);
      if (episode > 0 && !(episode >= 1900 && episode <= 2100)) {
        const looseSeason = t.match(/\bS(?:eason)?\s*(\d{1,3})\b/i);
        if (looseSeason) {
          const season = parseInt(looseSeason[1], 10);
          return {
            season,
            episode,
            label: `S${pad(season)} Ep ${episode}`,
            isBatch: false,
            isSeasonPack: false,
            isMultiSeason: false,
          };
        }
        return {
          episode,
          label: `Ep ${episode}`,
          isBatch: false,
          isSeasonPack: false,
          isMultiSeason: false,
        };
      }
    }
  }

  // Standalone season: S23 / Season 23 / S023 (no episode).
  //
  // A season marker with no episode number IS a season pack — that is what a
  // season pack is called. Reporting it as a plain episode made the `Packs`
  // filter hide real packs, and stopped automation preferring one grab over
  // twelve. Everything ambiguous (absolute numbering, `Ep 12 S02`) has already
  // been matched by the branches above, so reaching here means "whole season".
  const seasonOnly = t.match(/\bS(\d{1,3})\b(?!\s*E\d)/i);
  if (seasonOnly) {
    const season = parseInt(seasonOnly[1], 10);
    return {
      season,
      episode: undefined,
      label: `S${pad(season)} pack`,
      isBatch: true,
      isSeasonPack: true,
      isMultiSeason: false,
    };
  }
  const seasonWord = t.match(/\b(?:Seasons?|Series)\s*(\d{1,3})\b/i);
  if (seasonWord) {
    const season = parseInt(seasonWord[1], 10);
    return {
      season,
      episode: undefined,
      label: `S${pad(season)} pack`,
      isBatch: true,
      isSeasonPack: true,
      isMultiSeason: false,
    };
  }

  return {
    label: null,
    isBatch: false,
    isSeasonPack: false,
    isMultiSeason: false,
  };
}

export function compareEpisodes(a: EpisodeInfo, b: EpisodeInfo): number {
  const sa = a.season ?? 0;
  const sb = b.season ?? 0;
  if (sa !== sb) return sa - sb;
  return (a.episode ?? 0) - (b.episode ?? 0);
}

/** Suggest next episode search string from last known episode label */
export function nextEpisodeQuery(title: string, lastEpisode?: string | null): string {
  if (!lastEpisode) return title;

  const se = lastEpisode.match(/S(\d{1,3})E(\d{1,4})/i);
  if (se) {
    const season = parseInt(se[1], 10);
    const episode = parseInt(se[2], 10) + 1;
    return `${title} S${pad(season)}E${pad(episode)}`;
  }

  const ep = lastEpisode.match(/Ep\s*(\d{1,4})/i);
  if (ep) {
    return `${title} ${parseInt(ep[1], 10) + 1}`;
  }

  return title;
}

/**
 * Season folder segment for paths, e.g. "Season 23".
 * - Known single season (episode or single-season pack) → "Season NN"
 * - Multi-season pack or unknown season → null (stay at show root)
 */
export function seasonFolderSegment(ep: EpisodeInfo): string | null {
  if (ep.season == null) return null;
  if (ep.isMultiSeason) return null;
  return `Season ${String(ep.season).padStart(2, "0")}`;
}

function pad(n: number) {
  return n.toString().padStart(2, "0");
}
