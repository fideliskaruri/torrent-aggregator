/**
 * The rules in `snapshot-sync.ts`: a failed poll must not look like a
 * deletion, an older response must not overwrite a newer one, and select-all
 * must reflect the rows the user can actually see.
 *
 * Run: npx tsx src/app/downloads/snapshot-sync.test.ts
 */
import assert from "node:assert/strict";
import {
  applySnapshot,
  areAllVisibleSelected,
  emptySnapshotState,
  shouldApplySnapshot,
  shouldCloseMissingGroup,
  toggleVisibleSelection,
  type SnapshotState,
} from "./snapshot-sync";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL  ${name}`);
    console.error(`      ${(error as Error).message}`);
  }
}

type Row = { hash: string };

const good: SnapshotState<Row> = {
  torrents: [{ hash: "a" }, { hash: "b" }],
  error: null,
  offline: false,
  authoritative: true,
};

console.log("\ndownloads snapshot sync");

check("given a successful read, when applied, then it replaces rows and clears the error", () => {
  const next = applySnapshot<Row>(
    { ...good, error: "boom", authoritative: false },
    { ok: true, torrents: [{ hash: "c" }] },
  );
  assert.deepEqual(next.torrents, [{ hash: "c" }]);
  assert.equal(next.error, null);
  assert.equal(next.offline, false);
  assert.equal(next.authoritative, true);
});

check("given a network failure, when applied, then the last good rows are preserved", () => {
  const next = applySnapshot<Row>(good, { ok: false, error: "Failed to fetch" });
  assert.deepEqual(next.torrents, good.torrents);
  assert.equal(next.error, "Failed to fetch");
  assert.equal(next.authoritative, false);
});

check("given an offline client with no rows, when applied, then rows are preserved", () => {
  const next = applySnapshot<Row>(good, {
    ok: false,
    error: "Torrent client is offline or unreachable",
    offline: true,
  });
  assert.deepEqual(next.torrents, good.torrents);
  assert.equal(next.offline, true);
  assert.equal(next.authoritative, false);
});

check("given an offline client that still reports rows, when applied, then those rows win", () => {
  const next = applySnapshot<Row>(good, {
    ok: false,
    error: "offline",
    offline: true,
    torrents: [{ hash: "z" }],
  });
  assert.deepEqual(next.torrents, [{ hash: "z" }]);
});

check("given an empty page, when the first read fails, then it stays empty without crashing", () => {  const next = applySnapshot<Row>(emptySnapshotState<Row>(), {
    ok: false,
    error: "Empty response from client API",
  });
  assert.deepEqual(next.torrents, []);
  assert.equal(next.authoritative, false);
});

// The API's failure bodies (src/app/api/client/torrents/route.ts) always carry
// `torrents: []` — 503 when the external client is unreachable, 502 for a
// built-in engine error, 500 for an unhandled route error. These mirror those
// payloads exactly; a test that omits the key does not match the server and
// lets the wipe regression through.
check(
  "given a 503 offline body carrying torrents: [], when applied, then the last good rows survive",
  () => {
    const next = applySnapshot<Row>(good, {
      ok: false,
      error: "The configured torrent client is unavailable.",
      offline: true,
      torrents: [],
    });
    assert.deepEqual(next.torrents, good.torrents);
    assert.equal(next.error, "The configured torrent client is unavailable.");
    assert.equal(next.offline, true);
    assert.equal(next.authoritative, false);
  },
);

check(
  "given a 502 built-in engine body carrying torrents: [], when applied, then the last good rows survive",
  () => {
    const next = applySnapshot<Row>(good, {
      ok: false,
      error: "Built-in engine failed to respond",
      offline: false,
      torrents: [],
    });
    assert.deepEqual(next.torrents, good.torrents);
    assert.equal(next.error, "Built-in engine failed to respond");
    assert.equal(next.offline, false);
    assert.equal(next.authoritative, false);
  },
);

check(
  "given a 500 client API error body carrying torrents: [], when applied, then the last good rows survive",
  () => {
    const next = applySnapshot<Row>(good, {
      ok: false,
      error: "Client API error",
      offline: false,
      torrents: [],
    });
    assert.deepEqual(next.torrents, good.torrents);
    assert.equal(next.authoritative, false);
  },
);

check(
  "given a 503 body with torrents: [], when the group is missing, then the dialog stays open",
  () => {
    const after = applySnapshot<Row>(good, {
      ok: false,
      error: "The configured torrent client is unavailable.",
      offline: true,
      torrents: [],
    });
    assert.equal(
      shouldCloseMissingGroup({
        openKey: "series:the-show",
        groupFound: false,
        authoritative: after.authoritative,
      }),
      false,
    );
  },
);

check(
  "given a network failure with no body at all, then the rows survive and the state is stale",
  () => {
    const next = applySnapshot<Row>(good, { ok: false, error: "fetch failed" });
    assert.deepEqual(next.torrents, good.torrents);
    assert.equal(next.error, "fetch failed");
    assert.equal(next.offline, false);
    assert.equal(next.authoritative, false);
    assert.equal(
      shouldCloseMissingGroup({
        openKey: "series:the-show",
        groupFound: false,
        authoritative: next.authoritative,
      }),
      false,
    );
  },
);

check(
  "given a successful empty snapshot, then rows are cleared and a missing group closes",
  () => {
    const next = applySnapshot<Row>(good, { ok: true, torrents: [] });
    assert.deepEqual(next.torrents, []);
    assert.equal(next.error, null);
    assert.equal(next.offline, false);
    assert.equal(next.authoritative, true);
    assert.equal(
      shouldCloseMissingGroup({
        openKey: "series:the-show",
        groupFound: false,
        authoritative: next.authoritative,
      }),
      true,
    );
  },
);

check("given a quiet failure, when the group is missing, then the dialog stays open", () => {
  const after = applySnapshot<Row>(good, { ok: false, error: "Failed to fetch" });
  assert.equal(
    shouldCloseMissingGroup({
      openKey: "series:the-show",
      groupFound: false,
      authoritative: after.authoritative,
    }),
    false,
  );
});

check("given a successful read proving the group is gone, then the dialog closes", () => {
  const after = applySnapshot<Row>(good, { ok: true, torrents: [] });
  assert.equal(
    shouldCloseMissingGroup({
      openKey: "series:the-show",
      groupFound: false,
      authoritative: after.authoritative,
    }),
    true,
  );
});

check("given the group is still present, then the dialog never closes itself", () => {
  assert.equal(
    shouldCloseMissingGroup({ openKey: "s", groupFound: true, authoritative: true }),
    false,
  );
});

check("given no open dialog, then nothing is closed", () => {
  assert.equal(
    shouldCloseMissingGroup({ openKey: null, groupFound: false, authoritative: true }),
    false,
  );
});

check("given a newer response was applied, when an older one lands, then it is dropped", () => {
  assert.equal(shouldApplySnapshot(3, 5), false);
  assert.equal(shouldApplySnapshot(5, 5), true);
  assert.equal(shouldApplySnapshot(6, 5), true);
});

check(
  "given a delete refresh then a stale poll, when both land, then the deleted rows do not return",
  () => {
    // gen 7 = the refresh fired after the delete; gen 6 = a poll that started
    // before it and answers from a pre-delete snapshot.
    let latestApplied = 0;
    let state = emptySnapshotState<Row>();
    const commit = (seq: number, torrents: Row[]) => {
      if (!shouldApplySnapshot(seq, latestApplied)) return;
      latestApplied = seq;
      state = applySnapshot(state, { ok: true, torrents });
    };
    commit(7, []);
    commit(6, [{ hash: "deleted" }]);
    assert.deepEqual(state.torrents, []);
  },
);

check("given fewer visible rows than selected ones, then select-all is not checked", () => {
  // Two visible page rows; three episodes checked inside the dialog for a
  // series the current filter hides. Set-size equality would light this up.
  const visible = ["v1", "v2"];
  const selected = new Set(["e1", "e2", "e3"]);
  assert.equal(selected.size, 3);
  assert.equal(areAllVisibleSelected(visible, selected), false);
});

check("given every visible row is selected, then select-all is checked", () => {
  assert.equal(areAllVisibleSelected(["v1", "v2"], new Set(["v1", "v2", "hidden"])), true);
});

check("given no visible rows, then select-all is not checked", () => {
  assert.equal(areAllVisibleSelected([], new Set(["a"])), false);
});

check("given a partial visible selection, when toggled, then all visible rows are added", () => {
  const next = toggleVisibleSelection(["v1", "v2"], new Set(["v1", "hidden"]));
  assert.deepEqual([...next].sort(), ["hidden", "v1", "v2"]);
});

check(
  "given every visible row selected, when toggled, then only visible rows are cleared",
  () => {
    const next = toggleVisibleSelection(["v1", "v2"], new Set(["v1", "v2", "hidden"]));
    assert.deepEqual([...next], ["hidden"]);
  },
);

if (failures) {
  console.error(`\nFAIL — ${failures} snapshot sync check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("\nPASS — downloads snapshot sync rules hold");
}
