# Docker server hosting

**Docker is the recommended always-on host** for a Linux server, NAS or 64-bit Raspberry Pi.
The Windows executable remains the desktop default; Docker is not required for desktop use.
The image builds the Vite SPA, publishes the framework-dependent .NET 10 host, and includes
ffmpeg/ffprobe. It supports `linux/amd64` and `linux/arm64` (not 32-bit Pi operating systems).

## Quick start

From the repository root on your Docker host:

```sh
cp .env.example .env
# Edit .env: set PUID/PGID (id -u / id -g), TZ and optionally MEDIA_PATH.
docker compose config --quiet
docker compose up -d --build torrentflow
docker compose logs --tail=100 torrentflow
```

Open `http://127.0.0.1:3000` **on the Docker host**. For a headless NAS, use an SSH local forward
from your desktop, for example `ssh -L 3923:127.0.0.1:3000 user@nas`, then open
`http://127.0.0.1:3923`. Do not change the UI publication to `0.0.0.0`: this is a trusted owner
listener, not an authenticated LAN service.

Before the first download, setup suggests `/media`; choose it and an explicit storage cap.
The image default does not overwrite existing settings or bypass setup. When configuring
Settings → Downloads manually, enter `/media`, not the host's mount path.

After a release is published, use the GHCR image instead of building locally:

```sh
# Optionally pin TORRENTFLOW_TAG=v<release> in .env; latest tracks published v tags.
docker compose pull torrentflow
docker compose up -d --no-build torrentflow
```

The source-build command tags its local result with the configured image reference; always run
`pull` followed by `up --no-build` as above when switching back to a published release.

Release image: `ghcr.io/fideliskaruri/torrent-aggregator`. Tags are published by
`.github/workflows/docker.yml`; PRs build both architectures without pushing.

## Volumes, paths and permissions

| Container path | Default volume | Contents |
|---|---|---|
| `/data` | `tf-data` | SQLite database, engine resume/DHT state, encryption key, remote-access settings and media caches |
| `/media` | `tf-media` | Downloaded media |

Set `MEDIA_PATH=/mnt/media` to bind an existing host directory instead of a named media volume.
The actual volume names carry the Compose project prefix. Use the same project name when
switching between the ordinary and VPN examples to retain those volumes.

`TorrentFlow__DataDirectory=/data` is explicit: framework-dependent publishing does not use
the single-file executable's desktop data-directory rules. `TorrentFlow__DefaultDownloadDirectory=/media`
only changes the **suggestion** returned by setup; saved paths still win.

`PUID` and `PGID` default to `1000`, must be positive integer IDs, and should match the host user
that owns the media library. `TZ` defaults to `Etc/UTC`; set an IANA zone such as `America/New_York`.
The entrypoint initially runs as root, repairs mismatched ownership under `/data` without
following symlinks or crossing nested mounts, initializes the `/media` mount root, then uses
`gosu` to exec .NET as `PUID:PGID`. Application processes are non-root. Files use umask `002`.

Existing media files are **not recursively chowned**: large NAS libraries should not be traversed
at every start. Make existing files/directories writable through PUID ownership or PGID group ACLs.
The numeric `gosu` drop does not inherit the host user's supplementary group memberships.
On root-squashed NFS/CIFS shares, permission repair may be refused: pre-provision matching
ownership/ACLs and, if necessary, set Compose `user: "<uid>:<gid>"` to skip root initialization.
Both mounts must already exist and be writable in that mode. Do not use UID/GID zero.

Back up `/data` **and** media. Stop TorrentFlow before copying the SQLite files; retain the
encryption key beside the database. Do not use `docker compose down -v` unless you deliberately
want to erase the named volumes. Updates do not move existing downloads.

### Upgrading the old Next.js Docker image

Do not blindly replace an existing Compose deployment: the old image used database `prod.db`
under `/app/data`, media volume `tf-downloads` at `/downloads`, and possibly a generated key in
the container's application directory. Stop the old service and back up both volumes and its
`.torrentflow.key` **before** removing its container. Preserve a configured `ENCRYPTION_KEY` in
`.env`; both new Compose examples forward it.

