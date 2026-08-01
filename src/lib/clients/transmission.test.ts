import assert from "node:assert/strict";
import {
  TransmissionClient,
  buildTransmissionAddArguments,
  buildTransmissionRpcRequest,
  type TransmissionFetch,
} from "./transmission";
import type { ClientConnectionConfig } from "./types";

const config: ClientConnectionConfig = {
  clientType: "transmission",
  host: "http://127.0.0.1:9091/",
  username: "alice",
  password: "secret",
  category: "TV",
  savePath: "D:\\Downloads",
};

const request = buildTransmissionRpcRequest(
  config,
  "torrent-stop",
  { ids: ["abc"] },
  "session-1",
);
assert.equal(request.url, "http://127.0.0.1:9091/transmission/rpc");
const headers = new Headers(request.init.headers);
assert.equal(
  headers.get("Authorization"),
  `Basic ${Buffer.from("alice:secret").toString("base64")}`,
);
assert.equal(headers.get("X-Transmission-Session-Id"), "session-1");
assert.deepEqual(JSON.parse(String(request.init.body)), {
  method: "torrent-stop",
  arguments: { ids: ["abc"] },
});

const add = buildTransmissionAddArguments(config, {
  magnet: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
  category: "Anime",
  savePath: "D:\\Downloads\\Anime",
  purpose: "keep",
});
assert.equal(add.ok, true);
if (!add.ok) throw new Error("unreachable");
assert.deepEqual(add.args, {
  filename: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
  "download-dir": "D:\\Downloads\\Anime",
  labels: ["Anime"],
});
assert.equal(
  buildTransmissionAddArguments(config, { purpose: "keep" }).ok,
  false,
);

async function main() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    new Response("", {
      status: 409,
      headers: { "X-Transmission-Session-Id": "fresh-session" },
    }),
    Response.json({ result: "success", arguments: {} }),
    Response.json({
      result: "success",
      arguments: {
        torrents: [
          {
            hashString: "abc",
            name: "Show",
            percentDone: 0.5,
            totalSize: 1000,
            rateDownload: 200,
            rateUpload: 10,
            status: 4,
            eta: 30,
            labels: ["TV"],
            downloadDir: "D:\\Downloads\\TV",
          },
          { malformed: true },
        ],
      },
    }),
  ];
  const fetchFn: TransmissionFetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  };
  const client = new TransmissionClient(fetchFn);
  const added = await client.addTorrent(config, {
    torrentUrl: "https://example.invalid/show.torrent",
    purpose: "keep",
  });
  assert.equal(added.ok, true);
  assert.equal(calls.length, 2, "409 handshake retries exactly once");
  assert.equal(
    new Headers(calls[1].init?.headers).get("X-Transmission-Session-Id"),
    "fresh-session",
  );

  const torrents = await client.listTorrents(config);
  assert.deepEqual(torrents, [
    {
      hash: "abc",
      name: "Show",
      progress: 0.5,
      sizeBytes: 1000,
      dlspeed: 200,
      upspeed: 10,
      state: "downloading",
      eta: 30,
      category: "TV",
      savePath: "D:\\Downloads\\TV",
    },
  ]);

  const repeatedConflict = new TransmissionClient(async () =>
    new Response("", {
      status: 409,
      headers: { "X-Transmission-Session-Id": "still-bad" },
    }),
  );
  const failed = await repeatedConflict.addTorrent(config, {
    torrentUrl: "https://example.invalid/show.torrent",
    purpose: "keep",
  });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /rejected the refreshed session/);

  console.log("transmission.test.ts: all assertions passed");
}

void main();
