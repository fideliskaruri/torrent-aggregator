# Source audit: rebuild task 0.3

**Date:** 2026-10-03. **Tracking:** OPS-644 / FEAT-35. **Status:** measured, awaiting coordinator verification and the owner's source-selection decision.

## Decision in brief

The measurements **do not support dropping all four of bitsearch, limetorrents, torrentdownloads and torrentdownloadinfo**. Each supplied matching, unique hashes with at least five advertised seeds. Keep them out of the primary fan-out, but retain them as conditional fallbacks pending the rebuild's real swarm check. Bitsearch's real 429 makes its cooldown mandatory.

Keep the proposed six core sources, add AnimeTosho for anime, and retain TheRARBG as a fallback. Do not enable 1337x in the automatic pool on the strength of this run: every attempt failed TLS before an HTTP response. SubsPlease added no unique listed-healthy release on this historical set; Archive and unconfigured Torznab do not belong in the default torrent-search fan-out.

**“Healthy” below means only listed seeds >= 5, not verified peers or delivered bytes.** This audit does not supersede the essential swarm check.

## Summary

Totals are returned release occurrences, including overlap between English and original-name queries. Matching percentages use those occurrences. Unique healthy counts deduplicate valid 40-hex infohashes across all queries and compare against **every other source in the whole run**, not just the same query.

| Source | Total | Matching % | Unique healthy hashes | Median adapter ms | Attempt error rate | Recommendation | Reason |
|---|---:|---:|---:|---:|---:|---|---|
| apibay | 321 | 85.4% | 17 | 25.5 | 0/12, 0% | core | Fast, broad coverage with incremental anime releases. |
| nyaa | 234 | 85.0% | 6 | 316 | 0/12, 0% | core | Specialist anime index; complementary hashes to AnimeTosho. |
| eztv | 183 | 49.2% | 2 | 281.5 | 0/12, 0% | core, series only | Useful series/episode API, but wrong-season responses require independent matching. |
| yts | 7 | 71.4% | 0 | 442.5 | 0/12, 0% | core, films only, provisional | Correct A Silent Voice and Sintel releases; no incremental hashes here, so film value needs a broader film benchmark. |
| torrentscsv | 135 | 65.2% | 3 | 142.5 | 0/12, 0% | core | Small, fast API with incremental matching hashes after season checks. |
| knaben | 526 | 83.7% | 63 | 542 | 0/12, 0% | core | Largest incremental contribution among the proposed core APIs. |
| animetosho | 259 | 69.5% | 12 | 45 | 0/12, 0% | core, anime only | Fast feed with useful unique Frieren packs and A Silent Voice releases. |
| therarbg | 501 | 58.3% | 107 | 180 | 0/12, 0% | fallback | Strongest incremental pool, but broad/wrong-season results need strict metadata checks. Its current adapter uses JSON, not HTML. |
| bitsearch | 240 | 90.8% | 17 | 434.5 | 6/18, 33.3% | fallback | Adds unique hashes; one real 429 caused five cooldown skips. Six delayed second attempts succeeded. |
| limetorrents | 438 | 89.7% | 9 | 42 | 0/12, 0% | fallback | Incremental LFE and Rick and Morty releases, but several are explicitly Spanish; do not equate work-match with language eligibility. |
| torrentdownloads | 550 | 78.2% | 8 | 33 | 1/12, 8.3% | fallback | Some incremental releases, including Sintel, but malformed Prison Break RSS failed parsing. |
| torrentdownloadinfo | 506 | 81.0% | 37 | 365.5 | 0/12, 0% | fallback | Material incremental LFE, anime-film and older-show coverage; Spanish season numbering needed an extra audit check. |
| 1337x | 0 | n/a | 0 | 20 | 12/12, 100% | drop from automatic pool | TLS failures on every query; usefulness remains unmeasured, not proven absent. Retest before any re-enable. |
| subsplease | 50 | 34.0% | 0 | 205 | 0/12, 0% | drop from historical acquisition pool | Only the romaji Frieren query returned results; no listed seeder counts, and no unique listed-healthy evidence. |
| archive | 169 | 85.2% | 0 | 411.5 | 0/12, 0% | drop from default pool | No listed-healthy hashes; keep the existing optional public-domain/webseed use separate. |
| torznab | 0 | n/a | 0 | 0 | 0/12, not evaluated | drop from default pool | No configured endpoint or credential; adapter short-circuited without contacting any index. Keep as opt-in integration, not an audited public source. |

