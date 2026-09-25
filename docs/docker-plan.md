---
title: 'Docker always-on hosting'
type: 'feature'
ticket: ''
created: '2026-09-26'
status: 'built'
baseline_revision: 'f74c3fb55288133728d9380d7171bb30d67f1723'
route: 'full'
route_source: 'pinned'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
---

<frozen-after-approval reason="owner authorized autonomous checkpoints">

## Intent

**Problem:** The Dockerfile and Compose still run Next.js instead of the .NET monolith. Server installations need persistent state, predictable download paths, usable permissions and remote access without publishing the trusted UI.

**Approach:** Build the Vite SPA and framework-dependent .NET host in separate stages, ship ffmpeg and a deliberate curl health probe, and provide documented local-only Compose with optional Cloudflare and VPN hosting. Expose container capabilities and display-only path mappings without changing the engine's filesystem paths.

## Boundaries & Constraints

**Always:** Work only on feat/docker. Keep the Windows executable and native defaults unchanged. Persist state at /data and downloads at /media; retain explicit storage-cap setup. Owner HTTP binds inside the container but publishes to host loopback. Remote tunnel targets the second authenticated listener. Run application code without root after permission initialization. Build amd64 and arm64.

**Never:** Push, stage BMAD scaffolding or secrets, use host port 3000 for verification, operate on real downloads, change the data schema, translate paths used by engine operations, or claim Docker runtime verification when Docker is unavailable.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Fresh container | Empty mounted data/media, numeric PUID/PGID | Writable state and suggested /media folder; explicit cap setup remains | Invalid IDs fail before launch |
| Existing data | Persisted settings | Existing download settings win over image defaults | Permissions failures stop startup |
| Native app | No override/container environment | Existing Downloads/TorrentFlow suggestion; folder opening works | Existing validation unchanged |
| Container folder action | Container flag true | Features disables open-folder; direct API returns unsupported | No file manager spawn |
| Display mapping | /media to UNC or Linux host path | Read-only locations show mapped path, APIs keep original path | Unmatched paths unchanged; longest boundary match wins |
| Tunnel routing | cloudflared targets 3940 | Authenticated listener validates Access | Wrong target 3000 gives existing 421 |
| Missing token | Normal local-only startup | Cloudflared opt-in profile is not started | Tunnel profile requires operator configuration |

</frozen-after-approval>

## Code Map

- `Dockerfile`, `.dockerignore`, `docker-compose.yml`: stale Next.js packaging to replace.
- `server/TorrentFlow.Api/TorrentFlow.Api.csproj`: PublishWeb requires web/dist even when SkipWebBuild=true; copies to wwwroot.
- `server/TorrentFlow.Api/Program.cs`: data directory override, URL binding, health and features already exist.
- `server/TorrentFlow.Engine/Settings/ClientSettingsStore.cs`: static native default folder; settings row deliberately leaves folder/cap unset.
- `server/TorrentFlow.Engine/Controllers/SettingsClientController.cs`: defaults returned to setup UI.
- `server/TorrentFlow.Engine/Controllers/FoldersController.cs`: validated OS file-manager launch; refuse container invocation before spawning.
- `web/src/lib/features.tsx`: existing fail-closed capabilities provider, extend rather than create another fetch.
- Downloads page/dialog, settings page, retention panel: current open-folder actions and path displays.
- `.github/workflows/ci.yml`: read-only default permissions, checkout v4, bounded jobs and concurrency conventions.
- `docs/remote-access.md`: listener-specific trust; keep Host unchanged and never publish 3940 to the host.

## Tasks & Acceptance

