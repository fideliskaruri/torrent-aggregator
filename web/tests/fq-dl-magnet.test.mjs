import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { readFileSync } from "node:fs";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  resolve: { alias: { "@": path.resolve("src") } },
  server: { middlewareMode: true, watch: null, hmr: false, ws: false },
});
after(async () => {
  await server.close();
});

const {
  isValidTorrentSourceInput,
  parseTorrentSourceInput,
  TORRENT_SOURCE_INPUT_HINT,
} = await server.ssrLoadModule("/src/lib/torrents/magnet-input.ts");

const pageSrc = readFileSync(new URL("../src/app/downloads/page.tsx", import.meta.url), "utf8");

const HEX40 = "0123456789abcdef0123456789abcdef01234567";
const HEX40_UP = HEX40.toUpperCase();
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // 32 chars

test("rejects empty and garbage", () => {
  assert.equal(isValidTorrentSourceInput(""), false);
  assert.equal(isValidTorrentSourceInput("   "), false);
  assert.equal(isValidTorrentSourceInput(null), false);
  assert.equal(isValidTorrentSourceInput(undefined), false);
  assert.equal(isValidTorrentSourceInput("not-a-magnet"), false);
  assert.equal(isValidTorrentSourceInput("magnet:?dn=only"), false);
  assert.equal(isValidTorrentSourceInput("magnet:?xt=urn:btih:short"), false);
  assert.equal(isValidTorrentSourceInput("ftp://x/a.torrent"), false);
  assert.equal(isValidTorrentSourceInput("https://example.com/file.mkv"), false);
});

test("accepts hex40, uppercase, base32 magnets and whitespace", () => {
  assert.equal(isValidTorrentSourceInput(`magnet:?xt=urn:btih:${HEX40}`), true);
  assert.equal(isValidTorrentSourceInput(`  magnet:?xt=urn:btih:${HEX40}  `), true);
  assert.equal(isValidTorrentSourceInput(`magnet:?xt=urn:btih:${HEX40_UP}&dn=X`), true);
  assert.equal(isValidTorrentSourceInput(`magnet:?xt=urn:btih:${BASE32}`), true);
  assert.equal(
    isValidTorrentSourceInput(`magnet:?xt=urn:btmh:1220aabbccddeeff0011`),
    true,
  );
});

test("accepts http(s) .torrent URLs", () => {
  assert.equal(isValidTorrentSourceInput("https://cdn.example/a.torrent"), true);
  assert.equal(isValidTorrentSourceInput("http://cdn.example/path/file.torrent?x=1"), true);
  assert.equal(isValidTorrentSourceInput("HTTPS://CDN.EXAMPLE/A.TORRENT"), true);
});

test("parseTorrentSourceInput returns payload or null", () => {
  assert.equal(parseTorrentSourceInput("not-a-magnet"), null);
  assert.deepEqual(parseTorrentSourceInput(`magnet:?xt=urn:btih:${HEX40}`), {
    magnet: `magnet:?xt=urn:btih:${HEX40}`,
  });
  const withName = parseTorrentSourceInput(
    `magnet:?xt=urn:btih:${HEX40}&dn=My%20Show`,
  );
  assert.equal(withName?.magnet, `magnet:?xt=urn:btih:${HEX40}&dn=My%20Show`);
  assert.equal(withName?.name, "My Show");
  assert.deepEqual(parseTorrentSourceInput("https://x.test/a.torrent"), {
    torrentUrl: "https://x.test/a.torrent",
    name: "a",
  });
});

test("downloads form disables Add on invalid input and shows hint", () => {
  assert.match(pageSrc, /isValidTorrentSourceInput/);
  assert.match(pageSrc, /parseTorrentSourceInput/);
  assert.match(pageSrc, /TORRENT_SOURCE_INPUT_HINT/);
  assert.match(pageSrc, /rawSendInvalid/);
  assert.match(pageSrc, /data-raw-torrent-invalid/);
  assert.match(pageSrc, /disabled=\{sendingRaw \|\| !rawSendTrimmed \|\| rawSendInvalid\}/);
  assert.equal(
    typeof TORRENT_SOURCE_INPUT_HINT,
    "string",
  );
  assert.match(TORRENT_SOURCE_INPUT_HINT, /magnet:\?xt=urn:btih/);
});
