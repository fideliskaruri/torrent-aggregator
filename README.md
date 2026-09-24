# TorrentFlow

**A media-first torrent app for finding, tracking, downloading, and streaming titles.**

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

## Quick start

### Requirements

- **Node.js 22.23.2**, pinned in [`.nvmrc`](.nvmrc)
- **pnpm 12.4.2**, pinned by `packageManager` in [`package.json`](package.json)
- A configured download directory and local database

Enable the repository-pinned pnpm version through Corepack:

```powershell
corepack enable
```

Install the exact locked dependencies:

```powershell
pnpm install --frozen-lockfile
```

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

Open **http://127.0.0.1:3000**.

## Daily workflow

After pulling changes on an existing checkout:

```powershell
git pull
pnpm install --frozen-lockfile
pnpm run setup
pnpm run dev
```

Useful runtime checks:

```powershell
pnpm run doctor
pnpm run db:migrate:status
```

Do not use `npm ci` or Yarn. The authoritative lockfile is [`pnpm-lock.yaml`](pnpm-lock.yaml).

## Validation

Run the focused gates before pushing:

```powershell
pnpm run typecheck
pnpm run lint
pnpm run test:unit
pnpm run build
```

The project does not use Jest. Its test surface is split into:

- **Unit and contract tests:** `pnpm run test:unit`
- **Live/network tests:** `pnpm run test:live`
- **API smoke tests:** `pnpm run test:api`
- **UI checks:** `pnpm run test:ui`
- **Visual snapshots:** `pnpm run test:visual:snapshots`
- **Media and torrent E2E:** `pnpm run test:media:*`
- **Journey tests:** `pnpm run test:journeys`
- **Full orchestration:** `pnpm run test:all`

Browser verification uses Playwright. Network-dependent torrent tests are intentionally excluded
from the default offline unit run.

## Database commands

```powershell
pnpm run db:migrate          # Create/apply a development migration
pnpm run db:migrate:deploy   # Apply committed migrations
pnpm run db:migrate:status   # Check migration state
pnpm run db:studio           # Open Prisma Studio
```

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
