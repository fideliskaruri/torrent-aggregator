# Behaviour inventory

Port checklist for **OPS-645 / FEAT-35**, task 0.5. Main snapshot: `bf36395f947447de32221ec11cff01d857079f4e`; Next.js snapshot: `5824ed5~1` at `D:\code\memtest\nextjs-baseline` (read-only). `server\...` citations resolve in this worktree; `src\lib\...` citations resolve in that baseline. Symbols are implementation anchors, not claims that every branch was runtime-tested. `main` means evidenced in the current .NET implementation; `both` has explicit evidence in both trees; `nextjs` means historical baseline behavior. **LOST IN PORT** means no equivalent production .NET execution path was found, not merely a renamed file.

Unchecked boxes are future port verification, not failures. New module ownership follows `rebuild-plan.md`; preserve outcomes, not the old mixed-job class boundaries called out in `architecture-rethink.md`. `keep` does not bless existing bugs. Source adapter keeps remain subject to the plan's owner audit. Change/drop reasons reference the governing documents; old player-oriented behavior is recorded so its removal is deliberate. No running server was used or changed.

## Domain
- [ ] Represent a work's provider identity separately from its display title and aliases — server\TorrentFlow.Data\Entities\Work.cs:Work — main — keep
- [ ] Distinguish film, series and special format independently of anime classification — server\TorrentFlow.Core\Contracts\Metadata\WorkFormat.cs:WorkFormat — main — keep
- [ ] Label names English, Romaji, Synonym, Native and Original, with linked-provider provenance — server\TorrentFlow.Core\Contracts\Metadata\WorkNames.cs:WorkName — main — keep
- [ ] Deduplicate labelled names case-insensitively and discard blanks while retaining order — server\TorrentFlow.Core\Contracts\Metadata\WorkNames.cs:WorkNames.Of — main — keep
- [ ] Read malformed/missing labelled-name JSON through the legacy title/alias fallback — server\TorrentFlow.Core\Contracts\Metadata\WorkNames.cs:WorkNames.Read — main — keep
- [ ] Preserve authoritative new names while demoting obsolete unlinked labels to synonyms — server\TorrentFlow.Core\Contracts\Metadata\WorkNames.cs:WorkNames.Merge — main — keep
- [ ] Remove only names supplied by a removed provider link — server\TorrentFlow.Core\Contracts\Metadata\WorkNames.cs:WorkNames.WithoutLinked — main — keep
- [ ] Merge missing TMDB/AniList/MAL/IMDb/TVDB IDs without replacing an existing ID — server\TorrentFlow.Core\Contracts\Metadata\WorkNames.cs:WorkIds.Merge — main — keep
- [ ] Encode episode queue keys so lexical ordering puts episode 9 before episode 10 — server\TorrentFlow.Core\QueueKeys.cs:QueueKeys — main — keep
- [ ] Carry per-file selection, exact progress and full path in the engine's transfer contract — server\TorrentFlow.Core\Contracts\Engine\ITorrentEngine.cs:EngineFileInfo — main — keep
- [ ] Derive downloaded status from completed library filing, not download fraction alone — server\TorrentFlow.Data\Entities\EngineTorrent.Done.cs:EngineTorrent — main — keep
- [ ] Distinguish unknown file presence from confirmed absence — server\TorrentFlow.Core\Contracts\Engine\VerifiedFiles.cs:VerifiedFiles — main — keep
- [ ] Give all acquisition callers structured wait reasons rather than independent wording — server\TorrentFlow.Core\Scheduling\WaitReasonService.cs:WaitReasonService — main — keep
- [ ] Represent connected peers, connected seeders, delivery speed and observed stall duration — server\TorrentFlow.Core\Contracts\Engine\TransferHealth.cs:TransferHealth — main — keep
- [ ] Treat priority lane as owner, requester or automation provenance on a transfer — server\TorrentFlow.Core\Contracts\Engine\ITorrentEngine.cs:TorrentLane — main — change (dynamic target rank replaces fixed lane-only order; rebuild-plan.md)

## Parser
- [ ] Parse scene SxxEyy and NxYY episode notation — server\TorrentFlow.Core\ReleaseEpisodeParser.cs:ReleaseEpisodeParser.Parse — main — keep
- [ ] Parse season words and ordinal-season forms without requiring scene notation — server\TorrentFlow.Core\ReleaseEpisodeParser.cs:ReleaseEpisodeParser.Parse — main — keep
- [ ] Parse fansub dash/bracket absolute episode numbers and version suffixes — server\TorrentFlow.Core\ReleaseEpisodeParser.cs:ReleaseEpisodeParser.Parse — main — keep
- [ ] Recognize complete/batch/season-pack intent separately from single episodes — server\TorrentFlow.Core\ReleaseEpisodeParser.cs:ReleaseEpisodeParser.Parse — main — keep
- [ ] Recognize season ranges, multi-season lists and multiple episode markers — server\TorrentFlow.Core\ReleaseEpisodeParser.cs:ReleaseEpisodeParser.IsMultiEpisode — main — keep
- [ ] Reject episode ranges as single-episode intent even when their first episode parses — server\TorrentFlow.Core\ReleaseEpisodeParser.cs:ReleaseEpisodeParser.IsEpisodeRange; src\lib\torrents\pack-preference.ts:isEpisodeRangeRelease — both — keep
- [ ] Avoid interpreting release years and title numbers as episode ranges — server\TorrentFlow.Core\ReleaseEpisodeParser.cs:ReleaseEpisodeParser.Parse — main — keep
- [ ] Avoid treating Part/Cour markers as episode ranges — server\TorrentFlow.Core\ReleaseEpisodeParser.cs:ReleaseEpisodeParser.Parse — main — keep
- [ ] Classify OVA/OAD/recap/movie/special releases distinctly — server\TorrentFlow.Core\ReleaseEpisodeParser.cs:ReleaseEpisodeParser.SpecialType — main — keep
- [ ] Bound dynamic regex matching and the compiled-pattern cache — server\TorrentFlow.Core\ReleaseEpisodeParser.cs:ReleaseEpisodeParser — main — keep
- [ ] Strip scene group and encoding jargon before constructing grouping keys — server\TorrentFlow.Search\ReleaseRanking.cs:ReleaseRanking.StripReleaseGroup — main — keep
- [ ] Keep year and episode/pack coordinates in grouping keys so distinct releases do not collapse — server\TorrentFlow.Search\ReleaseRanking.cs:ReleaseRanking.GroupKey — main — keep
- [ ] Recover film year without stripping numbers genuinely belonging to the title — server\TorrentFlow.Core\ReleaseNames.cs:ReleaseNames — main — keep
- [ ] Normalize punctuation and apostrophe variants for identity matching — server\TorrentFlow.Core\Text\Apostrophes.cs:Apostrophes — main — keep
- [ ] Parse resolution aliases including 4K into numeric resolution — server\TorrentFlow.Core\ReleaseResolution.cs:ReleaseResolution — main — keep
- [ ] Recognize CAM/telecine/telesync and implausibly tiny high-resolution releases — server\TorrentFlow.Search\ReleaseQuality.cs:ReleaseQuality — main — keep
- [ ] Detect executable/script extensions even when disguised as `.mkv.exe` or Windows-trimmed names — server\TorrentFlow.Core\MediaFileRules.cs:MediaFileRules.IsDangerous — main — keep
- [ ] Reject a dangerous file anywhere in a torrent, including skipped files — server\TorrentFlow.Core\MediaFileRules.cs:MediaFileRules.Check — main — keep
- [ ] Refuse archive-only and no-video selections before admitting a release — server\TorrentFlow.Core\MediaFileRules.cs:MediaFileRules.Check — main — keep
- [ ] Identify sample files by filename and sample-directory markers — server\TorrentFlow.Core\MediaFileRules.cs:MediaFileRules — main — keep
- [ ] Parse clear foreign-language release markers — server\TorrentFlow.Core\ReleaseLanguage.cs:ReleaseLanguage — main — change (retain explicit-marker refusal, remove proof-of-English gate; rules.md)
- [ ] Normalize hex/base32 magnet hashes for same-swarm identity — server\TorrentFlow.Search\InfoHash.cs:InfoHash — main — keep
- [ ] Extract work/category/episode facts once instead of reparsing in adapters and acquisition services — server\TorrentFlow.Search\Adapters\TheRarbgAdapter.cs:TheRarbgAdapter — main — change (adapter episode filtering belongs in pure Parser/Plan; rebuild-plan.md)

## Plan
- [ ] Match explicit SxxEyy to exactly the requested season and episode — server\TorrentFlow.Library\Features\Grabs\EpisodeLadder.cs:EpisodeLadder.MatchesTargetEpisode; src\lib\torrents\pack-preference.ts:matchesTargetEpisode — both — keep
- [ ] Accept seasonless single-episode numbering only for season 1 unless metadata supplies a mapping — server\TorrentFlow.Library\Features\Grabs\EpisodeLadder.cs:EpisodeLadder.MatchesTargetEpisode; src\lib\torrents\pack-preference.ts:matchesTargetEpisode — both — keep
- [ ] Never satisfy one episode by blindly sending a season pack or episode range — server\TorrentFlow.Library\Features\Grabs\EpisodeLadder.cs:EpisodeLadder.MatchesTargetEpisode; src\lib\torrents\pack-preference.ts:selectSeriesCandidateWithPackPreference — both — keep
- [ ] Require release work identity to match canonical or permitted alias names — server\TorrentFlow.Library\Features\Grabs\EpisodeLadder.cs:EpisodeLadder.ReleaseMatchesWork — main — keep
- [ ] Apply premiere-year matching without applying the first-season year to a sequel entry — server\TorrentFlow.Library\Features\Grabs\EpisodeLadder.cs:EpisodeLadder.ReleaseMatchesWork — main — keep
- [ ] Treat requested resolution as a hard floor; unknown/lower resolution does not satisfy it — server\TorrentFlow.Library\Features\Grabs\ReleaseSelection.cs:ReleaseSelection.MeetsFloor — main — keep
- [ ] Prefer requested quality among eligible candidates without making it outrank a dead swarm — server\TorrentFlow.Search\ReleaseRanking.cs:ReleaseRanking.Rank — main — change (measured live health before quality; rules.md)
- [ ] Filter film candidates for matching identity, film-shaped release, magnet and quality floor — server\TorrentFlow.Library\Features\Grabs\FilmSelection.cs:FilmSelection — main — keep
- [ ] Require a positive listed seeder count before film selection — server\TorrentFlow.Library\Features\Grabs\FilmSelection.cs:FilmSelection — main — change (scrape/list counts are prefilter, Check decides viability; rebuild-plan.md)
- [ ] Put identity/category and junk gates ahead of numeric health scoring — server\TorrentFlow.Search\ReleaseRanking.cs:ReleaseRanking.Rank — main — keep
- [ ] Put samples/extras and anime specials below main-feature releases — server\TorrentFlow.Search\ReleaseRanking.cs:ReleaseRanking.Rank; src\lib\torrents\ranking.ts:rankResults — both — keep
- [ ] Return one best-pick flag per release group, with alternate releases retained — server\TorrentFlow.Search\ReleaseRanking.cs:ReleaseRanking.Rank — main — keep
- [ ] Map missing pack episodes only from unambiguous SxxEyy/NxYY video filenames — server\TorrentFlow.Core\SeasonPackFiles.cs:SeasonPackFiles.Map — main — keep
- [ ] Refuse entire packs containing executable, archive, disc-image or other-season files — server\TorrentFlow.Core\SeasonPackFiles.cs:SeasonPackFiles.Map — main — keep
- [ ] Ignore pack samples/extras/double episodes and omit episodes with multiple possible videos — server\TorrentFlow.Core\SeasonPackFiles.cs:SeasonPackFiles.Map — main — keep
- [ ] Select only missing pack episodes, never already-owned episodes — server\TorrentFlow.Core\SeasonPackFiles.cs:SeasonPackFiles.Map — main — keep
- [ ] Include only subtitle/audio sidecars associated with selected videos — server\TorrentFlow.Core\VideoSidecars.cs:VideoSidecars — main — keep
- [ ] Count union of touched pieces, including boundaries, for selective-pack storage reservations — server\TorrentFlow.Core\SeasonPackFiles.cs:SeasonPackFiles.PieceSpanBytes — main — keep
- [ ] Enforce maximum size per selected episode rather than against the entire pack — server\TorrentFlow.Library\Features\Grabs\GrabService.Pack.cs:GrabService — main — keep
- [ ] Try finished-season packs only after real single-episode misses and behind a disabled-by-default option — server\TorrentFlow.Library\Features\Grabs\WantedQueue.cs:SeasonPackAsync — main — change (healthy packs and singles compete immediately for finished seasons; rules.md)
- [ ] Exclude already-attempted hashes and automatically blocked hashes from automatic selection — server\TorrentFlow.Library\Features\Grabs\ReleaseSwapService.cs:ReleaseSwapService — main — keep
- [ ] Retain blocked choices for explicit owner “Use anyway” rather than silently hiding them — server\TorrentFlow.Library\Features\Grabs\ReleaseSwapService.cs:ReleaseSwapService — main — keep
- [ ] Prefer proven-English releases and suppress unknown ones after trying a healthy listed Pass — server\TorrentFlow.Library\Features\Grabs\LanguageLadder.cs:LanguageHold.Sendable — main — drop (unknown language is allowed without waiting; rules.md)
- [ ] Prefer direct-playable codecs/containers in otherwise similar release ranking — server\TorrentFlow.Search\ReleaseRanking.cs:ReleaseRanking.Rank — main — drop (no built-in player or streaming; rules.md)

