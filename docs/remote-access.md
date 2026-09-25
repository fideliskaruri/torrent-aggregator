# Remote access (Cloudflare Tunnel + Access)

TorrentFlow normally listens only on `http://127.0.0.1:3000` and trusts everyone who can reach it, because
that is only you, on this computer. Remote access lets the owner use it from a phone or away from home
without opening a port on the router and without TorrentFlow storing any password:

- **Cloudflare Tunnel** (`cloudflared`) carries the connection from Cloudflare to this computer.
- **Cloudflare Access** decides who may sign in (email one-time PIN, Google, GitHub, …).
- **TorrentFlow** checks the signed token Access attaches to every request and lets in only the owner emails.

It is off by default. Code: `server/TorrentFlow.Api/RemoteAccess/`; UI: Settings → Remote access
(`web/src/components/settings/remote-access-section.tsx`).

## Setup

1. In Cloudflare Zero Trust, create a tunnel (**Networks → Tunnels**) and install `cloudflared` on this
   computer with the command Cloudflare shows.
2. Add a **public hostname** to the tunnel, for example `tf.example.com`, with the service set to the tunnel
   URL shown in Settings, `http://<TunnelBindAddress>:<TunnelPort>` (`http://127.0.0.1:3940` by default; the
   tunnel port, **not** the port you open TorrentFlow on). Leave **HTTP Host Header** (`httpHostHeader`)
   empty so cloudflared forwards the public host unchanged; same-site writes depend on it (see below).
3. Create a **self-hosted Access application** for that hostname, with a policy that allows only your
   email. Copy the application's **Audience (AUD) tag** from its overview.
4. In TorrentFlow on this computer, open **Settings → Remote access**, paste the team domain
   (`<team>.cloudflareaccess.com`) and the AUD tag, add your email, turn remote access on and save.
5. Restart TorrentFlow. **Check setup** fetches your team's signing keys and lists anything missing.
6. Open `https://tf.example.com` on the phone, sign in to Access, and install the app from the browser
   menu if you like.

Settings live in `<dataDir>/remote-access.json` (written atomically) over the `TorrentFlow:RemoteAccess`
configuration section:

| Setting | Default | Applies |
| --- | --- | --- |
| `Enabled` | `false` | on restart |
| `TunnelPort` | `3940` | on restart |
| `TunnelBindAddress` | `127.0.0.1` | on restart |
| `TeamDomain` | — | immediately |
| `Audience` | — | immediately |
| `OwnerEmails` | — (array, or a comma-separated string from an environment variable) | immediately |
| `AllowRequesters` | `true` | immediately |

The API reports `restartRequired` when the saved listener settings differ from the running ones.
A tunnel port equal to the owner port stops startup with an error, and is refused on save.
Turning remote access **off** takes effect immediately for requests: the tunnel listener stays open until
the restart, but refuses everything with a 401. If a `Kestrel:Endpoints` configuration overrides the URL
list, the tunnel port never binds; TorrentFlow checks the bound addresses after startup, logs an error, and
reports `listening: false`.

## Settings API

All responses are JSON with `Cache-Control: no-store`.

- `GET /api/settings/remote-access` returns `enabled`, `tunnelPort`, `tunnelBindAddress`, `teamDomain`,
  `audience`, `ownerEmails`, `allowRequesters`, `restartRequired`, `running` (`enabled`, `tunnelPort`, `tunnelBindAddress`,
  `listening`, `tunnelUrl` of the running listener), `ownerPorts`, `editable` (false through the tunnel),
  `via` (`local`/`tunnel`) and `warnings` (problems found loading the settings; cleared by a successful save).
- `PUT /api/settings/remote-access` (local listener only; 403 through the tunnel) takes a JSON object with
  any of `enabled` (boolean), `tunnelPort` (1024–65535, not an owner port), `tunnelBindAddress` (an IP
  address), `teamDomain` (`team`, `team.cloudflareaccess.com` or its URL; `null`/empty clears it),
  `audience` (the AUD tag; `null`/empty clears it), `ownerEmails` (an array of email strings, at most
  50) and `allowRequesters` (boolean). Omitted fields keep their value. `Content-Type` must be JSON (415 otherwise); the body is limited to
  16 KB (413) and read with a bounded buffer. Unknown fields, wrong types, non-string emails and invalid
  values give a 400 with an `error` message and nothing is written. `enabled: true` requires the team
  domain, AUD tag and at least one owner email. A failure writing the file gives a 500 with a readable
  message. The response is the same shape as the GET.
