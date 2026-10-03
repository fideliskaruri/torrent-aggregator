# Catalog HTTP compatibility

Task 2.4, OPS-674. The unchanged web app consumes these routes:

| Method | Route | Port |
|---|---|---|
| GET | `/api/browse` | Metadata.Browse |
| GET | `/api/recommendations` | Targets watch intent read + Metadata.Recommend |
| GET | `/api/search/titles`, `/api/suggest` | Metadata.Search |
| POST | `/api/artwork` | Metadata.Resolve; this is a read |
| GET | `/api/title/{workKey}` | Metadata + Targets catalog/inventory read |
| GET | `/api/title/{workKey}/extras`, `/links` | Metadata |
| GET | `/api/title/{workKey}/progress` | Nothing-active projection |
| GET, POST, PATCH, DELETE | `/api/watchlist` | Targets catalog intent + Metadata |

`CatalogProjection` is the wire mapper, including explicit nullable fields, supported
web provider names, labelled names, IDs, ready-made links and the shared artwork
key. Requester projection remains the Access module's responsibility. API routes
do not reference Engine, Library, Find, Parser or EF.

`CatalogState` is the deliberately small Targets foundation for this phase.
WatchItem stores saved owner intent; Follow stores monitored/from-episode intent,
and WorkPreference stores the quality floor. Updates and removals are atomic CAS
transactions with immutable Attempt receipts. Repeated/concurrent saves reuse
one deterministic user/work WatchItem ID. Ongoing Follow starts at Unix epoch
(all catalog episodes); `monitorMode: "new"` records the actual save instant.
It does not start a worker or acquire any media.

Ownership comes only from `CatalogState.OwnedAsync`: present/offline **video**
MediaFile rows, never watchlist membership or a catalog match. The scratch
database has no inventory, so no title or episode is claimed owned. Phase 5
replaces this typed Store read with the Library read without changing HTTP
projection. There are no synthetic paths/hashes/progress. Origin is never
serialized. Saved `library.inLibrary` retains the web's existing watchlist
meaning; availability and downloaded episode counts carry ownership separately.

Transfers are null and transfer maps empty until the Targets/Engine phases.
Download actions, release search/picking, library filesystem operations and
desktop/notification routes are intentionally not implemented here. In particular,
do not mistake a catalog's unknown availability for checked-and-unavailable.

Home genres are defined once in Metadata `CatalogViews`, used by provider browse,
HTTP validation and genre chips. Metadata builds personal recommendation rails,
persists their canonical identities and deduplicates them against catalog rails.
Title season lists omit season zero and seasons without episodes; an explicit
zero season can still read its metadata. Empty future seasons remain in Metadata
for the calendar. Explicit/remembered populated seasons win, otherwise the first
ordered populated season opens. Comparison browsers clear cookies before cold
visits: `tf_season` intentionally remembers a manually selected season.
Unknown air dates never become a fabricated aired count.

## Verification and remaining integration findings

Use `tools\contract-check\Check.ps1`, `Test-Catalog.ps1` and
`Compare-Titles.ps1` against the sandbox. Evidence lives in ignored
`tools\.catalog-proof\`, not production code. No unit tests.

The replay has 22 passing catalog captures. One populated legacy links fixture
is deferred to converter verification (OPS-681, phase 7.1): phase 1.6 preserves
workKey, but this scratch catalog has not migrated that saved work. The checker
verifies the corresponding title is unknown before accepting this deferral.
Unknown slug links still return 404; saved-link shapes are not declared proven
by an unknown response.

Anime presentation uses AniList rating, synopsis, genres, covers and premiere.
Episode schedules do not define the show's release date. Metadata projects the
premiere from its provider cache into WorkSnapshot, without a second persisted
date or a Store schema change. Title recommendations use the same source priority
and cap at 12, filtering artwork before limits; home/browse replenish their pools.
Complete refreshed provider listings replace unreferenced obsolete episodes,
rather than unioning incompatible numbering. Referenced IDs and partial listings
are preserved.

The coordinator regression review fixed provider/numbering differences (OPS-677).
Independent unified-search ranking differences (OPS-678) and a static-hosting
service-worker MIME issue (OPS-676) remain. Those are recorded separately rather than
concealed by an API-specific ranking or numbering algorithm.
