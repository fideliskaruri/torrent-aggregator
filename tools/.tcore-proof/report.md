# Targets root-cause lane

Started 2026-10-03 21:26 +03; hard limit 35 minutes. Isolated detached snapshot
of `rebuild` in `D:\code\memtest\wt-tcore`; the branch was already checked out
elsewhere, so Git refused a second ordinary checkout. Output is
`D:\code\memtest\bin-tcore`. Only port **3963** was used. The scheduler was
disabled and the TMDB key was supplied only through the server child's environment.

## OPS-837: the reproduced conflict belongs to Api, not Targets

The exact failure is **not a stale target revision**:

1. On a fresh database, accept Sintel's existing intent through real
   `POST /api/dev/targets`.
2. Submit the licensed local Sintel through `/api/dev/filing/` with the
   proof adapter's separate target ID. With no root it returns
   `NoDriveSpace: No drive has space`.
3. Add a root through real HTTP. Repeat filing: HTTP **409**,
   `The download changed. Retry the action.`
4. Rename the supplied target ID and repeat: the same 409.

`server-fixed.log` records the actual database cause:
`SQLite Error 19: UNIQUE constraint failed: Target.workId`.
`Api/DevFiling.cs`, `AddAsync`, looks up a target only by the supplied ID and
inserts another film Target for the same WorkId. Store correctly enforces one
film Target per work. The adapter's generic commit exception disguises this
identity violation as a concurrent download change. Clearing Downloads cannot
remove that durable intent; changing its supplied ID cannot satisfy uniqueness.

Targets' real `/api/dev/targets/{existingId}/try` accepts the existing target
with HTTP **200** (`production-target-try.json`). It cannot dispatch discovery
while the explicitly requested scheduler-disabled configuration is active.
No retry loop, weakened uniqueness constraint, or Targets workaround was added.
**OPS-837 is blocked for the Api-owned composition.**

As a separate uncontaminated control, the same fresh no-root filing flow without
a competing intent successfully admitted after a root was added and completed
all **129,241,752** Sintel bytes. `completed-final.json` has the actual inventory;
its content digest equals the original seeder's full SHA-256 in `fixture.json`.
That is not claimed as a fixed duplicate-intent Try-now transfer.

Evidence: `accepted-existing-intent.json`, `no-root-admission.json`,
`root-added.json`, `retry-admission.json`, `retry-renamed-target.json`,
`production-target-try.json`, `completed-final.json`, `fixture.json`, and
`initial-transfer-cleanup.json`.

## OPS-751: bounded discovery owns its stopping decision

Each `DiscoveryPlan.RunAsync` previously started a new 28/54-second window and
an empty submission set. Check correctly cached completed verdicts, but canceled,
unfinished hashes had no verdict. Identical reads therefore refilled the scope's
budget with those hashes and waited again.

The fix records **only the stopping decision** in existing immutable Attempt
history: structural scope/policy fingerprint, canonical candidate-pool
fingerprint, a fingerprint of currently replayable Check evidence, stop reason,
and next-try deadline. There is no second verdict store or cached Plan answer.
Every warm call still reads Find and Check and runs Plan against current facts.
No canceled hash receives a manufactured verdict.

Scope identity ignores metadata observation timestamps, sorts episode IDs as a
set, and sorts query traces independently of source completion order. Changes
to meaningful metadata, policy, inventory, exclusions, candidates or valid Check
evidence invalidate reuse. The deadline uses Targets' existing release-calendar
scheduler, bounded by the source-cache window and actual verdict/Unknown expiry.
Only Check's public replayable evidence is fingerprinted, so transient/unstored
observations do not pretend to be durable verdicts.

### Real HTTP timing and integrity

| Scope / image | First bounded plan | Warm 1 | Warm 2 |
|---|---:|---:|---:|
| Before fix, Bunny 2160p | 28,387 ms | 28,048 ms | 28,023 ms |
| Canonical-key fresh data, Bunny 2160p | 30,881 ms | **301 ms** | **14 ms** |
| Canonical-key fresh data, Money Heist S1 2160p | 54,818 ms | **346 ms** | **83 ms** |

Both fresh-data warm repeats have **zero submissions and zero fresh probes**.
Cold/warm assignments, selected files and uncovered item IDs are identical.
Bunny retains one Weak and three Unknown verdicts; the season retains thirteen
Unknown verdicts. Unchecked alternatives remain unchecked, not Dead or Good.
See `canonical-film-*.json`, `canonical-season-*.json`, and `plan-integrity.json`.

Additional HTTP controls:

- Four simultaneous warm reads: **31–39 ms**, zero submissions/probes each
  (`concurrent-warm.json`).
- Changed quality policy starts its own bounded pass (`changed-policy.json`).
  Returning to the old policy can correctly invalidate its old stop when that
  pass has completed additional measurements; this is not an unchanged-input
  warm control.
- Delete one actual cached Unknown measurement in the private proof database:
  **28,011 ms**, four submissions/one fresh probe; next unchanged read
  **354 ms**, zero submissions/probes (`changed-verdict*.json`).
- Expire the private stopping deadline: **28,009 ms**, six submissions/three
  fresh probes; the next read **355 ms**, zero submissions/probes
  (`scheduled-retry-*.json`).
- The final replayable-evidence-stamp build is rerun for actual restart and
  deadline recovery in `final-restart-*.json` and `final-scheduled-retry-*.json`.
  Restart reopens changed source inputs (12 physical source requests per scope):
  film **29,015 ms**, then **17 ms** warm; season **54,688 ms**, then **82 ms**
  warm. The final due-deadline pass is **28,399 ms**, then **19 ms** warm.
  Each final warm answer has zero submissions and zero fresh probes. The
  restart's changed-pool first answers are explicitly not claimed as cache hits.

An early season control overlapped an overly broad proof-only deadline expiry
fixture. It is discarded, not counted as a pass. The final film/season controls
above use a new database, sequential requests and canonical episode-set keys.
The expiry fixture now selects only its own film work. A restart that actually
changes the reconstructed source pool correctly invalidates the old stop;
persisted stopping history is not permission to reuse changed inputs.

Final build: **0 warnings, 0 errors**, `build-final.log`. No unit tests.
Only four production paths under `backend/src/Targets` are changed.

## OPS-787: grouped swaps left unchanged

Root cause confirmed: `TargetRecovery.SwapAsync` explicitly refuses
`Assignments.Length != 1`; `TargetSwapTransfers.SwapAsync` admits, proves and
switches only one assignment. Library's same-name replacement namespace already
exists. A correct grouped solution needs prepare-all/prove-each followed by one
CAS transaction switching every participating Current association, with
all-or-nothing rollback. Looping through the existing single swap is unsafe.

Fewer than twelve minutes remained after the priority issues' implementation
and final film/season proof work. No speculative grouped-swap change was made.
OPS-787 retains **needs_verification** and its prior Library evidence.

## Isolation, cleanup and handoff

The locally seeded video was **copied**, not moved, from
`tools\.filing-proof\seed\Sintel\Sintel.mp4`, directly into this proof's seed
folder. The real seeder hash-checked **494/494** pieces before the receiver used
it. Original fixtures, `D:\code\memtest\stable`, port 3930/PID 3188, and every
other agent's port/process were untouched. No Api, Store, Library, Engine,
Metadata, Check, Plan or web code was edited.

Only the owned files are copied back. The foreign `tools/.gitignore` change is
left alone. Literal-PID shutdown, private worktree/data/payload removal, final
commit and issue handoff are recorded in `cleanup.json` and the final lane reply.
