# Library placement and download filing

Library depends on **Domain only**. Placement chooses a validated enrolled root,
pins series folders, preserves the existing Jellyfin kind folders and sanitized
torrent leaf names, and reserves final/partial bindings. Existing final names are
never adopted or overwritten. A reserve-full root returns `No drive has space`.

`DownloadFiling` validates drained, hash-complete files, creates downloaded
`MediaFile` proposals, handles interrupted publication from its stored digest,
and deletes only the download's authorized paths after Engine drains. ISO media
dimensions are read with bounded box traversal, not ffmpeg. Resolution is derived
from those dimensions when available, otherwise from the release's declared
quality, **never from the requested quality**.

The Domain `IEngineFilePublisher` port safely rebinds and atomically renames each
file in its own final directory. MonoTorrent's public `MoveFileAsync` performs
both operations together, so Engine performs that physical rename on Library's
chosen paths rather than Library issuing an unsafe second rename. The remaining
pack files stay attached and continue after acknowledgement.

Store's Library download capability persists bindings, pins, rename intent and
source/destination claims. It commits a filed binding, downloaded inventory, item
completion and operation completion together. A crash after rename but before
inventory is recovered only when the final file matches the recorded digest.
The rebound final is never turned back into a `.partial` or re-downloaded.
Unselected shared boundary fragments remain in hidden `.unwanted/<hash>` with
`.ignore`; they are not visible to the simulated Jellyfin scan.

`Api\DevFiling.cs` is isolated development-only composition, not the future Targets
worker: it wires Domain ports, exposes owner-loopback `/api/dev/filing`, and drives
the same real Engine and Library against SQLite. `/api/dev/library/owned/{workId}`
shows each filed video immediately. Removal waits for its ordered filing operation,
drains the hash, removes partials and unchanged owned finals, and prunes the hidden
fragments. An external final that appeared during a collision is left alone.

## HTTP integration proof

`tools\.filing-proof\summary.json` is intentionally gitignored. The proof uses
unmodified full **Sintel** and **Big Buck Bunny**, Blender Foundation CC BY 3.0
WebTorrent originals, in a genuine locally seeded four-file BitTorrent pack
(two videos selected, extras skipped). Synthetic episode identities exercise TV
layout; they do not claim Blender published a TV series. A second licensed torrent
proves the actual `Movies\Sintel (2010)\Sintel.mp4` filename.

Evidence covers final-directory partials, first-file ownership while another file
downloads, a directory walk ignoring `.partial` and hidden paths, crash replay with
unchanged SHA-256 and continued bytes, in-progress and completed removal, collision
refusal, reserve-full waiting, actual file size/resolution, and a zero-warning build.
The proof owns only port 3946 and `D:\code\memtest\rebuild-filing`. Its seeder, server
and proof helpers are stopped by their recorded literal PIDs. It never accesses
3930, 3948 or the stable data directory.
