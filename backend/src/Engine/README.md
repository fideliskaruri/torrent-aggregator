# Probe metadata and observation

Torrent HTTP metadata permits at most five redirects, including relative
locations. Every HTTP(S) hop retains the public-address connection check and
rejects embedded credentials. The whole chain, headers and body share one
six-second deadline. Bodies are limited to 20 MiB even without Content-Length;
`application/x-bittorrent` and `application/octet-stream` are accepted. A
redirected magnet is parsed and hash-checked instead of sent to HTTP.

Both probe attachment and payload admission use this resolver. Torrent metadata
and redirected magnets must match the candidate's expected hash.

Successful probe release retains the complete hash-bound torrent information in
the engine cache before MonoTorrent removes its probe metadata. Cached admission
and attachment read that information (or MonoTorrent's intact metadata cache)
before consulting the release URL, which may no longer respond. A Verdict's file
list alone cannot reconstruct piece hashes: Check skips cached file evidence when
the full torrent information is missing and performs a fresh check instead.
Admission timeouts and unavailable metadata return distinct, actionable failures.

Queue transitions log their supplied eligibility, run intent, cap and filing
permit. Queued or paused managers never retain stall flags; stall observations
apply only during an active run. Run and Queued admissions both retain runnable
intent, independently of whether the current cap grants a physical slot.

The optional progressive observation port takes Check's predicate; Engine never
decides a health band. An early stop uses the same stop, disk flush, capability
rotation and release cleanup as a full probe. Observation duration excludes the
final disk flush. A late integrity failure drains the remaining window before
returning, so it cannot create an early Weak or Dead result.

## Swarm and transfer diagnostics (OPS-836)

The development engine snapshot reports the physical client's download limit,
piece length, pending requests and per-connection payload bytes. Lifetime event
counters show established/failed connections and newly added peers by DHT, PEX,
local discovery or tracker URI. These are discovery event totals, not unique
seeder counts. Tracker state/failure and last DHT announce accompany the sample;
`TierLastAnnounceSucceeded` describes the tier, not every tracker in it.

Use connected seeders and actual payload delivery rather than advertised seeds
when diagnosing viability. Zero hash-valid bytes does not mean zero transport
bytes: an 8 MiB piece cannot verify until all its blocks arrive, and a globally
throttled multi-peer transfer can have several incomplete pieces. Sparse file
allocation does not measure received data. See `tools\.enghealth-proof\report.md`
for the isolated native Sintel/Bunny controls and the 128 KiB/s reproduction.

## Per-file download publication (OPS-749)

Library supplies every absolute binding before payload: selected files use the final
directory and `.partial`; unselected files use `.unwanted/<hash>/<index>/...`.
Engine does not name media or reference Library.

`PrepareFilingAsync` requires **every piece touching each requested file** to be
hash-valid, stops and flushes the manager, unselects those files, and grants a permit.
Other selected files remain attached, but cannot start during the permit. After
Library has validated the drained file and persisted the rename intent and digest,
`IEngineFilePublisher.PublishFilingAsync` uses MonoTorrent 3.0.2's
`MoveFileAsync`: one same-directory, no-overwrite rename plus path rebind on its
I/O loop. A separate `File.Move` while MonoTorrent still has the partial binding
is unsafe. No staging folder or cross-directory promotion is used.

Inventory acknowledgement releases the permit and resumes the remaining selection.
Filed files stay unselected and cannot be selected again. Replay obtains Domain
recovery bindings before requesting payload. Hash checks temporarily include filed
files **while stopped**, then return them to `DoNotDownload`; MonoTorrent otherwise
skips their non-boundary pieces (OPS-750). Changed filed data blocks resume rather
than rewriting owned files. The whole selected set finishing still stops seeding.

The isolated development composition and local-seeder HTTP evidence are described
in `..\Library\README.md`. `tools\.filing-proof\summary.json` records the option-(a)
proof, including a filed first video with a still-downloading second video, crash
replay, and removal of both final and partial bindings.
