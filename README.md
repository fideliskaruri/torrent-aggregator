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
