/**
 * qBittorrent add body must force flat content layout under our smart savepath.
 *
 * Without contentLayout=NoSubfolder + autoTMM=false, multi-file torrents nest:
 *   D:\Torrents\TV\Family Guy\Season 24\Family.Guy.S24E11.1080p\video.mkv
 * With the flags:
 *   D:\Torrents\TV\Family Guy\Season 24\video.mkv
 *
 * Run: npx tsx src/lib/clients/qbittorrent-add.test.ts
 */
import assert from "node:assert/strict";
import { buildQbittorrentAddBody } from "./qbittorrent";
import type { ClientConnectionConfig } from "./types";

const baseConfig: ClientConnectionConfig = {
  clientType: "qbittorrent",
  host: "http://127.0.0.1:8080",
  username: "admin",
  password: "adminadmin",
  categories: ["TV", "Anime", "Movies"],
  baseDownloadPath: "D:\\Torrents",
};

{
  const savePath = "D:\\Torrents\\TV\\Family Guy\\Season 24";
  const result = buildQbittorrentAddBody(baseConfig, {
    magnet: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
    category: "TV",
    savePath,
    name: "Family.Guy.S24E11.1080p.WEB.h264-playWEB",
    purpose: "keep",
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");

  const body = result.body;
  assert.equal(body.get("savepath"), savePath);
  assert.equal(
    body.get("contentLayout"),
    "NoSubfolder",
    "must set contentLayout=NoSubfolder so qBit does not add torrent-name dir",
  );
  assert.equal(
    body.get("autoTMM"),
    "false",
    "must disable autoTMM so smart savepath is not overridden",
  );
  assert.equal(body.get("category"), "TV");
  assert.ok(body.get("urls")?.startsWith("magnet:"));
}

// Path from resolveDownloadTarget (no explicit savePath) still gets layout flags
{
  const result = buildQbittorrentAddBody(
    {
      ...baseConfig,
      pathRules: {
        TV: "D:\\Torrents\\TV",
      },
    },
    {
      magnet: "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      category: "TV",
      purpose: "keep",
      // savePath omitted — resolveDownloadTarget uses pathRules[TV]
    },
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  // pathRules alone returns the category root (smart path is applied upstream)
  assert.equal(result.body.get("savepath"), "D:\\Torrents\\TV");
  assert.equal(result.body.get("contentLayout"), "NoSubfolder");
  assert.equal(result.body.get("autoTMM"), "false");
}

// No URL → error
{
  const result = buildQbittorrentAddBody(baseConfig, {
    category: "TV",
    savePath: "D:\\Torrents\\TV",
    purpose: "keep",
  });
  assert.equal(result.ok, false);
}

// No savepath → layout flags omitted (qBit default path / TMM ok)
{
  const result = buildQbittorrentAddBody(
    {
      clientType: "qbittorrent",
      host: "http://127.0.0.1:8080",
    },
    {
      magnet: "magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      purpose: "keep",
    },
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.body.get("savepath"), null);
  assert.equal(result.body.get("contentLayout"), null);
  assert.equal(result.body.get("autoTMM"), null);
}

console.log("qbittorrent-add.test.ts: all assertions passed");
