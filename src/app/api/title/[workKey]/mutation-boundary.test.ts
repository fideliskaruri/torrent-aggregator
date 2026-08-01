import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readTitleMutationBody } from "./route";
import {
  currentSourceIsBestResolution,
  currentSourceNoopResponse,
  readSelectMutationBody,
} from "../../stream/[infoHash]/select/route";
import { preRankKey } from "@/lib/prewarm/prerank";
import type { TorrentResult } from "@/lib/torrents/types";

function mutationRequest(
  contentType: string,
  site: "same-origin" | "cross-site",
): Request {
  return new Request("http://localhost/api/title/example", {
    method: "POST",
    headers: {
      "content-type": contentType,
      "sec-fetch-site": site,
    },
    body: "{}",
  });
}

async function checkMutationBoundary(
  name: string,
  read: (request: Request) => Promise<
    | { ok: true; value: unknown }
    | { ok: false; status: number; error: string }
  >,
) {
  const crossSiteText = await read(
    mutationRequest("text/plain", "cross-site"),
  );
  assert.equal(crossSiteText.ok, false, `${name} accepted a cross-site mutation`);
  if (!crossSiteText.ok) {
    assert.equal(crossSiteText.status, 403);
    assert.match(crossSiteText.error, /cross-site/i);
  }

  const sameOriginText = await read(
    mutationRequest("text/plain", "same-origin"),
  );
  assert.equal(sameOriginText.ok, false, `${name} accepted text/plain`);
  if (!sameOriginText.ok) {
    assert.equal(sameOriginText.status, 415);
    assert.match(sameOriginText.error, /application\/json/i);
  }

  const sameOriginJson = await read(
    mutationRequest("application/json", "same-origin"),
  );
  assert.equal(sameOriginJson.ok, true, `${name} rejected same-origin JSON`);
}

async function main() {
  await checkMutationBoundary("title acquisition", readTitleMutationBody);
  await checkMutationBoundary("resolution selection", readSelectMutationBody);

  const target = {
    title: "Solar Harbor",
    mediaType: "tv",
    season: 1,
    episode: 2,
  };
  assert.equal(
    preRankKey({ ...target, preferredResolution: 720 }),
    preRankKey({ ...target, preferredResolution: 2160 }),
    "resolution must not fork the stable work/episode watchdog key",
  );

  const selectSource = readFileSync(
    "src/app/api/stream/[infoHash]/select/route.ts",
    "utf8",
  );
  assert.match(selectSource, /updateSwarmWatchTarget\(contentKey, target\)/);
  assert.doesNotMatch(selectSource, /stopSwarmWatch\(/);

  const currentHash = "a".repeat(40);
  const releases: TorrentResult[] = [
    {
      id: "current",
      title: "The Bear S01E01 1080p WEB-DL",
      magnet: `magnet:?xt=urn:btih:${currentHash}`,
      infoHash: currentHash,
      sizeBytes: 900_000_000,
      seeders: 12,
      leechers: 0,
      source: "nyaa",
      sourceUrl: "https://example.invalid/current",
      tags: [],
    },
    {
      id: "fallback",
      title: "The Bear S01E01 720p WEB-DL",
      magnet: `magnet:?xt=urn:btih:${"b".repeat(40)}`,
      infoHash: "b".repeat(40),
      sizeBytes: 600_000_000,
      seeders: 20,
      leechers: 0,
      source: "nyaa",
      sourceUrl: "https://example.invalid/fallback",
      tags: [],
    },
  ];
  assert.equal(
    currentSourceIsBestResolution(releases, currentHash, 1080),
    true,
    "the current viable 1080p source is already the best 1080p match",
  );
  assert.equal(
    currentSourceIsBestResolution(releases, currentHash, 720),
    false,
    "a different best resolution must still enter automatic switching",
  );
  const noOp = currentSourceNoopResponse(currentHash, 1080);
  assert.equal(noOp.status, 200, "an already-best source is a successful no-op");
  assert.deepEqual(await noOp.json(), {
    ok: true,
    infoHash: currentHash,
    preferredResolution: 1080,
    noOp: true,
  });
  console.log("PASS title/select mutation boundaries and stable watchdog key");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