## Metadata
- [ ] Support TMDB v3 query credentials and v4 bearer credentials without exposing the key — server\TorrentFlow.Metadata\Providers\TmdbClient.cs:TmdbClient.BuildRequest — main — keep
- [ ] Search film/TV separately, exclude adults and persons, and request English display fields — server\TorrentFlow.Metadata\Providers\TmdbClient.cs:TmdbClient.SearchByTypeAsync — main — keep
- [ ] Try discovery query variants only after the primary query lacks relevant hits — server\TorrentFlow.Metadata\Providers\TmdbClient.cs:SearchWithVariantsAsync — main — keep
- [ ] Fetch TMDB alternative/original names to explain alias matches such as Gisaengchung/Parasite — server\TorrentFlow.Metadata\Providers\TmdbClient.cs:AlternativeTitlesAsync — main — keep
- [ ] Map detail artwork, genres, rating, original language and external IDs — server\TorrentFlow.Metadata\Providers\TmdbClient.cs:MapDetail — main — keep
- [ ] Distinguish TMDB found, not found, rate limited and failed lookup outcomes — server\TorrentFlow.Metadata\Providers\TmdbClient.cs:LookupByIdAsync — main — keep
- [ ] Fetch season episode names, dates, runtime and stills — server\TorrentFlow.Metadata\Providers\TmdbClient.cs:FetchSeasonAsync — main — keep
- [ ] Search AniList across English/romaji/native/synonym names and prefer English display names — server\TorrentFlow.Metadata\Providers\AniListClient.cs:Map — main — keep
- [ ] Preserve MOVIE versus episodic AniList format when resolving an anime work — server\TorrentFlow.Metadata\Providers\AniListClient.cs:ToWork — main — keep
- [ ] Derive aired count from FINISHED, NOT_YET_RELEASED and nextAiringEpisode — server\TorrentFlow.Metadata\Providers\AniListClient.cs:ToWork — main — keep
- [ ] Distinguish AniList rate limiting/failure from a confirmed missing entry — server\TorrentFlow.Metadata\Providers\AniListClient.cs:LookupWorkAsync — main — keep
- [ ] Share AniList in-flight queries and memoize work/search/airing answers separately — server\TorrentFlow.Metadata\Providers\AniListClient.cs:FetchMediaAsync — main — keep
- [ ] Pace all AniList calls through one gate with foreground reserve and startup grace — server\TorrentFlow.Metadata\Providers\AniListRateGate.cs:AniListRateGate — main — keep
- [ ] Honor AniList Retry-After and avoid inline retries on 429 — server\TorrentFlow.Metadata\Providers\AniListClient.cs:FetchUncoalescedAsync — main — keep
- [ ] Convert AniList score to a bounded ten-point rating and strip description HTML — server\TorrentFlow.Metadata\Providers\AniListClient.cs:ScoreTo10 — main — keep
- [ ] Retrieve the first scheduled airing after a saved intent timestamp — server\TorrentFlow.Metadata\Providers\AniListClient.cs:GetFirstAiringAfterAsync — main — keep
- [ ] Fetch episode-specific AniList air time while preserving unanswered versus answered-empty — server\TorrentFlow.Metadata\Providers\AniListClient.cs:AiringAsync — main — keep
- [ ] Offer keyless film/series lookup through iTunes and TVmaze — server\TorrentFlow.Metadata\Providers\KeylessClients.cs:KeylessClients — main — keep
- [ ] Search Cinemeta/IMDb and use IMDb alternate names and popularity evidence — server\TorrentFlow.Metadata\Search\WorkSearchService.cs:SearchSourceAsync — main — keep
- [ ] Ask every enabled catalog concurrently rather than stopping at the first plausible provider — server\TorrentFlow.Metadata\Search\WorkSearchService.cs:RegistryProviders — main — keep
- [ ] Interleave and rank cross-category work hits by relevance without losing same-name remakes — server\TorrentFlow.Metadata\Search\WorkSearchService.cs:SearchAsync — main — keep
- [ ] Reuse stored work keys via verified provider IDs/links instead of creating duplicate title identities — server\TorrentFlow.Metadata\Search\WorkSearchService.cs:StoredWorksAsync — main — keep
- [ ] Return stale catalog search only when every provider fails, marking stale and partial explicitly — server\TorrentFlow.Metadata\Search\WorkSearchService.cs:SearchAsync — main — keep
- [ ] Avoid making a partial provider result a fresh negative cache — server\TorrentFlow.Metadata\Search\WorkSearchService.cs:SearchAsync — main — keep
- [ ] Keep remake years in metadata cache keys even when bracket cleaning removes them — server\TorrentFlow.Metadata\Enrichment\MetadataResolver.cs:LookupTitle — main — keep
- [ ] Bound optional release enrichment so slow metadata cannot hold the search indefinitely — server\TorrentFlow.Metadata\Enrichment\MetadataResolver.cs:EnrichAsync — main — keep
- [ ] Attach query metadata only when release name, year and media category are compatible — server\TorrentFlow.Metadata\Enrichment\MetadataResolver.cs:MetadataIdentity.Compatible — main — keep
- [ ] Resolve detail records by explicit TMDB/AniList/TVmaze/iTunes/Cinemeta provider ID — server\TorrentFlow.Metadata\Enrichment\MetadataResolver.cs:GetByIdAsync — main — keep
- [ ] Persist successful metadata and delete expired cached rows on read — server\TorrentFlow.Metadata\Enrichment\MetadataResolver.cs:GetCachedAsync — main — keep
- [ ] Serve cached anime-list mapping at startup and refresh conditionally without blocking requests — server\TorrentFlow.Metadata\Links\AnimeListsMap.cs:AnimeListsMap — main — keep
- [ ] Keep last-good mapping after invalid, oversized or failed downloads — server\TorrentFlow.Metadata\Links\AnimeListsMap.cs:AnimeListsMap — main — keep
- [ ] Index AniList/MAL/IMDb/TMDB film and series IDs, including multiple anime entries per show — server\TorrentFlow.Metadata\Links\AnimeListsMap.cs:AnimeListsMap — main — keep
- [ ] Keep verified mapping claims separate from unverified title-search suggestions — server\TorrentFlow.Metadata\Links\WorkLinker.cs:WorkLinker — main — keep
- [ ] Persist rejected links so refresh does not silently reintroduce them — server\TorrentFlow.Metadata\Links\WorkLinker.cs:WorkLinker — main — keep
- [ ] Remove retired mapping claims and recompute linked names when the mapping version changes — server\TorrentFlow.Metadata\Links\WorkLinker.cs:WorkLinker — main — keep
- [ ] Match provider-link suggestions only on unique strong normalized names and compatible years — server\TorrentFlow.Metadata\Links\WorkLinker.cs:WorkLinker — main — keep
- [ ] Build anime seasons from sequel chains, distinguishing a new season from a split cour — server\TorrentFlow.Metadata\Title\AnimeFranchiseService.cs:SeasonMark — main — keep
- [ ] Cut an unmarked anime sequel into its own show when no confident listing connects it — server\TorrentFlow.Metadata\Title\AnimeFranchiseService.cs:Lay — main — keep
- [ ] Overlay anime chain numbering on TMDB/TVmaze names/stills while preserving absolute identity — server\TorrentFlow.Metadata\Title\AnimeFranchiseService.cs:Number — main — keep
- [ ] Snap near listing/chain season starts and mark uncertain episode ranges rather than guessing — server\TorrentFlow.Metadata\Title\AnimeFranchiseService.cs:Lay — main — keep
- [ ] Mark interrupted chains and unavailable show listings provisional, never confirmed-empty — server\TorrentFlow.Metadata\Title\AnimeFranchiseService.cs:LookupAsync — main — keep
- [ ] Give acquisition paths the same season shape and aired flags as the title page — server\TorrentFlow.Metadata\Title\SeasonShapeService.cs:GetSeasonAsync — main — keep
- [ ] Show film/series/anime featured and genre rails from one declarative feed registry — server\TorrentFlow.Metadata\Browse\HomeRails.cs:HomeRails — main — keep
- [ ] Deduplicate visible home cards across rails without claiming overflow cards not actually shown — server\TorrentFlow.Metadata\Browse\BrowseService.cs:DistinctAcrossRails — main — keep
- [ ] Resolve one canonical work poster across home, watchlist, notifications and requests — server\TorrentFlow.Data\WorkPosters.cs:WorkPosters — main — keep
- [ ] Build “because” recommendations from tracked catalog intent, not opaque torrent filenames — server\TorrentFlow.Metadata\Browse\BrowseService.cs:ReadWatchSeedAsync — main — keep

