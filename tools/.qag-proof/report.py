import collections
import json
import pathlib

OUT=pathlib.Path(__file__).parent
load=lambda name:json.loads((OUT/name).read_text(encoding="utf-8-sig"))
walk=load("walk.json")
focus=load("focused.json")
raw=load("contract/raw.json")
bugs=load("bugs-filed.json")
groups=collections.defaultdict(list)
for row in raw:
    groups[(row["method"],row["route"])].append(row)
passing=sum(any(r["category"]=="pass" for r in values) for values in groups.values())
screenshots=list((OUT/"screenshots").glob("*.png"))
text=[
    "# Phase 4–6 dedicated QA walk (OPS-860)",
    "",
    "Tested HEAD: `303c8676f7443022eca2f5b19d5eae73cb1da177`, detached isolated worktree `D:\\code\\memtest\\wt-qag`.",
    "Started 2026-10-04 00:18 +03. No application code fixed. Only this proof folder is committed.",
    "",
    "## Outcome",
    "",
    f"**Contract gate FAIL: {passing}/{len(groups)} routes pass the unchanged strict comparator, {len(groups)-passing} fail; {len(raw)} samples.**",
    "All four previously excluded route patterns were included and still return the host's missing-route 404. Existing OPS-799 received the evidence instead of a duplicate issue.",
    "Two strict sample failures are over-narrow captured nullability, not demonstrated app defects: Activity `infoHash:null` and roots `lastError:null` are allowed by the consuming web types. Activity already passes through its other sample; reviewing the roots nullability raises the reviewed route count to 81/86. The remaining fifth failure is the open-folder response/status discrepancy (OPS-863).",
    "The original library/delete capture used an absent historical ID. A second comparison using a real copied library item passes; both samples remain visible. The contract tool's route result is best-of-samples, not a claim that every sample succeeds.",
    "",
    f"**Browser:** {len(walk)} owner page/width/dataset checks (24 route variants × two widths × copied/empty), {len(focus)} focused Settings/season/preview checks, plus 24 lazy-artwork scroll checks and active/completed/removal captures. {len(screenshots)} screenshots retained.",
    "Owner walks recorded no console errors, failed HTTP requests, document-width overflow, em dashes, or flagged internal pipeline jargon. The requester calendar preview alone produced a repeatable HTTP 403 at both widths. These automated checks do not establish contrast compliance or every possible flow.",
    "",
    "**Gate spot checks:** Sintel finished with identical seed/final SHA-256, directly in `Movies\\Sintel (2010)\\Sintel.mp4`; no partial leftovers. The cap worked 2→1→2→1 within the one-second observations. UI Delete with files removed the final film and download row; only the root's operational `.torrentflow-root` marker remains. Completed-file Open actions fail (OPS-865/866).",
    "",
    "## Isolation and setup",
    "",
    "- A read-only SQLite backup of `D:\\code\\memtest\\stable\\data` and side-file copies were converted; all 76 media/supporting files were actual copies, path-mapped from the original media root to `D:\\code\\memtest\\qag-data\\media`.",
    "- API/Converter builds were isolated in `bin-qag` / `bin-qag-convert`; the web was built in the detached worktree. Build evidence is retained. The existing dependency store was shared by a junction only; no dependency installation was necessary.",
    "- Development, scheduler disabled, ports 3961 and 3962 only. TMDB credential supplied to child environment, never printed or persisted in proof.",
    "- An initial contract invocation raced host startup; its samples were discarded and the entire run restarted after HTTP health readiness. No startup-race failures are counted. Cold-start latency is not claimed: browser/API work warmed metadata concurrently.",
    "- The first 3962 Sintel gate ran before the empty page sweep. 3962 was then restarted with genuinely fresh `empty2` data for all empty-state captures. After those captures, the final Sintel proof used a distinct fresh root `qag-library-final`.",
    "- Source `tools\\.jelly-proof\\Seed.ps1` was used, not the stale seeder binary. The cap test used two distinct torrent hashes with byte-identical licensed Sintel copies and a proof-only 256 KiB/s seeder, never real-title payloads.",
    "- The cap was changed using the public PUT settings route; two physical Engine admissions were made through the development fixture endpoint. This proves Engine scheduling and settings propagation, not two end-user search/admission journeys.",
    "- `PLAYWRIGHT_NO_REVEAL=1` was supplied for the second-run finished-file check. An early inherited open-folder contract fixture invoked the existing parent-folder fallback; subsequent targeted reproduction used `reveal:false` and no player was launched.",
    "- No live port 3930 requests, changes, restarts, or stop operations. Live PID 3188 was only checked for continued existence during cleanup.",
    "- Runtime process memory/start timestamps are in `runtime-memory.json`; cold startup time was not measured reliably and is not reported as passing.",
    "",
    "## Bugs filed",
    "",
]
for b in bugs:
    text.append(f"- **{b['id']}**: {b['title']}. Exact repro, screenshot path, and module ownership are in Ops Tracker and `bugs-filed.json`.")
text += ["", "## Per-route contract results", "", "| Method | Route | Strict result | Samples | Failing evidence |", "|---|---|---|---:|---|"]
for key,values in sorted(groups.items(),key=lambda p:(p[0][1],p[0][0])):
    result="PASS" if any(r["category"]=="pass" for r in values) else "FAIL"
    failures=[f"{r['status']} {r['category']}: "+("; ".join(r["missingOrTypeChanged"]) or str(r["body"].get("message","")) if isinstance(r["body"],dict) else "") for r in values if r["category"]!="pass"]
    text.append("| "+ " | ".join([key[0],key[1],result,str(len(values)),"; ".join(failures).replace("|","\\|")])+" |")
