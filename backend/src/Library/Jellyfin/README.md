# Jellyfin watch-state adapter

Read-only integration with Jellyfin Items (UserData) and Shows/NextUp.
Library depends only on Domain. API composition reads typed settings and resolves
the protected API key using the same secret-file mechanism as TMDB.

Owner-only `/api/settings/jellyfin`: GET, PUT `{serverUrl,apiKey?,userId}`, DELETE,
and POST `/test` `{serverUrl?,apiKey?,userId?}`. Reads never return the API key.
PUT without apiKey preserves the saved key. DELETE disconnects the integration.

Title reads add optional `watchState: {watched,inProgress}` to films and episode
rows, where inProgress is a percentage from 0 to 100, and
`jellyfinNextUp: {episodeId,season,episode}` to series. Existing fields are unchanged.
Missing/unreachable Jellyfin omits these new fields. The complete read, including
cache contention, pagination and NextUp, has a 1500 ms deadline.

Verified Tmdb/Tvdb/Imdb provider IDs match first. Episodes also match their parent
series provider identity and exact season/episode coordinates. Exact normalized
owned-file paths are the fallback; ambiguous identities are not guessed.
Snapshots use CacheKind.JellyfinState with a 15-second in-memory TTL; settings
changes invalidate immediately. Failures do not serve stale watch-state data.
Unavailability is cached for five seconds, preventing every title read from
waiting for the same offline server.

Real integration evidence: gitignored `tools\.jelly-proof\` (OPS-823).
Official portable Jellyfin 12.1 ran only on loopback 8097 with its own data.
Three full licensed Blender films transferred through the actual backend Engine
and Library. A real mid-transfer Jellyfin scan saw no Movies while a `.partial`
contained verified bytes. Watched, 50% progress, and NextUp were set/read via
Jellyfin HTTP. Synthetic episodes test paths; a film renamed outside the recorded
inventory path proves provider-ID matching. Disconnect preserves every existing
title field, and offline reads omit all added fields. No web code is changed.