## Sources
- [ ] Overlay editable source configuration on embedded defaults, preserving last-good configuration — server\TorrentFlow.Core\Sources\SourceRegistry.cs:SourceRegistry.Reload — main — keep
- [ ] Enable/category-filter and priority-order registered torrent and metadata sources — server\TorrentFlow.Core\Sources\SourceRegistry.cs:Active — main — keep
- [ ] Heal abandoned default hosts to shipped live mirrors without rewriting hand-edited config on read — server\TorrentFlow.Core\Sources\SourceRegistry.cs:Heal — main — keep
- [ ] Validate source IDs, categories, implementation types, URL structure and secret fields — server\TorrentFlow.Core\Sources\SourceRegistry.cs:Validate — main — keep
- [ ] Write source settings atomically and revision-invalidate consumer caches — server\TorrentFlow.Core\Sources\SourceRegistry.cs:Save — main — keep
- [ ] Return only configured status and a masked hint for source credentials — server\TorrentFlow.Core\Sources\SourceRegistry.cs:Public — main — keep
- [ ] Isolate source-specific endpoint, mirrors, credentials and options per invocation — server\TorrentFlow.Core\Sources\SourceRegistry.cs:SourceExecution.RunAsync — main — keep
- [ ] Instantiate all sixteen registered torrent implementation types — server\TorrentFlow.Search\Adapters\RegisteredTorrentSources.cs:RegisteredTorrentSources — main — keep
- [ ] Parse ApiBay categories/hash/counts and suppress its no-result sentinel — server\TorrentFlow.Search\Adapters\TorrentAdapters.cs:ApiBayAdapter — main — keep
- [ ] Retain ApiBay site ID for file-list lookups even after cross-indexer dedupe — server\TorrentFlow.Search\Adapters\TorrentAdapters.cs:ApiBayAdapter — main — keep
- [ ] Parse TorrentsCSV size/count/completed/date into normalized listings — server\TorrentFlow.Search\Adapters\TorrentAdapters.cs:TorrentsCsvAdapter — main — keep
- [ ] Parse Nyaa RSS namespace-local fields, hashes, torrent URLs and category codes — server\TorrentFlow.Search\Adapters\TorrentAdapters.cs:NyaaAdapter — main — keep
- [ ] Return each YTS quality torrent as a film variant with IMDb/artwork and Unix upload date — server\TorrentFlow.Search\Adapters\TorrentAdapters.cs:YtsAdapter — main — keep
- [ ] Resolve EZTV series IMDb identity and page season results until requested coverage is exhausted — server\TorrentFlow.Search\Adapters\TorrentAdapters.cs:EztvAdapter — main — keep
- [ ] Recover EZTV episode coordinates from title when API coordinates are zero — server\TorrentFlow.Search\Adapters\TorrentAdapters.cs:EztvAdapter — main — keep
- [ ] Keep 1337x opt-in and enrich listing cards with bounded parallel detail requests — server\TorrentFlow.Search\Adapters\TorrentAdapters.cs:X1337Adapter — main — keep
- [ ] Retain partial 1337x listings when a detail page fails — server\TorrentFlow.Search\Adapters\TorrentAdapters.cs:X1337Adapter — main — keep
- [ ] Optionally solve 1337x challenges through one isolated Chromium browser/profile — server\TorrentFlow.Search\Adapters\BrowserFetcher.cs:BrowserFetcher — main — keep
- [ ] Return anime-only AnimeTosho JSON listings and per-file track/attachment facts — server\TorrentFlow.Search\Adapters\AnimeToshoAdapter.cs:AnimeToshoAdapter; server\TorrentFlow.Search\Adapters\AnimeToshoTracks.cs:AnimeToshoTracks — main — keep
- [ ] Keep AnimeTosho pending, missing and skipped-track states distinct — server\TorrentFlow.Search\Adapters\AnimeToshoTracks.cs:AnimeToshoTracks — main — keep
- [ ] Query opt-in Archive title/media filters and carry torrent/magnet/webseed locations — server\TorrentFlow.Search\Adapters\ArchiveAdapter.cs:ArchiveAdapter — main — keep
- [ ] Give Archive a synthetic listed seeder for discovery despite no measured swarm evidence — server\TorrentFlow.Search\Adapters\ArchiveAdapter.cs:ArchiveAdapter — main — change (synthetic count must not masquerade as measured health; rebuild-plan.md)
- [ ] Parse BitSearch HTML result cards and detect challenge responses — server\TorrentFlow.Search\Adapters\BitSearchAdapter.cs:BitSearchAdapter — main — keep
- [ ] Query Knaben JSON by category and exclude unsafe/XXX categories — server\TorrentFlow.Search\Adapters\KnabenAdapter.cs:KnabenAdapter — main — keep
- [ ] Parse LimeTorrents RSS hashes from enclosures and counts from descriptions — server\TorrentFlow.Search\Adapters\LimeTorrentsAdapter.cs:LimeTorrentsAdapter — main — keep
- [ ] Return one SubsPlease magnet per resolution and normalize base32 hashes — server\TorrentFlow.Search\Adapters\SubsPleaseAdapter.cs:SubsPleaseAdapter — main — keep
- [ ] Preserve absent SubsPlease seed counts as absent evidence, not invented liveness — server\TorrentFlow.Search\Adapters\SubsPleaseAdapter.cs:SubsPleaseAdapter — main — keep
- [ ] Query TheRARBG mirrors with sanitized paths and exclude adult content — server\TorrentFlow.Search\Adapters\TheRarbgAdapter.cs:TheRarbgAdapter — main — keep
- [ ] Parse TorrentDownloads RSS hashes, byte sizes and categories — server\TorrentFlow.Search\Adapters\TorrentDownloadsAdapter.cs:TorrentDownloadsAdapter — main — keep
- [ ] Parse TorrentDownloadInfo RSS slug titles and description hash/size/count fields — server\TorrentFlow.Search\Adapters\TorrentDownloadInfoAdapter.cs:TorrentDownloadInfoAdapter — main — keep
- [ ] Query Torznab movie/tv/general functions and fall back only for capability errors — server\TorrentFlow.Search\Adapters\TorznabAdapter.cs:TorznabAdapter — main — keep
- [ ] Never disguise Torznab authentication or rate-limit failures as generic-search fallback — server\TorrentFlow.Search\Adapters\TorznabAdapter.cs:TorznabAdapter — main — keep
- [ ] Disable external XML resolution/DTDs when parsing indexer feeds — server\TorrentFlow.Search\Adapters\TorrentAdapters.cs:TorrentAdapter — main — keep
- [ ] Pace requests per host with human-priority queue ahead of patient work — server\TorrentFlow.Search\Adapters\IndexerHttp.cs:IndexerHttp — main — keep
- [ ] Cool down only rate-limit/Retry-After evidence and adapt start spacing after repeated failures — server\TorrentFlow.Search\Adapters\IndexerHttp.cs:IndexerHttp — main — keep
- [ ] Share identical HTTP answers and include credentials/body/accept in their reuse identity — server\TorrentFlow.Search\Adapters\IndexerHttp.cs:IndexerHttp — main — keep
- [ ] Prefer a successful mirror and demote failed mirrors temporarily — server\TorrentFlow.Search\Adapters\IndexerHttp.cs:IndexerHttp — main — keep
- [ ] Wait inline for cooled sources and retry transient failures during acquisition — server\TorrentFlow.Search\TorrentSearchService.cs:RunSourceAsync — main — change (skip cooling sources and enforce own 6-second deadlines without inline retries; rebuild-plan.md)

