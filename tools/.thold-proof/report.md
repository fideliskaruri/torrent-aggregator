# OPS-856: item-scoped import admission

Date: 2026-10-03/04 EAT. Application commit on `rebuild`:
`bbc6d0ac31c42c3cb47f25101154a032c2d1177e`.
Isolated proof content: `80b1728`, rebased onto the independently landed OPS-853
identity fix (`211ba6d`) and its evidence commit (`0c7fe91`).
Only Targets and Library's existing review port/documentation were changed by this lane.
No Metadata, Store, API or web changes were authored here.

## Root cause and owning design

`TargetPipeline.AcceptAsync` returned a work-wide import refusal before reading
the requested items' ownership. Eleven already-owned Rick and Morty S1 episodes
therefore incorrectly reported review-needed instead of already-owned. The same
work-wide check appeared in worker admission, recovery, picker and item actions.
A separate blanket switchover gate also held unrelated background items.

`TargetAdmission` now owns one admission policy. It reads Library inventory first,
then evaluates the possible identities of pending review items against only missing
requested items. Owner-held items are not queued. Automatic/request held intent
remains durable in Waiting, with a retry timestamp that makes it eligible after
the review ends, but is counted as held rather than newly queued. Scope materialization,
season download, requests, follow/hunter/AutoRules, worker claims, admission rechecks,
picker, resume/try/now and replacement recovery compose this shared policy.
First-full-root-scan and scheduler-enable prerequisites remain in place; a review
does not impose an unrelated global background hold.

Library already persists candidate `workId`, `episodeId`, `season`, `episode`,
`kind`, `workKey`, and filename/ancestor parse evidence. Its existing review port
now exposes those effective pending items for canonical identities. The batch
read resolves each identity once per call, rather than repeating metadata reads
for every target. No persisted hold, ownership copy, new background service,
provider identity implementation, or filename re-parser was introduced.

**The Rick reviews are not genuinely unscoped.** S02E08 records an exact
candidate for `series:rick and morty`, plus an unmapped candidate for the public
`rick-and-morty-2013` identity. That second candidate has null coordinates, but its
recorded filename parse is season 2, episode 8. S09E01 has the same shape with
season 9, episode 1. Those unmapped candidates must not become work-wide holds.
`reviews-effective.json` retains the actual eleven pending reviews.
When a known-work review has neither candidate episode identity nor usable
filename/ancestor coordinates, a whole-work hold is correct. Unmatched files with
no candidate work do not claim some unrelated title. Film candidates hold that film.

## Isolation and baseline reproduction

The requested `git worktree add D:\code\memtest\wt-thold rebuild` refused because
`rebuild` was already checked out. Used the same rehearsal fallback:
`git worktree add --detach D:\code\memtest\wt-thold rebuild`.
Initial baseline HEAD was `d8990e3`.

`prepare.py` backed up `D:\code\memtest\stable\data\torrentflow.db` through SQLite's
read-only backup API, including committed WAL state, and copied all sidefiles.
Every one of the 76 real files under `D:\Torrents` was byte-copied, without
junctions, into `D:\code\memtest\thold-data\media`.
The documented converter ran over `thold-data\source` into `thold-data\converted`
with `path-map.json`. All 57 operative converted paths were audited under that
isolated directory; original roots were not configured as write destinations.
All 76 source/copy SHA-256 pairs matched afterward; source lengths and mtimes
remained unchanged. The copied source database was also unchanged.

Baseline PID 56856, HTTP 3963 only, returned:
`ok=false, owned=0, queued=0`, with the import refusal for Rick S01E08.
This is captured in `baseline-owned.json`.
Scheduler was disabled both in persisted settings and host configuration throughout.
TMDB_API_KEY was supplied only in each child process's environment.
No key is present in the proof files.
The live PID 3188/HTTP 3930 was never called, stopped, restarted or reconfigured.

