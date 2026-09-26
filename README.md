# TorrentFlow

**A media-first torrent app for finding, tracking, downloading, and streaming titles.**

## Install on Windows (one command)

From the repository root, in PowerShell:

```powershell
.\install.ps1
```

(or double-click `install.cmd`). It checks the prerequisites (.NET 10 SDK, Node.js, pnpm), gets Inno Setup
for your user if it's missing, and builds the app. It then installs it, or updates the existing install
after asking, and starts it in the tray. It also offers to move a `.\run.ps1` library into the installed
app, keeping the old folder as a backup. Add `-Yes` to accept every default. Details:
[docs/windows-install.md](docs/windows-install.md#install-from-source-one-command).

TorrentFlow turns torrent discovery into a title-first experience: search for a film, series,
or anime, open its title page, then choose **Play** or **Download**. Torrent details stay behind
the scenes while the app manages acquisition, playback, local files, and library state.

> **Local app:** TorrentFlow is designed for a single-user local installation.
> The owner runs the development server on port `3000`; agents and automation must only read
> from that server.

## At a glance

| Area | What it provides |
| --- | --- |
| Discovery | Search and browse films, series, and anime |
| Title pages | Seasons, episodes, releases, playback, and downloads |
| Acquisition | Per-episode and film downloads with quality-aware selection |
| Playback | Local-file and WebTorrent-backed streaming |
| Library | Progress, history, retention, storage limits, and watch state |
| Operations | EF Core SQLite migrations, diagnostics, automation, and CI validation |

## Run from source

No Docker required. Install the **.NET 10 SDK**, **Node.js 22** (pinned in [`.nvmrc`](.nvmrc);
`web/package.json` requires Node 22.12+ within 22.x), and **pnpm** (`npm i -g pnpm`, or
`corepack enable` if Corepack is installed).

From the repository root:

```powershell
.\run.ps1
```

On Linux/macOS: `sh ./run.sh`. Open **http://127.0.0.1:3000**.
The first run installs the locked **web/** dependencies and builds the SPA automatically;
later runs rebuild it only when its inputs change or `web/dist/index.html` is missing.
`dotnet build server/TorrentFlow.Api` does the same; use `-p:SkipWebBuild=true` for a
backend-only build. `dotnet test TorrentFlow.slnx` does not install/build the SPA.

Data defaults to `server/TorrentFlow.Api/data` when using these scripts. Configure the host
with environment variables (double underscores map to nested configuration:
`TorrentFlow__X__Y`) or `--TorrentFlow:X:Y=value` arguments. For example, in PowerShell:

```powershell
$env:TorrentFlow__DataDirectory = 'D:\TorrentFlow\data'
$env:TorrentFlow__DatabasePath = 'D:\existing-clone\torrentflow.db'
$env:TMDB_API_KEY = 'your-key'
.\run.ps1
```

`TorrentFlow:DatabasePath` can adopt an existing SQLite library database (including one created
by the archived Next.js app at git tag `nextjs-final`); back up first and stop the old app before
sharing it. Without this override the database is `torrentflow.db` under the data directory.
The host reads process environment/configuration, not a root `.env` file. On Linux/macOS use
`export NAME=value`.

To distribute a **single executable** that needs neither the .NET SDK/runtime nor Node/pnpm:

```powershell
.\scripts\publish-exe.ps1
```

The script builds `web/` with pnpm, then publishes `server/TorrentFlow.Api` as
`artifacts\exe\TorrentFlow.exe` (about 120 MB; it is left uncompressed because a compressed
bundle roughly doubles the app's private memory). Double-click the exe or run it directly:

```powershell
.\artifacts\exe\TorrentFlow.exe --urls http://127.0.0.1:3000
```

By default it stores the database and settings in `%LOCALAPPDATA%\TorrentFlow`.
If a `portable` marker file sits next to the exe, it instead keeps data in `data\`
beside the exe so the whole folder stays self-contained.
Pass `--urls http://127.0.0.1:3000` to override the port, or `--no-browser` to suppress the
automatic browser launch.

Windows users can instead run the per-user installer from the GitHub Releases page (Start-menu
shortcut, tray icon, optional Start with Windows, in-app updates); see
[docs/windows-install.md](docs/windows-install.md).

To distribute a **single folder** that needs neither the .NET SDK/runtime nor Node/pnpm:

```powershell
dotnet publish server/TorrentFlow.Api -c Release -r win-x64 --self-contained true -o artifacts/publish/win-x64
```

Ship the entire folder and run `.\TorrentFlow.exe --urls http://127.0.0.1:3000` from that
folder. Use `-r linux-x64`, `-r linux-arm64`, `-r osx-arm64` or `-r osx-x64` with a matching
output directory for those platforms. The publish can be produced on any OS (e.g. build the Linux
folder on Windows).

### Linux and macOS

Prerequisites for a published folder (no SDK, runtime, Node or pnpm needed):

- **Linux**: glibc x64/arm64 distro (Ubuntu 22.04+, Debian 12+, Fedora, …) with ICU and OpenSSL,
  which most desktop/server installs already have. If startup fails with
  `Couldn't find a valid ICU package`, install ICU:
  `sudo apt install libicu-dev` (Debian/Ubuntu; `libicu74` or similar also works),
  `sudo dnf install libicu` (Fedora/RHEL), `sudo pacman -S icu` (Arch).
  Alpine/musl needs a `linux-musl-x64` publish plus `apk add icu-libs`.
- **macOS**: nothing extra. Unsigned binaries may need
  `xattr -dr com.apple.quarantine <folder>` after downloading.
- Optional: `xdg-open` (Linux desktop) for
  the "Open folder" button (headless servers get a clear "could not launch its file manager"
  error instead), and Chromium/Chrome/Edge for the optional indexer browser fallback
  (`/usr/bin/chromium`, `google-chrome`, `/Applications/Google Chrome.app`, … are detected, or set
  `TorrentFlow:Search:BrowserExecutable`).

Run it from a native file system (not a Windows mount such as `/mnt/c` under WSL, which is slow):

```sh
cp -r TorrentFlow-linux-x64 ~/torrentflow && cd ~/torrentflow
chmod +x TorrentFlow
TorrentFlow__DataDirectory="$HOME/.local/share/torrentflow" ./TorrentFlow --urls http://127.0.0.1:3000
```

The SQLite database is created and migrated under the data directory on first start; the
secrets key file (`.torrentflow.key`) is written with owner-only (`600`) permissions. The default
download folder suggestion is `~/Downloads/TorrentFlow`. Paths are case-sensitive on Linux.

From source, install the .NET 10 SDK (e.g. `sudo apt install dotnet-sdk-10.0` or
`https://dot.net/v1/dotnet-install.sh`), Node.js and pnpm as above, then run `sh ./run.sh`.

## Quick start (web SPA only)

The UI lives under [`web/`](web/). Dependencies are locked by [`web/pnpm-lock.yaml`](web/pnpm-lock.yaml)
and pinned by `packageManager` in [`web/package.json`](web/package.json).

```powershell
corepack enable
pnpm --dir web install --frozen-lockfile
pnpm --dir web run typecheck
pnpm --dir web run build
# from web/:
node --test tests/*.test.mjs
```

Do not use `npm ci` or Yarn for `web/`.

## Validation

CI (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs:

```powershell
pnpm --dir web install --frozen-lockfile
pnpm --dir web run typecheck
# from web/: node --test tests/*.test.mjs
pnpm --dir web exec vite build
dotnet build TorrentFlow.slnx -c Release -p:SkipWebBuild=true
dotnet test TorrentFlow.slnx -c Release --no-build -p:SkipWebBuild=true
```

## Docker

The production image is defined in [`Dockerfile`](Dockerfile). It builds the Vite SPA, publishes
the ASP.NET Core host, and ships ffmpeg. Full hosting notes: [`docs/docker.md`](docs/docker.md).

```sh
cp .env.example .env
docker compose up -d --build torrentflow
```

## Repository layout

| Path | Role |
| --- | --- |
| `server/` | ASP.NET Core monolith (API, engine, library, media, search) |
| `web/` | Vite + React SPA |
| `installer/` | Windows Inno Setup script |
| `scripts/publish-exe.ps1` | Local single-file exe (+ optional installer) build |
| `docker/` | Container entrypoint |

The pre-.NET Next.js app is preserved at git tag **`nextjs-final`** and is not part of `main`.

## Repository guide

- [`AGENTS.md`](AGENTS.md): repository-specific rules for contributors and agents
- [`docs/design-system.md`](docs/design-system.md): UI tokens, patterns, and responsive requirements
- [`docs/windows-install.md`](docs/windows-install.md): Windows install / update details
- [`docs/docker.md`](docs/docker.md): Docker hosting
- [`docs/dotnet-port.md`](docs/dotnet-port.md): historical port notes (Next → .NET)
- [`Dockerfile`](Dockerfile): production container definition
- [`.github/workflows/ci.yml`](.github/workflows/ci.yml): CI install and validation pipeline
