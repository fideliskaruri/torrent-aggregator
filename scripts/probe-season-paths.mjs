import {
  resolveSmartPath,
  showFolderName,
} from "../src/lib/download/smart-category.ts";
import {
  parseEpisode,
  seasonFolderSegment,
} from "../src/lib/torrents/episodes.ts";

const titles = [
  "Family Guy S24E11 Tall Stewie 1080p",
  "Family Guy S09E01 1080p",
  "Family Guy Season 9 S09 [1080p Web x265]",
  "Family Guy S9E05",
  "Family Guy Season 09 Episode 03",
  "Family.Guy.S09E12.720p",
  "Family Guy Season 9 Complete",
];

for (const t of titles) {
  const ep = parseEpisode(t);
  const seg = seasonFolderSegment(ep);
  const path = resolveSmartPath("D:\\Torrents", "tv", "TV", {
    title: t,
    separator: "\\",
  });
  console.log(
    JSON.stringify({
      t: t.slice(0, 60),
      season: ep.season ?? null,
      episode: ep.episode ?? null,
      pack: ep.isSeasonPack,
      multi: ep.isMultiSeason,
      seg,
      show: showFolderName(t),
      path,
    }),
  );
}
