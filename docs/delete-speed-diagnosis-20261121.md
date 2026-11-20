# Installed deletion-speed diagnosis — 21 November 2026

Scope: read-only installed process/version/log inspection and matching source review.
No deletion, cancellation, retry, restart, installation, media reads or direct
database access were performed by this investigation.

Installed process: `0.4.1+f174b64aa74e547d10148fe30fa6c3921922332a`.
User reported the 14-item Classroom of the Elite deletion dialog busy for about
five minutes. Times below are Africa/Nairobi (+03:00).

## Measurements

- Current torrent command began **01:02:39.493** and returned HTTP 200 at
  **01:05:40.027**: **180,534.1591 ms**. Evidence: installed
  `logs/torrentflow-20261121.log`, lines 880 and 1115 at inspection time.
- The request body/action is not logged. This is the only torrent-command POST
  after the current process started and is consistent with the reported operation;
  the log alone cannot prove its exact selected IDs or all physical outcomes.
- A subsequent downloads-list GET finished at 01:05:42.302 in 2,268.5 ms.
- The process had issued approximately **27.9 GB of reads** since startup at
  01:02:10. This is a process-wide counter, not physical-disk throughput or bytes
  exclusively attributable to deletion. Startup/background work may contribute.
- Earlier-build logs on 20 November show another torrent command lasting 89.5 s,
  plus two confirmed deletion-path HTTP 500s: file could not be opened for verified
  deletion. Those older exceptions are not evidence that the current request failed.

## Matching source findings

`Api/DownloadEndpoints.cs:ActionAsync` handles distinct `(hash,targetId)` pairs
sequentially and invokes `DeleteTargetFilesAsync` per selected episode. It does not
combine a bulk selection into one file-index selection per torrent.

`Library/DownloadFiling.cs:DeletePayloadAsync` SHA-256 hashes each present owned
media file to compare its saved digest. The final-path branch can hash the same
file a second time before deletion. `DigestAsync` reads the entire file.

`Targets/TargetDownloadDeletion.cs:DeleteFilesCoreAsync` stops/drains the engine,
deletes files, and recovers remaining unfinished selected files when the torrent
is shared. Repeating per episode can repeatedly stop/recover a shared pack.
`Engine/MonoTorrentEngine.cs:StartAsync` may perform a full binding hash check for
recovery/changed bindings/filed files. Deletion also holds shared transfer/state
gates and waits for filing tasks, exposing other actions to these waits.

These are demonstrated expensive code paths, but the installed logs do not record
per-stage elapsed times or deleted bytes. Their individual contribution to the
180.5-second request remains **unconfirmed**. No explicit recheck messages were
found in the current log. An HTTP 200 is not independent physical-deletion proof.

## Next verification before a fix

In disposable isolation, reproduce a 14-episode shared-pack deletion and an
equivalent set of separate torrents. Measure lock wait, filing wait, stop/drain,
verification bytes/time, unlink time and recovery count. Assert bulk selection
performs one stop and at most one necessary recovery per torrent, preserves
unselected files and does not repeatedly hash completed files unnecessarily.
Preserve changed-file, identity/path/link and partial-failure protections.
If the modal remains busy after the server's reply, separately trace its promise,
response handling and dismissal; do not infer that UI symptom from server timing.