## Engine
- [ ] Maintain one production MonoTorrent client with rarest-first requests and a bounded write-only cache — server\TorrentFlow.Engine\Client\MonoTorrentBackend.cs:MonoTorrentBackend — main — keep
- [ ] Persist fast-resume, magnet metadata and DHT state under the engine data directory — server\TorrentFlow.Engine\Client\MonoTorrentBackend.cs:MonoTorrentBackend — main — keep
- [ ] Use DHT, PEx, local discovery and UPnP when configured — server\TorrentFlow.Engine\Client\MonoTorrentBackend.cs:MonoTorrentBackend — main — keep
- [ ] Support RC4/plaintext peer encryption negotiation — server\TorrentFlow.Engine\Client\MonoTorrentBackend.cs:MonoTorrentBackend — main — keep
- [ ] Pick a free listening port when configured port is zero — server\TorrentFlow.Engine\Client\MonoTorrentBackend.cs:MonoTorrentBackend — main — change (persist a stable assigned port across restarts; rebuild-plan.md)
- [ ] Refresh public trackers, respecting explicit configured tracker overrides — server\TorrentFlow.Engine\EngineOptions.cs:EngineOptions — main — keep
- [ ] Never append public trackers to private torrents — server\TorrentFlow.Engine\Client\MonoTorrentBackend.cs:MonoTorrentBackend — main — keep
- [ ] Bound `.torrent` and webseed HTTP response buffering even when Range is ignored — server\TorrentFlow.Engine\Client\TorrentHttpLimits.cs:TorrentHttpLimits — main — keep
- [ ] Fetch torrent metadata first when available, validate pinned hash, then fall back to magnet — server\TorrentFlow.Engine\TorrentEngineService.cs:AddAsync — main — keep
- [ ] Admit ordinary magnets quickly but inspect metadata before selective pack admission — server\TorrentFlow.Engine\TorrentEngineService.cs:AdmitAsync — main — keep
- [ ] Limit simultaneous metadata inspection independently from active download slots — server\TorrentFlow.Engine\TorrentEngineService.cs:InspectAsync — main — keep
- [ ] Reject unsafe/no-video file lists before payload when known, or on metadata arrival — server\TorrentFlow.Engine\Client\MonoTorrentBackend.cs:MonoTorrentBackend — main — keep
- [ ] Stop failed metadata admission and release the target so another release can be found — server\TorrentFlow.Engine\TorrentEngineService.cs:TickAsync — main — keep
- [ ] Deduplicate the same hash and retain manual provenance while only raising its priority — server\TorrentFlow.Engine\TorrentEngineService.cs:AddAsync — main — keep
- [ ] Serialize per-hash lifecycle operations and acquire multi-hash removal locks in stable order — server\TorrentFlow.Engine\TorrentEngineService.cs:RemoveManyCoreAsync — main — keep
- [ ] Keep queued/paused transfers detached rather than retaining idle peer caches — server\TorrentFlow.Engine\Client\MonoTorrentBackend.cs:MonoTorrentBackend — main — keep
- [ ] Prevent same-hash re-add while the previous manager is still detaching — server\TorrentFlow.Engine\Client\MonoTorrentBackend.cs:MonoTorrentBackend — main — keep
- [ ] Apply selected-file priorities and use sparse skipped boundary neighbors on Windows — server\TorrentFlow.Engine\Client\MonoTorrentBackend.cs:MonoTorrentBackend — main — keep
- [ ] Report progress only for selected bytes, and complete only when every selected file is whole — server\TorrentFlow.Engine\Client\MonoTorrentBackend.cs:MonoTorrentBackend — main — keep
- [ ] Persist initial selected file indices and restore them when restarting a pack — server\TorrentFlow.Engine\TorrentEngineService.cs:SelectedFilesJson — main — keep
- [ ] Update manual file selection live without updating the stored selection — server\TorrentFlow.Engine\TorrentEngineService.cs:SelectFilesAsync — main — change (persist intent in Store; rebuild-plan.md single-fact ownership)
- [ ] Give paused/queued/error durable intent precedence over a lagging live snapshot — server\TorrentFlow.Engine\TorrentEngineService.cs:ToInfo — main — keep
- [ ] Pause, resume, force-now and remove transfers without losing intended queue placement — server\TorrentFlow.Engine\TorrentEngineService.cs:PauseAsync — main — keep
- [ ] Let forced-now bypass the cap without preempting an already-active owner transfer — server\TorrentFlow.Engine\TorrentEngineService.cs:ForceAsync — main — keep
- [ ] Enforce changed concurrency caps immediately, promoting or demoting eligible rows — server\TorrentFlow.Engine\TorrentEngineService.cs:DemoteOverCapAsync — main — keep
- [ ] Rehydrate only allowed active slots and preserve schedule/forced/paused intent after restart — server\TorrentFlow.Engine\TorrentEngineService.cs:RehydrateAsync — main — keep
- [ ] Build exact verified size/mtime/bitfield manifests and omit paths for skipped fragments — server\TorrentFlow.Engine\TorrentEngineService.cs:BuildManifest — main — change (facts become MediaFile records rather than JSON shadows; rebuild-plan.md)
- [ ] Remove skipped partial fragments once selected files finish — server\TorrentFlow.Engine\TorrentEngineService.cs:DeleteFragments — main — keep
- [ ] Detach ordinary completed downloads, but continue seeding recovered/adopted torrents — server\TorrentFlow.Engine\Client\MonoTorrentBackend.cs:MonoTorrentBackend — main — change (seeding policy must be explicit target intent, not import-marker exception; rebuild-plan.md)
- [ ] Write new payload into hash-specific staging before library promotion — server\TorrentFlow.Engine\TorrentEngineService.cs:StartInBackendAsync — main — drop (write directly to final folder with partial suffix; rules.md)
- [ ] Gate final readiness on media validation and successful filing, notifying only afterward — server\TorrentFlow.Engine\TorrentEngineService.Promotion.cs:FinishAsync — main — change (keep validation, remove staging/promotion machinery; rebuild-plan.md)
- [ ] Hold interrupted/failed promotion for bounded retries and explicit Keep/Find another — server\TorrentFlow.Engine\TorrentEngineService.Promotion.cs:KeepAsync — main — drop (no promotion state in direct-final-folder design; rules.md)
- [ ] Remove old transfer/files before starting replacement backend — server\TorrentFlow.Engine\ReleaseSwap.cs:TorrentEngineService — main — change (prove replacement first, then switch/delete old; rebuild-plan.md)
- [ ] Transfer target/request/history associations transactionally during replacement — server\TorrentFlow.Engine\ReleaseSwap.cs:TorrentEngineService — main — keep
- [ ] Remove rows promptly but persist deletion tombstones for failed physical cleanup — server\TorrentFlow.Engine\TorrentEngineService.cs:RemoveManyCoreAsync — main — keep
- [ ] Retry detached file cleanup rather than resurrecting deleted rows after restart — server\TorrentFlow.Engine\DeletionCleanup.cs:TorrentEngineService — main — keep
- [ ] Read MKV/MP4 header tracks using bounded hash-valid torrent pieces in an isolated probe client — server\TorrentFlow.Engine\Client\MonoTorrentBackend.HeaderProbe.cs:MonoTorrentBackend — main — drop (language/codec probing is no longer required; rules.md)
- [ ] Carry post-admission English pending/probing/unconfirmed states and block proven failures — server\TorrentFlow.Engine\TorrentEngineService.Language.cs:CheckLanguageOnMetadata — main — drop (unknown language must proceed without waiting; rules.md)

## Check (swarm check)
- [ ] **LOST IN PORT:** attach a fresh probe to an absent hash and measure actual delivered bytes/byte-sending peers — src\lib\torrents\swarm-probe.ts:probeSwarm — nextjs — keep
- [ ] **LOST IN PORT:** classify no reached/connected peers as unknown rather than dead — src\lib\torrents\swarm-probe.ts:classifySwarm — nextjs — keep
- [ ] **LOST IN PORT:** classify connected peers delivering zero bytes as dead — src\lib\torrents\swarm-probe.ts:classifySwarm — nextjs — keep
- [ ] **LOST IN PORT:** classify sufficient delivery as good and insufficient positive delivery as weak — src\lib\torrents\swarm-probe.ts:classifySwarm — nextjs — keep
- [ ] **LOST IN PORT:** stop a fresh probe early after sufficient throughput evidence arrives — src\lib\torrents\swarm-probe.ts:runFreshProbe — nextjs — keep
- [ ] **LOST IN PORT:** reuse live transfer measurements without changing or removing that live transfer — src\lib\torrents\swarm-probe.ts:probeSwarm — nextjs — keep
- [ ] **LOST IN PORT:** fail closed when transfer liveness cannot be established, and clean only the probe-created handle — src\lib\torrents\swarm-probe.ts:probeSwarm — nextjs — keep
- [ ] **LOST IN PORT:** exclude caller-aborted measurements from persistence — src\lib\torrents\swarm-probe.ts:probeAndRecord — nextjs — keep
- [ ] **LOST IN PORT:** persist fresh measurements by normalized info hash, keeping a human release name — src\lib\torrents\swarm-probe.ts:recordSwarmMeasurement — nextjs — keep
- [ ] **LOST IN PORT:** never cache live download snapshots as reusable probe measurements — src\lib\torrents\swarm-probe.ts:probeAndRecord — nextjs — keep
- [ ] **LOST IN PORT:** read expired/missing/invalid measurements as unknown and bulk-load verdicts — src\lib\torrents\swarm-probe.ts:loadSwarmVerdicts — nextjs — keep
- [ ] **LOST IN PORT:** list recent named measurements with expiry corrected at read time — src\lib\torrents\swarm-probe.ts:listRecentSwarmMeasurements — nextjs — keep
- [ ] **LOST IN PORT:** derive required swarm throughput from playback bitrate and headroom — src\lib\torrents\swarm-probe.ts:requiredBitrateBps — nextjs — change (download-delivery threshold replaces playback bitrate; rules.md)
- [ ] Keep tracker scrape counts as a fast prefilter, not a substitute for byte-delivery verdicts — server\TorrentFlow.Search\TrackerScraper.cs:ScrapeAsync — main — change (Check must perform real swarm test before selection; rebuild-plan.md)
- [ ] Avoid same-hash probe-piece state contaminating a later real download — server\TorrentFlow.Engine\Client\MonoTorrentBackend.HeaderProbe.cs:CreateProbeEngine — main — change (validate MonoTorrent isolation before implementing Check inside the main engine; rebuild-plan.md)

## Find
- [ ] Trim empty queries and clamp page size; return no listings for an empty query — server\TorrentFlow.Search\TorrentSearchService.cs:TorrentSearchService — main — keep
- [ ] Ask selected sources for a bounded deep pool rather than only the displayed page — server\TorrentFlow.Search\TorrentSearchService.cs:TorrentSearchService — main — keep
- [ ] Share identical in-flight searches while separating deadline/background/freshness policies — server\TorrentFlow.Search\TorrentSearchService.cs:TorrentSearchService — main — keep
- [ ] Let one disconnected waiter leave without canceling shared search work for other waiters — server\TorrentFlow.Search\TorrentSearchService.cs:TorrentSearchService — main — keep
- [ ] Queue exhausted search capacity instead of refusing a valid acquisition request — server\TorrentFlow.Search\TorrentSearchService.cs:TorrentSearchService — main — keep
- [ ] Cache only complete successful pools; failed/skipped/truncated sources force a fresh next search — server\TorrentFlow.Search\TorrentSearchService.cs:TorrentSearchService — main — keep
- [ ] Invalidate search reuse when source or credential revision or preferred quality changes — server\TorrentFlow.Search\TorrentSearchService.cs:TorrentSearchService — main — keep
- [ ] Deduplicate case-insensitive same hashes plus normalized title/size duplicates — server\TorrentFlow.Search\ReleaseRanking.cs:Dedupe — main — keep
- [ ] Preserve maximum advertised seeders across duplicate sources — server\TorrentFlow.Search\ReleaseRanking.cs:Dedupe — main — change (use trusted scrape or conservative listed count; rebuild-plan.md)
- [ ] Scrape a bounded top-hash pool concurrently with optional language hints — server\TorrentFlow.Search\TorrentSearchService.cs:TorrentSearchService — main — change (retain scrape prefilter, remove language waiting; rules.md)
- [ ] Retain trusted Nyaa count while capping untrusted zero-scrape listings at one — server\TorrentFlow.Search\TorrentSearchService.cs:TorrentSearchService — main — change (record evidence/source separately; Check decides health; rebuild-plan.md)
- [ ] Include source errors and concrete candidate rejection reasons in acquisition diagnostics — server\TorrentFlow.Library\Features\Grabs\EpisodeRejections.cs:EpisodeRejections — main — keep
- [ ] Try punctuation/Unicode title variants and short guarded aliases when matching episodes — server\TorrentFlow.Library\Features\Grabs\EpisodeLadder.cs:EpisodeLadder — main — keep
- [ ] Search scene, NxYY, anime local and absolute numbering forms — server\TorrentFlow.Library\Features\Grabs\EpisodeLadder.cs:EpisodeLadder — main — keep
- [ ] Resolve anime release numbering from the shared season shape before searching — server\TorrentFlow.Library\Features\Grabs\AnimeEpisodeMappings.cs:ForAsync — main — keep
- [ ] Defer unknown/provisional AniList season mapping rather than downloading into guessed seasons — server\TorrentFlow.Library\Features\Grabs\AnimeEpisodeMappings.cs:ForAsync — main — keep
- [ ] Search each episode through repeated category/alias rungs with fresh whole-source fanout — server\TorrentFlow.Library\Features\Grabs\GrabService.cs:Episode — main — change (one film/season pool; episode searches only for uncovered gaps; rebuild-plan.md)
- [ ] Search films only by canonical title, without episode ladder alias rescue — server\TorrentFlow.Library\Features\Grabs\GrabService.cs:Film — main — change (English-first followed by fallback names when no good/weak release; rules.md)
- [ ] Search fallback romaji/synonyms together with English rungs rather than after measured English failure — server\TorrentFlow.Library\Features\Grabs\EpisodeLadder.cs:EpisodeLadder — main — change (sequential English-first viability policy; rules.md)
- [ ] Maintain a separate alternative-release search/rank path — server\TorrentFlow.Library\Features\Grabs\ReleaseSwapService.cs:ReleaseSwapService — main — change (share Find/Check/Plan pipeline; rebuild-plan.md)
- [ ] **LOST IN PORT:** reorder discovered candidates using fresh measured swarm verdicts — src\lib\prewarm\prerank.ts:orderByVerdict — nextjs — keep
- [ ] **LOST IN PORT:** memoize a pre-ranked choice by target and quality preference — src\lib\prewarm\prerank.ts:getPreRanked — nextjs — change (reuse shared target pool, not separate selection truth; rebuild-plan.md)
- [ ] **LOST IN PORT:** find latest cached search through normalizedQuery rather than guessing producer cacheKey — src\lib\prewarm\prerank.ts:getPreRanked — nextjs — keep
- [ ] **LOST IN PORT:** warm search options identically to a later speculative grab — src\lib\prewarm\prerank.ts:prewarmSearchOptions — nextjs — change (one Find pool contract replaces duplicate caller option coupling; rebuild-plan.md)