- `GET /api/settings/remote-access/check` returns `ok`, `listening`, `tunnelUrl`, `issuer`, `keyCount`,
  `keysError` and `problems` (a list of human-readable steps still missing). It fetches the team's signing
  keys directly, with a 10 s timeout.

## Security model

- **Trust is decided by the connection's local port.** Requests on the tunnel port need a token;
  requests on the owner port are the local owner. `Host` and `X-Forwarded-*` are never consulted.
- The tunnel listener joins the same `UseUrls` list as the owner listener, so `--urls` and
  `ASPNETCORE_URLS` keep working (`ConfigureKestrel().Listen()` would silently replace them).
- `RemoteAccessMiddleware` runs before static files, the SPA fallback and every endpoint, so an
  unauthenticated tunnel request gets a JSON 401 and never `index.html` or an asset.
- The `Cf-Access-Jwt-Assertion` token must be RS256 (`none`, HS256 and every other alg are refused before
  any key lookup), issued by `https://<team>.cloudflareaccess.com`, have the AUD tag in `aud` (an array),
  pass `exp`/`nbf` with 60 s of skew, and carry an `email` claim. Service tokens have no email and are
  refused. Emails are compared lowercase.
- Signing keys come from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, cached for an hour.
  An unknown `kid` refetches at most once every 5 minutes. A failed fetch keeps the last good keys for at
  most 24 hours; after that, or with none, the request gets a 401 and the failure is logged. Reasons are
  logged, never echoed to the client.
- A 401 that signing in again cannot fix (remote access turned off, team/AUD/owners missing, signing keys
  unreachable) carries `X-TorrentFlow-Auth: misconfigured`; a missing, expired or invalid token carries
  `X-TorrentFlow-Auth: required`. The SPA only treats `required` as an expired session.
