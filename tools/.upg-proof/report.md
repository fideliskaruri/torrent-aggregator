# OPS-857: owned-item quality sweep

## Design and changes

Targets owns the sweep and its durable UpgradeEvidence result. Library remains
the single ownership truth; no WatchItem, availability counter, seeder counter,
or copied download state is created. Catalog composes the result at read time.

The existing bounded worker schedules one film/confirmed-season quality scope
at a time on Find/Check's background lane. Explicit Check again uses the owner
lane. Items already at or above their work/global preferred quality are skipped.
Unknown owned resolution is not asserted to be below the preference. The shared
Find -> Check -> Plan path treats known below-preference items as Replace/Upgrade candidates,
with current ownership, quality, language, size, identity, file safety, mapping
and block gates. Only a fresh Good verdict can produce an upgrade offer.

Positive evidence expires with its Check verdict, normally six hours. Completed
negative searches with a successful source expire after thirty minutes. Failed
searches do not assert best available. Quality-policy changes invalidate either
result; changed owned resolution invalidates a negative result. Reads select
only the stored candidate, load persisted Check evidence and rerun pure Plan;
they never search indexers or probe peers.

Upgrade reuses the database's one Target per item. An existing Acquire/history
row becomes Replace; its old Current association is retired before a new one is
admitted. The normal worker/admission path no longer skips Replace merely because
the item is owned. A repeated Upgrade returns queued:0 and Already queued.

The referenced old video and its recorded sidecars survive until the new target
is Done and its exact filed binding identifies the better file. Normal Library
placement, filing, digest checking and removal are reused. Store's opaque removal
proposal commits clearing the old MediaFile foreign key and deleting inventory
and bindings atomically. This also avoids losing the new target when its identity
is shared with the old download. Failed cleanup retains the old file/reference
and retries without starving unrelated work; offline old storage is retained.

No migrations, dependencies, Automation/hunter, Engine, DevFiling, or web source
were changed. Library changes are the shared removal commit callback and
documentation; physical deletion and inventory proposals remain in their owners.
The ordinary imported-file removal HTTP regression passed with this proposal
builder. Acquisition after removing an upgrade restores Acquire on the same row.

## Web-lane contract

GET `/api/title/{workKey}` remains additive. For a film, fields are at the top
level; for episodes, the same fields are on each `episodes[]` row:

```ts
upgrade?: { resolution: number; seeders: number } | null;
bestAvailable?: { resolution: number | null; checkedAt: string } | null;
```

Only one object is non-null. Both are null when no fresh result applies, the item
is not owned, or owned quality meets the preference. `owned.resolution` remains
the best owned file's quality, never origin-specific. Each `seasons[]` row adds:

```ts
upgradeableEpisodes?: number;
```

That count covers every catalog episode in the season, not only the rendered
200. Existing `TitleOwned`, availability, transfer and Library fields retain
their shapes. Add optional properties to `TitleDetailPayload`, `TitleEpisode` and
`TitleSeason` in the later web lane; no web types or UI were edited here.
`backend/contract/owned-quality.schema.json` describes the extension without
changing the captured legacy baseline.

Owner-only POST `/api/title/{workKey}/check-again` and `/upgrade` take `{}` for
the title, `{season:1}` for a season, or `{season:1,episode:2}` for an episode.
Film episode/season arguments and invalid coordinates are refused with HTTP 400.
Check again returns `{items:[{episodeId,upgrade,bestAvailable}]}`; reload the title
afterwards. Upgrade returns the existing TargetActionReply, including actual
queued counts and deterministic item IDs. A negative reply says to Check again;
it never queues an ungated substitute. These actions do not implement the separate
“Tell me when” hunter notification watch.

## Real HTTP proof

Only HTTP 3965 was used for the isolated application. The initially requested
`git worktree add ... rebuild` correctly refused an already-checked-out branch;
the build worktree was therefore detached at `169c36f`, then received these exact
source changes. Output: `D:\code\memtest\bin-upg`; fresh data:
`D:\code\memtest\data-upg`. Development environment, scheduler disabled throughout.
The TMDB key was supplied only in the child environment by `start.ps1`.