## Library
- [ ] File films under catalog title/year and episodic works under show/Season NN — server\TorrentFlow.Core\Contracts\Engine\WorkPlacement.cs:MediaFolders.Item — main — keep
- [ ] Keep anime films and series as separate flat Jellyfin libraries — server\TorrentFlow.Core\Contracts\Engine\WorkPlacement.cs:MediaFolders.Library — main — keep
- [ ] Use canonical English catalog names, not opaque metadata torrent filenames, for folders — server\TorrentFlow.Engine\Settings\SmartSendTarget.cs:SmartSendTargets — main — keep
- [ ] Respect explicit save path and category path rules ahead of inferred defaults — server\TorrentFlow.Engine\Settings\ClientSettingsStore.cs:ResolveDownloadTarget — main — keep
- [ ] Sanitize catalog folder names and avoid duplicating film year suffixes — server\TorrentFlow.Core\Contracts\Engine\WorkPlacement.cs:MediaFolders.Name — main — keep
- [ ] Drop provably redundant wrappers, not merely any folder that has one child — server\TorrentFlow.Engine\Layout\ContentLayoutPolicy.cs:MayDropFolder — main — change (apply planner before writing direct final paths; rebuild-plan.md)
- [ ] Preserve structural season/subtitle/extra and protected disc folders — server\TorrentFlow.Engine\Layout\ContentLayoutPolicy.cs:ContentLayoutPolicy — main — keep
- [ ] Normalize multi-season release folders to Season NN without merging separate seasons — server\TorrentFlow.Engine\Layout\ContentLayoutPlanner.cs:ContentLayoutPlanner — main — keep
- [ ] Flatten matching episode folders and place matching subtitles beside their video — server\TorrentFlow.Engine\Layout\ContentLayoutPlanner.cs:ContentLayoutPlanner — main — keep
- [ ] Resolve extra-file collisions using a per-release namespace while retaining colliding videos — server\TorrentFlow.Engine\Layout\ContentLayoutPlanner.cs:ContentLayoutPlanner — main — keep
- [ ] Claim destination paths durably before moving files and refuse cross-file/path collapse — server\TorrentFlow.Engine\Layout\ContentLayoutPlanner.cs:Apply — main — keep
- [ ] Treat an unclaimed same-sized destination as an old own download and replace it — server\TorrentFlow.Engine\Layout\CompletedLayoutFinalizer.cs:Execute — main — change (review duplicates and never auto-delete them; rules.md)
- [ ] Validate content signatures to reject archives/programs wearing video extensions — server\TorrentFlow.Engine\Layout\CompletedMediaValidator.cs:ContainerSniffer.Classify — main — keep
- [ ] Reject empty/zero-filled videos and releases whose largest kept video is below the minimum — server\TorrentFlow.Engine\Layout\CompletedMediaValidator.cs:ValidateAsync — main — keep
- [ ] Retry unreadable media; never infer invalid content from file-sharing/permission failure alone — server\TorrentFlow.Engine\Layout\CompletedMediaValidator.cs:ReadAsync — main — keep
- [ ] Block proven-invalid releases and return their wanted items for a different release — server\TorrentFlow.Engine\Layout\CompletedLayoutFinalizer.cs:BlockFailedCheckAsync — main — keep
- [ ] Re-run tidy idempotently, preserving paths already laid out or deliberately pinned — server\TorrentFlow.Engine\Layout\CompletedLayoutFinalizer.cs:FinalizeDetailedAsync — main — keep
- [ ] Relocate finished anime season files only within one library/volume, without overwriting clashes — server\TorrentFlow.Engine\TorrentEngineService.Relocate.cs:RelocateAsync — main — change (Library owns moves and media-file paths; rebuild-plan.md)
- [ ] Journal relocation before moving and finish or roll back interrupted moves after restart — server\TorrentFlow.Engine\TorrentEngineService.Relocate.cs:RecoverRelocationsAsync — main — keep
- [ ] Detect configured-root loose media and track it in place without contacting a torrent client — server\TorrentFlow.Engine\Settings\DownloadRecoveryService.cs:ImportAsync — main — change (first-class StorageRoot/MediaFile, not synthetic EngineTorrent; rebuild-plan.md)
- [ ] Skip changing/link-swapped files and paths already tracked or pending deletion during recovery — server\TorrentFlow.Engine\Settings\DownloadRecoveryService.cs:ImportAsync — main — keep
- [ ] Restore cached `.torrent` metadata against exact existing file sizes and hash-check for seeding — server\TorrentFlow.Engine\Settings\DownloadRecoveryService.cs:MatchTorrent — main — keep
- [ ] Discover qBittorrent, Transmission, uTorrent, BitTorrent and Deluge local state read-only — server\TorrentFlow.Engine\Settings\ExternalDownloadScanner.cs:ExternalDownloadScanner — main — keep
- [ ] Snapshot external SQLite/WAL before reading and never mutate the source client — server\TorrentFlow.Engine\Settings\ExternalDownloadScanner.cs:ExternalDownloadScanner — main — keep
- [ ] Detect flat/nested/renamed/partial external layouts and refuse ambiguous file mappings — server\TorrentFlow.Engine\Settings\ExternalDownloadScanner.cs:ExternalDownloadScanner — main — keep
- [ ] Adopt present external files in place and hash-check them; leave missing-data imports paused — server\TorrentFlow.Engine\TorrentEngineService.cs:ImportExternalAsync — main — keep
- [ ] Compute a confirmed deletion plan with bytes/files and refuse narrow deletion of wider packs — server\TorrentFlow.Library\Features\Storage\DeletionController.cs:Plan — main — change (delete MediaFile scope safely rather than transfer-shaped whole-pack limitation; rebuild-plan.md)
- [ ] Protect shared category/show folders and other transfers' recorded paths during deletion — server\TorrentFlow.Engine\Storage\ReleaseFileRemoval.cs:Plan — main — keep
- [ ] Delete only bounded owned paths and partial siblings, pruning empty descendants without following links — server\TorrentFlow.Engine\Storage\ReleaseFileRemoval.cs:Execute — main — keep
- [ ] Report available/downloaded only from final media present on disk or positively held live — server\TorrentFlow.Metadata\Browse\BrowseService.cs:ReadyTorrentsAsync — main — change (offline roots remain owned, not redownload candidates; rebuild-plan.md)
- [ ] **Historical omission, deliberate:** reclaim watched/stalled ephemeral stream-cache allocations with lease guards — src\lib\library\retention-sweep.ts:sweepRetentionCache — nextjs — drop (no playback/cache eviction; owned files never auto-delete; rules.md)

## Store
- [ ] Enforce one target per user/target key and one transfer per user/hash — server\TorrentFlow.Data\TorrentFlowDbContext.cs:OnModelCreating — main — keep
- [ ] Keep work provider/kind IDs and work keys unique while preserving relationships — server\TorrentFlow.Data\TorrentFlowDbContext.cs:OnModelCreating — main — keep
- [ ] Store file selection, target intent, source preference, click time and substantive miss count — server\TorrentFlow.Data\Entities\AcquisitionTarget.cs:AcquisitionTarget — main — change (separate facts/intent and remove copied progress; rebuild-plan.md)
- [ ] Keep release blocks independent of transfer/work deletion so a bad hash stays refused — server\TorrentFlow.Data\TorrentFlowDbContext.cs:OnModelCreating — main — keep
- [ ] Distinguish tried releases from explicit blocked releases and preserve block origin/reason — server\TorrentFlow.Data\ReleaseBlocks.cs:ReleaseBlocks — main — keep
- [ ] Maintain request/target/transfer linkage through transactions and compare-and-set updates — server\TorrentFlow.Api\Requests\RequestDecisionService.cs:DecideAsync — main — keep
- [ ] Preserve user-scoped notifications, requests, settings and watchlist relationships — server\TorrentFlow.Data\TorrentFlowDbContext.cs:OnModelCreating — main — keep
- [ ] Adopt an existing Prisma database by recording EF baseline rather than recreating tables — server\TorrentFlow.Data\DatabaseInitializer.cs:InitializeAsync — main — keep
- [ ] Set WAL/foreign keys and apply pending EF schema migrations before serving requests — server\TorrentFlow.Data\DatabaseInitializer.cs:InitializeAsync — main — keep
- [ ] Create a consistent pre-migration backup and refuse updating when backup fails — server\TorrentFlow.Data\DatabaseInitializer.cs:BackupAsync — main — keep
- [ ] Keep newest migration backups and log table row-count changes — server\TorrentFlow.Data\DatabaseInitializer.cs:InitializeAsync — main — keep
- [ ] Backfill labelled work names/IDs/formats without overwriting existing labelled data — server\TorrentFlow.Data\DatabaseInitializer.cs:BackfillWorkNamesAsync — main — keep
- [ ] Version the switch to anime chain numbering so already-new coordinates are not translated twice — server\TorrentFlow.Data\ChainNumbering.cs:ChainNumbering — main — keep
- [ ] Store layout ownership in both database JSON and side manifests — server\TorrentFlow.Engine\Layout\CompletedLayoutManifestStore.cs:CompletedLayoutManifestStore — main — change (one SQLite-owned fact, no shadow truth; rebuild-plan.md)
- [ ] Ensure a local owner user exists on startup — server\TorrentFlow.Data\DatabaseInitializer.cs:InitializeAsync — main — keep

