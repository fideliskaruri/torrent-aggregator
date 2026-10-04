export type SeasonGrabStatus =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "done" }
  | { status: "error"; message: string };

export function seasonGrabKey(season: number): string {
  return `season-${season}`;
}

export function canOfferSeasonGrab(season: number | null): boolean {
  return season != null;
}