No direct database mutations, mocked sources/verdicts, synthetic ownership,
production-only proof hooks, or unit tests were used. Database captures use
SQLite read-only mode. Full downloads were limited to licensed Sintel; the real
better release was only probed, never fully downloaded.

1. Copied the unmodified free Blender Sintel from `tools\.filing-proof\seed`
   into the isolated import folder and confirmed it through the real Import API.
   Its native quality is **480p**, size **129,241,752 bytes**.
   `scan*.json`, `import.json`, `title-owned.json`.
2. Check again searched real public sources and found
   `classicalhd-sintel.2010.en-1080p.mkv`, hash
   `43f4001de4ab25d521c63684e2b69804193ed9d9`.
   Check measured **Good**, **737,280 payload bytes**, two byte-sending peers,
   three connected peers and two connected seeders in **7.628 seconds**.
   The current Find observation reports **4 seeders**. `healthy-verdict.json`.
3. Title returned `upgrade:{resolution:1080,seeders:4}`. Upgrade created
   Replace/Upgrade intent pinned to that hash and the old MediaFile. Repeat
   acceptance was idempotent. Positive evidence survived restart.
   `check-again.json`, `upgrade.json`, `targets-upgraded.json`, `title-restart.json`.
4. Preferred quality 480 suppressed both objects. Setting a hard 4320 floor
   invalidated the old offer, and a real owner check produced
   `bestAvailable:{resolution:480,checkedAt:...}`. Upgrade queued nothing.
   That exact checkedAt survived restart. `title-at-preferred.json`,
   `title-policy-invalidated.json`, `check-best-available.json`,
   `no-upgrade-at-high-floor.json`, `title-best-restart.json`.
5. Ordinary confirmed Library removal deleted the imported copy. Then the normal
   `/api/dev/filing` path downloaded and filed the same real 480p Sintel with the
   existing local `tools\.jelly-proof\Seeder` (all **494/494 pieces** hashed).
   `normal-import-removal.json`, `filing-admission.json`, `filed.json`.
6. The filed film had an existing Acquire row (the standalone filing harness
   leaves intent Wanted). Check again and Upgrade changed **that same row** to
   Replace, retired its old Current association, and kept the actual final file.
   There was exactly **one Target**, not a second conflicting item identity.
   `acquire-before-upgrade.json` (state is Wanted), `filed-upgrade.json`,
   `filed-replace-target.json`, `final-repeat.json`.
7. Paused the upgrade and restarted. The 480p ownership, healthy 1080p offer,
   Replace reference and paused intent persisted. The old final's SHA-256 remained
   `1dc6f2ca9762dfcc7d1b1843129a3e4f351d1fe935dea2241c7b359c11ebc1d8`.
   Existing title fields were unchanged apart from generatedAt and the new quality
   objects. Invalid film scope returned 400. SQLite foreign_key_check was empty.
   `final-title-restart.json`, `final-target-restart.json`, `assertions.json`,
   `db-verified-*.json`, `filed-old-retained.json`, `invalid-film-scope.json`.

Final exact backend build: **0 warnings, 0 errors**, `build-verified.log`.
There were 11 asserted real-HTTP/disk/persistence checks, not mock/unit tests.

## Unproven and handoff

Automatic background scheduling was not exercised because the required proof
server kept the scheduler disabled. Episode/season offer counts, requester
authorization, unknown-quality ownership, expired-wall-clock evidence, concurrent deletion/import,
same-quality Replace, and an actual upgrade's first bytes/final filing/retirement
and crash replay were not exercised. The worker paths are implemented and built,
but no full upgrade-completion claim is made.

The UI and optional hunter notification watch belong to later lanes. OPS-857 is
handed to verification with this explicit boundary, not represented as complete
end-to-end UI or background-worker QA.

All isolated processes and disposable worktree/data/seed/library/output directories
are removed in `cleanup.json`. No access was made to port 3930, PID 3188, the
stable directory, or the other agents' reserved HTTP ports. Existing tools/.gitignore
and unrelated worktree changes were left untouched. The commit carries Refs: OPS-857,
no Co-Authored-By, and only explicitly staged paths.