## Targets (pipeline, worker, scheduling)
- [ ] Persist wanted film/episode targets before searching so restart can resume intent — server\TorrentFlow.Library\Features\Grabs\WantedQueue.cs:SeedAsync — main — keep
- [ ] Preserve owner click order across restart instead of ordering only by target creation — server\TorrentFlow.Library\Features\Grabs\WantedQueue.cs:EnqueueAsync — main — keep
- [ ] Run multiple season searches while a single clicked film/episode bypasses season admission slots — server\TorrentFlow.Library\Features\Grabs\WantedQueue.cs:StartDue — main — change (unified dynamic target scheduler; rebuild-plan.md)
- [ ] Settle each episode immediately during bounded parallel season fanout — server\TorrentFlow.Library\Features\Grabs\SeasonFanout.cs:SeasonFanout — main — change (one shared pool before gap acquisition; rebuild-plan.md)
- [ ] Serialize settle/pick/remove per work and prevent late automatic results replacing a manual pick — server\TorrentFlow.Library\Features\Grabs\WantedQueue.cs:ClaimPickedAsync — main — keep
- [ ] Track which hashes a run admitted and clean only its own unwanted unfinished transfers — server\TorrentFlow.Library\Features\Grabs\WantedQueue.cs:RunRecord — main — keep
- [ ] Remove cancels in-flight work, clears durable intent and prevents restart resurrection — server\TorrentFlow.Library\Features\Grabs\WantedQueue.cs:WantedQueue — main — keep
- [ ] Recover orphaned queued intent and wake quickly on a failed transfer — server\TorrentFlow.Library\Features\Grabs\WantedQueue.cs:ScanAsync — main — keep
- [ ] Back off substantive failures indefinitely and ask the owner after repeated genuine misses — server\TorrentFlow.Library\Features\Grabs\WantedQueue.cs:Reschedule — main — change (persist next attempt/why and dynamic reprioritization; rebuild-plan.md)
- [ ] Do not count busy sources or unknown season lists as substantive misses — server\TorrentFlow.Library\Features\Grabs\WantedQueue.cs:Reschedule — main — keep
- [ ] Ask for help only after extended unresolved anime season-list waiting — server\TorrentFlow.Library\Features\Grabs\WantedQueue.cs:SeasonListPatience — main — keep
- [ ] Update one run-summary notification as later episodes settle rather than creating duplicates — server\TorrentFlow.Library\Features\Grabs\WantedQueue.cs:ReportRunsAsync — main — keep
- [ ] Reuse an episode already covered by a healthy single or selected pack transfer — server\TorrentFlow.Library\Features\Grabs\GrabService.cs:GrabCore — main — keep
- [ ] Coalesce same-work/episode grabs regardless of requested quality and first caller cancellation — server\TorrentFlow.Library\Features\Grabs\GrabService.cs:Grab — main — change (share target intent without losing quality/caller-independent lifetime; rebuild-plan.md)
- [ ] Claim only still-queued missing pack episodes and release claims on admission failure — server\TorrentFlow.Library\Features\Grabs\GrabService.Pack.cs:GrabService — main — keep
- [ ] Record send history/job and advance hunter cursor only from the exact expected coordinate — server\TorrentFlow.Library\Features\Grabs\GrabService.cs:GrabService — main — keep
- [ ] Respect airing date before hunting and speed up checks for freshly aired episodes — server\TorrentFlow.Library\Features\Automation\CheckSchedule.cs:Next — main — keep
- [ ] Apply minimum-seeder patience without spending misses while the episode is still warming — server\TorrentFlow.Library\Features\Automation\CheckSchedule.cs:WaitingForSeeders — main — change (measured weak/unknown Check evidence replaces listing-only patience; rebuild-plan.md)
- [ ] Pin new-episodes-only from the first airing after intent was saved, never fall back to S01E01 — server\TorrentFlow.Library\Features\Watchlist\NewEpisodes.cs:PinAsync — main — keep
- [ ] Space monitored-item searches and lock automation/rule runs against overlap — server\TorrentFlow.Library\Features\Automation\AutomationService.cs:Lock — main — keep
- [ ] Run only due monitored watching/planned items, with scheduler disable and interval settings honored — server\TorrentFlow.Library\Features\Automation\AutomationScheduler.cs:ExecuteAsync — main — keep
- [ ] Order queued transfers by lane, oldest work group and padded episode coordinate — server\TorrentFlow.Engine\Queue\DownloadQueue.cs:Order — main — change (rank targets dynamically while preserving within-work order; rebuild-plan.md)
- [ ] Honor weekly local-time download windows, overnight starts, ordered overlaps and DST transitions — server\TorrentFlow.Engine\Queue\DownloadWindows.cs:NextStart — main — keep
- [ ] Reserve queued bytes before starting new transfers; unknown-size rows reserve a conservative amount — server\TorrentFlow.Engine\Queue\DownloadQueue.cs:QueuedReservedBytes — main — keep
- [ ] Renumber targets/cursors/queue keys/tried and blocked releases together by stable anime episode identity — server\TorrentFlow.Library\Features\Grabs\AnimeNumberingReconciler.cs:RenumberAsync — main — keep
- [ ] Refuse provisional/listing-changed/uncertain renumbering and postpone it while a work grab is active — server\TorrentFlow.Library\Features\Grabs\AnimeNumberingReconciler.cs:ReconcileAsync — main — keep
- [ ] Merge renumbered target collisions without dropping a distinct live transfer — server\TorrentFlow.Library\Features\Grabs\AnimeNumberingReconciler.cs:MoveTargetsAsync — main — keep
- [ ] **LOST IN PORT:** pre-rank then pre-probe bounded upcoming monitored/watchlist targets on a nonoverlapping timer — src\lib\prewarm\preprobe-scheduler.ts:runPreProbeTick — nextjs — change (one Targets worker owns speculative checking; rebuild-plan.md)
- [ ] **LOST IN PORT:** skip live hashes and still-fresh verdicts, including fresh unknowns, during speculative probes — src\lib\prewarm\preprobe.ts:preProbeUpcoming — nextjs — keep
- [ ] **LOST IN PORT:** support off/watching/monitored probe scopes without sweeping the whole catalog — src\lib\prewarm\preprobe.ts:resolvePreProbeScope — nextjs — change (map supported scope to current tracking intent, no playback-state dependency; rules.md)
- [ ] **Historical omission, deliberate:** prewarm the next playable episode after playback crosses its trigger — src\lib\prewarm\prewarm.ts:onPlaybackProgress — nextjs — drop (no built-in playback or stream prewarming; rules.md)
- [ ] **Historical omission, deliberate:** suspend speculative traffic while foreground playback is active — src\lib\prewarm\foreground.ts:syncPrewarmSuspension — nextjs — change (yield to owner acquisition rather than removed playback; rebuild-plan.md)

## Api (requests, notifications, rules, desktop, access, settings, users)
- [ ] Expose title detail and progress using stable work keys and catalog identity — server\TorrentFlow.Library\Features\Titles\TitleService.cs:Detail — main — keep
- [ ] Reconcile target state when its transfer/file disappears and surface a concrete file-gone error — server\TorrentFlow.Library\Features\Titles\TitleService.cs:Reconcile — main — change (offline root is not missing ownership; rebuild-plan.md)
- [ ] Add/update/delete tracked works with watching/planned/completed/dropped states — server\TorrentFlow.Library\Features\Watchlist\WatchlistController.cs:WatchlistController — main — keep
- [ ] Keep provider-scoped numeric IDs distinct and retry racing duplicate watchlist additions — server\TorrentFlow.Library\Features\Watchlist\WatchlistController.cs:Save — main — keep
- [ ] Treat a series added without a start season as new-episodes-only — server\TorrentFlow.Library\Features\Watchlist\WatchlistController.cs:Save — main — keep
- [ ] Preserve stronger existing monitoring intent when the owner adds an already-saved work — server\TorrentFlow.Library\Features\Watchlist\WatchlistController.cs:Save — main — keep
- [ ] Reset seeder-wait/miss state only when cursor or requested quality actually changes — server\TorrentFlow.Library\Features\Watchlist\WatchlistController.cs:Save — main — keep
- [ ] Search requester catalog with only caller-specific request flags and real library availability — server\TorrentFlow.Api\Requests\MediaRequestService.cs:SearchAsync — main — keep
- [ ] Reject requests already satisfied on disk, overlapping own requests and excessive open requests — server\TorrentFlow.Api\Requests\MediaRequestService.cs:CreateAsync — main — keep
- [ ] Join another user's healthy same-title/scope ask without initiating a second acquisition — server\TorrentFlow.Api\Requests\MediaRequestService.cs:CreateAsync — main — keep
- [ ] Group same-ask requesters into one owner decision card while retaining individual requester rows — server\TorrentFlow.Api\Requests\MediaRequestService.cs:AllAsync — main — keep
- [ ] Approve/decline a shared ask in one transaction and elect only its oldest lead to grab — server\TorrentFlow.Api\Requests\RequestDecisionService.cs:DecideAsync — main — keep
- [ ] Permit requester cancellation only while the request is still pending and belongs to them — server\TorrentFlow.Api\Requests\MediaRequestService.cs:CancelAsync — main — keep
- [ ] Keep not-yet-aired season requests approved/waiting rather than failed — server\TorrentFlow.Api\Requests\RequestDecisionService.cs:GrabCoreAsync — main — keep
- [ ] Distinguish full start, partial start, no download and stopped transfer outcomes with actionable wording — server\TorrentFlow.Api\Requests\RequestDecisionService.cs:GrabCoreAsync — main — keep
- [ ] Attach automatic finds and owner picks to all requesters sharing the same ask — server\TorrentFlow.Api\Requests\RequestDecisionService.cs:AttachPickAsync — main — keep
- [ ] Allow retry of failed/partial requests, dropping dead/replaced hashes while protecting owner removals — server\TorrentFlow.Api\Requests\RequestDecisionService.cs:RetryAsync — main — keep
- [ ] Fulfill only when every owed transfer is filed and no queued/pending/stopped episode remains — server\TorrentFlow.Api\Requests\RequestDecisionService.cs:CheckFulfilledAsync — main — keep
- [ ] Record covered/fulfilled episode marks so removal or restart does not redownload settled history — server\TorrentFlow.Api\Requests\RequestDecisionService.cs:CoverStoppedAsync — main — keep
- [ ] Reopen fulfilled airing-season requests only for newly aired episodes above their mark — server\TorrentFlow.Api\Requests\RequestDecisionService.cs:ReconcileAiringAsync — main — keep
- [ ] Settle transfer stops once per newly stopped hash-set and keep owner removals quiet — server\TorrentFlow.Api\Requests\RequestDecisionService.cs:SettleDeadAsync — main — keep
- [ ] Sweep missed completions and backfill covered marks before restart reconciliation — server\TorrentFlow.Api\Requests\RequestDecisionService.cs:RequestFulfillmentWatcher — main — keep
- [ ] Write user-scoped feed notifications without letting publication failure break acquisition/decisions — server\TorrentFlow.Api\Notifications\NotificationService.cs:TryPublishAsync — main — keep
- [ ] Update a run notification in place without changing read state/time or creating a duplicate — server\TorrentFlow.Api\Notifications\NotificationService.cs:UpsertAsync — main — keep
- [ ] List/count/mark-read only the recipient's own notifications — server\TorrentFlow.Api\Notifications\NotificationService.cs:MarkReadAsync — main — keep
- [ ] Notify only user-origin download completion/failure, with clean labels and hash-specific links — server\TorrentFlow.Api\Notifications\DownloadNotificationWatcher.cs:DownloadNotificationWatcher — main — keep
- [ ] Relabel legacy raw-release notifications once without republishing them — server\TorrentFlow.Api\Notifications\DownloadNotificationWatcher.cs:RelabelLegacyAsync — main — keep
- [ ] Persist automation rules and execute category/source/seed/size/resolution constraints — server\TorrentFlow.Library\Features\Rules\RulesController.cs:RulesController — main — keep
- [ ] Prevent resending a rule's last matching magnet and record each rule outcome — server\TorrentFlow.Library\Features\Automation\AutomationService.cs:Rules — main — keep
- [ ] Send episode-shaped automation matches through the shared grab path, not raw engine add — server\TorrentFlow.Library\Features\Automation\AutomationService.cs:Rules — main — change (all acquisition through Targets; rebuild-plan.md)
- [ ] Offer expiring alternative-release choices bound to the current hash and explicit owner overrides — server\TorrentFlow.Library\Features\Grabs\ReleaseSwapService.cs:ReleaseSwapService — main — keep
- [ ] Default to built-in client; external client control remains explicitly feature-gated — server\TorrentFlow.Engine\Settings\ClientSettingsStore.cs:EnsureAsync — main — keep
- [ ] Require explicit folder/storage-cap setup rather than silently backfilling an owner's storage decision — server\TorrentFlow.Engine\Settings\ClientSettingsStore.cs:EnsureAsync — main — keep
- [ ] Encrypt persisted external-client passwords and omit plaintext from public connection config — server\TorrentFlow.Engine\Settings\SecretProtector.cs:SecretProtector — main — keep
- [ ] Refuse downloads that cannot fit physical free space, allowing override only for owner guardrails — server\TorrentFlow.Engine\Storage\StorageBudget.cs:Check — main — keep
- [ ] Keep queued reservation separate from chosen release size in storage-error explanations — server\TorrentFlow.Engine\Storage\StorageBudget.cs:StorageCheck — main — keep
- [ ] Resolve trust from connection local port, not attacker-supplied Host/forwarded headers — server\TorrentFlow.Api\RemoteAccess\RemoteAccessMiddleware.cs:InvokeAsync — main — keep
- [ ] Refuse Cloudflare-proxied traffic accidentally routed to the trusted local listener — server\TorrentFlow.Api\RemoteAccess\RemoteAccessMiddleware.cs:HandleLocalAsync — main — keep
- [ ] Validate RS256 Access signature, issuer, audience, expiry and email; reject service tokens — server\TorrentFlow.Api\RemoteAccess\AccessTokenValidator.cs:ValidateAsync — main — keep
- [ ] Cache signing keys with bounded stale fallback and unknown-key refetch/backoff limits — server\TorrentFlow.Api\RemoteAccess\AccessTokenValidator.cs:AccessKeyCache — main — keep
- [ ] Use local JWKS only in Development; ignore it in published production — server\TorrentFlow.Api\RemoteAccess\AccessTokenValidator.cs:DevelopmentAwareAccessKeySource — main — keep
- [ ] Gate non-owner tunnel users by requester opt-in and endpoint allowlist before database work — server\TorrentFlow.Api\RemoteAccess\RemoteAccessMiddleware.cs:HandleTunnelAsync — main — keep
- [ ] Create normalized requester users while retaining the local-owner identity for owner actions — server\TorrentFlow.Api\RemoteAccess\RequesterAccess.cs:RequesterDirectory — main — keep
- [ ] Strip owner transfer/path/magnet fields and attach only caller request state on shared catalog responses — server\TorrentFlow.Api\RemoteAccess\RequesterCatalogProjectionMiddleware.cs:InvokeAsync — main — keep
- [ ] Refuse cross-site browser writes on local and tunnel listeners — server\TorrentFlow.Api\RemoteAccess\RemoteAccessMiddleware.cs:UnsafeMethodGuardMiddleware — main — keep
- [ ] Disable host file/folder opening through remote access or container operation — server\TorrentFlow.Engine\Controllers\DownloadOpenController.cs:Open — main — keep
- [ ] Open/reveal only largest recorded finished video within configured roots, rechecking links before launch — server\TorrentFlow.Engine\Controllers\DownloadOpenController.cs:Open — main — keep
- [ ] Expose desktop availability/settings on all platforms but permit edits only locally — server\TorrentFlow.Api\Desktop\DesktopEndpoints.cs:MapDesktopEndpoints — main — keep
- [ ] Support installed-Windows autostart/tray/background launch without opening a second server — server\TorrentFlow.Api\Desktop\DesktopShellService.cs:DesktopShellService — main — keep
- [ ] Check trusted GitHub releases periodically and install only verified-size/SHA256 downloads — server\TorrentFlow.Api\Desktop\UpdateInstaller.cs:VerifiedDownload.DownloadAsync — main — keep
- [ ] Adopt old data with database checks/backups, path rewriting and rollback on publication failure — server\TorrentFlow.Api\Desktop\DataAdoption.cs:Adopt — main — keep

