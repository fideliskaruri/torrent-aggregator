# TorrentFlow

**One app.** Search, smart download folders, library automation, and a **built-in BitTorrent engine** — no qBittorrent install required.

Optional: connect your own **qBittorrent** or **Transmission** in Settings if you prefer.

## Quick start (one process)

```bash
cd torrent-aggregator
npm install
cp .env.example .env   # only DATABASE_URL is required
npm run db:migrate:deploy
npm run dev
```

Open http://localhost:3000 → **Search → Send**.
Downloads go to `./downloads` by default (or `DOWNLOAD_DIR`).

There is no sign-in. TorrentFlow is a single-user app that runs on your own
machine, so it binds to `127.0.0.1` and trusts whoever is at the keyboard.
See [Access and exposure](#access-and-exposure) before putting it on a network.

### Docker (single service)

```bash
docker compose up --build
```

Volumes: app data + `/downloads`. No second container.

## Features

- Multi-source search (Nyaa, apibay, Torrents-CSV, YTS, optional 1337x)
- Smart routing: `Anime/One Piece`, `TV/Show/Season 01`, Software vs Movies, etc.
- **Built-in engine** (WebTorrent) or optional external clients
- Library + monitored automation + Activity
- Dark amber UI, PWA

## Download engines

| Mode | When |
|------|------|
| **Built-in (default)** | One-app install; public magnets; no host URL required |
| **qBittorrent / Transmission** | Optional — your Web UI, private trackers, advanced tools |

Switch anytime: **Settings → Connection**. Built-in hides host fields; external clients need Host URL + credentials.

Default download root: `DOWNLOAD_DIR` or `./downloads` (Docker volume `/downloads`).

## Access and exposure

`npm run dev` and `npm start` bind to `127.0.0.1`, so the app is reachable only
from the machine it runs on. This is deliberate: there is no sign-in, so anyone
who can reach the port can browse folders, change your download paths, and
start downloads.

To reach it from another device, put it behind something that authenticates —
a reverse proxy with basic auth, a VPN, or a Tailscale/WireGuard network — and
point that at `127.0.0.1:3000`. Binding straight to `0.0.0.0` publishes an
unauthenticated app to your whole LAN.

External client passwords are encrypted at rest with AES-256-GCM. If you do not
set `ENCRYPTION_KEY` or `AUTH_SECRET`, a key is generated on first use and
stored in `.torrentflow.key` (gitignored) — back it up with your database, or
saved passwords will not decrypt after a move.

## Environment

| Variable | Required | Description |
| -------- | -------- | ----------- |
| `DATABASE_URL` | Yes | Default `file:./dev.db` |
| `ENCRYPTION_KEY` | No | Encrypts stored client passwords. Auto-generated if unset. |
| `DOWNLOAD_DIR` | No | Default download root (Docker: `/downloads`) |
| `TMDB_API_KEY` | No | Movie/TV metadata |
| `ENABLE_1337X` | No | Set `1` to enable 1337x |

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for required CI gates, migration rules,
and the offline-test policy. Release maintainers should also read
[docs/releasing.md](docs/releasing.md).

```bash
npm run test:unit    # fast, offline — no network required
npm run test:api     # contract-checks every API route against a running server
npm run test:ui      # layout, contrast and modal probes against a running server
npm run test:live    # the indexer-backed tests (needs unblocked network)
npm test             # everything: units, library, API contract, browse gates
npm run test:all     # same as npm test
npm run lint
npm run typecheck
npm run audit:prod   # fails on unreviewed high/critical production findings
```

`test:unit` discovers every `src/**/*.test.ts` and reports all of them, so one
failure does not hide the rest. Tests that hit real torrent indexers are kept
out of it — they fail on networks that block those hosts, which says nothing
about the code.

`test:ui` needs a server already running (`npm run start`). It measures the
things `tsc`, `eslint` and `next build` cannot see: sticky positioning,
horizontal overflow, text contrast against WCAG AA on every route, and the
mobile sheet's scroll lock and focus trap.

`scripts/seed-demo.mjs` fills the library with sample shows and rules for
manual QA against a running server.

## Architecture

**Handing this project to someone (or some agent) else?** Start with
[docs/handover.md](docs/handover.md) — the pipeline map, the invariants that
must not break, the things that look wrong but are deliberate, and how to
verify a change.

See [docs/architecture/download-engine.md](docs/architecture/download-engine.md) for the pluggable engine design (builtin → optional external → future sidecar).

Navigation lives in one place — `src/lib/navigation.ts`. Header and mobile nav
both render from it, and `flow.test.ts` asserts the product rules against it.

Auth is a single seam: `src/lib/auth.ts` (server) and
`src/components/providers/session-provider.tsx` (client) return a constant local
session. Every table still carries a `userId`, so real user management can be
added by changing those two files rather than migrating the schema.

## Stack

Next.js 16 · Prisma + SQLite · Tailwind · WebTorrent (builtin)

## License / legal

Self-hosted aggregator — respect local law and indexer terms.
