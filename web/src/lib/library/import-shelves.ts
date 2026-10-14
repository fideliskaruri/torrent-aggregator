import type { ImportCandidate, ImportItem } from "./import";

export type ImportStatus = "ready" | "needsPick" | "unmatched" | "owned";
export type ImportPick = { workId: string; episodeId: string | null } | null;

export interface ShelfSeason {
  /** null holds files with no season: a film, or an episode the name gave no season for. */
  number: number | null;
  items: ImportItem[];
}

/** Every file a scan found for one title, so a series shows once instead of once per episode. */
export interface ImportShelf {
  key: string;
  title: string;
  year: number | null;
  kind: "Film" | "Series" | "Unknown";
  posterUrl: string | null;
  items: ImportItem[];
  seasons: ShelfSeason[];
  counts: Record<ImportStatus, number>;
}

export function importStatus(item: ImportItem): ImportStatus {
  if (item.alreadyInLibrary) return "owned";
  if (item.group === "Confident") return "ready";
  if (item.group === "NeedsPick" && pickable(item).length > 0) return "needsPick";
  return "unmatched";
}

/** Candidates a file can be imported as: a film, or one exact episode. */
export function pickable(item: ImportItem): ImportCandidate[] {
  return item.candidates.filter((candidate) => candidate.kind === "Film" || candidate.episodeId);
}

export function topPick(item: ImportItem): ImportPick {
  const candidate = pickable(item)[0];
  return candidate ? { workId: candidate.workId, episodeId: candidate.episodeId } : null;
}

export function defaultPicks(items: ImportItem[]): Record<string, ImportPick> {
  return Object.fromEntries(items.map((item) => [item.id, importStatus(item) === "ready" ? topPick(item) : null]));
}

/** The candidate a file is shown under: its current pick, else the catalog's best guess. */
export function shownCandidate(item: ImportItem, pick: ImportPick): ImportCandidate | null {
  if (pick) {
    const picked = item.candidates.find((c) => c.workId === pick.workId && c.episodeId === pick.episodeId);
    if (picked) return picked;
  }
  return item.candidates[0] ?? null;
}

/** "S01E03", "E12", or null when the file has no episode number. */
export function episodeCode(item: ImportItem, pick: ImportPick): string | null {
  const candidate = shownCandidate(item, pick);
  const season = candidate?.episodeId ? candidate.season : seasonFromName(item);
  const episode = candidate?.episodeId ? candidate.episode : item.parsed?.episodes[0] ?? null;
  if (episode == null) return null;
  const e = `E${String(episode).padStart(2, "0")}`;
  return season == null ? e : `S${String(season).padStart(2, "0")}${e}`;
}

function seasonFromName(item: ImportItem): number | null {
  const fromFile = item.parsed?.seasons[0];
  if (fromFile != null) return fromFile;
  return item.parents?.find((parent) => parent.seasons.length > 0)?.seasons[0] ?? null;
}

/** The name the file or its folders gave, for files the catalog did not recognise. */
function nameFromFiles(item: ImportItem): { title: string; year: number | null } {
  const named = [item.parsed, ...(item.parents ?? [])].find((p) => p?.title.trim());
  if (named) return { title: tidy(named.title), year: named.year };
  const file = item.path.split(/[\\/]/).pop() ?? item.path;
  return { title: file.replace(/\.[^.]+$/, ""), year: null };
}

function tidy(title: string): string {
  return title.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
}

const STATUS_ORDER: ImportStatus[] = ["needsPick", "ready", "unmatched", "owned"];

/** The status a whole shelf is filed under: the one that most needs the owner. */
export function shelfStatus(shelf: ImportShelf): ImportStatus {
  return STATUS_ORDER.find((status) => shelf.counts[status] > 0) ?? "owned";
}

/**
 * Groups scanned files by title. Recognised files group by the catalog title
 * they match (or were picked as); the rest group by the name the parser read,
 * so a folder of one unknown show still reads as one show.
 */
export function buildShelves(items: ImportItem[]): ImportShelf[] {
  const shelves = new Map<string, ImportShelf>();
  for (const item of items) {
    const candidate = item.candidates[0] ?? null;
    const fallback = nameFromFiles(item);
    const key = candidate ? `work:${candidate.workId}` : `name:${fallback.title.toLowerCase()}:${fallback.year ?? ""}`;
    let shelf = shelves.get(key);
    if (!shelf) {
      shelf = {
        key,
        title: candidate?.title ?? fallback.title,
        year: candidate ? candidate.year : fallback.year,
        kind: candidate?.kind ?? (item.parsed?.episodes.length ? "Series" : "Unknown"),
        posterUrl: candidate?.posterUrl ?? null,
        items: [],
        seasons: [],
        counts: { ready: 0, needsPick: 0, unmatched: 0, owned: 0 },
      };
      shelves.set(key, shelf);
    }
    shelf.items.push(item);
    shelf.counts[importStatus(item)] += 1;
    shelf.posterUrl ??= candidate?.posterUrl ?? null;
  }

  for (const shelf of shelves.values()) {
    const bySeason = new Map<number | null, ImportItem[]>();
    for (const item of shelf.items) {
      const candidate = item.candidates[0] ?? null;
      const season = shelf.kind === "Film" ? null : candidate?.episodeId ? candidate.season : seasonFromName(item);
      bySeason.set(season, [...(bySeason.get(season) ?? []), item]);
    }
    shelf.seasons = [...bySeason.entries()]
      .sort(([a], [b]) => (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER))
      .map(([number, seasonItems]) => ({
        number,
        items: seasonItems.sort((a, b) => episodeSort(a) - episodeSort(b) || a.path.localeCompare(b.path)),
      }));
  }

  return [...shelves.values()].sort(
    (a, b) =>
      STATUS_ORDER.indexOf(shelfStatus(a)) - STATUS_ORDER.indexOf(shelfStatus(b)) ||
      a.title.localeCompare(b.title),
  );
}

function episodeSort(item: ImportItem): number {
  const candidate = item.candidates[0];
  return (candidate?.episodeId ? candidate.episode : item.parsed?.episodes[0]) ?? Number.MAX_SAFE_INTEGER;
}

/** "12 episodes, seasons 1 to 3", "1 file", "8 episodes, season 2". */
export function shelfSummary(shelf: ImportShelf): string {
  const files = shelf.items.length;
  if (shelf.kind === "Film") return files === 1 ? "Film" : `Film, ${files} files`;
  const numbers = shelf.seasons.map((s) => s.number).filter((n): n is number => n != null);
  const noun = shelf.kind === "Series" ? (files === 1 ? "episode" : "episodes") : files === 1 ? "file" : "files";
  if (numbers.length === 0) return `${files} ${noun}`;
  const span =
    numbers.length === 1
      ? `season ${numbers[0]}`
      : isRun(numbers)
        ? `seasons ${numbers[0]} to ${numbers[numbers.length - 1]}`
        : `seasons ${numbers.join(", ")}`;
  return `${files} ${noun}, ${span}`;
}

function isRun(numbers: number[]): boolean {
  return numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1);
}