## Cross-cutting
- [ ] Resolve a stable data directory independently of the launch working directory — server\TorrentFlow.Api\DataDirectoryResolver.cs:DataDirectoryResolver — main — keep
- [ ] Default local access to loopback and give the Access tunnel a separate listener — server\TorrentFlow.Api\Program.cs:ownerUrls — main — keep
- [ ] Reject owner/tunnel port clashes before startup — server\TorrentFlow.Api\Program.cs:OwnerPorts — main — keep
- [ ] Serve real static assets before SPA fallback and return API 404 rather than SPA HTML — server\TorrentFlow.Api\Program.cs:ResolveWebRootFileProvider — main — keep
- [ ] Report readiness using a required application table, not just a successful SQLite connection — server\TorrentFlow.Api\Program.cs:MediaRequests — main — keep
- [ ] Retain permanent `/activity` and `/client` bookmark redirects — server\TorrentFlow.Api\Program.cs:MapGet — main — keep
- [ ] Use invariant culture for dates/numbers across host locales — server\TorrentFlow.Api\Program.cs:DefaultThreadCurrentCulture — main — keep
- [ ] Preserve camelCase/null-compatible HTTP contracts while modules move behind them — server\TorrentFlow.Api\Program.cs:AddJsonOptions — main — keep
- [ ] Prevent traversal, junction and case/trailing-dot collisions in physical ownership paths — server\TorrentFlow.Engine\Layout\ContentLayoutPolicy.cs:PhysicalKey — main — keep
- [ ] Reserve actual allocation and promised bytes rather than multiplying size by progress — server\TorrentFlow.Engine\Storage\StorageBudget.cs:Check; src\lib\library\retention-sweep.ts:onDiskBytes — both — keep
- [ ] Treat network/provider failure as unknown or partial rather than proof of absence — server\TorrentFlow.Metadata\Title\SeasonShapeService.cs:GetSeasonAsync — main — keep
- [ ] Keep file validation in-process with no ffmpeg/ffprobe dependency — server\TorrentFlow.Engine\Layout\CompletedMediaValidator.cs:CompletedMediaValidator — main — keep
- [ ] **Historical omission, deliberate:** inspect local/remote media using ffprobe subprocesses — src\lib\media\probe.ts:probeFile — nextjs — drop (no ffmpeg/ffprobe or player workload; rules.md)
- [ ] **Historical omission, deliberate:** use stream URL/origin contracts and foreground playback state — src\lib\media\probe.ts:streamUrl; src\lib\prewarm\foreground.ts:foregroundActive — nextjs — drop (no embedded playback/streaming; rules.md)

## Known bugs today
Code-evidenced defects/regressions unless marked risk; not runtime reproductions. Line numbers belong to the snapshots above.
- **Inflated dedupe health:** duplicate same-hash listings keep maximum advertised seeders/leechers, allowing untrusted claims to beat conservative evidence — server\TorrentFlow.Search\ReleaseRanking.cs:51.
- **Real swarm check lost:** .NET selects using listed/scraped counts, not reached peers and delivered bytes; header probe checks language, not swarm verdicts — server\TorrentFlow.Search\TorrentSearchService.cs:196; src\lib\torrents\swarm-probe.ts:369.
- **Advertised 6 seconds is not end-to-end acquisition bound:** searches await all sources; patient line waiting/retries extend background acquisition — server\TorrentFlow.Search\TorrentSearchService.cs:127,249,320.
- **Destructive replacement ordering:** old backend/stage cleanup precedes replacement promotion/start; failure can leave neither useful transfer — server\TorrentFlow.Engine\ReleaseSwap.cs:88,105,120.
- **Manual selection not durable:** selection endpoint updates backend only, while resume/completion consult stored SelectedFilesJson — server\TorrentFlow.Engine\TorrentEngineService.cs:1472-1477,311-312.
- **Same-episode flight loses policy differences:** key excludes quality/lane/constraints and work inherits the first caller's cancellation token — server\TorrentFlow.Library\Features\Grabs\GrabService.cs:73-79.
- **Unknown language held after failed Pass:** HealthyPass reflects attempted listed seeders, not a successful transfer; unknown alternatives can remain unsent — server\TorrentFlow.Library\Features\Grabs\LanguageLadder.cs:110,117,138.
- **Retry/why state lost on restart:** plans and explanations are process dictionaries, while restart rebuilds generic immediate plans — server\TorrentFlow.Library\Features\Grabs\WantedQueue.cs:97-100,442,448.
- **Unstable port:** unset ListenPort selects a new free port on restart, undermining stable forwarding — server\TorrentFlow.Engine\EngineOptions.cs:42; server\TorrentFlow.Engine\Client\MonoTorrentBackend.cs:64.
- **Policy lag:** pack fallback defaults off and follows misses instead of measured pack/single competition; positive English proof and staging remain despite current rules — server\TorrentFlow.Library\Features\Automation\AutomationOptions.cs:11-16; server\TorrentFlow.Engine\TorrentEngineService.Language.cs:36.
- **Duplicate HTTP work risk (OPS-654):** SendScopedAsync is started before GetOrAdd picks the winner, so concurrent misses can send multiple supposedly shared requests — server\TorrentFlow.Search\Adapters\IndexerHttp.cs:79-80.
- **Import verification gap (OPS-655):** loose-file recovery compares size/mtime immediately and uses an extension inventory, marks promoted/verified without CompletedMediaValidator; newly recovered `.mkv` can bypass content sniffing — server\TorrentFlow.Engine\Settings\DownloadRecoveryService.cs:110-126.
- **Duplicate replacement violates new rules (OPS-656):** unclaimed same-sized media is treated as old own data, replaced and its backup deleted without review — server\TorrentFlow.Engine\Layout\ContentLayoutPlanner.cs:109-114; server\TorrentFlow.Engine\Layout\CompletedLayoutFinalizer.cs:212-236.
- **Disk inventory may conceal unreadable subtrees (OPS-657):** IgnoreInaccessible=true can skip content without raising the exception that sets Complete=false — server\TorrentFlow.Engine\Storage\StorageBudget.cs:100-110.
- **Check implementation hazard, not a new regression:** MonoTorrent 3.0.2 retains per-hash piece cache state after removal; existing header probes deliberately use their own client to avoid contaminating real downloads — server\TorrentFlow.Engine\Client\MonoTorrentBackend.HeaderProbe.cs:186-188. Validate before adopting the plan's shared-engine Check design.

## Constants and thresholds
Current tuning, not automatic approval to preserve obsolete player/language thresholds. Regex rows anchor the complete source expression rather than duplicating it here.

