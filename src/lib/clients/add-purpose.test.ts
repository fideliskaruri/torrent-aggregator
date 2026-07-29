import assert from "node:assert/strict";

import {
  resolveEffectiveAdd,
  resumeSelectionForLookup,
  type ExistingOriginLookup,
} from "./add-purpose";
import type { TorrentPurpose } from "./types";
import {
  EVICTING_ORIGIN,
  PREWARM_ORIGIN,
  STREAM_ORIGIN,
  USER_ORIGIN,
} from "@/lib/prewarm/types";

/**
 * Rule 4 — monotonic transitions, enforced in ONE function (resolveEffectiveAdd)
 * and proven here for EVERY (purpose × existing-origin) pair.
 *
 * A "demotion" is any transition that lowers a row's eviction-protection rank —
 * exactly the move that grants deletion eligibility over files the user never
 * consented to lose. This table asserts no such move is reachable, for any
 * input, from any starting origin, including a failed read and an unclassifiable
 * legacy origin. If a future edit weakens the classifier (e.g. lets a Play
 * deselect a `user` row, or adds `user`/`evicting` to a promoteFrom), a row here
 * turns RED.
 */

// HIGHER = safer from deletion.
const RANK: Record<string, number> = {
  [USER_ORIGIN]: 3, // a kept download — never swept
  [STREAM_ORIGIN]: 2, // an evictable playback cache
  [PREWARM_ORIGIN]: 2, // speculative, evictable
  [EVICTING_ORIGIN]: 1, // already claimed by a sweep — must stay claimed
};
// An origin we cannot positively classify is treated as MAXIMALLY protected:
// never deselect it, never move it toward eviction.
function rankOf(origin: string): number {
  return RANK[origin] ?? Number.POSITIVE_INFINITY;
}

const PURPOSES: TorrentPurpose[] = ["keep", "stream", "prewarm"];
const EXISTING: ExistingOriginLookup[] = [
  { status: "missing" },
  { status: "error" },
  { status: "found", origin: USER_ORIGIN },
  { status: "found", origin: STREAM_ORIGIN },
  { status: "found", origin: PREWARM_ORIGIN },
  { status: "found", origin: EVICTING_ORIGIN },
  { status: "found", origin: "external-legacy-origin" },
];

let checked = 0;
for (const purpose of PURPOSES) {
  for (const existing of EXISTING) {
    const eff = resolveEffectiveAdd(purpose, existing);
    const label =
      `${purpose} × ${existing.status}` +
      (existing.status === "found" ? `(${existing.origin})` : "");
    checked += 1;

    // INVARIANT 1 — the monotonic core: `user` is NEVER a promotion SOURCE. No
    // add path may move a row OUT of the kept state.
    assert.ok(
      !eff.promoteFrom.includes(USER_ORIGIN),
      `${label}: user must never appear in promoteFrom (that is a demotion source)`,
    );

    // INVARIANT 2 — only an EXPLICIT user action may steal a lease. A background
    // `prewarm` must never reclaim a row a sweep has claimed (`evicting`): it
    // loses the race deterministically. Download (keep) and Play (stream) MAY
    // steal — that is issue D reviewer round 2, proven positively below — but a
    // speculative prewarm may not.
    if (purpose === "prewarm") {
      assert.ok(
        !eff.promoteFrom.includes(EVICTING_ORIGIN),
        `${label}: a speculative prewarm must never steal an evicting lease`,
      );
    }

    // INVARIANT 3 — an APPLIED compare-and-set never lowers rank. If the concrete
    // existing origin is one this result would transition, the destination must
    // be at least as protected as the source.
    if (
      existing.status === "found" &&
      eff.promoteTo != null &&
      eff.promoteFrom.includes(existing.origin)
    ) {
      assert.ok(
        rankOf(eff.promoteTo) >= rankOf(existing.origin),
        `${label}: transition ${existing.origin} -> ${eff.promoteTo} must not lower eviction rank`,
      );
    }

    // INVARIANT 4 — a kept `user` download is untouchable: never deselected
    // (which would halt a real download), never relabelled to a lower state.
    if (existing.status === "found" && existing.origin === USER_ORIGIN) {
      assert.notEqual(
        eff.selection,
        "deselect",
        `${label}: a user download must never be deselected`,
      );
      assert.ok(
        eff.promoteTo == null || eff.promoteTo === USER_ORIGIN,
        `${label}: a user download must never be relabelled to a lower state`,
      );
    }

    // INVARIANT 5 — a Play (stream) only ever acts on a cache it can prove is
    // evictable: stream, prewarm, or a row a sweep is mid-evicting (which a Play
    // STEALS back to a live stream). Anything else — a kept `user` download or an
    // unclassifiable legacy origin — is LEFT: no deselect, no relabel.
    if (purpose === "stream" && existing.status === "found") {
      const touchableCache =
        existing.origin === STREAM_ORIGIN ||
        existing.origin === PREWARM_ORIGIN ||
        existing.origin === EVICTING_ORIGIN;
      if (!touchableCache) {
        assert.equal(
          eff.selection,
          "leave",
          `${label}: a Play must leave a non-cache row untouched`,
        );
        assert.equal(
          eff.promoteTo,
          null,
          `${label}: a Play must not relabel a non-cache row`,
        );
      }
    }

    // INVARIANT 6 — fail closed on a read error: a Play/Prewarm must never
    // deselect on an unreadable origin, and any degraded outcome is flagged so
    // it is never a silent conversion (issue G).
    if (existing.status === "error") {
      if (purpose !== "keep") {
        assert.equal(
          eff.selection,
          "leave",
          `${label}: a failed origin read must not deselect`,
        );
      }
      assert.equal(
        eff.degraded,
        true,
        `${label}: a failed read must be surfaced as degraded, never silent`,
      );
    }
  }
}