text += ["", "Per-sample requests, expected/actual status, bodies, type changes, and allowed extra fields: `contract/raw.json`. The inherited comparison script is retained under `contract/measure.py`; it includes all 86 registered web routes and has no exclusions.", "", "## Page coverage", "", "| Page / variant | Copied 390 | Copied 1280 | Empty 390 | Empty 1280 | Finding |", "|---|---|---|---|---|---|"]
for name in dict.fromkeys(r["page"] for r in walk):
    matches=[r for r in walk if r["page"]==name]
    cells=[]
    for run,width in [("copied",390),("copied",1280),("empty",390),("empty",1280)]:
        row=next(r for r in matches if r["run"]==run and r["width"]==width)
        cells.append("Captured" if row["result"]=="checked" else "BLOCKED: "+row.get("error",""))
    finding={"series-title":"Canonical copied ownership mismatch OPS-861; season 2 separately captured","settings":"Audio policy copy OPS-862; five collapsed sections separately expanded","downloads":"Active/completed additional proof; finished actions OPS-865/866"}.get(name,"No observed defect in scoped check")
    text.append("| "+" | ".join([name,*cells,finding])+" |")
text += [
    "",
    "Browse type categories All/Films/Series/Anime and representative Comedy/Drama/Action genre filters were covered; this is not an all-genres content audit. Search includes populated and impossible-query empty results. Series season switching and episode rows were exercised. Settings covers default Downloads/quality/audio/download-app plus Advanced, Sources, Jellyfin, Remote access, App, and Drives/import.",
    "Requester preview covers Browse, Search, film/series/anime titles, Library, Upcoming, Requests, Alerts, and Settings/Downloads guards at both widths. Preview was entered through the actual More/header button, not storage injection. Actual authenticated remote requester sessions were not exercised.",
    "The legacy `/activity` and `/client` aliases redirect to Notifications and Downloads; their destination pages were covered. Share, About, Everything, History and Rules were also captured.",
    "Full-page screenshots put fixed navigation in its actual captured viewport position. Long-page lazy images were explicitly loaded by scrolling in the supplementary walk; blank off-viewport placeholders in earlier captures were not filed as poster bugs.",
    "",
    "## Download / library checks",
    "",
    "| Check | Result | Evidence |",
    "|---|---|---|",
    "| Sintel full completion, bytes and SHA match unchanged seed | PASS | gate-completion.json, gate-final.log |",
    "| Final Movies/Sintel (2010) folder; no partial leftovers | PASS | gate-completion.json |",
    "| Active and completed Downloads at both widths | Captured; completed actions FAIL | active-download-*.png, completed-download-*.png |",
    "| New owned Sintel no longer offers Download | PASS | owned-film-*.json and screenshots |",
    "| Existing converted owned Rick episodes through canonical ID | FAIL OPS-861 | rick-canonical.json vs rick-rick-and-morty-2013.json |",
    "| Lower cap from 2 to 1 | PASS: one active/Run, other Queued/Stopped | cap.json |",
    "| Raise cap from 1 to 2 | PASS: both active/Run/Downloading | cap.json |",
    "| Lower cap a second time | PASS | cap.json |",
    "| Remove two partial cap downloads | PASS: physical rows and files empty | cap-leftovers.json, cap.json |",
    "| UI Delete with files on completed Sintel | PASS: torrent list empty; film gone | removal-ui-result.json, removed-download-390.png |",
    "| Open completed Sintel | FAIL 409 no-video, OPS-866 | completed-open-http.json, completed-bindings.json |",
    "| Show/Open finished controls | FAIL OPS-865 | completed-menu.json and screenshots |",
    "| Big Buck Bunny, forced-stall swap, actual Jellyfin scan | NOT EXERCISED | Beyond requested spot checks / no permitted Jellyfin server |",
    "",
    "These spot checks do not claim that all Phase 4 or Phase 5 gates pass. No real-title downloads were started.",
    "",
    "## Cleanup",
    "",
    "See `cleanup.json`: dedicated API/seeder processes stopped by recorded literal PIDs; copied media/data/fixtures, build outputs and detached worktree removed. Live PID 3188 remains alive. Only `tools\\.qag-proof\\` was staged; the evidence commit uses `Refs: OPS-860` and no Co-Authored-By.",
    "",
]
(OUT/"report.md").write_text("\n".join(text),encoding="utf-8")
contract=["# Readiness-gated contract rerun","",f"Tested HEAD 303c867; 3961; {passing}/{len(groups)} strict route passes; {len(raw)} samples.","Real media copies and path-map conversion; scheduler disabled. All four previously excluded patterns are included.","See ../report.md for fixture/nullability review and bugs.","","| Method | Route | Result |","|---|---|---|"]
for (method,route),values in sorted(groups.items(),key=lambda p:(p[0][1],p[0][0])):
    contract.append(f"| {method} | {route} | {'PASS' if any(r['category']=='pass' for r in values) else 'FAIL'} |")
(OUT/"contract/report.md").write_text("\n".join(contract),encoding="utf-8")
print(f"Report: {passing}/{len(groups)} strict route passes; {len(walk)} owner walk entries, {len(focus)} focused entries; {len(screenshots)} screenshots")