The fast TLS failures and no-I/O short-circuits are included in adapter medians; these numbers are **not** successful-source response times. EZTV has four movie-query short-circuits. Bitsearch's first-pass error rate was 6/12 (50%); after delayed retries all 12 query cells had an upstream outcome, with one earlier 429 preserved in the raw evidence.

## Method and boundaries

- Read `rebuild-plan.md` Phase 0, `architecture-rethink.md` and `rules.md`. Enumerated all 16 concrete `TorrentAdapter` implementations, cross-checking `RegisteredTorrentSources` and `sources.default.json`.
- Ran a throwaway .NET 10 console at `D:\code\memtest\source-audit` referencing the unchanged `server\TorrentFlow.Search` project. This calls each actual adapter's `SearchAsync`, preserving its URL formats, filters, mirrors, pagination, response parsing and HTTP cooldown behavior. It is not a recreation of the adapters.
- Search options: `Category = "all"`, `Limit = 50`, enrichment off. “All” avoids suppressing cross-category discoveries; production source category routing will be narrower. Adapter-specific caps still apply: notably bitsearch returns 20 and apibay returned 25 for many queries. Counts are **returned pool sizes**, not the site's full inventory.
- Sources ran in four independent lanes. Within each source, queries were sequential, English query before its original-name variant, with a one-second pause after every query. The HTTP wrapper also inserted a one-second gap between completed requests where applicable. No 1337x detail-page fan-out occurred because its search request failed TLS.
- One initial call per source/query. Only bitsearch's six failed/skipped final queries were called a second time, after its cooldown had long expired. No other query was repeated. Existing adapter mirror/page requests are parts of one call, not additional query attempts.
- The primary run completed its cells between **02:20:15 and 02:21:23 UTC** (05:20–05:21 EAT). The six bitsearch second attempts ended by **02:24:03 UTC** (05:24 EAT). There are **192 logical cells, 198 adapter attempts, 182 HTTP requests and 4,119 returned release occurrences**.
- Original adapter deadlines remain (generally 10–14 seconds per HTTP request). An outer 35-second safety cancellation bounded an adapter call; none reached it. This is a source baseline, not a test of the future six-second Find deadline.
- EZTV requires an IMDb lookup before its upstream search. Supplied a fixed `IKeylessSeriesLookup` fixture: Scorpion `tt3514324`, Little Fires Everywhere `tt8089592`, Frieren/Sousou `tt22248376`, Prison Break `tt0455275`, Money Heist/La Casa `tt6468322`, Rick and Morty `tt2861424`. Films have no series ID and return without a request. The source requests and downstream adapter logic are unchanged; metadata discovery latency is deliberately excluded.
- Used built-in endpoints, matching the shipped defaults, and their adapter-defined mirrors. Archive and 1337x were invoked despite being opt-in. Browser fallback for 1337x was disabled, matching the default source options. Torznab had no configured endpoint; no credential was invented.
- No tracker scrape, swarm probe, torrent add or download was performed. Neither port 3930 nor process 3188 was accessed, stopped or modified. The sandbox on 3931 was not needed. No server source files were changed; no commits were made.

## Matching and measurement definitions

The hard set is:

