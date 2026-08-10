import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  clearCompletionSweepOwnerState,
  completionSweepCounters,
  completionSweepNoticedHashes,
  COMPLETION_SWEEP_OWNER_RETRY_MS,
  COMPLETION_SWEEP_PARK_BUDGET,
  COMPLETION_SWEEP_TRACKED_HASH_LIMIT,
  decideCompletionParkingAdmission,
  decideCompletionSweep,
  resetCompletionSweepCountersForTests,
  runCompletionSweep,
  type CompletionSweepDeps,
} from "./completion-sweep";

/** A fake live torrent: only what the sweep is allowed to look at. */
type FakeTorrent = {
  hash: string;
  complete: boolean;
  /** Records every mutation the sweep performed on this torrent. */
  quiesced: number;
};

function fake(hash: string, complete = true): FakeTorrent {
  return { hash, complete, quiesced: 0 };
}

type World = {
  leases: Map<string, number>;
  foreground: Set<string>;
  parking: Set<string>;
  retries: Set<string>;
  owners: Map<string, string>;
  parkCalls: Array<{ userId: string; hash: string }>;
  missingOwnerLookups: string[];
  ownerLookupResult: (hash: string) => boolean | void | Promise<boolean | void>;
  now: number;
  parkResult: (hash: string) => Promise<boolean> | boolean;
  logs: string[];
};

function world(over: Partial<World> = {}): World {
  return {
    leases: new Map(),
    foreground: new Set(),
    parking: new Set(),
    retries: new Set(),
    owners: new Map(),
    parkCalls: [],
    missingOwnerLookups: [],
    ownerLookupResult: () => false,
    now: 1_000_000,
    parkResult: () => true,
    logs: [],
    ...over,
  };
}

