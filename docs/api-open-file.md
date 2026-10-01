# Opening finished downloads (server contract)

TorrentFlow has no in-app player (docs/rules.md). A finished download opens in the owner's own player, or in the
computer's file manager with the file selected. This page is the `/api` contract the web uses for that, plus the
Downloads row fields that came with it.

## `POST /api/downloads/{transferId}/open`

Owner only, on the computer running TorrentFlow. Opens one finished video file of a built-in download.

- `transferId`: the row's `transferId` from `GET /api/client/torrents` (`builtin:<40 hex hash>`), URL-encoded with
  `encodeURIComponent`. A bare 40-character hash is accepted too.
- Body (JSON): `{ "mode": "open" }` or `{ "mode": "reveal" }`. `mode` is optional and defaults to `"open"`.
  - `open`: the computer's default app for that file type opens the file (Windows shell open, `open` on macOS,
    `xdg-open` on Linux).
  - `reveal`: the file manager opens with the file selected (`explorer.exe /select,` on Windows, `open -R` on macOS;
    Linux opens the containing folder).

Which file: the largest finished video file in the download's own recorded file list (the list written when the
download finished and was checked). Only video extensions are ever opened (`mkv mp4 avi m4v mov wmv flv webm ts m2ts
mpg mpeg vob`). The path must be inside the download folders from Settings, and no folder on the way and not the file
itself may be a link (symlink or junction). These checks run again right before launching.

### Success: `200`

```json
{ "ok": true, "mode": "open", "fileName": "Sintel.2010.1080p.mkv", "path": "D:\\Media\\Movies\\Sintel.2010.1080p.mkv", "launched": true }
```

`launched` is `false` only when the server runs with `PLAYWRIGHT_NO_REVEAL=1` (automated tests): every check ran, nothing
was started.

### Failures

Body: `{ "ok": false, "reason": "<code>", "error": "<what happened>", "message": "<what to do>" }`. Show `message`
(fall back to `error`). `reason` is for code paths, never shown.

| HTTP | `reason` | When |
|---|---|---|
| 400 | `invalid-mode` | `mode` is not `open` or `reveal` (also carries `field: "mode"`). |
| 400 | `invalid-id` | `transferId` is not a built-in transfer id or a 40-character hash. |
| 409 | `remote` | Owner using TorrentFlow through remote access. Also `openFolderDisabled: true`. |
| 409 | `container` | TorrentFlow runs in a container (Docker). Also `openFolderDisabled: true`. |
| 409 | `other-client` | The transfer belongs to qBittorrent or Transmission. |
| 404 | `not-found` | No built-in download with that id. |
| 409 | `not-finished` | The download is not finished and checked yet (downloading, queued, paused or failed). |
| 409 | `no-video` | The download has no video file. |
| 410 | `files-missing` | The video file is no longer on disk. |
| 403 | `outside-folders` | The file is not inside the download folders from Settings. |
| 403 | `link` | The file, or a folder on its path, is a link. |
| 500 | `launch-failed` | The computer could not start the player or file manager. |

Requesters never reach this endpoint: the remote access requester allow list refuses it before routing with
`403 { "error": "...", "code": "requester_forbidden" }`.

### When the web shows Open and Show in folder

Only on finished built-in rows (`ownerClientType === "builtin"` and `state === "downloaded"`), and only when
`GET /api/features` returns `openFolder: true` (false in a container and through remote access, the same rule as
`POST /api/settings/open-folder`). When `openFolder` is false, show the copy-path fallback the folder button already uses.
`GET /api/features` no longer has `streaming`.

## Downloads row fields (`GET /api/client/torrents`)

- `addedAt: string | null`: when the transfer was added, ISO 8601 UTC (for example `2025-09-30T18:04:05.123Z`).
  Built-in rows: when the engine first admitted it. qBittorrent: `added_on`. Transmission: `addedDate`. `null` when the
  client does not say.
- `filesMissing: boolean`: `true` only for a finished built-in download when any file it kept is gone from disk
  (deleted or moved outside TorrentFlow). Re-checked at most every 30 seconds per row. `false` for every other row.
- Gone: `playable`. `retentionState` is only ever `"kept"` (or `"unknown"`); streaming caches no longer exist.

## Checking downloads (error text on rows)

Every finished download is checked on disk before it counts as downloaded: no program files, a real video
(container header matches the extension, not an archive or program in disguise, not zero-filled), and a main video
of at least 1 MiB. A release whose file list has program files, or only archives, or no video at all, is refused as
soon as its file list arrives, before anything downloads.

| Row `state` | Row `error` | Meaning |
|---|---|---|
| `error` | `This download wasn't a real video file, so TorrentFlow is looking for another release.` | Finished, failed the check. The files stay until the owner deletes the row. Wanted episodes and films go back to the wanted queue, which never picks the same release again. |
| `error` | `This release has a program file in it, so TorrentFlow didn't download it.` | Refused when its file list arrived (a magnet added by hand). |
| `error` | `This release has no video file in it, so TorrentFlow didn't download it.` | Same, for archive-only or no-video releases. |
| `error` | `Couldn't check this download. Close any app using its files, then press Resume to check it again.` | A file could not be read, even after retries. Not accepted as downloaded and not deleted. Resume checks it again. |

An add (`POST /api/torrent/send`, grabs, requests) of a release whose file list is refused fails with the same
"program file" or "no video file" message, and so does re-adding a release that already failed the check
(`This release already turned out not to be a real video file, so TorrentFlow won't download it again.`). Automatic
grabs then try the next release on their own.
