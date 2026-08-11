import type { AcquisitionWorkRow } from "@/lib/work/store";

export function acquisitionIntentByHash(
  targets: readonly AcquisitionWorkRow[],
): Map<string, AcquisitionWorkRow> {
  const grouped = new Map<string, AcquisitionWorkRow[]>();
  for (const target of targets) {
    const hash = target.infoHash?.trim().toLowerCase();
    if (!hash) continue;
    const rows = grouped.get(hash);
    if (rows) rows.push(target);
    else grouped.set(hash, [target]);
  }

  return new Map(
    [...grouped].map(([hash, rows]) => {
      const nonEpisode = rows.find((row) => row.scope !== "episode");
      if (nonEpisode) return [hash, nonEpisode];

      const first = rows[0];
      const seasons = new Set(rows.map((row) => row.season));
      const episodes = new Set(rows.map((row) => row.episode));
      if (seasons.size === 1 && episodes.size === 1) return [hash, first];

      return [
        hash,
        {
          ...first,
          scope: "season",
          season: seasons.size === 1 ? first.season : null,
          episode: null,
        },
      ];
    }),
  );
}