**Execution:**
- [x] `Dockerfile`, `docker/entrypoint.sh`, `.dockerignore` — build SPA then publish host, install ffmpeg/curl/gosu, initialize permissions and drop privileges.
- [x] `docker-compose.yml`, `docker-compose.vpn.yml`, `.env.example` — persist volumes, pin peer port, isolate tunnel network with separate egress and opt-in Cloudflare profile.
- [x] Engine settings/controllers, API features — configurable folder suggestion, container capability and configured path mappings.
- [x] Web features and folder/path surfaces — disable unsupported actions, map only read-only displayed locations.
- [x] API/Engine and web tests — native/container defaults, feature response, unsupported opening, longest-prefix path mapping and untouched operations.
- [x] `.github/workflows/docker.yml` — multi-arch build on PR, authenticated GHCR publication only on v tags.
- [x] `docs/docker.md`, dotnet-port and remote-access docs — quick start, permissions, tunnel, VPN, mapping, performance, verification limits.

**Acceptance Criteria:**
- Given built SPA assets, when framework-dependent publish skips the web build, then published wwwroot contains the SPA.
- Given Docker availability, when the image runs at host 3923 with scratch volumes, then health is ready, UI renders, ownership matches and state survives; otherwise local publish and explicit runtime-verification limitation are required.
- Given fresh image defaults, when setup loads, then /media is suggested without bypassing the explicit storage cap.
- Given a v tag, when CI succeeds, then both supported Linux architectures are published; PR builds never authenticate or push.
- Given container capabilities, when settings/downloads render at 390, 768 and 1280 pixels, then folder launching is disabled and no new overflow is introduced.

## Implementation Notes

- Implemented directly in this assigned worktree; nested implementation delegation was not needed.
- The bootstrap workflow document was at root `bmad-workflow.md`, not the requested nonexistent `docs/bmad-workflow.md`. Read the root version. Owner authorized autonomous checkpoint choices; plan approved and continued.
- Docker CLI is absent. Used the expressly permitted publish/lint fallback and added CI runtime smoke coverage; no container execution/ARM64/ownership results are claimed locally.
- Preserved pre-existing modified AGENTS.md and untracked BMAD scaffolding, not staged.

## Plan Change Log

## Review Triage Log

Four independent read-only lenses ran (Opus 5 low for blind/edge/intent; GPT-5.6 Luna for verification).
Patch fixes were followed by all four .NET suites, web tests/types/build, shell/YAML checks and a fresh publish.

