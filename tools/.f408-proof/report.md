# OPS-858 / OPS-855 / OPS-854: local filing and real visual proof

## Root cause and owning change

The historical `tools\.jelly-proof\seeder-bin\Seeder.dll` is stale. It embeds
`http://127.0.0.1:3973/api/dev/engine/torrents`, ignores the supplied receiving
server argument, and silently waits on the wrong instance. Its SHA-256 is
`def2d1ec096d30ad698b29cccd36b359759c8ffe5f396922082efa1366e4692a`.
Hashing 494/494 pieces proves the fixture, not discovery or a connection.

The current owning Seeder source already requires an explicit loopback receiver
and reads **diagnostics**, including metadata probes, plus that receiver's
current peer listen port. The working delp proof rebuilt that source; a reused
historical output does not pick up this behaviour. With that old output, the
exact symptom reproduces five times even when the torrent and magnet hashes
match. With current source, five new cold hashes really download and file.
The historical failing reports do not record their binary fingerprints, so
their exact executed DLL identity cannot be established retrospectively.

The fix belongs to the proof seeder: new `tools\.jelly-proof\Seed.ps1` builds
and launches current source instead of trusting a previous proof's binary.
`tools\.jelly-proof\README.md` gives the complete copy/build/root/metadata/
filing/poll/digest recipe; the Seeder README now routes callers through it.
No application code, Engine timeout, peer policy, admission, metadata ownership,
Targets, Store or Converter was changed. No symptom-only production workaround.

### Recipe differences and excluded causes

| Fact | Working/current recipe | Failing/reused recipe |
| --- | --- | --- |
| Receiver address | Explicit `http://127.0.0.1:3964`, validated by source | Historical DLL polls 3973 regardless of second argument |
| Peer discovery | Seeder injects the actual receiver's current peer port after its hash appears in diagnostics | No injection to 3964; seeder only logs full hashing |
| Metadata visibility | `diagnostics` includes `probe:true,state:"Metadata"` | The payload-only `torrents` array is empty during metadata; it is not a readiness check |
| Torrent identity | Same loaded torrent hash and magnet, logged by tool | webjf regenerated single-file hash `b62e432...`; delp/wown original is `e1d833...`; never interchange them |
| Fixture layout | `seed\Sintel.mp4` directly, all pieces verified | Both failed reports also hashed fully, so nested/missing files do not explain them |
| Root | Normal confirmed, empty dedicated root before filing | wown's retained script disables root creation (`None and ...`); that is a separate later placement failure, not the metadata 408 |

Seeder: IPv4 loopback, ephemeral peer port; DHT, LSD and UPnP disabled.
Receiver: IPv4 any plus IPv6 any when supported; independently allocated
TCP/UDP peer port **37587** in the final instance, persisted and reused on restart.
Source loopback connections and complete payloads rule out IPv4/IPv6 binding or
peer-port collisions for this reproduction. Engine already checks a stored
port's availability and chooses/persists another if occupied.

No `x.pe`, tracker, public seeder, DHT or LSD is needed for local proof. Public
discovery can make the original public Sintel hash appear to work despite a
broken local seeder; isolated hashes with the same licensed bytes remove that
accidental success. A 30-second metadata deadline cannot make a seeder polling
the wrong HTTP origin discover this receiver.

## Reproduction and verified results

`baseline-matched-runs.json` records five matching-hash cold requests using the
historical DLL: **5/5 HTTP 408**, “No file list arrived”, about 30.5 seconds each.
`seeder-baseline-final.log` confirms the requested hash and all 494/494 pieces.
`baseline-diagnostics-4.json` shows a real metadata manager with no established
connection; it is visible in diagnostics while payload snapshots are empty.
An initial exploratory baseline is retained separately and is not the final
matched-hash evidence.

`successful-runs.json`, `admitted-1..5.json`, `completed-1..5.json` and
`seeder-success.log` record **5/5 successful cold metadata admissions, real
transfers and final Library publication**, using five different torrent hashes
for the same unchanged licensed fixture. No warm metadata or duplicate admission
is counted. Each run deletes its real filed media before the next; the fifth
is retained for the visual proof.

