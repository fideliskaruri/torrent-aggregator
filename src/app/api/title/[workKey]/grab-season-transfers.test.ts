import assert from "node:assert/strict";

import { exactSeasonEpisodeTransfers, fanOutSeasonEpisodes } from "./grab";

const transfers = exactSeasonEpisodeTransfers(
  [1, 2, 3],
  [
    {
      kind: "single",
      episode: 1,
      status: "sent",
      message: "queued",
      infoHash: "hash-1",
    },
    {
      kind: "single",
      episode: 2,
      status: "failed",
      message: "No peers",
      infoHash: "hash-2",
    },
    {
      kind: "pack",
      status: "sent",
      message: "queued",
      infoHash: "pack-hash",
    },
  ],
  new Map([[2, "No peers"]]),
  null,
  null,
);

assert.deepEqual(transfers, [
  {
    episode: 1,
    status: "downloading",
    infoHash: "hash-1",
    error: null,
  },
  {
    episode: 2,
    status: "failed",
    infoHash: null,
    error: "No peers",
  },
  {
    episode: 3,
    status: "failed",
    infoHash: null,
    error: "No exact episode release was found.",
  },
]);

void (async () => {
  const attempted: number[] = [];
  const fanout = await fanOutSeasonEpisodes(
    [1, 2, 3],
    async (episode) => {
      attempted.push(episode);
      if (episode === 2) throw new Error("provider refused episode 2");
      return {
        ok: true,
        message: "queued",
        infoHash: `hash-${episode}`,
      };
    },
  );

  assert.deepEqual(attempted, [1, 2, 3]);
  assert.deepEqual(fanout.coveredEpisodes, [1, 3]);
  assert.deepEqual(fanout.transfers, [
    {
      episode: 1,
      status: "downloading",
      infoHash: "hash-1",
      error: null,
    },
    {
      episode: 2,
      status: "failed",
      infoHash: null,
      error: "provider refused episode 2",
    },
    {
      episode: 3,
      status: "downloading",
      infoHash: "hash-3",
      error: null,
    },
  ]);

  console.log("PASS season grab reports one exact transfer outcome per episode");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
