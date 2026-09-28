# Live anime episode acquisition — September 28, 2026

## Outcome

| Measure | Before | After |
|---|---:|---:|
| Correct release identity, original 22 title cases | 18 / 22 | 22 / 22 |
| **Correct episode confirmed in actual torrent metadata** | **17 pass / 5 fail** | **21 pass / 1 fail** |
| Watchlist grabs, with actual file-list confirmation | **2 pass / 3 fail** | **5 pass / 0 fail** |
| One Piece E1100/E1180 exposed by title episode endpoints | 0 / 2 | 2 / 2 |
| Additional batch-only title | Not in baseline | 1 expected refusal; no single-episode download |

The remaining acquisition failure is **Cowboy Bebop E5**: the 2021 remake is now rejected, but the selected correctly named 1080i anime release had zero peers and did not provide metadata. **Haibane Renmei E5** has batch candidates but no eligible 1080p single in the searches performed; existing policy forbids silently turning an episode click into a full-pack download. Neither is counted as a download pass.

This is a real-indexer, real-engine test, **not browser certification**. Playwright MCP navigation and snapshot failed with `Transport closed`, including a later retry. The exact HTTP title-detail/episode-download and watchlist routes used by the UI were exercised instead.

## Method and isolation

- Baseline was `1760d68`; repairs were independently committed and pushed to `main`.
- Dedicated worktree `anime-live`, server **3928**, isolated `memtest\anime-live` data/download directory, approximately **20 GB** storage cap. No requests were made to owner ports 3000/3930 or owner data directories.
- Real **Nyaa, apibay and torrents-csv** adapters remained enabled. All three returned candidates. Source errors, app throttling and unsuccessful intermediate runs were retained, not hidden.
- Used provider discovery, title detail, and `POST /api/title/{workKey}` with `scope=episode`, AniList provider ID, requested coordinates and 1080 resolution floor. Watchlist cases used the title response's real `addPayload` and `POST /api/automation/run`.
- AniList sequel entries use **local S01**; matching translates those coordinates to franchise season/absolute numbering without changing target identity.
- A pass requires the **actual `.torrent` metadata file list**, not just HTTP 200 or the advertised release name. Quality here is the release/file's advertised 1080p, not a decoded-video probe.
- Transfers were rate-limited, paused as soon as metadata was available, and removed with `deleteFiles=true`. No full-episode downloads were needed. The stalled case was removed after its metadata wait.
- “Before” is the original 22-case run. “After” combines the complete 22-case rerun with the final three Frieren retries after the identity-cache repair. Five final automation cases ran back-to-back, without added sleeps, using **12 searches** within the unchanged 15/minute background allowance.
- Mushoku S3 E1 and E14 cover a recently airing summer-2026 title's first/latest episodes: the live AniList schedule marked 14 episodes complete, with E14 on **September 27, 2026**.

## Title results

Full names, ordered queries, candidates, source counts/errors, filenames and cleanup results are preserved in [the JSON evidence ledger](anime-live-evidence.json). Release names below are shortened only where needed for readability.

