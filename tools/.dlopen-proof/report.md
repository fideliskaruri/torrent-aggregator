# Completed download actions: OPS-866 / OPS-865

Tested detached HEAD `c7db58f` in `D:\code\memtest\wt-dlopen`, 2026-10-04.
HTTP port **3963 only**. No requests, builds, restarts, reads of data, or process
operations against 3930 / PID 3188 / `D:\code\memtest\stable`.

## Root cause and owning fix

- **OPS-866:** Store's `ProposeFiledAsync` deliberately commits
  `Selected=false`, `Filed=true`, and `MediaFileId` atomically with MediaFile.
  Selected is pending Engine transfer intent, not completed Library ownership.
  LocalFiles incorrectly required both Selected and Filed, then opened the
  placement reservation's FinalPath. Both normal Targets filing and dev filing
  clear Selected. The resulting no-video 409 was captured in the existing
  `.qag-proof/completed-open-http.json`.
  Commit **519b6e2** joins filed video bindings to Library inventory by
  MediaFileId, selects the largest owned video deterministically, and opens its
  MediaFile.Path. Filing, Store state, route wiring and metadata are unchanged.
- **OPS-865:** `canOpenFinishedFile` recognized only the historical `downloaded`
  spelling, although the built-in server returns `complete` and the shared
  downloaded-state helper already recognizes it. Commit **c7db58f** reuses
  `isDownloaded`, preserving builtin-only and missing-file guards. The existing
  folder menu now naturally says **Show in folder**, without a second copy rule.

## Real proof

Fresh data `D:\code\memtest\dlopen-data`, confirmed fresh root
`D:\code\memtest\dlopen-library`, copied licensed Sintel fixture
`D:\code\memtest\dlopen-fixture`. Development; scheduler disabled;
TMDB credential passed only in the initial server child's environment.
`PLAYWRIGHT_NO_REVEAL=1` intentionally prevents player/file-manager windows.

Source `tools\.jelly-proof\Seed.ps1` with explicit server URL produced
`hash=E1D833FE2ADC88BC76B8B29E380B80E2CE43F82C pieces=494/494`,
injected the receiver's allocated peer port 58535 and connected. Peer traffic
used the existing Engine-selected ephemeral port, not another HTTP server.
The ordinary documented dev filing composition ran real Engine and Library.

| Check | Result | Evidence |
|---|---|---|
| Backend Release build | 0 warnings / 0 errors | backend-build.log |
| `npm run build` | PASS; TypeScript + Vite, no warning diagnostics | web-build.log |
| Real full Sintel filing | PASS, selected=false, filed=true, video | admission.json, filed.json |
| Final payload | 129241752 bytes; seed/final SHA-256 identical | digest.json |
| POST Open | 200, ok=true, correct Library final path, launched=false | open.json |
| POST Show in folder | 200, same final path, mode=reveal, launched=false | reveal.json |
| Server row | complete, verified=true, filesMissing=false, builtin | torrents.json |
| Real Downloads Open control | PASS at 390 / 768 / 1280, real 200 response | browser.json |
| Real overflow Show in folder control | PASS at all three widths, real 200 response | browser.json |
| Screenshots | Open in row; Show in folder in overflow | downloads-*.png, downloads-menu-*.png |
| Page errors / console errors / horizontal overflow | None at all three widths | browser.json |
| Invalid ID / mode, absent ID, external client | Expected 400 / 404 / 409 refusals | edges.json |
| Removed physical file | Both actions refuse 410; restore reopens | edges.json |
| Server restart with persisted inventory | Open still 200, correct path, no launch | restart-open.json |

Final path:
`D:\code\memtest\dlopen-library\Movies\Sintel (2010)\Sintel.mp4`.
SHA-256:
`1DC6F2CA9762DFCC7D1B1843129A3E4F351D1FE935DEA2241C7B359C11EBC1D8`.

Headless Edge/Playwright drove the actual controls against the isolated server,
not mocked responses. Mobile overflow covers part of the row while expanded;
the paired menu-closed screenshot clearly shows its Open button.

## Review and limits

Direct critic: the change reads MediaFile instead of duplicating ownership;
it does not reselect filed files or restart completed payloads. Largest-video
selection and all existing filesystem/root/link safety checks are preserved.
The UI reuses the one finished-state helper shared by badges and filters;
finishing/held/queued do not become Ready or Open. No Api route wiring changes,
Metadata, Catalog, settings pages, new packages or unit tests.
Store has no separate README; its boundaries in backend/README.md and the actual
filing transaction were reviewed.

**Unproven:** launching a real player/file manager is deliberately suppressed.
No separately seeded multi-video pack, episode, external-client or imported-only
open flow; requester access and junction refusal were not re-exercised.
Independent coordinator/QA critic remains required; this is implementer proof.
The source seeder later printed HandshakeFailed on post-completion reconnects;
the full received digest and successful filed inventory establish completion.

## Cleanup

Dedicated server PID 40496, seeder PID 19320 / launcher 62824, and restarted
server PID 62528 stopped by literal PID. Own worktree, fixture, data, Library and
bin-dlopen output removed. `cleanup.json` records path and port checks.
Only this evidence folder is staged for proof; tools/.gitignore is left alone.
