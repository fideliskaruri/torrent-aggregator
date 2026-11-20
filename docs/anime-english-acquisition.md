# Anime English-first acquisition repair

## Scope and baseline

Owner requested a focused audio acquisition fix from main and, after verification,
a Windows release available through in-app updates. Base: `cb436138` (v0.4.0).
Installed version reported `0.4.1-audit.8`; its read-only client API reported English
audio and 1080p. No installed settings, database, media, downloads or runtime were changed.
The unrelated dirty UI checkout is not the release source.

## Proven failures

Before the fix, automated tests demonstrated that higher-seeded unlabelled audio
won both shortlisting and final selection over an English dub. A Japanese-audio
release labelled English Subs also won. The quality-floor control passed.

`ReleaseGates.LanguageAllowed` accepted unknown language and generic multi/dual
labels. `ReleaseScore.Select` ranked resolution and seed count without an audio
preference. `FindService` searched title names rather than audio-qualified queries,
truncated per-tier query plans, omitted enabled opt-in sources, and could stop on
coverage/provisional seed evidence before English alternatives were exhausted.

The late state is actual track inspection in `JellyfinLibrarySync`: it waits for
the completed file to be indexed, reads MediaSources/MediaStreams, then stores
inspection state and audio languages on MediaFile. Release-name evidence cannot
provide that same confirmation before downloading media bytes.

## Acquisition contract

- For anime with English/auto/default audio, prefer explicitly advertised English
  audio. English subtitles never establish English audio.
- Search dub, dual-audio and ordinary coordinate queries across supported enabled
  core, fallback and opt-in sources and the bounded existing catalog aliases.
  Retain source/category filters, cache coalescing, cancellation and bounded fanout.
  Request limits bound concurrent windows rather than silently omitting sources.
- Consider generic dual/multi, unknown, then Japanese audio only after complete
  successful searches and resolution of eligible English metadata/swarm evidence.
- Failed, partial, timed-out, busy, cooling-down, incomplete, early-stopped or
  truncated searches do not establish absence of English. Neither does unknown
  English seed health or an unresolved English metadata probe. Retry normally.
- Zero-seed English can yield to an eligible seeded fallback. Preserve the owner's
  configured minimum seed count, hard resolution floor, identity, mapping, safety,
  duplicate and ownership checks. Other foreign audio is not Japanese fallback.
- Explicit other-language/any preferences and manual-source behavior stay intact.
  Film/non-anime policy is unchanged. No staged download or new payload scanning.
- Advertised audio remains a hint; post-download track inspection stays intact.
  Assignment explanations distinguish advertised English from unverified fallback.

## Verification

Run `dotnet build tools/AnimeAudioAudit/AnimeAudioAudit.csproj -m:1`, then
`dotnet tools/AnimeAudioAudit/bin/Debug/net10.0/AnimeAudioAudit.dll`.
The executable fails on any failed assertion. It covers pure ranking/gates and the
actual DiscoveryPlan, plus real FindService/SQLite/metadata/planner integration
with deterministic provider/engine doubles. All 38 assertions pass. The integration
searches 54 requests across both title aliases and all three enabled tiers with
peak concurrency 2, finding English under the original alias in the last tier.
Coverage/provisional-stop feedback cannot short-circuit this search.
It does not download real anime or prove accuracy of provider claims.

Release verification additionally requires a full API build, unchanged main web
typecheck/build, isolated published-executable startup/version/HTTP checks, installer
compilation and updater asset/version checks. Do not install or restart the owner's app.

### Release result — 21 November 2026

Published [v0.4.1](https://github.com/fideliskaruri/torrent-aggregator/releases/tag/v0.4.1)
from product commit `f174b64aa74e547d10148fe30fa6c3921922332a`, based on main/v0.4.0.
The separate UI checkout was neither merged nor modified.

- Fresh regression executable: **38 PASS, zero failures**.
- Full API build and main web TypeScript/Vite production build: passed.
- Self-contained Windows binary and Inno Setup installer: compiled.
- Packaged binary startup with a new disposable database on port 3996: health,
  desktop version 0.4.1, web route, English client settings and downloads API passed.
- After publishing, the real packaged updater's check endpoint recognized latest
  0.4.1 with `hasInstaller=true` and no error. Installation was never invoked.
- Uploaded installer: 38,880,234 bytes; GitHub asset digest matches local SHA-256:
  `673c86ef24bfe5501d3c702a03acbe33fd3e197136e0f4ea75fac9443904dd04`.
- Disposable test processes were stopped. Installed app was not installed over,
  restarted, reconfigured or commanded to acquire media.

The first sandbox startup check could not reach loopback despite a 2.8-second
ready log. The next smoke attempt used a nonexistent test API route; correcting
the script to `/api/client/torrents` produced the successful checks above.
These were test-environment/script issues, not changes to the released product.

Remaining verification: owner installs through the normal updater and tests real
anime acquisition/provider labels. No claim of live anime content verification.
