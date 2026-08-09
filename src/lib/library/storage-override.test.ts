/**
 * The cap is a guardrail, not a wall.
 *
 * The owner's own words: *"no direct link to the place i can change the cap.. i
 * should be able to click the warning popup actually it shouldn't even block me,
 * it should ask me if i'm sure to override my cap..."*
 *
 * The cap is a number the owner chose about their own disk. Enforcing it as a
 * hard refusal with a toast naming a settings tab that does not exist is the app
 * overruling its user. So an over-cap **Download** must state the real figures
 * and let the owner decide.
 *
 * The line these tests exist to defend is the one that must NOT move:
 *
 *   - **cap** — the owner's preference. Overridable. Going over costs disk space
 *     they had reserved for themselves; nothing breaks.
 *   - **reserve** — the app's 500 MB spare-room margin. Overridable. The release
 *     *fits*; the app just prefers more elbow room afterwards. The owner's
 *     correction was explicit: *"it should not be non-negotiable.. maybe i want
 *     to download that.. unless my storage is full that is when it shouldn't
 *     continue"*. A margin the app invented is not "storage is full".
 *   - **wont-fit** — the release needs more bytes than the volume has. NEVER
 *     overridable. Consent cannot create disk, and forcing the write corrupts
 *     the download partway through. This is the single hard stop.
 *   - **setup** — no cap has been chosen yet, so there is nothing to exceed.
 *
 * The regression these guard against is the line drifting back up: an earlier
 * pass lumped `reserve` and `wont-fit` into one `free-space` kind and refused
 * both, which made a 700 MB episode impossible on a drive with 900 MB free.
 *
 * And the rule from the original brief that still holds: **Play never gets
 * here.** Streaming reclaims its own reclaimable cache and proceeds, so a
 * `retention: "stream"` send is never turned into a prompt.
 *
 * Table-driven per AGENTS.md — these pin the RULE CLASS, not one screen.
 * Run: npx tsx src/lib/library/storage-override.test.ts
 */
import assert from "node:assert/strict";
import type { ClientConnectionConfig } from "@/lib/clients/types";
import type { StorageLimitKind, StoragePolicyResult } from "./disk-space";
import { assertStorageBudget, storageCapMessage } from "./disk-space";
import type { RetentionSweepResult } from "./retention-sweep";
import { checkSendStorage } from "./storage-gate";
import {
  capOverridePrompt,
  isOverridableLimit,
  parseStorageOverrideFacts,
  runWithStorageOverride,
  STORAGE_CAP_FOCUS_PARAM,
  STORAGE_CAP_SETTINGS_HREF,
  StorageLimitError,
  storageOverrideFacts,
  type StorageOverrideFacts,
} from "./storage-override";

let failures = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

const GB = 1_000_000_000;

const config = {
  clientType: "builtin",
  host: "",
  savePath: "D:\\Downloads",
  maxStorageBytes: 20 * GB,
} as ClientConnectionConfig;

/** The live measurement that started all this: 41.1 GB held under a 20 GB cap. */
function refusal(limit: StorageLimitKind, usedBytes = 41.1 * GB): StoragePolicyResult {
  return {
    ok: false,
    limit,
    message:
      limit === "cap"
        ? storageCapMessage(usedBytes, 20 * GB)
        : limit === "wont-fit"
          ? "Not enough space on the drive"
          : limit === "reserve"
            ? "This would leave under 500 MB free"
            : "Finish setup first",
    usedBytes,
    maxStorageBytes: 20 * GB,
    freeBytes: limit === "wont-fit" || limit === "reserve" ? 100_000_000 : 500 * GB,
  } as StoragePolicyResult;
}

function allowed(usedBytes = 3 * GB): StoragePolicyResult {
  return {
    ok: true,
    usedBytes,
    maxStorageBytes: 20 * GB,
    freeBytes: 500 * GB,
    remainingBudgetBytes: 20 * GB - usedBytes,
  } as StoragePolicyResult;
}

function emptySweep(): RetentionSweepResult {
  return {
    mode: "delete",
    budgetBytes: 0,
    usedBytes: 0,
    targetBytes: 0,
    reclaimedBytes: 0,
    satisfied: false,
    scanned: 0,
    wouldDelete: [],
    deleted: [],
    skipped: [],
  } as unknown as RetentionSweepResult;
}

