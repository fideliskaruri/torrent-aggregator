import assert from "node:assert/strict";
import { grabForTitle, SERIES_TITLE_SCOPE_MESSAGE } from "./grab";

async function main() {
  let wholeWorkCalls = 0;

  const filmResult = await grabForTitle(
    {
      userId: "user-1",
      workKey: "dune-2021",
      resolvedTitle: "Dune",
      resolvedYear: 2021,
      resolvedMediaType: "movie",
      resolvedAliases: [],
      isSeries: false,
      watchListItemId: null,
      season: null,
      episode: null,
      retention: "keep",
      overrideStorageCap: false,
      preferredResolution: 1080,
    },
    {
      grabWholeWork: async (input) => {
        wholeWorkCalls += 1;
        assert.equal(input.isSeries, false);
        return {
          ok: true,
          message: "sent",
          title: "Dune 2021 1080p WEB-DL",
          savePath: "/media/Dune",
          infoHash: "hash-1",
          storage: null,
        };
      },
    },
  );

  assert.equal(wholeWorkCalls, 1);
  assert.deepEqual(filmResult, {
    ok: true,
    message: "sent",
    title: "Dune 2021 1080p WEB-DL",
    savePath: "/media/Dune",
    infoHash: "hash-1",
    storage: null,
  });

  let reuseCalls = 0;
  let rejectedWholeWorkCalls = 0;
  const seriesResult = await grabForTitle(
    {
      userId: "user-1",
      workKey: "bear-2022",
      resolvedTitle: "The Bear",
      resolvedYear: 2022,
      resolvedMediaType: "tv",
      resolvedAliases: [],
      isSeries: true,
      watchListItemId: null,
      season: null,
      episode: null,
      retention: "keep",
      overrideStorageCap: false,
      preferredResolution: 1080,
    },
    {
      reuseStreamingEpisode: async () => {
        reuseCalls += 1;
        throw new Error("reuseStreamingEpisode should not run for title scope");
      },
      grabWholeWork: async () => {
        rejectedWholeWorkCalls += 1;
        throw new Error("grabWholeWork should not run for series title scope");
      },
    },
  );

  assert.equal(reuseCalls, 0);
  assert.equal(rejectedWholeWorkCalls, 0);
  assert.deepEqual(seriesResult, {
    ok: false,
    message: SERIES_TITLE_SCOPE_MESSAGE,
  });
  console.log("PASS title grab defends title-scope series and keeps film whole-work");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
