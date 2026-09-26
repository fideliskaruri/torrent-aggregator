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
| Operations | Prisma migrations, diagnostics, automation, and CI validation |

## Run the .NET version

No Docker required. Install the **.NET 10 SDK**, **Node.js 22.23.2** (the repository's
pinned Node 20+ toolchain; `web/package.json` currently requires Node 22.12+ within 22.x),
and **pnpm** (`npm i -g pnpm`, or `corepack enable` if Corepack is installed).

From the repository root:

```powershell
.\run.ps1
```

On Linux/macOS: `sh ./run.sh`. Open **http://127.0.0.1:3000**.
The first run installs the locked **web/** dependencies and builds the SPA automatically;
later runs rebuild it only when its inputs change or `web/dist/index.html` is missing.
There is no separate root/Next.js install or database setup step for the .NET version.
`dotnet build server/TorrentFlow.Api` does the same; use `-p:SkipWebBuild=true` for a
backend-only build. `dotnet test TorrentFlow.slnx` does not install/build the SPA.

Data defaults to `server/TorrentFlow.Api/data` when using these scripts. Configure the host
with environment variables (double underscores map to nested configuration:
`TorrentFlow__X__Y`) or `--TorrentFlow:X:Y=value` arguments. For example, in PowerShell:

```powershell
$env:TorrentFlow__DataDirectory = 'D:\TorrentFlow\data'
$env:TorrentFlow__DatabasePath = 'D:\existing-clone\prisma\dev.db'
$env:TMDB_API_KEY = 'your-key'
.\run.ps1
```

`TorrentFlow:DatabasePath` adopts existing Prisma databases automatically; back up the
database first and stop the old app before sharing it. Without this override the database
is `torrentflow.db` under the data directory. The host reads process environment/configuration,
not the Next.js `.env` file. On Linux/macOS use `export NAME=value`.

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
The existing Next.js instructions below remain separate.

## Quick start

### Requirements

- **Node.js 22.23.2**, pinned in [`.nvmrc`](.nvmrc)
- **pnpm 12.4.2**, pinned by `packageManager` in [`package.json`](package.json)
- A configured download directory and local database

Enable the repository-pinned pnpm version through Corepack:

```powershell
corepack enable
```

This enables Node's package-manager shim so the `packageManager` field can select pnpm
`12.4.2` automatically.

Install the exact locked dependencies:

```powershell
pnpm install --frozen-lockfile
```

This installs the versions recorded in `pnpm-lock.yaml` and refuses to rewrite the lockfile.

Run first-time setup:

```powershell
pnpm run setup
```

Setup checks the runtime and native tools, creates `.env` from `.env.example` when needed,
generates Prisma, and applies the committed migrations. It is safe to run again; an existing
`.env` is preserved.

Start the development server:

```powershell
pnpm run dev
```

This runs the `predev` doctor check and starts the Next.js development server with hot reload.

Open **http://127.0.0.1:3000**.

## Daily workflow

After pulling changes on an existing checkout:

```powershell
git pull
pnpm install --frozen-lockfile
pnpm run setup
pnpm run dev
```

`git pull` fetches the latest committed code. The install, setup, and dev commands then
reconcile dependencies, database state, and the local server with that code.

Useful runtime checks:

```powershell
pnpm run doctor
pnpm run db:migrate:status
```

`pnpm run doctor` checks Node, native torrent bindings, FFmpeg, FFprobe, esbuild, and the
Prisma migration ledger. `pnpm run db:migrate:status` reports whether the local database has
applied every committed migration.

Do not use `npm ci` or Yarn. The authoritative lockfile is [`pnpm-lock.yaml`](pnpm-lock.yaml).

## Validation

Run the focused gates before pushing:

```powershell
pnpm run typecheck
pnpm run lint
pnpm run test:unit
pnpm run build
```

Each command has a different job:

| Command | What it does |
| --- | --- |
| `pnpm run typecheck` | Runs the TypeScript compiler without emitting files; catches type and import errors. |
| `pnpm run lint` | Runs ESLint across the repository; catches code-quality and hook-rule violations. |
| `pnpm run test:unit` | Runs the offline unit and contract test suite against an isolated private database. |
| `pnpm run build` | Generates Prisma Client and creates the optimized production Next.js build. |

The project does not use Jest. Its test surface is split into:

| Command | What it does |
| --- | --- |
| `pnpm run test:unit` | Runs offline unit and contract tests without contacting live torrent indexers. |
| `pnpm run test:live` | Runs the network-dependent unit tests that are excluded from the offline run. |
| `pnpm run test:api` | Exercises the running app's API surface with smoke requests. |
| `pnpm run test:ui` | Runs layout and UI regression checks against the running app. |
| `pnpm run test:visual:snapshots` | Runs Playwright screenshot comparisons against committed visual baselines. |
| `pnpm run test:media:*` | Runs media, playback, torrent, bitrate, stall, and player E2E scripts; choose the specific suffix. |
| `pnpm run test:journeys` | Runs scripted end-to-end user journeys through the app. |
| `pnpm run test:all` | Runs the broader validation orchestration, including offline tests, E2E checks, and Playwright coverage. |

Browser verification uses Playwright. Network-dependent torrent tests are intentionally excluded
from the default offline unit run.

## Database commands

```powershell
pnpm run db:migrate
pnpm run db:migrate:deploy
pnpm run db:migrate:status
pnpm run db:studio
```

| Command | What it does |
| --- | --- |
| `pnpm run db:migrate` | Creates and applies a new development migration from schema changes. |
| `pnpm run db:migrate:deploy` | Applies already-committed migrations without creating new ones. |
| `pnpm run db:migrate:status` | Shows which migrations are applied or pending. |
| `pnpm run db:studio` | Opens Prisma Studio for inspecting and editing local database records. |

## Docker

The production image is defined in [`Dockerfile`](Dockerfile). It:

1. Uses `node:22-bookworm-slim`.
2. Activates pnpm `12.4.2` through Corepack.
3. Installs with `pnpm install --frozen-lockfile`.
4. Builds the Next.js application.
5. Runs `prisma migrate deploy` before starting Next.js on port `3000`.

## Repository guide

- [`AGENTS.md`](AGENTS.md): repository-specific rules for contributors and agents
- [`docs/AGENT-GUIDE.md`](docs/AGENT-GUIDE.md): architecture, testing doctrine, and operational traps
- [`docs/design-system.md`](docs/design-system.md): UI tokens, patterns, and responsive requirements
- [`Dockerfile`](Dockerfile): production container definition
- [`.github/workflows/ci.yml`](.github/workflows/ci.yml): CI install and validation pipeline