| Area | Current value / boundary | Source file:line |
|---|---|---|
| Episode regex execution/cache | 1s per match; 128 compiled patterns | server\TorrentFlow.Core\ReleaseEpisodeParser.cs:16-17 |
| Episode-range regex family | Scene, NxYY, explicit episode ranges; do not promote first episode | server\TorrentFlow.Core\ReleaseEpisodeParser.cs:39-49 |
| Pack explicit coordinates | SxxEyy/NxYY, single mark only; refuse following range/episode marker | server\TorrentFlow.Core\SeasonPackFiles.cs:30-34 |
| Pack absolute/sidecar coordinates | Dash, bracket, E/EP/Episode, numeric-only filename | server\TorrentFlow.Core\SeasonPackFiles.cs:36-38 |
| Search source deadline | 6000ms interactive | server\TorrentFlow.Search\TorrentSearchService.cs:21 |
| Search transient retry base | 250ms, then exponential delay | server\TorrentFlow.Search\TorrentSearchService.cs:24 |
| Per-source result pool | At least 50, at most 80 | server\TorrentFlow.Search\TorrentSearchService.cs:125 |
| Acquisition source attempt | At most 15000ms | server\TorrentFlow.Search\TorrentSearchService.cs:249 |
| Patient line wait | 20s | server\TorrentFlow.Search\TorrentSearchService.cs:320 |
| Scrape budgets | 1800ms interactive; 3500ms background | server\TorrentFlow.Search\TorrentSearchService.cs:161-162 |
| Zero scrape treatment | Untrusted listing capped to 1; Nyaa retains listed count | server\TorrentFlow.Search\TorrentSearchService.cs:196 |
| Listed swarm class | 10+ usable; 1–9 weak; zero dead in old ranking | server\TorrentFlow.Search\ReleaseRanking.cs:41-44 |
| Swarm bucket | log2 counts capped to 13 score steps | server\TorrentFlow.Search\ReleaseRanking.cs:45 |
| Tracker batching/cache | 74 hashes; 5000 cached hashes | server\TorrentFlow.Search\TrackerScraper.cs:31-32 |
| Tracker quorum | 3 answered trackers, then 250ms grace | server\TorrentFlow.Search\TrackerScraper.cs:33-34 |
| Search capacity | 24 concurrent adapters; 64 concurrent searches; adapter lifetime 180000ms | server\TorrentFlow.Search\SearchModuleOptions.cs:10-14 |
| Site defaults | ApiBay 2/2s; Nyaa 2/1s; default 2/250ms concurrency/start gap | server\TorrentFlow.Search\SearchModuleOptions.cs:22-40 |
| Cooldown waits | 2s interactive; 30s patient | server\TorrentFlow.Search\Adapters\IndexerHttp.cs:14-20 |
| Rate cooldown | 30s default; 300s cap; adaptive gap at most 15000ms | server\TorrentFlow.Search\Adapters\IndexerHttp.cs:24-28 |
| Shared HTTP answer reuse | 5min | server\TorrentFlow.Search\Adapters\IndexerHttp.cs:42 |
| Adaptive burst suppression | 5s before another slowdown | server\TorrentFlow.Search\Adapters\IndexerHttp.cs:405 |
| Source config | Timeout 500–60000ms; priority 0–10000; at most 10 mirrors | server\TorrentFlow.Core\Sources\SourceRegistry.cs:134-135 |
| Source identifier regex | `^[a-z0-9][a-z0-9-]{0,63}$` | server\TorrentFlow.Core\Sources\SourceRegistry.cs:131 |
| Metadata query memo | AniList 60s | server\TorrentFlow.Metadata\Providers\AniListClient.cs:75 |
| AniList retry delays | 50/100ms on server errors, never 429 | server\TorrentFlow.Metadata\Providers\AniListClient.cs:34,151 |
| AniList turn wait | 8s | server\TorrentFlow.Metadata\Providers\AniListClient.cs:36 |
| AniList gate | Default 90/min; reserve 5; startup foreground grace 60s | server\TorrentFlow.Metadata\Providers\AniListRateGate.cs:23-28 |
| AniList block cap | 10min | server\TorrentFlow.Metadata\Providers\AniListRateGate.cs:138 |
| TMDB discovery budget | One 10s wall-clock deadline | server\TorrentFlow.Metadata\Providers\TmdbClient.cs:140 |
| Alternative-title memo | 1day success; 1min empty/failure; 4s lookup | server\TorrentFlow.Metadata\Providers\TmdbClient.cs:122,131 |
| Work search cache | 5min fresh; 24h stale; stored-ID index 30s | server\TorrentFlow.Metadata\Search\WorkSearchService.cs:71-86 |
| Optional enrichment | 450ms; 4 lookup slots; top 16 inputs / 6 unique release names | server\TorrentFlow.Metadata\Enrichment\MetadataResolver.cs:143-144,345 |
| Metadata resolver caches | 30min memory success; 3min miss; 7day DB | server\TorrentFlow.Metadata\Enrichment\MetadataResolver.cs:145-147 |
| Anime season alignment | Snap within 2 episodes; at most 40 listing seasons | server\TorrentFlow.Metadata\Title\AnimeFranchiseService.cs:66-68 |
| Anime lookup cache | Partial 1min; mapped show 1h; chain-only 5min | server\TorrentFlow.Metadata\Title\AnimeFranchiseService.cs:129 |
| Wanted parallelism/help | 6 season runs; owner help after 3 substantive tries | server\TorrentFlow.Library\Features\Grabs\WantedQueue.cs:77-78 |
| Wanted orphan/retry | 10min orphan; 1/5/15/60/180/360min waits | server\TorrentFlow.Library\Features\Grabs\WantedQueue.cs:80-82 |
| Pending season-list patience | 24h | server\TorrentFlow.Library\Features\Grabs\WantedQueue.cs:93 |
| Run removal settling | 30s | server\TorrentFlow.Library\Features\Grabs\WantedQueue.cs:119 |
| Episode search pool | 40 per rung | server\TorrentFlow.Library\Features\Grabs\EpisodeLadder.cs:27 |
| Automation seeder patience | Minimum 3; timeout 360min; recheck 15min | server\TorrentFlow.Library\Features\Automation\AutomationOptions.cs:7-9 |
| Automation pacing/pack probes | 1000ms item gap; fallback off; 2 misses; 4 inspections | server\TorrentFlow.Library\Features\Automation\AutomationOptions.cs:10-17 |
| Fresh-air checks | First 12h; 15min cadence | server\TorrentFlow.Library\Features\Automation\CheckSchedule.cs:18,44 |
| New-episode unknown cadence | No announcement 12h; unknown date at least 1h | server\TorrentFlow.Library\Features\Automation\CheckSchedule.cs:29-30 |
| Legacy language healthy Pass | 5 listed seeders | server\TorrentFlow.Library\Features\Grabs\LanguageLadder.cs:97 |
| Engine peer caps | 400 global; 120 per torrent; 40 half-open | server\TorrentFlow.Engine\EngineOptions.cs:19-23 |
| Engine resource bounds | 32MiB disk cache; 40 open files | server\TorrentFlow.Engine\EngineOptions.cs:26-32 |
| Engine timing | Metadata 90s; monitor 5s; tracker refresh 24h | server\TorrentFlow.Engine\EngineOptions.cs:47-64 |
| Metadata inspection capacity | 4 | server\TorrentFlow.Engine\TorrentEngineService.cs:47 |
| Queue default | 2 active downloads | server\TorrentFlow.Engine\Queue\DownloadQueue.cs:40 |
| Download schedule bounds | 14 windows; rates at most int.MaxValue bytes/s | server\TorrentFlow.Engine\Queue\DownloadWindows.cs:27-29 |
| Storage physical reserve | 500MiB; directory-size memo 30s | server\TorrentFlow.Engine\Storage\StorageBudget.cs:29-31 |
| Torrent HTTP buffers | Metadata 20MiB; webseed response 32MiB | server\TorrentFlow.Engine\Client\TorrentHttpLimits.cs:5-6 |
| Header probe limits | 45s; 32MiB/file; 3 files; 12 reads/file; 2 concurrent probes | server\TorrentFlow.Engine\Client\HeaderProbe.cs:16; server\TorrentFlow.Engine\Client\MonoTorrentBackend.HeaderProbe.cs:24 |
| Header piece limit | Piece size cannot exceed half per-file byte budget | server\TorrentFlow.Engine\Client\MonoTorrentBackend.HeaderProbe.cs:40 |
| Media validation reads | Head 64KiB; three 4KiB zero checks; largest video at least 1MiB | server\TorrentFlow.Engine\Layout\CompletedMediaValidator.cs:121-123 |
| Unreadable media retries | 1s then 2s | server\TorrentFlow.Engine\Layout\CompletedMediaValidator.cs:124 |
| Foreign-client import bounds | File 32MiB; entries 10000; API request 20s | server\TorrentFlow.Engine\Settings\ExternalDownloadScanner.cs:38-39,182 |
| Renumber worker bounds | 75s startup; 12 works/pass; 3s spacing; 50 moves/pass; 12h recheck | server\TorrentFlow.Library\Features\Grabs\AnimeNumberingReconciler.cs:43-54 |
| Migration backups | Keep newest 5 | server\TorrentFlow.Data\DatabaseInitializer.cs:21 |
| Request history limits | Requester 200; owner 500; catalog search 20 | server\TorrentFlow.Api\Requests\MediaRequestService.cs:86,163,178 |
| Request upkeep | Health 1min; airing 30min; fulfilled airing window 365days | server\TorrentFlow.Api\Requests\RequestDecisionService.cs:52,826-828 |
| Auto-approve input | 200 rules; 320-character email | server\TorrentFlow.Api\Requests\RequestAutoApprove.cs:40-41 |
| In-app notification bounds | List 100; title 200; body 500 | server\TorrentFlow.Api\Notifications\NotificationService.cs:43-46 |
| Access key cache | 1h fresh; 5min unknown-kid refetch; 30s failed fetch; 24h max stale | server\TorrentFlow.Api\RemoteAccess\AccessTokenValidator.cs:98-103 |
| Access JWT bounds | 16KiB token; 60s clock skew | server\TorrentFlow.Api\RemoteAccess\AccessTokenValidator.cs:171-172 |
| Desktop update cadence | 1day | server\TorrentFlow.Api\Desktop\UpdateChecker.cs:74 |
| Next.js swarm probe | 8s measurement window; verdict TTL 6h | src\lib\torrents\swarm-probe.ts:84-97 |
| Next.js playback throughput | 1.5 headroom; 8Mbps default required (replace) | src\lib\torrents\swarm-probe.ts:59-72 |
| Next.js speculative probe | 2 targets × 3 candidates; 6 attachments; concurrency 1 | src\lib\prewarm\preprobe.ts:136-153 |
| Next.js probe scheduler | Startup 45s; normal 30min; foreground/busy 1min; disabled 5min | src\lib\prewarm\preprobe-scheduler.ts:63-79 |
| Next.js pre-rank reuse | 10min choice; 30min tolerated stale pool; 15 search results; 200 memo entries | src\lib\prewarm\prerank.ts:59-74 |