function deps(w: World, torrents: FakeTorrent[]): CompletionSweepDeps<FakeTorrent> {
  return {
    torrents,
    hashOf: (t) => t.hash,
    isVerifiedComplete: (t) => t.complete,
    leaseCount: (hash) => w.leases.get(hash) ?? 0,
    isForeground: (hash) => w.foreground.has(hash),
    onMissingOwner: (hash) => {
      w.missingOwnerLookups.push(hash);
      return w.ownerLookupResult(hash);
    },
    now: () => w.now,
    parkBudget: 8,
    isParking: (hash) => w.parking.has(hash),
    isParkRetryPending: (hash) => w.retries.has(hash),
    ownerOf: (hash) => w.owners.get(hash),
    quiesce: (t) => {
      t.quiesced += 1;
    },
    park: (userId, t) => {
      w.parkCalls.push({ userId, hash: t.hash });
      // The engine's real park registers itself in `parking` for its duration.
      w.parking.add(t.hash);
      return Promise.resolve(w.parkResult(t.hash)).then((ok) => {
        w.parking.delete(t.hash);
        return ok;
      });
    },
    log: (message) => w.logs.push(message),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function main(): Promise<void> {
  assert.equal(
    decideCompletionParkingAdmission({
      leases: 1,
      activeParking: 0,
    }),
    "leased",
    "an active stream lease blocks even the first completion finalizer",
  );
  assert.equal(
    decideCompletionParkingAdmission({
      leases: 0,
      activeParking: COMPLETION_SWEEP_PARK_BUDGET,
    }),
    "capacity",
    "slow finalizers cannot accumulate beyond the global parking cap",
  );
  assert.equal(
    decideCompletionParkingAdmission({
      leases: 0,
      activeParking: COMPLETION_SWEEP_PARK_BUDGET - 1,
    }),
    "start",
    "a free slot admits the next completed torrent",
  );

  // --- decision precedence ---------------------------------------------------

  assert.equal(
    decideCompletionSweep({
      verifiedComplete: false,
      leases: 0,
      parking: false,
      parkRetryPending: false,
      owner: "u1",
    }),
    "skipped-incomplete",
    "an unverified torrent is never touched",
  );
  assert.equal(
    decideCompletionSweep({
      verifiedComplete: true,
      leases: 1,
      parking: true,
      parkRetryPending: true,
      owner: "u1",
    }),
    "skipped-leased",
    "a stream lease outranks every other reason to act",
  );
  assert.equal(
    decideCompletionSweep({
      verifiedComplete: true,
      leases: 0,
      foreground: true,
      parking: false,
      parkRetryPending: false,
      owner: "u1",
    }),
    "skipped-foreground",
    "a leaseless but recently-foreground torrent is left for the player",
  );
  assert.equal(
    decideCompletionSweep({
      verifiedComplete: true,
      leases: 0,
      parking: true,
      parkRetryPending: true,
      owner: "u1",
    }),
    "skipped-parking",
    "an in-flight park owns the torrent",
  );
  assert.equal(
    decideCompletionSweep({
      verifiedComplete: true,
      leases: 0,
      parking: false,
      parkRetryPending: true,
      owner: "u1",
    }),
    "skipped-retry-pending",
    "a pending retry timer owns the torrent",
  );
  assert.equal(
    decideCompletionSweep({
      verifiedComplete: true,
      leases: 0,
      parking: false,
      parkRetryPending: false,
      owner: undefined,
    }),
    "quiesced-no-owner",
    "no owning user means quiesce without a park attempt",
  );
  assert.equal(
    decideCompletionSweep({
      verifiedComplete: true,
      leases: 0,
      parking: false,
      parkRetryPending: false,
      owner: "u1",
    }),
    "parked",
    "a free verified-complete torrent is parked",
  );

  // --- the bug: completion that no event ever reported -----------------------

  {
    await flush();
    resetCompletionSweepCountersForTests();
    const w = world();
    w.owners.set("aa", "user1");
    const t = fake("aa");
    // No `done`/`verified`/`download` event ever fired for this torrent: the last
    // piece verified after the final triggering event. Only the sweep can see it.
    const stats = runCompletionSweep(deps(w, [t]));

    assert.equal(stats.complete, 1, "the sweep sees the verified-complete torrent");
    assert.equal(stats.parkAttempted, 1, "a park is attempted for it");
    assert.deepEqual(
      w.parkCalls,
      [{ userId: "user1", hash: "aa" }],
      "park is called with the owning user id",
    );
    assert.equal(t.quiesced, 1, "the torrent is quiesced before the park runs");
    assert.equal(
      completionSweepNoticedHashes().includes("aa"),
      true,
      "the sweep-caught hash is recorded once",
    );
    assert.equal(
      w.logs.some((line) => line.includes("aa") && line.includes("completion event")),
      true,
      "the log names the hash and why the sweep had to act",
    );
  }

  // --- lease guard: playback must never be interrupted -----------------------

  {
    await flush();
    resetCompletionSweepCountersForTests();
    const w = world();
    w.owners.set("bb", "user1");
    w.leases.set("bb", 2);
    const t = fake("bb");
    const stats = runCompletionSweep(deps(w, [t]));

    assert.equal(stats.skippedLeased, 1, "a leased torrent is reported as leased");
    assert.equal(stats.parkAttempted, 0, "no park is attempted while a reader holds it");
    assert.equal(t.quiesced, 0, "a leased torrent's selection is left untouched");
    assert.equal(w.parkCalls.length, 0, "park is never called for a leased torrent");

    w.leases.delete("bb");
    const afterRelease = runCompletionSweep(deps(w, [t]));
    assert.equal(
      afterRelease.parkAttempted,
      1,
      "the next periodic beat parks it after the final lease releases",
    );
    assert.equal(t.quiesced, 1, "quiescing happens only after playback is protected");
  }

  // --- playback / reselection safety: an incomplete stream is untouched ------

  {
    await flush();
    resetCompletionSweepCountersForTests();
    const w = world();
    w.owners.set("cc", "user1");
    const streaming = fake("cc", false);
    const stats = runCompletionSweep(deps(w, [streaming]));

    assert.equal(stats.scanned, 1);
    assert.equal(stats.complete, 0, "an incomplete torrent is not counted complete");
    assert.equal(streaming.quiesced, 0, "an in-progress download keeps its selection");
    assert.equal(stats.parkAttempted, 0, "and is never parked");
  }

  // --- bitfield hole: a 99.9%-done torrent is never quiesced ---------------

  {
    await flush();
    resetCompletionSweepCountersForTests();
    const w = world();
    w.owners.set("gg", "user1");
    const holed = fake("gg");
    // One missing piece in the middle: `progress` may round to 1 and WebTorrent
    // may have latched `done`, but every-piece verification says no.
    const bitfield = [true, true, false, true, true];
    const stats = runCompletionSweep({
      ...deps(w, [holed]),
      isVerifiedComplete: () => bitfield.every(Boolean),
    });

    assert.equal(stats.complete, 0, "a bitfield hole is not completeness");
    assert.equal(holed.quiesced, 0, "the holed torrent keeps its selection and keeps downloading");
    assert.equal(w.parkCalls.length, 0, "and is never parked");

    bitfield[2] = true;
    const afterFill = runCompletionSweep({
      ...deps(w, [holed]),
      isVerifiedComplete: () => bitfield.every(Boolean),
    });
    assert.equal(
      afterFill.parkAttempted,
      1,
      "and is parked as soon as the hole is genuinely filled — no stale negative",
    );
  }

  // --- idempotence: repeated sweeps do not re-park ---------------------------

  {
    await flush();
    resetCompletionSweepCountersForTests();
    const w = world();
    w.owners.set("dd", "user1");
    // A park that never settles: the engine's `parking` entry stays for its
    // duration, which is exactly what makes the next beat a no-op.
    w.parkResult = () => new Promise<boolean>(() => {});
    const t = fake("dd");
    const d = deps(w, [t]);

    runCompletionSweep(d);
    const second = runCompletionSweep(d);
    const third = runCompletionSweep(d);

    assert.equal(w.parkCalls.length, 1, "a repeated sweep never starts a second park");
    assert.equal(second.skippedParking, 1, "the second sweep reports park-in-flight");
    assert.equal(third.skippedParking, 1, "and so does the third");
    assert.equal(t.quiesced, 1, "quiesce is not repeated either");
  }

  // --- failed park: the retry timer owns the torrent, then the sweep resumes --

  {
    await flush();
    resetCompletionSweepCountersForTests();
    const w = world();
    w.owners.set("ee", "user1");
    w.parkResult = () => false; // the engine's park failed and armed a retry
    const t = fake("ee");
    const d = deps(w, [t]);

    runCompletionSweep(d);
    await flush();
    assert.equal(
      completionSweepCounters().parkFailed,
      1,
      "a failed park is counted as a failure, not as no attempt",
    );

    // While the engine's retry timer is armed, the sweep must not duplicate it.
    w.retries.add("ee");
    const duringRetry = runCompletionSweep(d);
    assert.equal(duringRetry.skippedRetryPending, 1);
    assert.equal(w.parkCalls.length, 1, "the sweep does not race the retry timer");

    // Retry timer fired and gave up; the sweep is the safety net that tries again.
    w.retries.delete("ee");
    w.parkResult = () => true;
    runCompletionSweep(d);
    await flush();
    assert.equal(w.parkCalls.length, 2, "once the retry is gone the sweep re-attempts");
    assert.equal(
      completionSweepCounters().parkSucceeded,
      1,
      "a successful park is counted separately",
    );
  }

  // --- park attempts vs no attempt are distinguishable -----------------------

  {
    await flush();
    resetCompletionSweepCountersForTests();
    const w = world();
    const orphan = fake("ff"); // complete, unleased, but no owning user recorded
    const stats = runCompletionSweep(deps(w, [orphan]));

    assert.equal(stats.parkSkippedNoOwner, 1, "no owner is its own distinct outcome");
    assert.equal(stats.parkAttempted, 0, "and is not reported as an attempt");
    assert.equal(
      orphan.quiesced,
      1,
      "an unownable complete torrent is still quiesced so it stops pulling traffic",
    );
    assert.equal(completionSweepCounters().parkFailed, 0, "nothing is counted as failed");
  }

  // --- hostile input: one bad handle cannot stop the sweep -------------------

  {
    await flush();
    resetCompletionSweepCountersForTests();
    const w = world();
    w.owners.set("hh", "user1");
    const good = fake("hh");
    const stats = runCompletionSweep({
      ...deps(w, [good]),
      torrents: [
        null as unknown as FakeTorrent,
        { hash: "boom", complete: true, quiesced: 0 },
        good,
      ],
      isVerifiedComplete: (t) => {
        if (t.hash === "boom") throw new Error("half-destroyed torrent");
        return t.complete;
      },
    });

    assert.equal(stats.errors, 1, "the throwing torrent is recorded as an error");
    assert.equal(stats.parkAttempted, 1, "the healthy torrent is still parked");
    assert.equal(good.quiesced, 1, "and still quiesced");
  }

  // --- cumulative counters ---------------------------------------------------

  {
    await flush();
    resetCompletionSweepCountersForTests();
    const w = world();
    w.owners.set("ii", "user1");
    const d = deps(w, [fake("ii"), fake("jj", false)]);
    runCompletionSweep(d);
    const counters = completionSweepCounters();
    assert.equal(counters.sweeps, 1, "sweeps are counted");
    assert.equal(counters.scanned, 2, "every scanned torrent is counted");
    assert.equal(counters.complete, 1);
    assert.equal(counters.parkAttempted, 1);
    const copy = completionSweepCounters();
    copy.sweeps = 999;
    assert.equal(
      completionSweepCounters().sweeps,
      1,
      "reading counters hands out a copy, never the live record",
    );
    resetCompletionSweepCountersForTests();
    assert.equal(completionSweepCounters().sweeps, 0, "the reset clears everything");
  }

  // --- foreground grace: a paused player holds no lease --------------------

  {
    await flush();
    resetCompletionSweepCountersForTests();
    const w = world();
    w.owners.set("kk", "user1");
    w.foreground.add("kk");
    const paused = fake("kk");
    const stats = runCompletionSweep(deps(w, [paused]));

    assert.equal(
      stats.skippedForeground,
      1,
      "the recently-foreground torrent is left alone even with zero leases",
    );
    assert.equal(paused.quiesced, 0, "its selection survives for an instant resume");
    assert.equal(w.parkCalls.length, 0, "and it is not parked out from under the player");
  }

  // --- cold-start cap: 15 completes do not launch 15 parks at once ----------

  {
    await flush();
    resetCompletionSweepCountersForTests();
    const w = world();
    const backlog = Array.from({ length: 15 }, (_, i) => {
      const hash = `c${i}`;
      w.owners.set(hash, "user1");
      return fake(hash);
    });
    // Parks that never settle, i.e. the worst case: everything stays in the
    // engine's `parking` map, so only the budget limits the fleet.
    w.parkResult = () => new Promise<boolean>(() => {});
    const d = { ...deps(w, backlog), parkBudget: 2 };

    const first = runCompletionSweep(d);
    assert.equal(first.complete, 15, "all fifteen are seen");
    assert.equal(first.parkAttempted, 2, "but only two parks start on this beat");
    assert.equal(first.deferred, 13, "the rest are explicitly deferred");
    assert.equal(
      backlog.filter((t) => t.quiesced > 0).length,
      2,
      "deferred torrents are left completely untouched",
    );

    const second = runCompletionSweep({
      ...d,
      parkBudget: Math.max(
        0,
        COMPLETION_SWEEP_PARK_BUDGET - w.parking.size,
      ),
    });
    assert.equal(
      second.parkAttempted,
      0,
      "the next beat waits while both global parking slots are occupied",
    );
    assert.equal(
      w.parkCalls.length,
      2,
      "hung finalizers stay capped across beats instead of growing forever",
    );
  }

  // --- re-entrancy: a sweep started inside a sweep is refused --------------

  {
    await flush();
    resetCompletionSweepCountersForTests();
    const w = world();
    w.owners.set("rr", "user1");
    const t = fake("rr");
    const base = deps(w, [t]);
    let inner: ReturnType<typeof runCompletionSweep> | null = null;
    runCompletionSweep({
      ...base,
      quiesce: (torrent) => {
        base.quiesce(torrent);
        // A dep that re-enters (a hot-reloaded copy, a nested call) must not
        // get a second concurrent pass over the same torrent list.
        inner = runCompletionSweep(base);
      },
    });

    assert.equal(inner!.scanned, 0, "the nested sweep does no work");
    assert.equal(
      completionSweepCounters().reentrantSkipped,
      1,
      "and the refusal is observable",
    );
    assert.equal(w.parkCalls.length, 1, "the torrent is parked exactly once");
  }

  // --- no durable owner: observable, quiesced, and looked up once ----------

  {
    await flush();
    resetCompletionSweepCountersForTests();
    const w = world();
    const orphan = fake("nn");
    const d = deps(w, [orphan]);
    runCompletionSweep(d);
    runCompletionSweep(d);
    runCompletionSweep(d);

    assert.deepEqual(
      w.missingOwnerLookups,
      ["nn"],
      "the durable owner lookup fires once per hash, never once per beat",
    );
    assert.equal(w.parkCalls.length, 0, "and no park is attempted without an owner");
    assert.equal(
      w.logs.some((line) => line.includes("nn") && line.includes("no owning user")),
      true,
      "the missing owner is logged, not swallowed",
    );
  }

  // --- owner resolution: bounded retry, recovery, and shutdown -------------

  {
    await flush();
    resetCompletionSweepCountersForTests();
    const w = world();
    const orphan = fake("tr");
    const d = deps(w, [orphan]);

    // 1) The first durable lookup blows up (transient database failure).
    w.ownerLookupResult = () => {
      throw new Error("db down");
    };
    runCompletionSweep(d);
    assert.deepEqual(w.missingOwnerLookups, ["tr"], "the failing lookup ran once");

    // 2) Within the cooldown the sweep does not hot-loop the database.
    w.now += 5_000;
    runCompletionSweep(d);
    w.now += 5_000;
    runCompletionSweep(d);
    assert.equal(
      w.missingOwnerLookups.length,
      1,
      "the 5s beat does not turn into a 5s query loop",
    );
    assert.equal(w.parkCalls.length, 0, "and nothing is parked without an owner");
    assert.equal(orphan.quiesced > 0, true, "the orphan stays safely quiesced meanwhile");

    // 3) After the cooldown it is retried — a transient failure is not fatal.
    w.now += COMPLETION_SWEEP_OWNER_RETRY_MS;
    w.ownerLookupResult = (hash) => {
      w.owners.set(hash, "user1");
      return true;
    };
    runCompletionSweep(d);
    assert.equal(w.missingOwnerLookups.length, 2, "the lookup is retried after the cooldown");
    assert.equal(
      completionSweepCounters().ownerLookupRecovered,
      1,
      "the recovery is observable",
    );

    // 4) The recovered owner is used on the very next beat.
    runCompletionSweep(d);
    assert.deepEqual(
      w.parkCalls,
      [{ userId: "user1", hash: "tr" }],
      "the once-stranded torrent is parked once the owner comes back",
    );

    // 5) A successful resolution is not looked up again.
    w.now += COMPLETION_SWEEP_OWNER_RETRY_MS * 3;
    runCompletionSweep(d);
    assert.equal(
      w.missingOwnerLookups.length,
      2,
      "a resolved owner never triggers another durable lookup",
    );
  }

  {
    await flush();
    resetCompletionSweepCountersForTests();
    const w = world();
    const absent = fake("ab");
    const d = deps(w, [absent]);
    // No durable row at all: `false`, forever.
    w.ownerLookupResult = () => false;

    for (let beat = 0; beat < 24; beat += 1) {
      runCompletionSweep(d);
      w.now += 5_000;
    }

    assert.equal(
      w.missingOwnerLookups.length,
      4,
      "two minutes of beats cost four queries, not twenty-four",
    );
    assert.equal(
      completionSweepCounters().ownerLookupFailed,
      4,
      "each unresolved lookup is counted",
    );
    assert.equal(w.parkCalls.length, 0, "an ownerless torrent is never parked");
  }

  {
    await flush();
    resetCompletionSweepCountersForTests();
    const w = world();
    const orphan = fake("sd");
    const d = deps(w, [orphan]);
    runCompletionSweep(d);
    assert.equal(w.missingOwnerLookups.length, 1, "one lookup so far");

    // Shutdown must not leave the cooldown (or a wedged in-flight flag) behind
    // for the next engine to inherit.
    clearCompletionSweepOwnerState();
    runCompletionSweep(d);
    assert.equal(
      w.missingOwnerLookups.length,
      2,
      "a restarted engine resolves owners from a clean slate",
    );
  }

  // --- process-lifetime diagnostics/retries stay bounded --------------------

  {
    await flush();
    resetCompletionSweepCountersForTests();
    const w = world();
    for (let i = 0; i < COMPLETION_SWEEP_TRACKED_HASH_LIMIT + 3; i += 1) {
      const hash = `bounded-notice-${i}`;
      w.owners.set(hash, "user1");
      runCompletionSweep(deps(w, [fake(hash)]));
      await flush();
    }
    const hashes = completionSweepNoticedHashes();
    assert.equal(
      hashes.length,
      COMPLETION_SWEEP_TRACKED_HASH_LIMIT,
      "completion notices retain a fixed number of hashes",
    );
    assert.equal(
      hashes.includes("bounded-notice-0"),
      false,
      "the oldest notice is evicted at capacity",
    );
    assert.equal(
      hashes.includes(
        `bounded-notice-${COMPLETION_SWEEP_TRACKED_HASH_LIMIT + 2}`,
      ),
      true,
      "the newest notice remains observable",
    );
  }

  {
    resetCompletionSweepCountersForTests();
    const w = world();
    for (let i = 0; i < COMPLETION_SWEEP_TRACKED_HASH_LIMIT + 1; i += 1) {
      runCompletionSweep(deps(w, [fake(`bounded-owner-${i}`)]));
    }
    const before = w.missingOwnerLookups.length;
    runCompletionSweep(deps(w, [fake("bounded-owner-0")]));
    assert.equal(
      w.missingOwnerLookups.length,
      before + 1,
      "owner retry state evicts its oldest hash instead of growing forever",
    );
  }

  {
    resetCompletionSweepCountersForTests();
    const w = world({
      ownerLookupResult: () => new Promise<boolean>(() => {}),
    });
    for (let i = 0; i < COMPLETION_SWEEP_TRACKED_HASH_LIMIT + 1; i += 1) {
      runCompletionSweep(deps(w, [fake(`in-flight-owner-${i}`)]));
    }
    assert.equal(
      w.missingOwnerLookups.length,
      COMPLETION_SWEEP_TRACKED_HASH_LIMIT,
      "the retry-state bound also caps concurrent durable owner lookups",
    );
  }

  // --- wiring: the engine reuses the existing 5s beat, adds no timer ---------

  {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/lib/clients/builtin-engine.ts"),
      "utf8",
    );
    assert.equal(
      /sweepCompletedBuiltinTorrents\(\);/.test(source),
      true,
      "the engine calls the sweep",
    );
    const sweepFn = source.slice(
      source.indexOf("export function sweepCompletedBuiltinTorrents"),
      source.indexOf("function startUploadThrottleLoop"),
    );
    assert.equal(
      sweepFn.includes("isVerifiedComplete: (t) => isComplete(t)"),
      true,
      "candidate completeness uses the full verification predicate",
    );
    assert.equal(
      /\bt\.done\b/.test(sweepFn),
      false,
      "the sweep never trusts WebTorrent's latched `done`",
    );
    assert.equal(
      sweepFn.includes("parkBuiltinStreamTorrent(hash)"),
      true,
      "quiescing goes through the shared park helper, not a raw deselect",
    );
    assert.equal(
      sweepFn.includes("prioritizedStreamFiles.delete") &&
        sweepFn.includes("prioritizedEdgePrefetches.delete"),
      true,
      "the fallback path still clears both priority maps so Play reselects",
    );
    assert.equal(
      sweepFn.includes("s.parkingRetryTimers.has(hash)") &&
        sweepFn.includes("s.parking.has(hash)"),
      true,
      "the sweep honours both the in-flight park and the 30s retry backoff",
    );
    assert.equal(
      sweepFn.includes("MAX_CONCURRENT_COMPLETION_PARKS - s.parking.size"),
      true,
      "the periodic beat budgets against all finalizers already in flight",
    );
    assert.equal(
      /releasePaths|destroyStore:\s*true|deleteMany|\.delete\(\{/.test(sweepFn),
      false,
      "the sweep deletes no files and no rows",
    );
    const loop = source.slice(
      source.indexOf("function startUploadThrottleLoop"),
      source.indexOf("* Stops the in-process engine"),
    );
    assert.equal(
      loop.includes("sweepCompletedBuiltinTorrents()"),
      true,
      "the sweep runs on the existing upload-throttle beat",
    );
    assert.equal(
      loop.includes("try {") && loop.includes("catch"),
      true,
      "a throwing sweep cannot kill the throttle loop or the swarm watchdog",
    );
    assert.equal(
      loop.includes("driveForegroundSwarmWatch"),
      true,
      "the watchdog still runs on the same beat",
    );
    assert.equal(
      (source.match(/setInterval\(/g) ?? []).length,
      1,
      "the fix does not arm a second interval",
    );
    assert.equal(
      /destroyStore:\s*false/.test(source),
      true,
      "destroyStore:false parking is untouched",
    );
    assert.equal(
      /status:\s*"downloaded"/.test(source),
      true,
      "the durable downloaded state the park writes is still there to regress from",
    );
    const parkFn = source.slice(
      source.indexOf("async function persistAndParkCompletedTorrent"),
      source.indexOf("function observeCompletion"),
    );
    assert.equal(
      parkFn.includes("decideCompletionParkingAdmission") &&
        parkFn.includes("s.streamLeases.get(hash)") &&
        parkFn.includes("s.parking.size"),
      true,
      "event-driven parking shares the lease and global-capacity admission guard",
    );
  }

  console.log(
    "PASS completion sweep: missed-final-event completion, bitfield-hole safety, lease + foreground guards, cold-start park cap, re-entrancy refusal, idempotent sweeps, failed park + retry backoff handoff, no-durable-owner skip with bounded owner-lookup retry + recovery + shutdown reset, no data deletion, single-timer wiring",
  );

}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
