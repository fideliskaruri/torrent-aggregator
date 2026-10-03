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
Standard season lists omit season zero as the legacy API does; an explicit zero
season can still read its metadata. Provisional future seasons are not silently
discarded, and unknown air dates never become a fabricated aired count.

## Verification and remaining integration findings

Use `tools\contract-check\Check.ps1`, `Test-Catalog.ps1` and
`Compare-Titles.ps1` against the sandbox. Evidence lives in ignored
`tools\.catalog-proof\`, not production code. No unit tests.

The final replay has 22 passing catalog captures and one documented failure:
`GET /api/title/family-guy/links` returns 404 rather than the populated legacy
capture's 200 (OPS-681). That yearless legacy slug is not a persisted canonical
identity, and title-only resolution is ambiguous. The route must not choose an
unrelated film just to produce a passing shape. Canonical web links retain their
provider hints; legacy aliases need a migration/identity fix.

This is not a claim that the whole rebuild phase gate passes. Integration exposed Metadata provider/numbering differences
(OPS-677), unified-search ranking differences (OPS-678), and a static-hosting
service-worker MIME issue (OPS-676). Those are recorded separately rather than
concealed by an API-specific ranking or numbering algorithm.