// The one legitimate rank INCREASE must actually be present: a Download of a
// fresh hash selects the whole file and is born/kept `user`.
{
  const keepFresh = resolveEffectiveAdd("keep", { status: "missing" });
  assert.equal(keepFresh.selection, "select-all", "a Download selects the whole file");
  assert.equal(keepFresh.birthOrigin, USER_ORIGIN, "a Download is born user (kept)");
  assert.equal(keepFresh.promoteTo, USER_ORIGIN, "a Download promotes up to user");

  // …and a Download of a speculative prewarm promotes it up to a real download
  // (issue B) — the only allowed change to an existing row's class, and it is an
  // increase, never a demotion.
  const keepOverPrewarm = resolveEffectiveAdd("keep", {
    status: "found",
    origin: PREWARM_ORIGIN,
  });
  assert.equal(keepOverPrewarm.promoteTo, USER_ORIGIN);
  assert.ok(keepOverPrewarm.promoteFrom.includes(PREWARM_ORIGIN));
  assert.ok(rankOf(USER_ORIGIN) > rankOf(PREWARM_ORIGIN), "prewarm -> user is an increase");

  // …and the STEAL (issue D reviewer round 2): an explicit user action beats a
  // sweep that has already claimed the row (origin `evicting`). A Download steals
  // it up to a kept `user` download and selects the whole file; a Play steals it
  // back to a live `stream` but stays deselected. Both are rank INCREASES over
  // `evicting` (rank 1), so neither is a demotion — the sweep's re-check under
  // its now-cleared lease is what actually aborts the delete.
  const keepStealsEvicting = resolveEffectiveAdd("keep", {
    status: "found",
    origin: EVICTING_ORIGIN,
  });
  assert.equal(keepStealsEvicting.promoteTo, USER_ORIGIN, "Download steals evicting -> user");
  assert.ok(
    keepStealsEvicting.promoteFrom.includes(EVICTING_ORIGIN),
    "Download's promote guard must include evicting so the steal actually fires",
  );
  assert.equal(keepStealsEvicting.selection, "select-all", "a stolen Download selects the whole file");
  assert.ok(rankOf(USER_ORIGIN) > rankOf(EVICTING_ORIGIN), "evicting -> user is an increase");

  const streamStealsEvicting = resolveEffectiveAdd("stream", {
    status: "found",
    origin: EVICTING_ORIGIN,
  });
  assert.equal(streamStealsEvicting.promoteTo, STREAM_ORIGIN, "Play steals evicting -> stream");
  assert.ok(
    streamStealsEvicting.promoteFrom.includes(EVICTING_ORIGIN),
    "Play's promote guard must include evicting so the steal actually fires",
  );
  assert.equal(
    streamStealsEvicting.selection,
    "deselect",
    "a stolen Play stays a stream — never whole-file selected",
  );
  assert.ok(rankOf(STREAM_ORIGIN) > rankOf(EVICTING_ORIGIN), "evicting -> stream is an increase");
}

assert.equal(
  checked,
  PURPOSES.length * EXISTING.length,
  "every purpose x origin pair must be covered",
);

// ── issue C on the explicit-resume path (resumeTorrent) ──────────────────────
// A resume must derive selection from the STORED origin. The bug that shipped:
// resume unconditionally whole-file selected, so un-pausing a stream/prewarm
// turned it into a full download. These assertions go RED against that: a
// stream/prewarm resume must NOT be "select-all", only a kept `user` row is.
{
  assert.equal(
    resumeSelectionForLookup({ status: "found", origin: USER_ORIGIN }),
    "select-all",
    "resuming a kept download must continue the whole-file download",
  );
  assert.equal(
    resumeSelectionForLookup({ status: "found", origin: STREAM_ORIGIN }),
    "deselect",
    "resuming a stream must NOT whole-file select (the item-3 bug)",
  );
  assert.equal(
    resumeSelectionForLookup({ status: "found", origin: PREWARM_ORIGIN }),
    "deselect-cap",
    "resuming a prewarm must stay deselected and peer-capped",
  );
  assert.equal(
    resumeSelectionForLookup({ status: "found", origin: EVICTING_ORIGIN }),
    "deselect",
    "resuming a row mid-eviction treats it as an ephemeral stream, never whole-file (issue D)",
  );
  assert.equal(
    resumeSelectionForLookup({ status: "found", origin: "external-legacy-origin" }),
    "select-all",
    "an unclassifiable legacy row resumes as a normal download (never a stream)",
  );
  assert.equal(
    resumeSelectionForLookup({ status: "missing" }),
    "leave",
    "an absent row: reconnect only, never reselect nor deselect",
  );
  assert.equal(
    resumeSelectionForLookup({ status: "error" }),
    "leave",
    "a failed read must never reselect (convert a stream) nor deselect (halt a keep)",
  );
}

console.log(
  `PASS add-purpose demotion-refusal table: ${checked} purpose x origin pairs proven; no demotion of a user download is reachable`,
);