| Title | Episode | Before-fix result | After-fix result | Picked release | Notes |
|---|---|---|---|---|---|
| Frieren | S1 E5 | PASS: correct 1080p file | PASS | `Frieren - Beyond Journey’s End S01E05 MULTi 1080p ... Tsundere-Raws (CUSTOM)` | AniList 154587. 1 → 1 queries. Intermediate provider-ID failure fixed. |
| Frieren | S1 E28 | PASS | PASS | `Frieren - Beyond Journey's End S01E28 VOSTFR 1080p ... Tsundere-Raws (CR).mkv` | 1 → 1 queries. |
| Frieren S2 | Local S1 E3 | PASS | PASS | `[Erai-raws] Sousou no Frieren 2nd Season - 03 [1080p CR WEB-DL AVC AAC][MultiSub][86271E51]` | AniList 182255. 6 → 5 queries. |
| Mushoku Tensei S3 sequel entry | Local S1 E14 | PASS | PASS | `Mushoku Tensei Jobless Reincarnation S03E14 SUBFRENCH 1080p CR WEB-DL ... Tsundere-Raws` | AniList 178789. Owner's episode; latest current-season episode. 2 → 2 queries. |
| Mushoku Tensei root entry | S3 E14 | PASS | PASS | `[AnoZu] Mushoku Tensei: Jobless Reincarnation S03E14 1080p CR WEB-DL AAC 2.0 H.264` | AniList 108465. Explicit franchise coordinates also verified. 1 → 1 queries. |
| Mushoku Tensei S2 | Local S1 E1 | PASS | PASS | `[Erai-raws] Mushoku Tensei II - Isekai Ittara Honki Dasu - 01 [1080p][Multiple Subtitle]` | AniList 146065. 6 → 5 queries. |
| One Piece | E1100 | Correct file, but episode hidden | PASS; episode exposed | `One Piece S01E1100 VOSTFR 1080p WEB x264 AAC -Tsundere-Raws (CR)` | AniList 21. Episode projection now reaches 1,180 rather than 200. 1 → 1 queries. |
| One Piece | E1180 | Correct file, but episode hidden | PASS; episode exposed | `One Piece S01E1180 ... REPACK 1080p CR WEB-DL AAC2.0 H.264-VARYG (Multi-Subs)` | Absolute numbering; 1 → 1 queries. |
| Solo Leveling S2 | Local S1 E5 | PASS | PASS | `[Erai-raws] Ore dake Level Up na Ken Season 2: Arise from the Shadow - 05 [1080p CR WEB-DL AVC AAC][MultiSub][927CC364]` | AniList 176496. 3 → 5 queries. |
| Jujutsu Kaisen S2 | Local S1 E10 | PASS | PASS | `[Erai-raws] Jujutsu Kaisen 2nd Season - 10 [1080p][Multiple Subtitle][69006CC1].mkv` | AniList 145064. 2 → 4 queries. |
| Demon Slayer S4 / Hashira Training | Local S1 E3 | PASS | PASS | `[Anime Time] Kimetsu no Yaiba - Hashira Geiko-hen - 03 [1080p][HEVC 10bit x265][AAC][Multi Sub]` | AniList 166240. 9 → 2 queries. |
| Attack on Titan Final Season Part 2 | Local S1 E3 | **FAIL: earlier Final Season part E3** | **PASS: correct part** | `[Erai-raws] Shingeki no Kyojin - The Final Season Part 2 - 03 [1080p][Multiple Subtitle][525B4EBE].mkv` | AniList 131681. 15 → 4 queries. |
| Dan Da Dan | E7 | PASS | PASS | `DAN DA DAN S01E07 MULTi 1080p WEB x264 AAC -Tsundere-Raws (CUSTOM).mkv` | AniList 171018. 1 → 1 queries. |
| Kaiju No. 8 | E4 | PASS | PASS | `[Yameii] Kaiju No. 8 - S01E04 [English Dub] [CR WEB-DL 1080p] [5CD5E95A]` | AniList 153288. 1 → 1 queries. |
| Spy x Family S2 | Local S1 E6 | PASS | PASS | `[Erai-raws] Spy x Family Season 2 - 06 [1080p][Multiple Subtitle]` | AniList 158927. 2 → 2 queries. |
| Dr. Stone Science Future / S4 | Local S1 E3 | PASS | PASS | `[Anime Time] Dr STONE SCIENCE FUTURE - 03 [1080p CR WEB-DL AVC AAC] (Dual-Audio, Multi-Subs)` | AniList 172019. 2 → 2 queries. |
| Oshi no Ko S2 | Local S1 E2 | PASS | PASS | `[Erai-raws] Oshi no Ko 2nd Season - 02 [1080p] [ENG]` | AniList 166531. 2 → 2 queries. |
| Bleach TYBW: The Separation / Part 2 | Local S1 E3 | **FAIL: earlier TYBW part E3** | **PASS: correct part** | `[Erai-raws] Bleach - Sennen Kessen Hen - Ketsubetsu Tan - 03 [1080p][Multiple Subtitle]` | AniList 159322. 11 → 6 queries. |
| Mushoku Tensei S3 | Local S1 E1 | PASS | PASS | `[Erai-raws] Mushoku Tensei III: Isekai Ittara Honki Dasu - 01 [1080p CR WEB-DL AVC AAC][MultiSub][07335B96]` | First episode of the same recently airing season. 2 → 5 queries. |
| Cowboy Bebop anime | E5 | **FAIL: 2021 live-action remake** | **FAIL: no metadata; zero peers** | `Cowboy Bebop S01E05 Ballad of Fallen Angels 1080i DTS-HD MA 5 1 AVC REMUX-F` | AniList 1 / 1998. Correct advertised episode, but 1080i, not preferred 1080p; file unconfirmed. 1 → 1 queries. |
| Dr. Stone Science Future Cour 3 | Local S1 E1 | **FAIL: 2019 S01E01** | **PASS: correct cour** | `[Erai-raws] Dr. Stone: Science Future Part 3 - 01 [1080p CR WEBRip HEVC AAC][MultiSub][C8130DE1]` | AniList 199221. 2 → 5 queries. |
| Bleach TYBW: The Separation / Part 2 | Local S1 E1 | FAIL: correctly named pick, no metadata | PASS | `[Erai-raws] Bleach - Sennen Kessen Hen - Ketsubetsu Tan - 01 [1080p][Multiple Subtitle]` | New normalized query found a working release instead of the stalled torrents-csv pick. 19 → 6 queries. |
| Haibane Renmei | E5 | Not in initial matrix | **EXPECTED REFUSAL: no eligible single** | None | AniList 387 / 2002. 24 ladder queries; batch-only explanation below. |