| Run | Complete filing, seconds | Bytes | SHA-256 match |
| --- | ---: | ---: | --- |
| 1 | 9.912 | 129,241,752 | Pass |
| 2 | 7.394 | 129,241,752 | Pass |
| 3 | 7.292 | 129,241,752 | Pass |
| 4 | 7.828 | 129,241,752 | Pass |
| 5 | 7.647 | 129,241,752 | Pass |

Source and final digest:
`1dc6f2ca9762dfcc7d1b1843129a3e4f351d1fe935dea2241c7b359c11ebc1d8`.
The native file reader finds **1024 × 436**, projected as **480p**. The UI uses
this real filed quality, not the old proof target's preferred 720p.
After the matched stale-binary rerun, the **exact receiver-side PowerShell block
from the new README** was executed with the source launcher. The original
`e1d833...` fixture also admitted and filed its full 129,241,752 bytes at 480p;
`readme-recipe-result.log` and `seeder-recipe.log` record this additional check.

## Real headless visual proof

Dedicated **headless Edge through Playwright MCP**, new browser contexts for
each screen, actual server responses, no interception or response fabrication.
Actual Jellyfin 12.1.0 runs on **8097**, with isolated data/config/cache/logs under
`D:\code\memtest\jf-f408`. Its actual scan found the filed Sintel and its actual
user-data API set half-runtime progress. TorrentFlow's ordinary settings API
connected it. `jellyfin-scanned.json`, `jellyfin-title.json`,
`jellyfin-library.json` and `jellyfin-test.json` contain the real reads.

| Check | 390 | 768 | 1280 |
| --- | --- | --- | --- |
| Owned Sintel title: **In your library, 480p**, no Download | Pass | Pass | Pass |
| Not-owned Big Buck Bunny: still **Download** | Pass | Pass | Pass |
| Library: real **50% watched** chip below title/type, outside poster | Pass | Pass | Pass |
| Chip wholly within card, no page horizontal overflow | Pass | Pass | Pass |
| Page JavaScript errors in dedicated proof context | 0 | 0 | 0 |

Screenshots: `owned-film-{390,768,1280}.png`,
`not-owned-film-{390,768,1280}.png`, `library-{390,768,1280}.png`.
`visual-summary.json` records the final MCP DOM assertions. The screenshots were
also opened for actual visual review. The inherited MCP page's unrelated old
console errors are not counted as errors on the dedicated proof pages.

Both prior fixes (`0258bb9`, `d8990e3`) are visually correct. **No web fix needed.**
One early browser run reused a context and missed the not-owned control; final
proof uses a fresh context for every page. A screenshot loop's final file-writing
attempt hit the MCP VM import restriction after all nine PNGs were written;
the final independent DOM-assertion run succeeded and is recorded separately.

## Validation, review and limitations

- Isolated detached worktree `D:\code\memtest\wt-f408` at `d8990e3`, based on
  `rebuild`; Git cannot attach the already-active branch in a second worktree.
- Publish `D:\code\memtest\bin-f408`; only receiver HTTP **3964**.
  Fresh proof data; scheduler disabled; Development; background/no-browser.
- TMDB key supplied only to the child host environment, never to proof artifacts.
- Backend Release build: **0 warnings, 0 errors** (`build-verified.log`).
  `web\npm run build` passes (`web-build.log`).
- Current seeder builds and actually runs through the new source launcher.
- Self-review: one owning proof tool, no duplicated production facts, no
  admission/timeout patch, no unit tests, no seed changes, no unrelated edits,
  no `tools/.gitignore` change, no port 3930 or stable-directory access.
- **Unproven:** owned series episode list. No cheap genuine licensed series
  episode fixture was filed; no synthetic ownership is represented as proof.
  Public-swarm reliability, arbitrary remote peer reachability and all old
  agents' exact binary invocation histories are not claimed.

Cleanup, exact stopped PIDs and removed owned paths are in `cleanup.json`.
Only explicit tool/document/evidence paths are staged. Commit has `Refs: OPS-858`,
`Refs: OPS-855` and `Refs: OPS-854`, no Co-Authored-By.