- A signed-in email that is not an owner is a **requester** (see [Requesters](#requesters)). With
  `AllowRequesters` off it gets 403 "not enabled yet" instead. The log line masks the email
  (`j***@example.com`).
- Remote access settings can only be changed from the local listener; through the tunnel they are
  read-only (403 on PUT), so a stolen remote session cannot widen who gets in.
- `UnsafeMethodGuardMiddleware` refuses POST/PUT/PATCH/DELETE with `Sec-Fetch-Site: cross-site`, or
  `same-site` from another host, on both listeners. Without `Sec-Fetch-Site`, a request that sends an
  `Origin` must still come from this host; one with neither (curl, scripts) passes. Origin is compared to
  `Host` only, because the browser uses https while cloudflared reaches Kestrel over http. **This requires
  cloudflared to forward the public `Host` unchanged**: do not set an `httpHostHeader` override on the
  tunnel's public hostname, or every same-site write through the tunnel is refused. The per-module guards
  stay in place.
- Every admitted request carries a `ClaimsPrincipal` (`email`, `tf:role`, `tf:via`, and `tf:uid` for
  requesters). `GET /api/me` returns `{ role, via, email, pendingRequests }`: `role` is `owner` or
  `requester`; `pendingRequests` is the number of requests waiting for a decision, for the owner only
  (`null` for requesters).

## Requesters

Friends outside the home sign in through the same Cloudflare Access application. Who may sign in is
managed only in Cloudflare (the Access policy); TorrentFlow has no user management. Any email that passes
Access and is not in `OwnerEmails` becomes a requester while `AllowRequesters` is on (the default).

- On first sight a `User` row is created for the lowercase email; request rows point at it. Owner data
  keeps using the local user and is never shared with requesters.
- A requester reaches **only** this allow-list: `/api/requester/*`, `/api/me`, `/api/health`,
  `/api/features`, static assets and the SPA fallback (`index.html`). Everything else, on any method,
  gets 403 `{ code: "requester_forbidden" }`: library, browse, indexer search, downloads, streaming,
  settings, the owner's `/api/requests` list, deletion.
- Enforcement is two layers. `RemoteAccessMiddleware` checks the path before static files and routing
  (so a requester cannot reach an `/api` path that routes nowhere, and odd spellings such as `/API`,
  `//api`, `/api.` or `/%61pi` are treated as `/api`). After routing,
  `RequesterAuthorizationMiddleware` requires the matched endpoint to carry `AllowRequesters()`
  metadata. **New endpoints are therefore owner-only by default**; a test builds the full list from
  `EndpointDataSource` and asserts that every endpoint except the allow-list answers 403 to a requester.
- Requester endpoints refuse the owner (403 `requester_only`); they only ever touch the caller's own rows.
- The SPA reads `role` from `/api/me` and renders a trimmed shell for requesters (title search with
  Request buttons, My requests). Owner navigation and pages are never mounted for them. On a non-loopback
  host the SPA waits for `/api/me` before choosing a shell, and offers a retry if it fails. This is presentation only; the server
  enforces the boundary.
- Turning `AllowRequesters` off applies immediately and restores the 403 "not enabled yet" answer.
  **Upgrading turns requesters on** (a settings file without the key uses the default `true`). If your
  Access policy admits more people than you want asking for titles (for example a whole email domain),
  narrow the policy or turn requesters off in Settings.

See [requests.md](requests.md) for the request API and its rules.

## Misrouted tunnel (421)

If the tunnel's service points at the owner port (for example `http://127.0.0.1:3000`), Cloudflare traffic
would arrive on the trusted listener with no token check. The local listener therefore refuses any request
carrying `Cf-Ray`, `Cf-Connecting-Ip`, `Cf-Access-Jwt-Assertion` or `Cdn-Loop: cloudflare` with
**421 Misdirected Request** and a message naming the configured tunnel URL. This applies even while remote
access is off. Fix it by changing the tunnel's service to that URL
(`http://<TunnelBindAddress>:<TunnelPort>`).

## Streaming is off remotely

`/api/stream`, `/api/playback`, `/api/prewarm` and `/api/subtitles` answer 404 with
`streamingDisabled: true` on the tunnel listener, and `/api/features` reports `streaming: false` there, so
the SPA hides playback. Cloudflare's service terms restrict serving video and other large media through
its proxy (they point to Stream, Images or R2 instead), and its 100 s proxy timeout breaks long-lived
media responses. Browse, search, downloads, library and settings all work remotely for owners.
Server-side folder launching is also unavailable through the tunnel: `/api/features` reports
`openFolder: false`, and `/api/settings/open-folder` returns 409 before launching a file manager.

## Browser details

- The manifest link uses `crossorigin="use-credentials"`: without cookies, Access redirects the manifest
  fetch to its sign-in page and the PWA cannot be installed.
- When an Access session expires, `/api` calls are redirected to Cloudflare (a followed redirect, a 401
  with `X-TorrentFlow-Auth: required`, or a rejected fetch). While the page came through the tunnel,
  `sessionAwareFetch` in `web/src/lib/session-expiry.ts` (used by `use-api-query` and the remote access
  panel) reports that, and `SessionProvider` (`web/src/lib/session.tsx`) shows a "session expired, reload"
  prompt. A rejected fetch only counts when the browser is online and a `redirect: "manual"` probe of
  `/api/me` comes back as an `opaqueredirect`, so a dropped connection or a cloudflared restart is shown as
  an ordinary error. `/api/me` is polled every minute so idle pages notice too, and a successful poll
  clears the prompt.
- The service worker already bypasses `/api/`; navigations are passed to the network, so the Access
  sign-in redirect works unchanged.

## Docker

See [Docker server hosting](docker.md) for Compose, persistent volumes and an optional VPN example.
Compose publishes the owner UI only to host loopback, binds the tunnel listener to `0.0.0.0`,
and connects cloudflared over an internal network. Configure the Cloudflare service as
`http://torrentflow:3940` (or `http://gluetun:3940` with the standalone VPN example), never port 3000.
Existing saved listener settings override environment defaults; update them and restart.
The connector is trusted: a shared Docker network does not filter ports, and anything that can
reach the owner port without Cloudflare headers is treated as the owner. Do not attach untrusted
containers or publish the tunnel port. Start cloudflared explicitly with the `remote` profile.

## Tests

`server/tests/TorrentFlow.Api.Tests/RemoteAccessTests.cs` covers every row of the plan's I/O matrix with a
TestServer. TestServer has no real `LocalPort`, so an `IStartupFilter` sets it from a test-only header,
and an in-memory RSA key replaces the Cloudflare key source. The production build has no such backdoor.
One test starts real Kestrel on two ephemeral loopback ports (owner and tunnel) and checks the split over
real sockets. `RequesterTests.cs` covers the requester role, the allow-list table and the request rules.
`web/tests/session-expiry.test.mjs` covers the SPA's expiry detection and `web/tests/requester.test.mjs`
the role-aware shell.