## Watchlist / automation results

| Title / episode | Before | After | Picked release | Queries after |
|---|---|---|---|---:|
| Frieren S2 E3 | FAIL: no grab | PASS: actual 1080p file | `Frieren.Beyond.Journeys.End.S02E03.MULTi.1080p.WEBRiP.x265-T3KASHi` | 1 |
| Mushoku S3 E14 | FAIL: no grab | PASS: actual 1080p file | `Mushoku Tensei Jobless Reincarnation S03E14 1080p HEVC x265-MeGusta` | 1 |
| Dan Da Dan E7 | PASS | PASS | `DAN DA DAN S01E07 VOSTFR 1080p WEB x264 AAC -Tsundere-Raws (ADN).mkv` | 1 |
| Bleach TYBW Part 2 E3 | FAIL: no grab | PASS: actual 1080p file | `[Erai-raws] Bleach - Sennen Kessen Hen - Ketsubetsu Tan - 03 [1080p][HEVC][Multiple Subtitle][C025A952].mkv` | 7 |
| One Piece E1100 | PASS | PASS | `One Piece S01E1100 VOSTFR 1080p WEB x264 AAC -Tsundere-Raws (CR).mkv` | 2 |

Newly added watchlist entries lacked Work/provider aliases; the old background path therefore used local sequel coordinates without mapping. Regression tests cover both newly added watchlist items and previously verified Work identities when catalog lookup fails. Cursor advancement, quality gates and zero-seeder grace remain covered.

## Query shapes and candidate evidence

The JSON ledger records each case's exact ordered query strings, category/filter rung, all captured candidate names/rejection reasons, and per-source counts/errors **before and after**. Its `titleBefore`, `titleAfter`, `automationBefore`, `automationAfter`, `batchOnly` and intermediate-failure sections distinguish initial results from retries.

Representative real query sequences and their effects:

- Frieren sequel: local `... Season 2 S01E03` misses; `Sousou no Frieren 2nd Season - 03` finds the entry-local release. Automation now starts with proven franchise `Sousou no Frieren S02E03` rather than the less productive accented/localized synonym.
- Mushoku S3: sequel-local `... Season 3 S01E14`, qualified `... Season 3 - 14`, and explicit franchise `Mushoku Tensei: Jobless Reincarnation S03E14` were all exercised.
- One Piece: `ONE PIECE S01E1100` and `ONE PIECE S01E1180`; filenames confirm four-digit episode numbers.
- AoT: `Attack on Titan Final Season Part 2 S01E03` → qualified local absolute forms → `Shingeki no Kyojin: The Final Season Part 2 - 03`. Earlier-part E3 is no longer eligible.
- Bleach: `BLEACH: Sennen Kessen-hen - Ketsubetsu-tan - 03` produced only three unsuitable candidates in the observed rung; `BLEACH Sennen Kessen hen Ketsubetsu tan - 03` found the seeded Erai singles directly. This avoids relying on broad `Bleach - 03` after many localized/franchise queries.
- Dr. Stone Cour 3: `Dr. STONE SCIENCE FUTURE Cour 3 S01E01` → local absolute spellings → `Dr. STONE: SCIENCE FUTURE Part 3 - 01`; the 2019 root S01E01 is excluded.
- Haibane: exact, local absolute, `1x05`, provider-alias, anime/all-category and zero-seeder-relaxed shapes all failed to produce an eligible 1080p E5 single.

