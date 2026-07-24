# TorrentFlow

**One app.** Search, smart download folders, library automation, and a **built-in BitTorrent engine** — no qBittorrent install required.

Optional: connect your own **qBittorrent** or **Transmission** in Settings if you prefer.

## Quick start (one process)

```bash
cd torrent-aggregator
npm install
cp .env.example .env   # AUTH_SECRET, GitHub OAuth, optional TMDB
npx prisma db push
npm run dev
```

Open http://localhost:3000 → sign in → **Search → Send**.  
Downloads go to `./downloads` by default (or `DOWNLOAD_DIR`).

### Docker (single service)

```bash
export AUTH_SECRET=$(openssl rand -base64 32)
export AUTH_GITHUB_ID=...
export AUTH_GITHUB_SECRET=...
docker compose up --build
```

Volumes: app data + `/downloads`. No second container.

## Features

- Multi-source search (Nyaa, apibay, Torrents-CSV, YTS, optional 1337x)
- Smart routing: `Anime/One Piece`, `TV/Show/Season 01`, Software vs Movies, etc.
- **Built-in engine** (WebTorrent) or optional external clients
- Library + monitored automation + Activity
- GitHub OAuth, dark amber UI, PWA

## Download engines

| Mode | When |
|------|------|
| **Built-in (default)** | One-app install; public magnets; no host URL required |
| **qBittorrent / Transmission** | Optional — your Web UI, private trackers, advanced tools |

Switch anytime: **Settings → Connection**. Built-in hides host fields; external clients need Host URL + credentials.

Default download root: `DOWNLOAD_DIR` or `./downloads` (Docker volume `/downloads`).

## Environment

| Variable | Required | Description |
| -------- | -------- | ----------- |
| `DATABASE_URL` | Yes | Default `file:./dev.db` |
| `AUTH_SECRET` | Yes | Sessions + encryption |
| `AUTH_GITHUB_ID` / `SECRET` | For sign-in | GitHub OAuth |
| `DOWNLOAD_DIR` | No | Default download root (Docker: `/downloads`) |
| `TMDB_API_KEY` | No | Movie/TV metadata |
| `ENABLE_1337X` | No | Set `1` to enable 1337x |

## Architecture

See [docs/architecture/download-engine.md](docs/architecture/download-engine.md) for the pluggable engine design (builtin → optional external → future sidecar).

## Stack

Next.js 16 · Prisma + SQLite · Auth.js · Tailwind · WebTorrent (builtin)

## License / legal

Self-hosted aggregator — respect local law and indexer terms.
