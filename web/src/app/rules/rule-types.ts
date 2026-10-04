export interface Rule {
  id: string;
  name: string;
  query: string;
  category: string;
  minSeeders: number;
  maxSizeBytes: number | null;
  resolution: string | null;
  sources: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastMatchTitle: string | null;
  matchCount: number;
}

export const RULE_CATEGORIES = [
  { value: "all", label: "All video" },
  { value: "anime", label: "Anime" },
  { value: "movies", label: "Movies" },
  { value: "tv", label: "TV" },
] as const;

export const RULE_RESOLUTIONS = [
  { value: "__any", label: "Any resolution" },
  { value: "1080p", label: "1080p" },
  { value: "720p", label: "720p" },
  { value: "2160p", label: "2160p" },
] as const;

export type RuleCategory = (typeof RULE_CATEGORIES)[number]["value"];

export function normalizedCategory(category: string | null | undefined): RuleCategory {
  return RULE_CATEGORIES.some((option) => option.value === category)
    ? (category as RuleCategory)
    : "all";
}

export function isSupportedCategory(category: string | null | undefined): boolean {
  return RULE_CATEGORIES.some((option) => option.value === category);
}