```powershell
dotnet build backend\src\Api\Api.csproj -o D:\code\memtest\bin-thold
dotnet build backend\tools\Convert\Convert.csproj -o D:\code\memtest\bin-thold-convert
dotnet D:\code\memtest\bin-thold-convert\TorrentFlow.Convert.dll `
  --from D:\code\memtest\thold-data\source `
  --to D:\code\memtest\thold-data\converted `
  --path-map tools\.thold-proof\path-map.json
dotnet D:\code\memtest\bin-thold\TorrentFlow.dll --urls http://127.0.0.1:3963 `
  --TorrentFlow:DataDirectory D:\code\memtest\thold-data\converted `
  --TorrentFlow:Scheduler:Disabled true --background --no-browser
```

## Real HTTP outcomes

The final four cases use the original public `rick-and-morty-2013` key and
`POST /api/title/{workKey}`, not invented catalog or inventory fixtures.

| Case | Actual response | Evidence |
|---|---|---|
| Owned S01E08 | ok=true, owned=1, queued=0, Already in your library | final-owned-S01E08.json |
| Whole season 1 | ok=true, owned=11, queued=0, Already in your library | final-owned-season1.json |
| Review-covered S02E08 | ok=false, owned=0, queued=0, exact Import review message | final-held-S02E08.json |
| Unrelated missing S02E01 | ok=true, owned=0, queued=1 | final-missing-S02E01.json |
| Every owned S01E01-E11 | Eleven owned=1, queued=0 replies | final-all-owned-episodes.json |
| Mixed season 2 on the confirmed provider identity | queued=9, owned=0, held=1; counts retained in message | mixed-season2.json |
| Manual real hunter, follow beginning S09E01 | S09E01 durable Waiting with exact review message; S09E02-E10 Wanted | hunter.json, automation-targets.json |
| Developer item reply | owned item held=0; covered item held=1, queued=0 | shipping-owned.json, shipping-held.json |

The first season/public-S2 attempts before OPS-853 landed encountered the existing
provider episode uniqueness failure and correctly remained pending metadata scope
intent, rather than inventing missing catalog episodes. That is retained in
`owned-season1.json`, `held-S02E08.json`, `missing-S02E01.json`.
After the other agent's identity fix landed, this lane rebased its isolated build
and reran all four required public-key cases successfully. This lane did not patch
Metadata or Store, rewrite inventory, manufacture owned episodes, dismiss the
reviews, or mask metadata failures.

All newly accepted targets were removed through real DELETE HTTP actions.
The preliminary pending scope intents were cancelled through the real Wanted API.
The temporary follow was disabled. Final integrity: **ok**, **zero FK failures**,
**14 MediaFiles**, **30 Downloads**, **zero active newly-created targets** and
**zero pending scopes**. Final physical engine HTTP reads contain **zero torrents
and zero diagnostics**; no real-title bytes were downloaded, not even a first piece.
The stable payloads remain untouched.

Builds: **0 warnings, 0 errors**, including the final build with OPS-853.
No unit tests were added or run. Self-review checked item ownership precedence,
candidate/coordinate fallback, canonical identities, mixed counts, held durable
intent release eligibility, worker/recovery reuse and the specific-file diff.

## Limits

Requests and AutoRules share the verified admission function but were not each
driven through their full HTTP creation/approval flows. No enabled scheduler,
swarm/download completion, reboot during a hold, UI, live cutover or independent
QA agent was exercised in this slice. A genuinely known-work/no-coordinate series
review is handled conservatively in code but was not synthesized for an HTTP test.
The hunter API's existing coarse item projection calls a held no-new-queue item
`existing`; its actual target is Waiting and it is not included in queued counts.
Targets exposes numeric Held, while the production title adapter retains its old
field shape and communicates held counts through the batch message.

## Cleanup

See `cleanup.json`. Every proof host was stopped using its literal PID
(56856, 19600, 5928, 40608, 35444). Copied source/media/converted data,
isolated worktree and all proof build outputs were removed. HTTP 3963 was released.
Only this evidence directory persists. `tools/.gitignore` was not changed or staged.