Baseline automation did not yet log candidate names per rung. Its exact job queries/errors and confirmed file lists are retained; detailed candidate diagnostics were added before the final automation runs. No missing baseline candidate list is invented.

## Remaining limits and exact failures

### Cowboy Bebop E5

The API initially returned success because the engine accepted the magnet. An extended retry allowed up to **120 seconds** for metadata; the engine stopped at its own approximately 90-second deadline with zero progress and this exact error:

> Couldn't get this torrent's file list from peers. Check the magnet or try another release.

The selected apibay release was paused and deleted with data. The remake-selection defect is fixed, but peer availability and preferred progressive quality are **not verified**.

### Haibane Renmei E5 — batches only in the observed 1080p inventory

Exact API response:

> Couldn't find a release for S01E05 at 1080p or higher. 98 results checked: 94 were a different title; 4 had no recognizable episode number.

A separate broad live search returned batch-shaped 1080p releases including:

- `Haibane Renmei S01 1080p BluRay FLAC2.0 x264 [CTR] (English Dubbed Dual Audio)`
- `[KnF] Haibane Renmei [BD 1080p] [Spanish sub]`
- `[2ndfire] Haibane Renmei [BD][1080p][Dual-Audio][AV1][10bit]`

None advertises an individually addressable E5 single. Existing episode-grab policy disallows silently acquiring packs, so **no batch was queued**. A deliberate opt-in batch/file-selection flow would be a separate feature, not a safe matcher relaxation. The inventory observation is not a claim that no single exists anywhere.

### Transient provider and rate failures

- Intermediate Frieren grabs returned `Provider identity does not match this title.` while discovery still returned the correct IDs. Independent by-ID probes returned HTTP 403. Reusing a bounded, five-minute cache of **successfully verified** provider objects restored the real discovery → detail → grab flow. Failed/wrong-ID responses are not cached; uncached deep links during a complete catalog outage remain a limitation.
- Intermediate automation exhausted the unchanged background search allowance and returned `Search could not finish; try again shortly.` Final English/romaji-first and punctuation-free qualified queries completed all five cases with 12 searches; the limiter was not raised or bypassed.
- Occasional apibay/torrents-csv invalid-response errors are retained per rung in the ledger. Other successful sources continued to provide candidates.
- Browser interaction remains unverified because Playwright MCP transport was unavailable.

## Repairs and regression validation

| Commit | Repair | Regression basis |
|---|---|---|
| `73070be` | Expose anime episodes beyond 200, up to the existing provider bound of 5,000 | Real One Piece E1100/E1180; provider and local-target projection tests |
| `5fb7cfa` | Preserve cour identity across incomplete/OVA prequel chains; reject shared predecessor aliases; retain part numbers | Real AoT Part 2, Bleach Separation and Dr. Stone Part 3 release names; incomplete-chain and numeric-range tests |
| `d692801` | Reject explicitly dated remakes when acquiring a first season | Actual Cowboy Bebop 2021 E5 mismatch; manual/background guards and mapped-sequel year exceptions |
| `886e63f` | Recover verified watchlist identity, reuse anime query ladder, normalize qualified names, prefer productive franchise aliases | Actual Frieren/Mushoku/Bleach releases; existing-Work outage recovery; zero-seeder grace and cursor assertions |
| `d444882` | Reuse bounded AniList identity through discovery, detail and grab | Real Frieren provider failure; successful-cache reuse, expiry, failure and wrong-ID regressions |

`dotnet test TorrentFlow.slnx -p:SkipWebBuild=true` was run before every push. Final functional suite: **10,179 passed, 9 skipped, 0 failed**. The worktree frontend also built successfully. Selection was independently checked against actual torrent filenames; no HTTP-success-only result was promoted to a metadata pass.

One final documentation-validation run hit an intermittent `ConcurrentTitleTests.ConcurrentTitleGrabsReuseOneWorkAndTarget(existingWork: True)` failure. The targeted fixture then passed unchanged, followed by the full 10,179-test pass above. Both full-run logs are retained; no unrelated concurrency fix is claimed.

Final cleanup verified **zero active transfers, zero engine rows, zero test watchlist entries and zero remaining episode payload files/bytes**. The dedicated port-3928 server was stopped. Raw local logs and intermediate responses are retained under the isolated test data's evidence directory; the sanitized ledger is committed alongside this report.
