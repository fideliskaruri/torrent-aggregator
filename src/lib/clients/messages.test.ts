import assert from "node:assert/strict";

import { formatAddTorrentMessage } from "./messages";
import type { AddTorrentResult } from "./types";

const cases: Array<{
  name: string;
  result: AddTorrentResult;
  expected: string;
}> = [
  {
    name: "new transfer with one peer uses singular copy",
    result: {
      ok: true,
      message: "",
      details: {
        type: "builtin-transfer",
        action: "started",
        pct: 12,
        peers: 1,
      },
    },
    expected: "Download started (12% · 1 peer)",
  },
  {
    name: "existing transfer with many peers uses plural copy",
    result: {
      ok: true,
      message: "",
      details: {
        type: "builtin-transfer",
        action: "already_downloading",
        pct: 40,
        peers: 2,
      },
    },
    expected: "Download already in progress (40% · 2 peers)",
  },
  {
    name: "complete transfer does not expose peer or path details",
    result: {
      ok: true,
      message: "",
      details: {
        type: "builtin-transfer",
        action: "already_complete",
        pct: 100,
        peers: 99,
      },
    },
    expected: "Already complete (100%)",
  },
  {
    name: "external client messages pass through",
    result: { ok: true, message: "Added to qBittorrent" },
    expected: "Added to qBittorrent",
  },
];

for (const tc of cases) {
  const actual = formatAddTorrentMessage(tc.result);
  assert.equal(actual, tc.expected, tc.name);
  assert.ok(!/[A-Z]:\\/.test(actual), `${tc.name}: user copy must not expose Windows paths`);
}

console.log("messages.test.ts: all assertions passed");
