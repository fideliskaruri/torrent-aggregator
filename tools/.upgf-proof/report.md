# OPS-868 / OPS-869 proof

## Change
- Targets `ReadUpgradesAsync` composes the item's live Replace target (mode upgrade, not Done/Removed) at read time as `ItemUpgrade.Queued {resolution, state}`; while it exists the offer and bestAvailable are null. `UpgradeAsync` still answers "Already queued" for it.
- Title read: additive `upgradeQueued` on the film and each episode, `seasons[].upgradingEpisodes`.
- Web `owned-quality.tsx`: "Upgrade to 1080p queued" (title), "1080p queued" pill (row), no Upgrade button. Season line adds "N upgrade(s) queued". Progress is not shown: the title read carries no transfer data (`transfer: null`), so it is not cheap.
- OPS-869: `LibraryControls` hides the "In Library" pill when the owned line or season ownership already says it; Remove stays.

## Fixture
Real import path (move mode) of hardlinks of the Sintel seed: Sintel film and Rick and Morty S01E01-11 (`root.json`, `scan.json`, `import.json`). Resolution is probed from the file: 480.

## Proven
- (c) series: `series-check-again.json` (real check, 7.5s): 11 episodes offered 1080 (25 seeders). `series-upgrade-offered.json`: upgradeableEpisodes 11.
- OPS-868: `upgrade-e01.json` queued 1; `series-after-upgrade.json`: E01 `upgrade:null, upgradeQueued:{1080,"wanted"}`, season `upgradeableEpisodes:10, upgradingEpisodes:1`; repeat `upgrade-e01-repeat.json`: "Already queued".
- UI: `series-queued-{390,768,1280}.png`, `series-queued.dom.json`: season line "11 of 11 in your library, 10 can be upgraded to 1080p, 1 upgrade queued", E01 "1080p queued" (44px), no Upgrade on E01, all upgrade buttons 44px at 390, zero In Library pills, Remove 44px.

## Unproven
- (a) "N is the best available" and (b) "In your library, 1080p": not proven. A real 1080p transcode of the seed was refused on import ("A file already uses the destination name") because the 480 copy was already filed under the same name (`import-1080.json`). Time ran out.
- Film hero "Upgrade to 1080p queued" line: built, not screenshotted.
- Bug seen: E01 row at 390 shows a dark empty box where the 480p badge should be next to "1080p queued" (filed). Rows also say 480p twice (subtitle and badge), pre-existing.
