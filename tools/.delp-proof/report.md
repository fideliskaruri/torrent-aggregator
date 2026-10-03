# OPS-827 / OPS-821: real Sintel deletion

## Result

Both acceptance flows pass against a clean, shipping backend built from
`a4c990decce025d597331f2479744bd2aaa1159c` (`rebuild`).
No application or seeder fix was necessary. No LibraryRead, LibraryEndpoints,
Engine, DevFiling, web source, or `tools/.gitignore` was changed in this lane.

The previously reported DevFiling 408 **did not reproduce on current HEAD**.
With a fresh data directory, the original `tools/.jelly-proof/Seeder` hashed
**494/494 pieces** from a copied Sintel placed directly in its seed folder.
The first valid cold-magnet request reached Library and returned `NoDriveSpace`
because this new instance had no storage root yet, not a metadata timeout.
After adding the normal root through `/api/dev/library/roots`, DevFiling
accepted the torrent, downloaded the real bytes, and published the ordinary
`.partial` file to `Movies\Sintel (2010)\Sintel.mp4`.

Expected and actual file: **129,241,752 bytes**, SHA-256
`1dc6f2ca9762dfcc7d1b1843129a3e4f351d1fe935dea2241c7b359c11ebc1d8`.
The original seed's final digest and length are unchanged.

Historical context only: `eb3fba1` already added Engine metadata readiness
and binding fences, and `a4c990d` already demonstrated ordinary Sintel filing.
This run does not establish which historical change explains the earlier
timeout; it establishes that it no longer happens with this current clean build.
No symptom-only patch or fabricated completion was introduced.

## Real headless browser proof

Playwright MCP is configured `--headless --isolated`. Final proofs used fresh
browser contexts in that headless process with **no intercepted requests**.
The inherited shared page contained another proof's synthetic `wl-sintel`
response; that page and its screenshot were excluded from the final evidence.
The real server-generated item was `library:01a10376-d695-7c55-90f0-034faa845c23`.

| Check | 1280 × 900 | 390 × 844 | Evidence |
|---|---|---|---|
| Really filed Sintel visible as Ready | Pass | Pass, independently refiled | `real-library-1280.png`, `mobile-refiled-control.png`, `completed*.json` |
| Film More options exposes Delete files | Pass | Pass | `real-film-control-1280.png`, `real-film-control-390.png` |
| Dialog count and size match disk | Pass | Pass | `real-delete-dialog-1280.png`, `real-delete-dialog-390.png`, `mobile-refiled-dialog.png`, `delete-preview.json` |
| Cancel leaves the file available | Pass | Pass | Desktop dialog was cancelled after resizing; the subsequent real deletion still freed all bytes |
| Real Delete 1 file button sends POST | Pass | Pass | Browser response on each run: HTTP 200, `ok:true`, `freedFiles:1`, `freedBytes:129241752`, `failed:[]` |
| Card disappears immediately, without reload or waiting for a poll | Pass | Pass | `deleted-1280.png`, `deleted-390.png`: 0 titles and empty-library state |
| File and its Sintel directory removed | Pass | Pass | `disk-db-after-1280.json`, `disk-db-after-390.json` |
| MediaFile and active download ownership removed | Pass | Pass | `after-delete-1280.json`, `after-delete-390.json`, final database counts |
| Title ownership cleared | Pass | Pass | `title-after-delete-*.json`: `library.inLibrary:false`, `watchListItemId:null`; empty watchlist |
| Deletion survives backend restart | Pass | Pass | `restart-watchlist.json`, `restart-title.json`, `restart-filing.json` |

The real preview and dialog say:

> Deletes 1 files · 123.25 MB from this title.
>
> Sintel.mp4
>
> Delete 1 file

The backend's grammatical plural in that summary is pre-existing; its count and
size are correct. The retained WorkFolder row is a placement preference, not a
payload, inventory row or ownership fact. The actual folder is absent.
Final database: MediaFile, Download, DownloadFile, DownloadTarget, WatchItem
and FilePathClaim all **0**; the film Target is **removed**.

## Environment, validation and scope

- Detached worktree `D:\code\memtest\wt-delp` at the exact `rebuild` HEAD.
  Git cannot check out `rebuild` in a second worktree while it is already active.
- Published output `D:\code\memtest\bin-delp`; fresh data
  `D:\code\memtest\data-delp`; final root `D:\code\memtest\library-delp`.
- Only receiver HTTP **3962**. Seeder uses its own ephemeral loopback peer port.
- Development environment; scheduler disabled; background and no-browser flags.
- TMDB key supplied only in the child host environment, never in proof files.
- Backend build: **0 warnings, 0 errors**, `build-summary.log`.
  Seeder publish also succeeds. No web source changed, so no web build was needed.
- No proof endpoint was added, no direct database edits, no copied ownership,
  no unit tests, no modified seed, no port 3930 or stable-directory access.
- Existing unrelated worktree/index edits were left untouched.

Unproven: the old 408's root cause; missing/offline-file and multi-file deletion;
series/episode deletion; requester permission flows; double-submit/concurrency.
Those are not claimed by this real-film acceptance proof.

## Persistence and cleanup

This is a proof-only commit with `Refs: OPS-827` and `Refs: OPS-821`, no
Co-Authored-By, and only explicit proof paths staged. The commit is returned in
the handoff. `cleanup.json` records literal stopped process IDs and removal of
the isolated worktree, published outputs, fresh data, copied seed and library
root. Evidence JSON, screenshots and build/seeder logs remain here.