| Finding | Verdict / route | Evidence and action |
|---|---|---|
| Blind: missing pnpm workspace install settings | medium / patch | Copied web/pnpm-workspace.yaml before frozen install to match local policy. |
| Blind: old Docker state/media adoption undocumented | high / patch | Documented prod.db override, legacy tf-downloads mount, original key backup and staged migration before removing volumes. |
| Blind: Gluetun input ports also allow VPN interface | false | Upstream firewall documentation distinguishes default-interface FIREWALL_INPUT_PORTS from FIREWALL_VPN_INPUT_PORTS; main.go applies InputPorts to defaultRoutes' interface, not VPN interface. No speculative firewall rewrite. |
| Blind: dropped ENCRYPTION_KEY forwarding | high / patch | SecretProtector reads it directly; restored forwarding in both examples. |
| Blind: CI never executes entrypoint/health | medium / patch | Added amd64 load/run smoke before tag publication, invalid IDs, identity/ownership, UI/health and persistence checks. Local run still unavailable. |
| Blind: supplementary group ACL promise | medium / patch | Clarified ACLs must target PUID or primary PGID; numeric gosu does not inherit host groups. |
| Blind: identity mapping falsely labeled host path | medium / patch | Default mapping now empty; settings asks for MEDIA_DISPLAY_PATH if untranslated. |
| Blind: local build occupies release tag | low / patch | Documented distinction and mandatory pull + --no-build when returning to a release; existing upgrade commands already pull explicitly. |
| Edge: failed /media chown lacks actionable hint | low / patch | Added pre-provision/user override diagnostic while retaining fail-fast. |
| Edge: failed /data repair lacks actionable hint | low / patch | Added explicit ownership repair diagnostic; no silent partial-success startup. |
| Edge: native tunnel could call folder-launch API | medium / patch | RemoteAccessMiddleware now refuses the route; authenticated tunnel regression added. |
| Edge: Linux host directory containing backslash | low / patch | Windows separators selected only for UNC/drive prefix; added test. |
| Edge: removed encryption env | high / patch | Same verified root cause as blind finding; forwarding restored. |
| Edge: legacy /downloads becomes unmounted | high / patch | Same migration documentation fix; no automatic rewriting of saved transfer paths. |
| Edge: removed ENABLE_1337X forwarding | medium / patch | Restored existing env forwarding in both examples. |
| Verification: tunnel flag not enforced on endpoint | medium / patch | Authenticated API test now exercises 409 as well as openFolder false; middleware rejects before filesystem access. |
| Intent: peer publication broadens surface | false | Owner explicitly requested peer TCP/UDP port publication; HTTP remains host-loopback only. |
| Intent: authenticated remote sees mapped host paths | false | Existing owner-only remote access can already see original paths; display mapping is intentionally owner-facing. |
| Intent: container capability follows env override | false | Owner explicitly requested DOTNET_RUNNING_IN_CONTAINER detection; environment is trusted deployment configuration. |
| Intent: Docker runtime and ARM64 not locally exercised | maybe-false / documented limit | Docker is unavailable; owner allowed fallback. CI now contains runtime smoke; multiarch image still requires Docker-enabled execution. |
| Intent: mapped component surfaces lack dedicated rendering tests | low / accepted | Pure boundary/separator tests plus real settings MCP check and unchanged operation payloads cover minimal presentation change; no full download fixture was claimed. |
| Intent: runtime claims such as 421 lack evidence | false in part / documented limit | RemoteAccess suite including 421 ran; Docker-specific claims remain unexecuted locally and explicitly disclosed. |
| Intent: retained legacy DATABASE_URL | false | Retained solely for unchanged Next.js tooling, labeled ignored by .NET; avoids unrelated regression. |
| Intent: Defaults changed static to instance | false | No other callers; instance accesses injected configuration and existing API shape remains. |

## Design Notes

Compose networks isolate membership, not ports: cloudflared must target 3940 and no untrusted containers should join the app networks. A trusted connector shares connectivity to the owner listener; documentation must not falsely claim `expose` is a firewall. Separate egress networks preserve torrent and Cloudflare connectivity alongside the internal tunnel network. VPN is a standalone alternative Compose file to avoid unsafe port/network merges. Path mappings are deployment configuration delivered by features, not persisted client path rules.

## Verification

- `docker version`, image build/run and `docker compose config` when available.
- Offline frozen pnpm install, web TypeScript, node tests and production SPA build.
- API, Engine, Library and Media `dotnet test -p:SkipWebBuild=true`.
- Local framework-dependent publish to worktree scratch directory; run only on 127.0.0.1:3923 and verify health/features/settings through HTTP and UI through Playwright MCP.
- Self-review all modified files; preserve unrelated AGENTS.md/bootstrap changes. Remove scratch artifacts and stop only own process before explicit-file commit.

**Results:** API 77 passed; Engine 257 passed / 3 pre-existing skipped; Library 116 passed;
Media 487 passed / 4 pre-existing skipped. Web 21 passed; TypeScript and Vite production build passed.
Framework-dependent publish passed with wwwroot/index.html; isolated port 3923 returned health 200,
container flag true/openFolder false, /media default, and database in configured scratch data directory.
Playwright MCP navigated settings, opened Advanced and confirmed disabled folder action plus UNC mapping.
CSS widths 390/768/1280 were measured (tool window sizes adjusted for 125% Windows scaling); no horizontal
document overflow. Docker/Compose unavailable: YAML contracts and sh syntax passed, but image execution,
Linux permission repair, actual cloudflared/VPN connection and ARM64 runtime remain unverified.
