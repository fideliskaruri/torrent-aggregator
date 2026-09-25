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

  // A single slow episode used to stall the whole season: the old fan-out
  // awaited each episode in turn, so episode 1 taking seconds meant episode 8
  // had not even been searched yet. With the bounded pool the later episodes
  // finish while the slow one is still running, and the response order is
  // still strictly by episode.
  let slowFinishedAt = -1;
  let finishOrder = 0;
  const finishedBeforeSlow: number[] = [];
  const started = Date.now();
  const pooled = await fanOutSeasonEpisodes(
    [1, 2, 3, 4, 5, 6],
    async (episode) => {
      if (episode === 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        slowFinishedAt = finishOrder++;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (slowFinishedAt < 0) finishedBeforeSlow.push(episode);
        finishOrder++;
      }
      return { ok: true, message: "queued", infoHash: `hash-${episode}` };
    },
  );
  const elapsed = Date.now() - started;

  assert.ok(
    finishedBeforeSlow.length >= 3,
    `expected several episodes to finish while episode 1 was still slow, got ${finishedBeforeSlow.join(",")}`,
  );
  assert.ok(
    elapsed < 900,
    `pool should not serialise the season, took ${elapsed}ms`,
  );
  assert.deepEqual(
    pooled.transfers.map((t) => t.episode),
    [1, 2, 3, 4, 5, 6],
    "transfers stay in episode order regardless of completion order",
  );
  assert.deepEqual(pooled.coveredEpisodes, [1, 2, 3, 4, 5, 6]);

  // Queued episodes are a success: they are covered, not failed.
  const queued = await fanOutSeasonEpisodes([1, 2], async (episode) => ({
    ok: true,
    message: "Queued",
    infoHash: `hash-${episode}`,
    queued: episode === 2,
  }));
  assert.deepEqual(
    queued.transfers.map((t) => t.status),
    ["downloading", "queued"],
  );
  assert.deepEqual(queued.coveredEpisodes, [1, 2]);

  console.log("PASS season fan-out pool does not block on a slow episode");
  // Searches run in the pool, but sends commit in episode order: E3/E4 with
  // fast searches must not reach the engine before E1/E2.
  const sendOrder: number[] = [];
  const searchMs: Record<number, number> = { 1: 60, 2: 40, 3: 5, 4: 5 };
  const ordered = await fanOutSeasonEpisodes(
    [1, 2, 3, 4],
    async (episode, hooks) => {
      await new Promise((r) => setTimeout(r, searchMs[episode]));
      await hooks.beforeSend();
      sendOrder.push(episode);
      return {
        ok: true,
        message: "ok",
        infoHash: `hash-${episode}`,
        queued: episode > 2,
      };
    },
    { concurrency: 4, orderWaitMs: 5_000, sendHoldMs: 5_000 },
  );
  assert.deepEqual(sendOrder, [1, 2, 3, 4], "sends commit in episode order");
  assert.deepEqual(
    ordered.transfers.map((t) => [t.episode, t.status]),
    [
      [1, "downloading"],
      [2, "downloading"],
      [3, "queued"],
      [4, "queued"],
    ],
  );

  // An earlier episode that fails its search releases later ones at once; one
  // that hangs is passed after `orderWaitMs`.
  const sends2: number[] = [];
  const t0 = Date.now();
  const skipping = await fanOutSeasonEpisodes(
    [1, 2, 3],
    async (episode, hooks) => {
      if (episode === 1) throw new Error("no release");
      if (episode === 2) {
        await new Promise((r) => setTimeout(r, 400));
        return { ok: false, message: "slow and dead" };
      }
      await hooks.beforeSend();
      sends2.push(episode);
      return { ok: true, message: "ok", infoHash: "h3" };
    },
    { concurrency: 4, orderWaitMs: 50, sendHoldMs: 5_000 },
  );
  assert.deepEqual(sends2, [3]);
  assert.ok(Date.now() - t0 < 1_000);
  assert.deepEqual(
    skipping.transfers.map((t) => t.status),
    ["failed", "failed", "downloading"],
  );
  console.log("PASS season fan-out commits sends in episode order");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
