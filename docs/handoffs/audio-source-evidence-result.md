# Anime release audio evidence repair

21 November 2026. Isolated worktree `audit-runtime/audio-source-evidence-fix`,
branch `fix/anime-source-audio-evidence`, based on `46b60c8`.

## Cause and evidence

v0.4.1 allowed an unmarked release, or one named MULTi/dual, to become an
automatic fallback once the search finished. The Nyaa RSS adapter supplied
the listing name and identity. The description on its view page was never
read for this decision. The baseline audit reproduced an automatic choice
of an unknown-audio release on a completed search.

Public, read-only listing checks kept the two reported packs distinct.

| Listing | Infohash | Uploader audio claim |
|---|---|---|
| [T3KASHi](https://nyaa.si/view/1733389) | `07d77fa13ec33dd235557934e60ee523356a354b` | The numbered audio fields specify French and Japanese. |
| [YURASUKA](https://nyaa.si/view/1495607) | `39de3b8c3c615d7548a73d68c4c956eae30b2428` | Two MediaInfo audio sections specify English and Japanese. The text sections describe subtitles. |

The public Nyaa RSS query `Classroom of the Elite S01` returned both listings
in 8 results. The broad title query returned 75 results and omitted YURASUKA
in that observation. APiBay returned `Classroom of the Elite English Dub 1080p
Season 1` under the written-out season query with one listed seeder. Its
`English Dub` qualifier was previously included in the parsed work title,
which failed the exact title match. Counts are provider observations.

## Changes

- `Sources/NyaaAudioDetails.cs`, `SourcesService.cs`, `SourceTransport.cs` read
  the public uploader description at the configured Nyaa endpoint. The request
  uses a numeric listing ID and the HTML infohash must match the candidate.
  Audio rows and MediaInfo audio sections supply evidence. Categories, subtitle
  rows and comments supply no audio evidence. The [upstream Nyaa template](https://github.com/nyaadevs/nyaa/blob/master/nyaa/templates/view.html)
  defines the separate hash, description and comment fields.
- `Domain/AnimeAudioPolicy.cs`, `Interfaces.cs`, `Records.cs` and
  `Find/CandidatePool.cs` retain listing claims across same-hash results. A
  matching source detail takes precedence over names. Bare dual/MULTi, an
  unclassified track and conflicting name claims remain unresolved. Filename
  evidence comes from a bounded audio label or a standalone language tag.
  Caption and subtitle markers, negated audio labels and commentary do not
  contribute dialogue claims. The parser reads individual track labels and
  keeps blank or unrecognized entries unresolved, including entries linked
  by punctuation or by “and”. Descriptions with explicit episode headings or
  multiple MediaInfo file sections remain unresolved at the release level.
- `Find/FindService.cs`, `SourceSearches.cs`, `SourcesComposition.cs` and
  `SearchQueries.cs` use the existing bounded search and source transport.
  Audio detail work runs in groups of three, with up to 12 fresh requests
  per owner pass and six per background pass. Each call uses the existing six
  second provider deadline. Successful reads share the existing cache policy
  in a separate typed cache. Failed details can be retried. APiBay adds a
  written-out season query and `Parser/ReleaseParser.cs` strips the observed
  dub suffix in the season-pack format before exact work identity comparison.
- `Targets/DiscoveryPlan.cs` and `Plan/ReleaseGates.cs`,
  `ReleasePlanner.cs`, `ReleaseScore.cs` prefer English audio for each item.
  A Japanese-only listing can cover a remaining item only after the applicable
  search passes finish successfully and no eligible English or unresolved
  candidate could still cover that item. Zero listed seeds and complete metadata
  showing an ineligible file list can remove a candidate from that decision.
  Unknown seed counts, unresolved metadata, result truncation, failed searches
  and skipped or failed detail requests keep fallback guarded. The normal
  seed, quality, scope, file mapping and safety gates still apply. Explicit
  language modes, Any, and manual source selections use their existing path.
  The supplemental episode search can supply a candidate's first Nyaa
  observation. Discovery checks the merged observations before making an
  assignment and keeps the latest claim alongside any already-probed files.

## Verification

The focused audit uses the real Sources, Find, DiscoveryPlan and Plan code,
a loopback provider serving RSS/HTML or APiBay JSON, a disposable SQLite store,
and an in-process fixture engine for file lists. It exercises both reported
Nyaa hashes, the APiBay identity and query case, Japanese fallback, unresolved
audio and seed counts, missing/mismatched provider details, subtitle-only
claims, exhaustion flags, request limits and manual selection.
The independent review reproduced false English claims from caption,
commentary and negated language labels. It also identified unresolved extra
tracks, episode-scoped descriptions and a late Nyaa observation that could
invalidate an earlier candidate. The revised fixture suite covers those paths.

| Command | Result |
|---|---|
| Baseline `dotnet run --no-build --project tools/AnimeAudioAudit/AnimeAudioAudit.csproj` with the new unknown-audio assertion | Exit 1. The baseline selected an unknown-audio release in the fallback phase. |
| First repair revision with the new review assertions | Exit 1. Eight filename assertions reproduced false English claims. The source fixture also reproduced a Japanese assignment with an unresolved additional language. Raw output is under `artifacts/anime-audio-tests/review-red.log`. |
| Prior repair revision with the second review assertions | Exit 1. The source fixture reproduced a Japanese assignment with a second, undetermined track joined by “and”. Raw output is under `artifacts/anime-audio-tests/review-round-two-red.log`. |
| `dotnet build backend/TorrentFlow.Backend.slnx` | Exit 0, zero warnings and errors. |
| `dotnet build tools/AnimeAudioAudit/AnimeAudioAudit.csproj` | Exit 0, zero warnings and errors. |
| `dotnet run --no-build --project tools/AnimeAudioAudit/AnimeAudioAudit.csproj` | Exit 0, 96 checks passed after both rounds of review corrections. The sandboxed run could not reach its loopback fixture. The final run used loopback access after rebuilding the focused project. Raw output is under `artifacts/anime-audio-tests/latest.log`. |
| `dotnet run --no-build --project tools/bench/bench.csproj -- parse --iterations 1 --json <path>` | Exit 1 on both `46b60c8` and the patch. All ten field accuracy entries and all 326 mismatch records matched exactly across the 3,535-row corpus. There were 17 pre-existing gate mismatches. The corpus does not assert parsed title text. The exact APiBay title match is covered by the focused audit. |
| `git diff --check` | Exit 0. |

Builds ran with `--nologo -m:1 --disable-build-servers -p:NuGetAudit=false
-p:RestoreIgnoreFailedSources=true -p:UseSharedCompilation=false`. The first
default build stopped during restore without a diagnostic. The serial
offline-compatible invocation used packages already present locally.

## Limits

Detailed uploader claims currently come from Nyaa HTML. For other providers,
explicit release-name evidence is available and generic dual/MULTi remains
unresolved without a matching Nyaa observation. Popular or incomplete result
windows, stale provider claims and unsupported description formats can leave
an item waiting. The scope covers the configured search windows, not every
listing in an index. Uploader metadata and the fixture file map do not establish
actual media tracks or current swarm health. No payload, running installed
instance, original database, or media was accessed. The patch is uncommitted
and pending independent review.
