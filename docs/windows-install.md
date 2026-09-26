# TorrentFlow on Windows: installer, tray, autostart and updates

The published `TorrentFlow.exe` (see [dotnet-port.md](dotnet-port.md#single-exe-distribution))
runs as a desktop app on Windows. Everything here applies only to that published exe on
Windows. `dotnet run`, Docker and Linux builds keep their console and none of these features
appear.

## Install from source (one command)

From the repository root, in PowerShell:

```powershell
.\install.ps1
```

You can also double-click `install.cmd`. From a terminal, type `.\install.cmd` with the `.\`: a bare
`install.cmd` can run a different `install.cmd` found on `PATH`; nvm-windows ships one.

What it does, in order:

1. **Checks prerequisites.** It needs the .NET 10 SDK, Node.js and pnpm. If one is missing, it prints the
   command that installs it and stops. If Inno Setup is missing, it installs it for your user without
   prompting (`winget install JRSoftware.InnoSetup --scope user`). If that fails, it installs by copying
   `TorrentFlow.exe` to `%LOCALAPPDATA%\Programs\TorrentFlow` and creating the same Start-menu shortcut
   instead.
2. **Builds** the web UI, the single-file exe and the installer (`scripts\publish-exe.ps1 -Installer`).
   The version is `<latest v* tag, else 0.0.0>+<git short sha>`, with `.dirty` added for uncommitted
   changes, so two builds are always distinguishable. A `0.0.0` build never offers GitHub updates.
3. **Detects an existing install** from the installer's uninstall entry (or the install folder) and asks:
   `TorrentFlow <old> is installed at <path>. Update to <new>? [Y/n]`, or `Install TorrentFlow <new>? [Y/n]`
   if there is none. It asks even when the versions match, because rebuilds share a version.
4. **Offers to move your `run.ps1` library.** `dotnet run` keeps its data in
   `server\TorrentFlow.Api\data`; `<repo>\data` is checked too.
   - If the installed app (`%LOCALAPPDATA%\TorrentFlow`) has no library yet, it asks
     `Move your existing library from <repo data> into the installed app? [Y/n]`.
   - It stops the `run.ps1` server first, then copies the whole folder: database with `-wal`/`-shm`,
     engine resume state, settings and the default `downloads` folder.
   - It checks every file by SHA-256 and opens the copied database read-only. It then rewrites the stored
     absolute paths that pointed into the old folder, so downloads stay attached.
   - Finally it renames the old folder to `data.migrated-<timestamp>`. Nothing is deleted.
   - If **both** libraries exist, nothing is overwritten. It shows both and asks which to keep; the
     default is the installed one. Keeping the `run.ps1` one first renames the installed library to
     `TorrentFlow.replaced-<timestamp>`.
   - Running it again offers nothing once the old folder has been renamed (unless you point `-LegacyDataDir` at a backup). It follows the same rules as
     the app's own first-run migration: the same target folder, and never overwriting.
5. **Stops a running TorrentFlow gracefully** (the same clean shutdown as *Quit* in the tray), runs the
   installer silently over it and relaunches it in the tray. It ends with:
   `TorrentFlow <version> installed. Open: http://127.0.0.1:3000 (tray icon running)`.

Options:

| Option | Effect |
| --- | --- |
| `-Yes` | Accept every default without prompting: install/update, move the library, keep the installed one if both exist, and stop a `run.ps1` server or other TorrentFlow that holds the port. |
| `-Version` | Version to stamp. Defaults to `<latest v* tag or 0.0.0>+<git short sha>`. |
| `-SkipBuild` | Reinstall the previous build in `artifacts\exe`. |
| `-NoInnoSetup` | Install by copying files instead of running the installer. |
| `-InstallDir`, `-DataDir`, `-LegacyDataDir` | Override the install folder, the installed app's data folder, or the library to move. |

`TorrentFlow__DataDirectory` and `ASPNETCORE_URLS` are honoured, and the relaunched app inherits them.
Use them for a throwaway test install that leaves your real library and port 3000 alone. The installer has a single uninstall entry, so a test install with `-InstallDir` takes it over. Uninstall the test copy afterwards and run `.\install.ps1` again to put the entry back on your real install.

## Install a release

Download `TorrentFlow-Setup-<version>.exe` from the
[latest release](https://github.com/fideliskaruri/torrent-aggregator/releases/latest) and run it.
The installer:

- runs **per user** and needs no admin rights. It installs to
  `%LOCALAPPDATA%\Programs\TorrentFlow`.
- adds a Start-menu shortcut, plus a desktop shortcut if you tick it.
- can add **Start with Windows** (optional task). This writes the same value as the Settings toggle:
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\TorrentFlow` = `"<app>\TorrentFlow.exe" --background`.
- appears in *Settings → Apps* with an uninstaller.

The exe and the installer are not code-signed, so Windows SmartScreen may warn on first run.
Choose *More info → Run anyway*. The release's `SHA256SUMS.txt` lists the expected hashes.

Silent install, for scripts: `TorrentFlow-Setup-<version>.exe /VERYSILENT /TASKS=autostart,desktopicon`.
Add `/DIR=<folder>` to choose another folder.

The release also ships the bare `TorrentFlow.exe`. It runs from anywhere with no install and
has the same tray behaviour. Put a `portable` file next to it to keep data beside the exe.

## Running

- **No console window.** The exe is a GUI-subsystem app. Started from a terminal, it attaches to
  that terminal for log output. Fatal startup errors appear in a message box, including the error
  shown when port 3000 is taken by another app.
- **Tray icon.** Left-click opens TorrentFlow in the browser. Right-click shows a menu:
  - *Open TorrentFlow*
  - *Pause all downloads* / *Resume all downloads*: normal downloads only. Streams and
    pre-warm transfers are left alone.
  - *Quit TorrentFlow*: shuts down cleanly and saves the engine state.

  Windows may put new icons in the hidden-icons overflow at first. Drag it onto the taskbar to
  keep it visible.
- **Launching it again** while it already runs (Start menu, shortcut) just opens the browser.
- `--background` starts without opening a browser (used by autostart and after updates).
  `--no-browser` does the same for manual runs.
- `taskkill /IM TorrentFlow.exe` without `/F` also triggers a clean shutdown (the installer uses this).

## Settings → App & media tools

This section is only shown on the Windows desktop app. It is only editable from the PC itself;
requests through Remote access get `403`.

| Setting | What it does |
| --- | --- |
| Start with Windows | Adds or removes the HKCU Run value above. If the value points to a different TorrentFlow copy, the toggle says so and turning it on repoints it here. |
| Check for updates automatically | Checks GitHub Releases at most once a day (first check 30 s after start). Turn it off to never contact GitHub. *Check now* works either way. |
| ffmpeg & ffprobe | Shows which binaries are in use (found / installed by TorrentFlow / missing) and offers a one-click download when missing. |

API: `GET /api/desktop` (status), `PUT /api/desktop/settings` `{ startWithWindows?, checkForUpdates? }`,
`POST /api/desktop/update/check`, `POST /api/desktop/update/install`, `POST /api/desktop/ffmpeg/download`.
The preferences are stored in `desktop.json` in the data directory.

## Updates

1. The checker reads `https://api.github.com/repos/fideliskaruri/torrent-aggregator/releases/latest`
   and compares its tag (`vMAJOR.MINOR.PATCH[-pre]`) with the running exe's version.
   - Offline, rate-limited or other failed checks are recorded as "Could not reach GitHub."
     The last known result is kept.
   - A `404` (no releases yet) means "up to date".
   - Dev builds (version `0.0.0`) never check.
2. When a newer release has a `TorrentFlow-Setup-*.exe` asset, a banner appears under the header.
   Settings shows the same notice. *Later* hides the banner for that version.
3. *Update* downloads the installer into `<data>\updates\`. Only https URLs on github.com or
   githubusercontent.com are accepted.
   - The file is checked against the size and SHA-256 `digest` that GitHub publishes for release
     assets. An asset without a digest is never run: the notice links to the release page instead.
   - The installer then runs with `/SILENT /SP- /NOCANCEL /NORESTART /CLOSEAPPLICATIONS /UPDATE=1`,
     and TorrentFlow quits.
   - The installer replaces the exe, restarts it with `--background`, and leaves your
     Start-with-Windows choice unchanged.

## ffmpeg and ffprobe

TorrentFlow uses ffprobe to check that finished downloads are real video, and ffmpeg for
subtitle and audio extraction and HLS. Neither is bundled. Lookup order:

1. The configured path: `TorrentFlow:Media:FfmpegPath` / `TorrentFlow:Media:FfprobePath`.
2. The environment variables `FFMPEG_PATH` / `FFPROBE_PATH`.
3. **The managed tools folder**: `<data>\tools\ffmpeg`. Override it with
   `TorrentFlow:Media:ManagedToolsDirectory`.
4. `node_modules` (development), then `PATH`.

The Settings download fetches a pinned build and saves `ffmpeg.exe`, `ffprobe.exe` and
`LICENSE.txt` into the managed folder:

- file: `ffmpeg-7.1.1-essentials_build.zip` from
  [GyanD/codexffmpeg 7.1.1](https://github.com/GyanD/codexffmpeg/releases/tag/7.1.1), GPLv3
- size: 92,234,348 bytes
- SHA-256: `04861d3339c5ebe38b56c19a15cf2c0cc97f5de4fa8910e4d47e5e6404e4a2d4`

A mismatch aborts the download and leaves nothing installed. To change the pinned build, update
`FfmpegPackage.Windows` in `server/TorrentFlow.Api/Desktop/FfmpegInstaller.cs` with the new URL,
size and hash.

## Data directory

Data stays in `%LOCALAPPDATA%\TorrentFlow` (or `TorrentFlow__DataDirectory`, or `data\` next to a
`portable` exe). This holds the database, engine state, `.torrentflow.key`, `desktop.json`,
`tools\` and `updates\`.

> **Behaviour change:** before this release, the engine and media modules of the published exe
> wrote their state under `<working directory>\data` instead of the resolved data directory. An
> autostart launch would have used `C:\Windows\System32\data`. All modules now use the same data
> directory. If you ran an older exe, you may find a stray `data\engine` folder next to where
> you started it. It can be deleted once the new version has re-added your torrents, or moved
> into `%LOCALAPPDATA%\TorrentFlow` first to keep engine resume state.

## Uninstall

Use *Settings → Apps → TorrentFlow → Uninstall*, or run `unins000.exe` in the install folder. It:

- closes the installed copy (cleanly, force-stopping it after 15 s),
- removes the program, the shortcuts and the Run value (if it points at this install),
- asks whether to **also remove your data** in `%LOCALAPPDATA%\TorrentFlow`. The default is
  **No**. Silent uninstalls always keep your data.

Downloads saved to a custom folder outside the data directory are never touched.

## Building a release

Tag and push: `git tag v1.2.3 && git push origin v1.2.3`.
[`.github/workflows/release-windows.yml`](../.github/workflows/release-windows.yml) then runs on
windows-latest. It:

- builds `web/`,
- runs the .NET tests,
- publishes the single-file exe with `-p:Version=1.2.3`,
- installs Inno Setup via Chocolatey and compiles `installer/windows/TorrentFlow.iss`,
- smoke-tests the exe on port 3924,
- attaches `TorrentFlow.exe`, `TorrentFlow-Setup-1.2.3.exe` and `SHA256SUMS.txt` to the release.

Tags with a suffix (`v1.2.3-beta.1`) become pre-releases. The *latest* API ignores pre-releases,
so they are never offered as updates.

Local build: `.\scripts\publish-exe.ps1 -Version 1.2.3 -Installer`. This needs Inno Setup 6
(`winget install JRSoftware.InnoSetup`). The output goes to `artifacts\exe\`.