1. `Scorpion S01` (2014, 22 episodes).
2. `Little Fires Everywhere` (2020, 8 episodes).
3. `Frieren S01`, then `Sousou no Frieren` (2023, 28 episodes).
4. `A Silent Voice 2016`, then `Koe no Katachi` (2016 film).
5. `Prison Break S01` (2005, 22 episodes).
6. `Money Heist S01`, then `La Casa de Papel` (2017; Netflix first-part ceiling of 13, original first season 9).
7. `Rick and Morty S01` (2013, 11 episodes).
8. `Sintel 2010` (freely licensed pipeline film).
9. `Big Buck Bunny` (2008, freely licensed pipeline film).

Matching normalizes separator punctuation and `&`, then checks the named work against the above aliases. It rejects Scorpion King/Mortal Kombat lookalikes, explicitly different seasons, episode numbers beyond the first-season ceiling, incompatible stated years, episode numbering on films, and named OST/soundtrack/manga/trailer material. For seasons spanning two calendar years, the first and following year are accepted. A multi-season pack must start with season 1.

Numbering comes from the existing `TorrentFlow.Core.ReleaseEpisodeParser`, recorded per release in the CSV. The audit also checks Spanish `Temporada N` and `Cap 1xx`; otherwise some season 3 La Casa de Papel releases look like unnumbered season 1 candidates to today's parser. These supplementary checks are audit-only, not server changes.

**Missing year or numbering is not proof of correctness.** Such names can be counted as a plausible work match with an explicit `unverified` reason. No file list, pack completeness, size-per-episode plausibility or metadata identity was verified. Matching is a name/year/claimed-number sanity screen, not the full future Plan gate.

The summary's healthy count requires all three:

1. a matching result under that screen;
2. a valid 40-hex hash returned by exactly one source across the entire run;
3. at least five **listed** seeders in one observation.

Uniqueness is **observed sample uniqueness**. An index that caps results at 20/50, or fails, may have the same hash beyond this sample. Alias searches can change rank/window, and counts are time-sensitive. Do not claim global exclusivity. Within-source query duplicates count in totals/matching percentages, but never twice in unique-hash counts.

Language eligibility is intentionally separate from work matching. CSV `english_name_verdict` / `english_name_reason` reuse the existing name-only `ReleaseLanguage` checker. Unknown is acceptable under the rebuild rule; obvious foreign releases must still be refused later. The summary counts requested listed-health evidence even when a matching release is foreign. For example, several LimeTorrents LFE uniques say `Castellano`. No recommendation authorizes downloading those.

## Failures, blocks and coverage limits

| Source | Observed outcome | What it does and does not show |
|---|---|---|
| bitsearch | Prison Break first attempt returned HTTP 429; the next five calls were locally skipped during the adapter's cooldown. All six delayed second calls returned 20 results each. | Rate-limit susceptibility is real. The five skips are not five additional HTTP 429 responses. |
| 1337x | 12 TLS connection failures, status 0; no HTTP response. | No observed 403 or Cloudflare challenge. Do not label TLS failure as Cloudflare or bypass certificate checks. |
| torrentdownloads | Prison Break returned HTTP 200, then `XmlException: An error occurred while parsing EntityName. Line 295, position 49.` | An invalid feed is an error, not an empty successful search. Other 11 queries parsed. |
| torznab | All 12 calls returned immediately without I/O. | Unconfigured integration, not an index with zero catalog results. |
| subsplease | Listed seed counts absent (mapped to 0). | Zero healthy count is “not demonstrated,” not proof the swarms are dead. |
| archive | Seeds mapped to 0; webseeds are a separate capability. | The requested seed threshold does not measure Archive's HTTP-webseed usefulness. |

Across captured responses: **one HTTP 429, zero HTTP 403, zero HTTP 503, and zero detected Cloudflare challenge bodies**. Challenge detection checked `cf-chl`, `Just a moment` and `Attention Required`; this is not a comprehensive anti-bot classifier. Successful empty searches remain distinct from exceptions and no-request short-circuits in the raw request lists.