function facts(over: Partial<StorageOverrideFacts> = {}): StorageOverrideFacts {
  return {
    ...storageOverrideFacts({
      limit: "cap",
      usedBytes: 41.1 * GB,
      capBytes: 20 * GB,
      incomingBytes: 4 * GB,
      message: storageCapMessage(41.1 * GB, 20 * GB),
    }),
    ...over,
  };
}

async function main() {
  console.log("storage-override.test.ts");

  // ── The line: what may be overridden, and what may never be ───────────────
  //
  // Default-deny by kind. A future refusal reason must not be able to inherit
  // "overridable" by accident — that is why this is one predicate and not a
  // conditional buried in a dialog.
  const overridability: Array<{
    limit: StorageLimitKind | null | undefined;
    overridable: boolean;
    why: string;
  }> = [
    { limit: "cap", overridable: true, why: "the owner's own preference about their own disk" },
    {
      limit: "reserve",
      overridable: true,
      why: "it fits; only the app's spare-room margin objects",
    },
    {
      limit: "wont-fit",
      overridable: false,
      why: "the bytes do not exist; consent cannot create disk",
    },
    { limit: "setup", overridable: false, why: "no cap chosen yet, so nothing to exceed" },
    {
      limit: "inventory",
      overridable: false,
      why: "an incomplete scan cannot prove the library is under budget",
    },
    { limit: null, overridable: false, why: "unknown reason defaults to a hard stop" },
    { limit: undefined, overridable: false, why: "absent reason defaults to a hard stop" },
  ];
  for (const row of overridability) {
    check(`isOverridableLimit(${String(row.limit)}) === ${row.overridable} — ${row.why}`, () => {
      assert.equal(isOverridableLimit(row.limit), row.overridable);
    });
  }

  // ── The gate: Download asks, Play never does, free space never budges ─────
  const gateTable: Array<{
    name: string;
    retention: "stream" | "keep";
    limit: StorageLimitKind;
    overrideCap: boolean;
    /** Reclaim frees enough on the second look. Only ever relevant to Play. */
    reclaimFrees: boolean;
    expectOk: boolean;
    expectOverridable?: boolean;
  }> = [
    {
      name: "over-cap Download is refused, but the refusal offers an override",
      retention: "keep",
      limit: "cap",
      overrideCap: false,
      reclaimFrees: false,
      expectOk: false,
      expectOverridable: true,
    },
    {
      name: "over-cap Download proceeds once the owner confirms",
      retention: "keep",
      limit: "cap",
      overrideCap: true,
      reclaimFrees: false,
      expectOk: true,
    },
    {
      name: "wont-fit Download is refused and is NOT overridable",
      retention: "keep",
      limit: "wont-fit",
      overrideCap: false,
      reclaimFrees: false,
      expectOk: false,
      expectOverridable: false,
    },
    {
      // The whole point of the hard stop: an override flag arriving from a
      // forged request, a stale client, or a future bug must change nothing.
      name: "wont-fit Download stays refused even WITH overrideCap: true",
      retention: "keep",
      limit: "wont-fit",
      overrideCap: true,
      reclaimFrees: false,
      expectOk: false,
      expectOverridable: false,
    },
    {
      // The owner's correction, encoded: a release that fits must never be an
      // outright refusal just because it eats the app's spare-room margin.
      name: "reserve Download is refused but offers an override",
      retention: "keep",
      limit: "reserve",
      overrideCap: false,
      reclaimFrees: false,
      expectOk: false,
      expectOverridable: true,
    },
    {
      name: "reserve Download proceeds once the owner confirms",
      retention: "keep",
      limit: "reserve",
      overrideCap: true,
      reclaimFrees: false,
      expectOk: true,
    },
    {
      name: "setup refusal is never overridable",
      retention: "keep",
      limit: "setup",
      overrideCap: true,
      reclaimFrees: false,
      expectOk: false,
      expectOverridable: false,
    },
    {
      name: "Play over the cap reclaims and proceeds — it never prompts",
      retention: "stream",
      limit: "cap",
      overrideCap: false,
      reclaimFrees: true,
      expectOk: true,
    },
  ];

  for (const row of gateTable) {
    await checkAsync(row.name, async () => {
      let asserts = 0;
      let reclaims = 0;
      const decision = await checkSendStorage({
        userId: "u1",
        config,
        root: "D:\\Downloads",
        incomingBytes: 4 * GB,
        retention: row.retention,
        overrideCap: row.overrideCap,
        _assert: async () => {
          asserts += 1;
          // Only a reclaim that actually frees space changes the second answer.
          if (row.reclaimFrees && asserts > 1) return allowed();
          return refusal(row.limit);
        },
        _reclaim: async () => {
          reclaims += 1;
          return emptySweep();
        },
        _resetDirectorySizeCache: () => {},
      });

      assert.equal(decision.ok, row.expectOk, "ok");

      if (row.expectOk) {
        assert.equal(decision.override, null, "an allowed send carries no refusal facts");
      } else {
        assert.ok(decision.override, "a refusal must carry the facts to act on");
        assert.equal(decision.override.limit, row.limit, "limit");
        assert.equal(
          decision.override.overridable,
          row.expectOverridable,
          "overridable",
        );
        assert.ok(
          decision.override.settingsHref.startsWith("/settings"),
          "a refusal must point at a real settings route",
        );
      }

      // Download must never delete anything to satisfy a cap: the owner asked
      // to KEEP something, not to trade away what they already keep.
      if (row.retention !== "stream") {
        assert.equal(reclaims, 0, "Download must not reclaim");
      }
    });
  }

  // An accepted override must not quietly reclaim either — "yes, go over" means
  // go over, not "delete some of my things to make it fit".
  await checkAsync("a confirmed override adds bytes without deleting anything", async () => {
    let reclaims = 0;
    const decision = await checkSendStorage({
      userId: "u1",
      config,
      root: "D:\\Downloads",
      incomingBytes: 9 * GB,
      retention: "keep",
      overrideCap: true,
      _assert: async () => refusal("cap"),
      _reclaim: async () => {
        reclaims += 1;
        return emptySweep();
      },
      _resetDirectorySizeCache: () => {},
    });
    assert.equal(decision.ok, true);
    assert.equal(reclaims, 0);
    assert.equal(decision.reclaim, null);
  });

  // ── The client rule: confirm, don't block ────────────────────────────────
  await checkAsync("first attempt never carries an override", async () => {
    const seen: boolean[] = [];
    await runWithStorageOverride(
      async ({ overrideStorageCap }) => {
        seen.push(overrideStorageCap);
        return "sent";
      },
      async () => true,
    );
    assert.deepEqual(seen, [false], "the app must not pre-emptively break its own cap");
  });

  await checkAsync("confirming re-sends exactly once, with the override", async () => {
    const seen: boolean[] = [];
    let asked = 0;
    const outcome = await runWithStorageOverride(
      async ({ overrideStorageCap }) => {
        seen.push(overrideStorageCap);
        if (!overrideStorageCap) {
          throw new StorageLimitError("over cap", facts());
        }
        return "sent";
      },
      async () => {
        asked += 1;
        return true;
      },
    );
    assert.deepEqual(seen, [false, true]);
    assert.equal(asked, 1);
    assert.deepEqual(outcome, { status: "done", value: "sent" });
  });

  await checkAsync("cancelling sends nothing and is not an error", async () => {
    const seen: boolean[] = [];
    const outcome = await runWithStorageOverride(
      async ({ overrideStorageCap }) => {
        seen.push(overrideStorageCap);
        throw new StorageLimitError("over cap", facts());
      },
      async () => false,
    );
    assert.deepEqual(seen, [false], "no second attempt after a decline");
    assert.deepEqual(outcome, { status: "cancelled" });
  });

  await checkAsync("a wont-fit refusal is rethrown, never prompted", async () => {
    let asked = 0;
    let attempts = 0;
    await assert.rejects(
      runWithStorageOverride(
        async () => {
          attempts += 1;
          throw new StorageLimitError(
            "no free space",
            facts({ limit: "wont-fit", overridable: false }),
          );
        },
        async () => {
          asked += 1;
          return true;
        },
      ),
      /no free space/,
    );
    assert.equal(asked, 0, "the user must never be offered a way past physics");
    assert.equal(attempts, 1, "and must never be retried past it either");
  });

  await checkAsync("a second refusal surfaces instead of re-prompting forever", async () => {
    let asked = 0;
    let attempts = 0;
    await assert.rejects(
      runWithStorageOverride(
        async () => {
          attempts += 1;
          throw new StorageLimitError("still over", facts());
        },
        async () => {
          asked += 1;
          return true;
        },
      ),
      /still over/,
    );
    assert.equal(asked, 1, "asked once");
    assert.equal(attempts, 2, "tried twice, then stopped");
  });

  await checkAsync("a non-storage failure is not swallowed by the override path", async () => {
    let asked = 0;
    await assert.rejects(
      runWithStorageOverride(
        async () => {
          throw new Error("client offline");
        },
        async () => {
          asked += 1;
          return true;
        },
      ),
      /client offline/,
    );
    assert.equal(asked, 0);
  });

  // ── Play never reaches the prompt at all ─────────────────────────────────
  //
  // Belt and braces: the gate already proves a stream send is allowed after
  // reclaim, so it never throws — meaning the confirm callback is unreachable
  // for Play by construction, not by a check somewhere in the UI.
  await checkAsync("Play is never asked to confirm", async () => {
    let asked = 0;
    const outcome = await runWithStorageOverride(
      async () => {
        const decision = await checkSendStorage({
          userId: "u1",
          config,
          root: "D:\\Downloads",
          incomingBytes: 4 * GB,
          retention: "stream",
          _assert: (() => {
            let n = 0;
            return async () => {
              n += 1;
              return n === 1 ? refusal("cap") : allowed();
            };
          })(),
          _reclaim: async () => emptySweep(),
          _resetDirectorySizeCache: () => {},
        });
        if (!decision.ok) {
          throw new StorageLimitError(decision.message, facts());
        }
        return "playing";
      },
      async () => {
        asked += 1;
        return true;
      },
    );
    assert.equal(asked, 0);
    assert.deepEqual(outcome, { status: "done", value: "playing" });
  });

  // ── The payload: honest, and not trusted blindly ─────────────────────────
  check("parse re-derives overridability rather than trusting the wire", () => {
    // A server (or a tampered response) claiming a wont-fit refusal may be
    // overridden must not be believed. The rule is the product guarantee.
    const parsed = parseStorageOverrideFacts({
      limit: "wont-fit",
      overridable: true,
      usedBytes: 41.1 * GB,
      capBytes: 20 * GB,
      incomingBytes: 4 * GB,
      settingsHref: STORAGE_CAP_SETTINGS_HREF,
      message: "nope",
    });
    assert.ok(parsed);
    assert.equal(parsed.overridable, false);
  });

  check("parse rejects junk and unknown limits", () => {
    for (const junk of [null, undefined, 0, "cap", [], {}, { limit: "whatever" }]) {
      assert.equal(parseStorageOverrideFacts(junk), null, JSON.stringify(junk) ?? "undefined");
    }
  });

  check("parse refuses an off-site settings link", () => {
    const parsed = parseStorageOverrideFacts({
      limit: "cap",
      settingsHref: "https://example.invalid/steal",
      usedBytes: 1,
      capBytes: 2,
      incomingBytes: null,
      message: "x",
    });
    assert.ok(parsed);
    assert.equal(parsed.settingsHref, STORAGE_CAP_SETTINGS_HREF);
  });

  check("parse degrades missing numbers instead of inventing them", () => {
    const parsed = parseStorageOverrideFacts({ limit: "cap", message: "x" });
    assert.ok(parsed);
    assert.equal(parsed.usedBytes, 0);
    assert.equal(parsed.capBytes, null);
    assert.equal(parsed.incomingBytes, null);
  });

  // ── The copy: a real destination, and real numbers ───────────────────────
  //
  // The bug this replaces: "Raise the limit in Settings → Folders" named a tab
  // that does not exist. The tabs are Connection / Downloads / Categories, and
  // the Downloads tab's route key is `folders`.
  check("the deep link targets a tab the settings page actually accepts", () => {
    const url = new URL(STORAGE_CAP_SETTINGS_HREF, "http://localhost");
    assert.equal(url.pathname, "/settings");
    assert.equal(
      url.searchParams.get("tab"),
      "folders",
      "must be one of connection|folders|categories",
    );
    assert.equal(
      url.searchParams.get("focus"),
      STORAGE_CAP_FOCUS_PARAM,
      "must land on the cap field, not merely the page",
    );
  });

  check("the prompt states used, cap and required size — not adjectives", () => {
    const prompt = capOverridePrompt(facts());
    // Informed consent needs figures. "Are you sure?" is not informed.
    assert.match(prompt.body, /41\.1 GB/, "how much is in use");
    assert.match(prompt.body, /20(\.0)? GB/, "what the cap is");
    assert.match(prompt.body, /4(\.0)? GB/, "what this item needs");
    assert.equal(prompt.raiseCapHref, STORAGE_CAP_SETTINGS_HREF);
    assert.ok(prompt.cancelLabel, "cancelling must always be offered");
    assert.ok(prompt.confirmLabel, "proceeding must be a deliberate, labelled choice");
    assert.notEqual(
      prompt.confirmLabel.toLowerCase(),
      prompt.cancelLabel.toLowerCase(),
      "the two must be distinguishable at a glance",
    );
  });

  check("the prompt stays honest when the item size is unknown", () => {
    const prompt = capOverridePrompt(facts({ incomingBytes: null }));
    assert.doesNotMatch(prompt.body, /NaN|undefined|null/);
    assert.match(prompt.body, /41\.1 GB/);
  });

  check("the prompt promises only what the override actually does", () => {
    // Going over the cap deletes nothing and does not touch the free-space
    // floor. Saying otherwise would make the confirmation a lie.
    const body = capOverridePrompt(facts()).body.toLowerCase();
    assert.match(body, /nothing else is deleted/);
    assert.match(body, /free disk space is still protected/);
  });

  // ── The dialog must explain its own arithmetic ──────────────────────────
  //
  // Measured verbatim from the running app with a 1 MB cap on an EMPTY folder:
  // "You are using 0 B of 1 MB under the download folder." — a library that is
  // plainly not full, reported as the reason it is full. The missing term is
  // the release being added; when its size is unknown, the app's own reserve is
  // what tipped the balance and was never mentioned.
  //
  // The server-side message had already been fixed for exactly this. The dialog
  // carries its own copy, which is what the owner actually reads, and it had
  // not been.
  const promptCases: Array<{
    name: string;
    over: Partial<StorageOverrideFacts>;
    mustSay: RegExp;
  }> = [
    {
      name: "an empty library with an assumed size names the reserve",
      over: { usedBytes: 0, capBytes: 1_000_000, incomingBytes: 2 * GB, incomingEstimated: true },
      mustSay: /does not report its size/i,
    },
    {
      name: "an empty library with a known size names the size",
      over: { usedBytes: 0, capBytes: 1_000_000, incomingBytes: 4 * GB, incomingEstimated: false },
      mustSay: /needs about/i,
    },
    {
      name: "a genuinely full library still reads correctly",
      over: { usedBytes: 41.1 * GB, capBytes: 20 * GB, incomingBytes: 4 * GB },
      mustSay: /needs about/i,
    },
  ];
  for (const row of promptCases) {
    check(`the cap dialog explains itself — ${row.name}`, () => {
      const prompt = capOverridePrompt(facts(row.over));
      assert.match(prompt.body, row.mustSay, prompt.body);
      assert.doesNotMatch(prompt.body, /NaN|undefined|null/, prompt.body);
      if (row.over.usedBytes === 0) {
        // The heart of it: a dialog citing "0 B" must also state the term that
        // made the sum exceed the cap, or the numbers contradict each other.
        assert.match(
          prompt.body,
          /set aside|needs about/i,
          `an empty library was called full with no reason given: ${prompt.body}`,
        );
      }
    });
  }

  check("an unknown release size is never presented as a measurement", () => {
    const assumed = capOverridePrompt(
      facts({ incomingBytes: 2 * GB, incomingEstimated: true }),
    ).body;
    const measured = capOverridePrompt(
      facts({ incomingBytes: 2 * GB, incomingEstimated: false }),
    ).body;
    assert.notEqual(assumed, measured, "an assumption must read differently");
    assert.match(assumed, /set aside/i);
    assert.doesNotMatch(measured, /set aside/i);
  });

  check("the reserve prompt does not reuse the cap's reassurances", () => {    // The cap copy promises free disk space is still protected. For a reserve
    // override that promise is exactly backwards — spare room is the thing
    // being spent — so the two must not share wording.
    const prompt = capOverridePrompt(
      facts({ limit: "reserve", freeBytes: 900_000_000, incomingBytes: 700_000_000 }),
    );
    const body = prompt.body.toLowerCase();
    assert.doesNotMatch(body, /free disk space is still protected/);
    assert.doesNotMatch(body, /cap/, "a reserve refusal is not about the cap at all");
    assert.match(prompt.body, /900(\.0)? MB/, "how much is free");
    assert.match(prompt.body, /700(\.0)? MB/, "what this item needs");
    assert.match(prompt.body, /200(\.0)? MB/, "what would be left afterwards");
    assert.doesNotMatch(prompt.body, /NaN|undefined|null/);
  });

  // ── The classifier: where the hard stop is actually drawn ────────────────
  //
  // These run the real `assertStorageBudget` against a stubbed volume so the
  // boundary is pinned at the arithmetic, not at the prose.
  const fitTable: Array<{
    name: string;
    freeBytes: number;
    incomingBytes: number;
    expect: StorageLimitKind;
  }> = [
    {
      name: "fits with room to spare but eats the margin → reserve (overridable)",
      freeBytes: 900_000_000,
      incomingBytes: 700_000_000,
      expect: "reserve",
    },
    {
      name: "drive already under the margin, item still fits → reserve",
      freeBytes: 400_000_000,
      incomingBytes: 50_000_000,
      expect: "reserve",
    },
    {
      name: "item larger than everything free → wont-fit (hard stop)",
      freeBytes: 400_000_000,
      incomingBytes: 2_000_000_000,
      expect: "wont-fit",
    },
    {
      name: "exactly equal to free space is still a fit, so it stays negotiable",
      freeBytes: 700_000_000,
      incomingBytes: 700_000_000,
      expect: "reserve",
    },
    {
      name: "one byte over free space flips it to a hard stop",
      freeBytes: 700_000_000,
      incomingBytes: 700_000_001,
      expect: "wont-fit",
    },
  ];
  for (const row of fitTable) {
    await checkAsync(row.name, async () => {
      const result = await assertStorageBudget({
        root: process.cwd(),
        maxStorageBytes: 500 * GB,
        incomingBytes: row.incomingBytes,
        _getFreeSpace: async () => ({ ok: true as const, freeBytes: row.freeBytes }),
        _getDirectorySize: async () => 0,
      });
      assert.equal(result.ok, false, "the budget must refuse in every one of these");
      assert.equal(
        result.ok === false ? result.limit : null,
        row.expect,
        `expected ${row.expect}`,
      );
      assert.equal(
        isOverridableLimit(result.ok === false ? result.limit : null),
        row.expect === "reserve",
        "overridability must follow directly from whether it fits",
      );
    });
  }

  // ── The refusal message must never contradict the numbers it prints ─────
  //
  // The owner's recurring complaint, twice now: being told storage is full
  // when it plainly is not. First it was 37 GB of files they could not see;
  // then it was this message reporting "using 0 B of 1.0 GB" — measured
  // verbatim from the running server with an empty download folder.
  //
  // A refusal is `used + incoming > cap`. Printing only `used` makes the
  // arithmetic look broken whenever the incoming release is the real reason,
  // which is every time the folder is near-empty.
  const capMessages: Array<{
    name: string;
    used: number;
    cap: number;
    incoming: number | null;
    estimated: boolean;
  }> = [
    {
      name: "empty folder, unknown release size (the measured case)",
      used: 0,
      cap: 1 * GB,
      incoming: 2 * 1024 * 1024 * 1024,
      estimated: true,
    },
    {
      name: "empty folder, known release size",
      used: 0,
      cap: 1 * GB,
      incoming: 4 * GB,
      estimated: false,
    },
    {
      name: "a genuinely full library",
      used: 41.1 * GB,
      cap: 20 * GB,
      incoming: 4 * GB,
      estimated: false,
    },
    {
      name: "no size information at all",
      used: 41.1 * GB,
      cap: 20 * GB,
      incoming: null,
      estimated: false,
    },
  ];
  for (const row of capMessages) {
    check(`cap message stays truthful — ${row.name}`, () => {
      const msg = storageCapMessage(row.used, row.cap, row.incoming, row.estimated);
      assert.doesNotMatch(msg, /NaN|undefined|null/);
      // It must always leave the owner somewhere to go.
      assert.match(msg, /Settings → Downloads/);

      if (row.used === 0) {
        // The specific lie: an empty library described as full/reached.
        assert.doesNotMatch(
          msg,
          /cap reached|storage is full|no space left/i,
          `an empty library must not be described as full: ${msg}`,
        );
        assert.ok(
          /\b0 B\b/.test(msg) === false || /in use/.test(msg),
          `if it prints 0 B it must label it as usage: ${msg}`,
        );
      }
      if (row.incoming != null) {
        // The number that actually caused the refusal has to appear.
        assert.match(
          msg,
          /needs|sets aside|reserving/i,
          `the incoming release must be accounted for: ${msg}`,
        );
      }
      if (row.estimated) {
        // Otherwise the owner cannot tell an assumption from a measurement.
        assert.match(
          msg,
          /does not report its size|size unknown/i,
          `an assumed size must be named as an assumption: ${msg}`,
        );
      }
    });
  }

  if (failures > 0) {
    console.error(`storage-override.test.ts: ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("storage-override.test.ts: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