Use the same Compose project name to retain `tf-data`. Before starting the new image, add
`TorrentFlow__DatabasePath: /data/prod.db` to its environment to adopt the existing database
instead of creating `torrentflow.db`. Copy the original generated key into the data volume as
`.torrentflow.key` if you did not use `ENCRYPTION_KEY`.

For existing media, add `tf-downloads:/downloads` to the service's volumes and declare
`tf-downloads:` under top-level volumes. Keep this compatibility mount until all old transfers
and saved category paths are migrated; changing the default folder alone does not rewrite them.
Use `/media` for new downloads, or intentionally mount the old volume at both paths while
migrating. Verify library and downloads before deleting any old volume. Keep backups for rollback;
never run old and new hosts against the same SQLite file simultaneously.

### Display-only host path mapping

In `.env`, map the default `/media` prefix to a host-readable location:

```dotenv
MEDIA_DISPLAY_PATH='/mnt/media'
# Or Windows/SMB:
# MEDIA_DISPLAY_PATH='\\NAS\media'
```

Compose passes this as:

```yaml
TorrentFlow__DisplayPathMappings__0__ContainerPath: /media
TorrentFlow__DisplayPathMappings__0__HostPath: /mnt/media
```

Additional numbered entries support nested mounts. The longest matching directory prefix wins;
`/media` does not match `/media-backup`, and Linux path matching is case-sensitive. Targets can
be Linux paths, Windows drive paths or UNC paths. Use non-root container directory prefixes.
An unset `MEDIA_DISPLAY_PATH` creates no mapping and Settings asks you to configure one rather
than claiming the container path is a host location.

Downloads' file details/delete confirmation, notification save locations and storage inventory
show translated paths. Settings shows the host location alongside the unchanged container input.
This is **not filesystem remapping**: folder pickers, saved settings, downloads and deletion APIs
always use the original container paths. `/api/features` exposes the mappings plus
`runningInContainer` and `openFolder`. Open-folder controls are disabled in a container; direct
folder-launch requests return 409 rather than trying to start a server-side desktop file manager.

## Ports and health

| Port | Publication | Purpose |
|---|---|---|
| `3000/tcp` | `127.0.0.1:3000` only | Trusted owner UI/API |
| `3940/tcp` | **Not published** | Authenticated remote listener, only enabled after remote setup/restart |
| `6881/tcp` + `6881/udp` | Host peer port | Built-in BitTorrent and DHT |

`ASPNETCORE_URLS=http://0.0.0.0:3000` makes the owner listener reachable through Docker's loopback
publication. `TorrentFlow__Engine__ListenPort=6881` pins the peer port (zero would choose a random
port). If changing it, change both TCP and UDP mappings too. Never forward owner/tunnel HTTP
ports from your router. Peer router forwarding is optional and affects incoming connectivity.

The image deliberately installs **curl** and probes `/api/health` on container loopback with a
four-second timeout. A healthy response means the required SQLite schema is readable, not just
that a process exists. Inspect with `docker compose ps` and `docker inspect <container>`.
Allow up to the healthcheck's 40-second startup grace. Stop gets 60 seconds for engine shutdown.

## Cloudflare Tunnel + Access

Follow [Remote access](remote-access.md) to create an Access application restricted to your owner
email, obtain its team domain/AUD, and enable remote access in local Settings. Set the bind address
to `0.0.0.0` and tunnel port to `3940`; Compose supplies these defaults but an existing
`/data/remote-access.json` takes precedence. Save and restart TorrentFlow.

1. Set `TUNNEL_TOKEN` in `.env` from your Cloudflare tunnel. Never commit `.env` or real tokens.
2. Configure the public hostname's service in Cloudflare as **`http://torrentflow:3940`**.
3. Leave **HTTP Host Header** empty. Access and same-origin writes require the public Host unchanged.
4. Run `docker compose --profile remote up -d`.
5. Check local Settings → Remote access → Check setup, then sign in through the public hostname.

