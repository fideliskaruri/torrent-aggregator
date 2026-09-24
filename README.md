# TorrentFlow (torrent-aggregator)

A Next.js app for finding, tracking and streaming torrents. Agent-facing rules live in
[`AGENTS.md`](AGENTS.md); UI decisions live in [`docs/design-system.md`](docs/design-system.md).

## Requirements

- **Node.js `22.23.2`** — the version pinned in [`.nvmrc`](.nvmrc). `package.json` declares
  `engines.node: ">=22.12.0 <23"`, so any Node 22.12+ (but not 23) satisfies the runtime check.
- **pnpm `12.4.2`** — the package manager pinned by `packageManager` in `package.json`. Do not use
  npm or yarn; the repo's lockfile is `pnpm-lock.yaml`.

Enable pnpm through Corepack so the pinned version is the one that runs:

```bash
corepack enable
```

## Install

```bash
pnpm install --frozen-lockfile
```

`--frozen-lockfile` is what CI runs; it fails instead of silently updating `pnpm-lock.yaml`.

## First-time setup

```bash
pnpm run setup
```

`setup` checks the Node version and the native/media/build tooling, creates `.env` from
`.env.example` when it is missing, then runs `prisma generate`, `prisma migrate deploy` and
`prisma migrate status`. Re-running it is safe — it keeps an existing `.env`.

## Run the dev server

```bash
pnpm run dev
```

This starts Next.js on **http://127.0.0.1:3000** (`next dev -H 127.0.0.1 -p 3000`) and runs
`pnpm run doctor` first via `predev`.

> The **owner** runs the dev server on port 3000. Agents must only read from it — never start,
> stop, restart or rebuild it. It hot-reloads edits on its own.

## Validation

Run these before pushing; CI runs the same commands:

```bash
pnpm run typecheck   # tsc --noEmit
pnpm run lint        # eslint
pnpm run test:unit   # offline unit tests
pnpm run build       # prisma generate && next build
```

## Database

```bash
pnpm run db:migrate          # create/apply a dev migration
pnpm run db:migrate:deploy   # apply migrations (CI / production)
pnpm run db:migrate:status   # verify migration state
pnpm run db:studio           # Prisma Studio
```

## Docker

The production image (see [`Dockerfile`](Dockerfile)) builds on `node:22-bookworm-slim`, activates
pnpm `12.4.2` through Corepack, installs with `--frozen-lockfile`, runs `prisma migrate deploy` on
start, and serves the app on port `3000` bound to the container's own interfaces.