Wrong-season findings were also observed, not inferred: EZTV `Scorpion S01` returned two `S03E01E02` titles; the control `Rick and Morty S01` included `S00E177`/`S00E23` specials. These are rejected in this audit. Tracked follow-ups: **OPS-652** (EZTV season mismatch) and **OPS-653** (TorrentDownloads malformed RSS). Neither was fixed in task 0.3.

## Evidence that the proposed drops are not redundant

Representative matching hashes absent from every other source's observed pool:

| Source | Query | Release | Listed seeds | Unique infohash |
|---|---|---|---:|---|
| bitsearch | Sousou no Frieren | `[SubsPlease] Sousou no Frieren - 09 (1080p) [40376E5A].mkv` | 4347 | `530198ca831ad9d24e9b8a5ad01bbdd9762f1170` |
| limetorrents | Rick and Morty S01 | `Rick.and.Morty.S01.1080p.3D.FULL-SBS.HEVC.SBS-SUB.ENG-HUN.iFA-AI3...` | 48 | `d3d5ae806990e31fe7d6bece3150d6f37fb9e70a` |
| torrentdownloads | Sintel 2010 | `Sintel - 2010 - Multisubs mkv` | 29 | `a41915eababbf8d37ff5f96c0db70a289d1b206c` |
| torrentdownloadinfo | La Casa de Papel | `La-Casa-De-Papel-S01-MULTi-720p-NF-WEB-DL-x264-ARK01` | 873 | `f99b0cc416f42616488354ee64b54be0a10b0425` |

The LimeTorrents example is a 3D conversion, not necessarily a desirable default release. The TorrentDownloadInfo example is MULTi, not proof of English. The bitsearch advertised count is very large, not a live peer measurement. These examples justify **retaining a checkable fallback pool**, not trusting or choosing these releases.

TheRARBG had 107 unique listed-healthy hashes across Scorpion, LFE, Frieren, Prison Break, Money Heist, Rick and Morty and A Silent Voice. Despite the rethink's broad “HTML scrapers” description, its present adapter calls a JSON `get-posts/keywords:...:format:json/` endpoint. Keep the observed source behavior rather than categorizing it by site appearance.

## Raw data and reproducibility

[`source-audit.csv`](source-audit.csv) is the portable evidence:

- **198 `record_type=query` rows:** source, exact query, attempt number, UTC timestamp, elapsed adapter time, result/matching counts, unique/healthy hash counts, full error, HTTP status sequence, Cloudflare flag, and JSON request metadata (exact URL, method, status, request ms and response length).
- **4,119 `record_type=release` rows:** original title, normalized infohash, listed seeds, matching verdict/reason, existing parser output, observed uniqueness, other sources returning the hash, and name-only language verdict.
- Filter to `query` for per-source × query measurements. Do not sum release-row fields as query counts. Bitsearch's second attempts have `attempt=2`; original rows have `attempt=1`.
- The per-query unique count includes unmatched unique hashes; **unique healthy** additionally requires a matching work. Per-query unique counts may overlap across aliases; use deduplicated summary counts for source selection.
- A blank/malformed hash cannot be unique. Request status 0 denotes transport failure, not an HTTP code. Empty request JSON distinguishes cooldown/unsupported/unconfigured skips from actual empty upstream responses.

Local reproducibility material remains outside the repo at `D:\code\memtest\source-audit`: `SourceAudit.csproj`, `Program.cs`, `analyze.py`, `raw.jsonl`, `parsed.jsonl`, `analyzed.json`, `summary.json`, and run logs. Running with `--parse` only reparses saved names; it does not contact sources. Do not blindly rerun a live audit without allowing site cooldowns.

## Coordinator verification checklist

- Confirm 16 distinct sources, 12 distinct queries per source, and at most two calls per source/query.
- Independently recalculate matching and unique listed-healthy counts from the CSV, including cross-query overlap.
- Review sample-matching assumptions, especially unnumbered anime packs and Money Heist's alternate numbering.
- Treat fallback counts as hypotheses for the real swarm probe, not connected-seed evidence.
- Decide the final source tiers at the Phase 0 gate; this task changes documentation only.