Pointing cloudflared at `http://torrentflow:3000` gets **421 Misdirected Request**, not an
authentication bypass. Streaming stays disabled through the tunnel. The `remote` profile is
opt-in so a local-only server starts without a token; an empty/invalid token cannot establish a tunnel.

Both services join an **internal** `tunnel` network. Separate egress networks let TorrentFlow
reach peers/indexers and cloudflared reach Cloudflare. Network membership is not a per-port firewall:
the connector can technically connect to the owner listener too, so it must be trusted and configured
to target **only 3940**. Do not attach unrelated/untrusted containers to these networks; `EXPOSE`
does not enforce isolation. Do not publish the tunnel port on the host.

## Optional VPN (Gluetun)

`docker-compose.vpn.yml` is a **standalone alternative**, not an override to merge with the main file.
It requires a host TUN device and a supported WireGuard provider. Fill `VPN_SERVICE_PROVIDER`,
`WIREGUARD_PRIVATE_KEY`, `WIREGUARD_ADDRESSES` and any provider-specific region settings in `.env`.
The example's `SERVER_COUNTRIES` is optional. Consult your provider's Gluetun configuration for
additional required settings.

```sh
docker compose down
docker compose -f docker-compose.vpn.yml config --quiet
docker compose -f docker-compose.vpn.yml up -d --build
# Optional remote connector:
docker compose -f docker-compose.vpn.yml --profile remote up -d
```

TorrentFlow uses `network_mode: service:gluetun`; **cloudflared must target
`http://gluetun:3940`**, not `torrentflow:3940`. Only Gluetun publishes the loopback owner port.
Its firewall permits owner/tunnel ingress while the VPN provides TorrentFlow's outbound route.
Cloudflared keeps its own egress so a VPN reconnect does not interrupt the connector itself.

The example intentionally does not expose a host peer port as a substitute for provider-side VPN
port forwarding. Incoming peers require provider support: configure the forwarded VPN port,
Gluetun's `FIREWALL_VPN_INPUT_PORTS` and `TorrentFlow__Engine__ListenPort` consistently. A dynamic
provider port needs operator automation; this example does not promise automatic forwarding.
Verify the VPN public IP and kill switch before downloading. Recreate TorrentFlow when recreating
Gluetun so it joins the new network namespace. Do not add a direct app egress network.

## Windows mounts and troubleshooting

For Windows desktops prefer the native executable. Docker Desktop bind mounts from Windows drives,
especially network-mapped drives, can be slower for torrent random writes and metadata scans.
Prefer Linux/WSL-backed storage or a native Linux NAS; a Windows drive letter also may not exist
inside Docker's VM. SMB/UNC **display mapping does not mount a share**. Mount the share on the
Docker host first and bind that host path as `MEDIA_PATH`. Keep SQLite `/data` on local storage
rather than an SMB share.

If startup fails, check volume permissions, configured IDs, logs and saved remote listener settings.
If the UI works but health fails, inspect `/api/health` and the database migration logs. If the
tunnel fails, confirm Access is enabled, restart has happened, target port is 3940, and the token
is current. A media path changed in Compose never migrates old database paths automatically.

## Verification record

The implementation host had no Docker CLI/daemon, so **the image was not built or run locally**,
and Compose config validation, Linux ownership, ARM64 runtime and healthcheck status require a
Docker-enabled runner. YAML and shell syntax were checked locally. The real framework-dependent
publish was built with `SkipWebBuild=true`; its SPA, health, container capabilities and path display
were exercised on isolated host port `3923`. See [delivery plan](docker-plan.md) for test evidence.
The Docker workflow additionally loads an amd64 smoke image before publication and checks invalid
IDs, non-root process identity, file ownership, media writes, health, UI and restart persistence.
Those CI steps have been authored, not run from the Docker-less implementation host.
