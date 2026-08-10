import assert from "node:assert/strict";
import type { ClientConnectionConfig } from "./types";
import type { ClientTorrent } from "@/lib/torrents/types";
import {
  aggregateOwnedTorrents,
  configuredClientSources,
  inspectOtherOwners,
  mergeOwnedTransferSnapshots,
  otherOwnerState,
  ownedTransferState,
  retainedExternalClientType,
  transferStoragePathsOverlap,
  verifyOwnedTransfer,
} from "./transfer-ownership";

const base: ClientConnectionConfig = {
  clientType: "builtin",
  externalClientType: "qbittorrent",
  host: "http://127.0.0.1:8080",
  userId: "user-1",
};

function row(hash: string, name = hash): ClientTorrent {
  return {
    hash,
    name,
    progress: 0.5,
    sizeBytes: 100,
    dlspeed: 1,
    upspeed: 0,
    state: "downloading",
  };
}

let failures = 0;
async function check(name: string, run: () => void | Promise<void>) {
  try {
    await run();
    console.log(`  PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(error);
  }
}

console.log("\nClient transfer ownership");

async function main() {
await check("preference changes dispatch, not the configured source set", () => {
  assert.deepEqual(
    configuredClientSources(base).map((source) => source.clientType),
    ["builtin", "qbittorrent"],
  );
  assert.deepEqual(
    configuredClientSources({
      ...base,
      clientType: "qbittorrent",
      externalClientType: "qbittorrent",
    }).map((source) => source.clientType),
    ["builtin", "qbittorrent"],
  );
});

await check("same hash in two clients remains two owned rows", async () => {
  const snapshot = await aggregateOwnedTorrents(base, async (config) => {
    if (config.clientType === "builtin") {
      return [row("ABC", "built-in copy"), row("abc", "duplicate adapter row")];
    }
    return [row("abc", "external copy")];
  });
  assert.deepEqual(
    snapshot.torrents.map((torrent) => torrent.transferId).sort(),
    ["builtin:abc", "qbittorrent:abc"],
  );
  assert.equal(
    snapshot.torrents.find((torrent) => torrent.ownerClientType === "builtin")
      ?.name,
    "duplicate adapter row",
    "duplicates from one owner are deduped without hiding another owner",
  );
});

await check("an unavailable secondary does not hide built-in transfers", async () => {
  const snapshot = await aggregateOwnedTorrents(base, async (config) => {
    if (config.clientType === "qbittorrent") throw new Error("ECONNREFUSED");
    return [row("built")];
  });
  assert.deepEqual(
    snapshot.torrents.map((torrent) => torrent.transferId),
    ["builtin:built"],
  );
  assert.deepEqual(
    snapshot.issues.map((issue) => issue.clientType),
    ["qbittorrent"],
  );
});

await check("partial polls retain only the unavailable owner's last rows", () => {
  const previous = [
    {
      ...row("old-built"),
      ownerClientType: "builtin" as const,
      ownerClientLabel: "Built-in",
      transferId: "builtin:old-built",
    },
    {
      ...row("external"),
      ownerClientType: "qbittorrent" as const,
      ownerClientLabel: "qBittorrent",
      transferId: "qbittorrent:external",
    },
  ];
  const fresh = [
    {
      ...row("new-built"),
      ownerClientType: "builtin" as const,
      ownerClientLabel: "Built-in",
      transferId: "builtin:new-built",
    },
  ];
  assert.deepEqual(
    mergeOwnedTransferSnapshots(previous, fresh, ["qbittorrent"])
      .map((torrent) => torrent.transferId)
      .sort(),
    ["builtin:new-built", "qbittorrent:external"],
  );
});

await check("actions resolve and verify the row's owner, not the preference", async () => {
  const calls: string[] = [];
  const verified = await verifyOwnedTransfer(
    { ...base, clientType: "qbittorrent" },
    "builtin",
    "AA",
    async (config) => {
      calls.push(config.clientType);
      return config.clientType === "builtin" ? [row("aa")] : [];
    },
  );
  assert.equal(verified?.config.clientType, "builtin");
  assert.equal(verified?.torrent.transferId, "builtin:aa");
  assert.deepEqual(calls, ["builtin"]);
});

await check("unknown hashes are rejected before a remote delete can run", async () => {
  const verified = await verifyOwnedTransfer(
    base,
    "qbittorrent",
    "missing",
    async () => [row("known")],
  );
  assert.equal(verified, null);
});

await check("remote success is not trusted until the owner no longer lists the hash", async () => {
  assert.equal(
    await ownedTransferState(base, "qbittorrent", "known", async () => [
      row("known"),
    ]),
    "present",
  );
  assert.equal(
    await ownedTransferState(base, "qbittorrent", "known", async () => []),
    "absent",
  );
  assert.equal(
    await ownedTransferState(base, "qbittorrent", "known", async () => {
      throw new Error("unavailable during verification");
    }),
    "unknown",
  );
});

await check("same-hash ownership prevents local record cleanup", async () => {
  assert.equal(
    await otherOwnerState(base, "qbittorrent", "same", async (config) =>
      config.clientType === "builtin" ? [row("SAME")] : [],
    ),
    "present",
  );
  assert.equal(
    await otherOwnerState(base, "qbittorrent", "same", async () => {
      throw new Error("could not verify");
    }),
    "unknown",
  );
});

await check("file deletion detects shared paths and unverifiable owners", async () => {
  const shared = await inspectOtherOwners(
    base,
    "builtin",
    "same",
    async (config) =>
      config.clientType === "qbittorrent"
        ? [{ ...row("SAME"), savePath: "D:\\Media\\Show" }]
        : [],
  );
  assert.equal(shared.unknown, false);
  assert.equal(shared.torrents.length, 1);
  assert.equal(
    transferStoragePathsOverlap(
      "D:\\Media\\Show",
      "d:/media/show/Season 01",
    ),
    true,
  );
  assert.equal(
    transferStoragePathsOverlap("D:\\Media\\Show", "E:\\Media\\Show"),
    false,
  );
  assert.equal(transferStoragePathsOverlap(undefined, "E:\\Media\\Show"), true);

  const unavailable = await inspectOtherOwners(
    base,
    "builtin",
    "same",
    async () => {
      throw new Error("client unavailable");
    },
  );
  assert.equal(unavailable.unknown, true);
});

await check("external configuration survives while external is preferred", () => {
  assert.equal(retainedExternalClientType("qbittorrent", null, null), "qbittorrent");
  assert.equal(
    retainedExternalClientType("builtin", undefined, "transmission"),
    "transmission",
  );
});

if (failures) {
  console.error(`\n${failures} transfer ownership test(s) failed`);
  process.exit(1);
}
console.log("\nPASS client transfer ownership");
}

void main();
