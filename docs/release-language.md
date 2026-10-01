# Release language

How TorrentFlow decides whether a release's language fits what the owner wants, and what the grab ladder does about
it. The design is in `docs/audio-language-plan.md`; this page describes what the code does.

## The ladder: names order, they never refuse

Every release the ladder can send gets a language fit: **Preferred**, **Neutral**, **Backup** or **Clash**.

- `GrabService.Eligible` orders each rung's results by quality first, then by fit. Language never filters there.
- The normal pass (`GrabService.Episode`, `Film`, `SeasonPack`) sends only Preferred and Neutral releases, in rung
  order and in the existing rank, exactly as before. A failed send still falls through to the next candidate, then
  the next rung.
- Backup and Clash releases are not sent in the normal pass. The same picker (`EpisodeLadder.Select`) chooses which of
  them each rung would have sent, and they are held (`LanguageHold`) across all rungs.
- When every rung is exhausted with no working send, the last-resort pass sends the held releases: Backups first,
  then Clashes, each in the order the ladder found them. A release the engine refused for its language joins the
  Clashes after the ones judged by name. These sends accept a clash, so the engine does not refuse them again.
- A ladder cut short by a failed search (the search threw, `searchFailure`) skips the last resort and keeps its holds
  for the retry, which may still find the preferred release.
- So an episode with any sendable release always ends up with something, and the conflict is recorded.
- Films do the same over `FilmSelection.Select`. Season packs probe Preferred and Neutral packs first; a Backup or
  Clash pack is chosen only when none of those maps, and it is sent as a fallback.
- A release picked by hand always goes, whatever its language (`GrabService.SendPicked`).

Every send writes two columns on its `GrabJob` row, returned by `/api/activity` as `rung` and `language`:

- `rung`: the rung that found the release, `kind: query`, for example `exact: Frieren Beyond Journey's End S01E05`.
  Films use `film: <title>`, hand picks `picked by hand`.
- `language`: the verdict, for example `Japanese audio, English subtitles`, `fallback: French audio, no Japanese
  release found`, or `picked by hand: English dub`.

Titles are made plain before any query is built (`TorrentFlow.Core.Text.Apostrophes`): `’ ‘ ʼ ´ ` ′` become `'`,
so the rung reads `Journey's End`, never `Journey’s End`. `EpisodeLadder.SearchTitleVariants` (and through it every
alias form), the AniList mapping's entry and franchise names, and the franchise lookup all use it.

## Real misses, hunt misses and messages

- A language hold or refusal is never a real miss. When any release was held back or refused for its language,
  `GrabResult.RealMiss` is false, so `AcquisitionTarget.RealMisses` does not grow and the season pack fallback does not
  count the attempt. `GrabFailure.IsRealMiss` no longer lists a language code.
- Held rows carry a language reason code in their `CandidateRejection`, so they count as relevant results and the
  watchlist hunt never treats them as a hunt miss (`GrabResult.HuntMiss` stays false).
- If the only reason nothing started is language and every send failed for a passing reason, the wanted queue keeps
  the target queued and retries it on its usual schedule.
- Batch and result messages stay counts only, for example `12 results: 9 French audio, 3 other episodes`. The words for
  each code come from `GrabFailure.ReasonLabel`. The detailed verdict lives on the `GrabJob` row.

## Outcomes by case

| Case | GrabResult | CandidateRejection | RealMiss | HuntMiss |
| --- | --- | --- | --- | --- |
| Name clash (the name says another audio, or foreign subtitles only) | Not sent in the normal pass. If nothing better sends, it is sent in the last resort: `Ok`, GrabJob `language` = `fallback: <label>, <what was missing>`. | The row gets its language code (`audio_fr`, `subs_zh`, `dub`, ...) after any other reason. | false | false |
| Header clash (the probe read the file's audio tracks and none is wanted) | The engine refuses: `EngineAddResult.Unusable = "audio_language"`, `Language = "audio_fr"`. `Send` maps it to the `audio_language` failure, the ladder falls through to the next candidate and holds the release as a confirmed clash for the last resort. | `send_failed`, then the language code. | false | false |
| File-list clash (every kept video file names another audio) | Same as a header clash. Only explicit audio markers in the file names refuse; subtitles and group names never do. | `send_failed`, then the language code. | false | false |
| Probe timeout or no peers | Not a refusal: the release passes as unchecked and the send goes on. The GrabJob `language` notes `header not checked`. | none | unchanged | unchanged |
| Probe parse error | Same as a timeout: passes as unchecked, noted on the GrabJob. | none | unchanged | unchanged |
| All candidates clash | The last resort sends the first Backup, else the first Clash, with the clash accepted: `Ok` with a `fallback:` note. If every last-resort send fails for a passing reason, the result is that failure (for example `metadata_unavailable`), the target stays queued and the wanted queue retries it. | Each failed send: `send_failed`. | false | false |
| Accepted, then metadata unavailable | The engine never got the file list: `metadata_unavailable` (or `no_seeders` with no seeders). The ladder falls through to the next candidate as before. The language check could not run on files, so the name verdict stands. | `send_failed` | As before (true only when every send failed this way, the search ran cleanly and no release was held for language) | false |

`Unusable = "audio_language"` is the engine's only language refusal, and it needs high-confidence evidence: a header
fact, or explicit audio markers in the file names. Names alone only order releases.

Header probes (`HeaderProbeCache`, commit 14225f8) are not wired into the engine's add path yet. Until they are, the
header rows above describe the contract that wiring must follow, and no release is refused on a header.

## The rule: `ReleaseLanguage`

`TorrentFlow.Core.ReleaseLanguage` is the one implementation. The grab ladder, the engine, the picker, the search
page order and (later) release swap all call it. Language codes go through `LanguageTag.Normalize`.

- `Detect(name, sourceCategory, files)` reads the facts. `Verdict(want, name, sourceCategory, files)` reads them and
  judges them. `Judge(want, facts)` judges facts read elsewhere.
- `LanguageWant.For(preference, mediaType, originalLanguage)`: the preference (`auto`, `english`, `any`), whether the
  title is anime, and the title's original language. `GrabService.LanguageWantAsync` asks the one anime rule
  (`AnimeIdentity`, plus the film identity's anime call) first, and fills the original language from TMDB
  `original_language` for TMDB titles. Titles from other catalogs (cinemeta, tvmaze, anilist) have none, so for a
  non-anime title only English counts as wanted.
- `LanguageVerdict`: `Fit` (Preferred, Neutral, Backup, Clash), `Code` (`audio_fr`, `subs_zh`, `dub`, `multi`,
  `no_subs`; null when it fits), `Label` in plain words, `Basis` (`name`, `category`, `files`, `group`, `none`),
  `Confidence` (`high`, `medium`, `low`), `Refusable`, and the facts: `Audio`, `Subtitles`, `SubtitleState`.

Each claim has a confidence, strongest first:

| Confidence | Comes from | Example |
| --- | --- | --- |
| HeaderFact | the file's own audio tracks (probe; not wired yet) | `jpn`, `eng` tracks |
| ExplicitAudio | an audio marker in the name or file names | `TRUEFRENCH`, `VF`, `German DL`, `[English Dub]`, `国语`, `JPN AAC2.0`, `Greek Audio`, `MVO` |
| ExplicitSubs | a subtitle marker | `VOSTFR`, `SUBFRENCH`, `CHS`, `CHT`, `BIG5`, `简繁`, `内封`, `Baha`, `Multi-Subs`, `MSubs`, `ESub`, `nlsubs`, `Subs.Ita.Eng`, `.en.srt` |
| ProviderCategory | the site's category | nyaa `Anime - English-translated` (1_2), `Non-English-translated` (1_3), `Raw` (1_4) |
| GroupHeuristic | a release group or the script | SubsPlease, Erai-raws, ToonsHub, VARYG, EMBER, Judas (English subtitles); Tsundere-Raws, T3KASHi, KAF (French); Ohys-Raws, Leopard-Raws (raw); NC-Raws, LoliHouse, ANi (Chinese); a bare `Dub` in a Cyrillic name (Russian) |

A higher confidence wins. A group or the script never refuses and never outweighs a marker. Rules that matter:

- Untagged is Neutral, never English. `English`, `[ENG]` and `英語` alone are ambiguous: audio or subtitles is not clear.
- `VOSTFR` is original audio with French subtitles, a strong negative for anime, not a fact about the audio.
- `MULTi` is several audio tracks with an unknown default (usually the original plus French). `Dual Audio`, `DUAL`
  and `2A` are Japanese and English audio; that alone is Neutral, not Preferred, because the subtitles are unknown.
- `English Dub` by name is a dub; the header will confirm it once probes are wired.
- `RAW` is no subtitles, but `Something-Raws` is a group name (Erai-raws subtitles in English, Tsundere-Raws in French).
- Language sets: `German DL` and `Hindi-English` are several audio tracks; `FLAC.JPN.Subs.Ita.Eng` is Japanese audio
  with Italian and English subtitles; codes next to an audio codec (`JPN AAC2.0`, `ENG-AC3`) are audio.
- nyaa 1_2 means English subtitles; 1_3 means non-English subtitles unless the name shows English ones; 1_4 means raw.
  The nyaa adapter stores the label (`Anime - Non-English-translated`); the ids are read too.
- Subtitle state: KnownEnglish, KnownNonEnglish, Mixed or Unknown. Untagged or `und` is Unknown, never English. Only
  KnownEnglish satisfies anime.
- Language words count after the title or in brackets, so `The Office S03E10 The French Connection` is not French.

## Wants and fits

`auto` (the default):

- Anime: Japanese audio with English subtitles is Preferred. An English dub or English-only file is Backup. Raws and
  foreign-only subtitles are Clash, ranked last but allowed as the final fallback. Audio in a third language is Clash.
- Everything else: English audio is Preferred. The original language, when the catalog knows it, is Backup. Other
  audio is Clash. English audio with foreign subtitles, `MULTi` and other language sets are Backup.

`english`: English audio first, anime dubs included. Japanese with English subtitles is Backup.

`any`: every release is Neutral; nothing is held.

## Decision table (auto)

Real names, as the picker labels them on live nyaa, animetosho, apibay, knaben, bitsearch and other results. The
four rows marked * are made-up names in a real pattern, because no live source had that case for these films.

| Release | Label | Fit |
| --- | --- | --- |
| **Anime** (Frieren, Mushoku Tensei) | | |
| `[AnoZu] Mushoku Tensei: Jobless Reincarnation S03E14 1080p CR WEB-DL AAC 2.0 H.264` in nyaa `Anime - English-translated` | English subtitles | Preferred |
| `[Judas] Sousou no Frieren (Frieren: Beyond Journey's End) - S01E05 [1080p][HEVC x265 10bit][Multi-Subs] (Weekly)` | English subtitles | Preferred |
| `Mushoku Tensei Jobless Reincarnation S03E04 A King-Class Water Mage 1080p CR WEB-DL JPN AAC2 0 H 264 MSubs-ToonsHub mkv` | Japanese audio, English subtitles | Preferred |
| `[Erai-raws] Sousou no Frieren - 05 [1080p][Multiple Subtitle] [ENG][POR-BR][SPA-LA][SPA][ARA][FRE][GER][ITA][RUS]` | English subtitles | Preferred |
| `[ZeroBuild] Frieren: Beyond Journey's End - S01E05 (WEB 1080p HEVC 10-bit E-AC-3) [Dual Audio] (Sousou no Frieren)` in nyaa `Anime - English-translated` | Japanese and English audio, English subtitles | Preferred |
| `[ToonsHub] Frieren: Beyond Journey's End - 05 (Multi-Audio 1080p x264 AAC) [Multi-Subs] (English, Japanese, ... Dubs)` | Japanese and English audio, English subtitles | Preferred |
| `[ToonsHub] Cosmic Princess Kaguya (2026) 1080p BSITE WEB-DL AAC2.0 H.264 (Chou Kaguya-hime!, Multi-Subs)` in nyaa `Anime - Non-English-translated` | English subtitles | Preferred |
| `Frieren Beyond Journeys End S01E05 REPACK 1080p CR WEB-DL DUAL DDP2 0 H 264-Kitsune` | Japanese and English audio | Neutral |
| `[MALD] Frieren Beyond Journey's End (2023) S01E05 (1080p WEB-DL H264 SDR DDP 2.0 Japanese)` | Japanese audio | Neutral |
| `Mushoku Tensei: Jobless Reincarnation - S03E01 - Burn Bright, Mad Dog [19158AE0].mkv` | Language not stated | Neutral |
| `Mushoku Tensei Jobless Reincarnation S03E01 Burn Bright Mad Dog 1080p CR WEB-DL MULTi AAC2.0 H.264-VARYG (..., Multi-Audio, Multi-Subs)` | Several audio tracks, English subtitles | Neutral |
| `Horimiya (2021) [BluRay.1080p.x265.AAC.ITA.FLAC.JPN.Subs.Ita.Eng] [12.8GB] [stress]` in nyaa `Anime - Non-English-translated` | Several audio tracks, English subtitles | Neutral |
| `[Yameii] Frieren - Beyond Journey's End - S01E05 v2 [English Dub] [CR WEB-DL 1080p] [455869CD] (Sousou no Frieren)` | English dub | Backup |
| `Frieren.Beyond.Journeys.End.S01E05.DUBBED.1080p.WEB.H264-SKYANiME` | English dub | Backup |
| `Mushoku Tensei Jobless Reincarnation S03E01 MULTi AD 1080p CR WEB-DL AAC2.0 H.264-Tsundere-Raws.mkv` | Several audio tracks, likely French | Backup |
| `Frieren - Beyond Journey's End S01E28 VOSTFR 1080p WEB x264 AAC -Tsundere-Raws (CR) (Sousou no Frieren)` | French subtitles only | Clash |
| `Mushoku Tensei Jobless Reincarnation S03E14 SUBFRENCH 1080p CR WEB-DL AAC2.0 H.264-Tsundere-Raws (VOSTFR, ...)` | French subtitles only | Clash |
| `Frieren - Beyond Journey's End S01E05 MULTi 1080p WEB H.264 E-AC-3 AAC -Tsundere-Raws (CUSTOM) (VOSTFR, VF, ...)` | Several audio tracks, French subtitles | Clash |
| `[ANi] Sousou no Frieren S02 / 葬送的芙莉蓮 第二季 - 31 [1080P][Baha][WEB-DL][AAC AVC][CHT][MP4]` | Chinese subtitles only | Clash |
| `[One Fansub] Sousou no Frieren - S02E01 [WebRip 1080p HEVC AAC]` in nyaa `Anime - Non-English-translated` | non-English subtitles only | Clash |
| `[Ohys-Raws] Sousou no Frieren - 05 (NTV 1280x720 x264 AAC).mp4` | Raw, no subtitles | Clash |
| **Films** (English original) | | |
| `[BDRip 1080p ENG-AC3-MULTI SUB] Michael Jackson This Is It-LiFE` | English audio | Preferred |
| `This Is It 2009 1080p BluRay x264-OFT` | Language not stated | Neutral |
| `This is It (2009) 720p BRRip Nl-ENG subs DutchReleaseTeam` | English subtitles | Neutral |
| `Stuart Little 1999 MULTI PAL DVDRip x264-LOWDEF` | Several audio tracks | Backup |
| `Stuart Little (1999) 1080p Blu-ray REMUX Dual Audio [Hindi + English] ESub ~ RemuxDoc` | Hindi and English audio | Backup |
| `Стюарт Литтл 2 / Stuart Little 2 [2002, ..., Blu-Ray CEE 1080p] Dub + Original + Sub` | Several audio tracks | Backup |
| `Stuart Little 1999 VOSTFR 1080p BluRay x264` * | French subtitles | Backup |
| `Stuart.Little.1999.German.DL.1080p.BluRay.x264` * | Several audio tracks | Backup |
| `This Is It (2009) Spanish TS` | Spanish audio | Clash |
| `Stuart Little 1999 Greek Audio Toyristas` | Greek audio | Clash |
| `Stuart Little 1999 XviD MVO AC3 BDRip avi` | Russian audio | Clash |
| `Myšák Stuart Little 1999 CZ 1080p.mkv` | Czech audio | Clash |
| `Stuart Little 1999 TRUEFRENCH 1080p BluRay x264` * | French audio | Clash |
| `The Office S03E10 The French Connection 1080p WEB` * | Language not stated | Neutral |

Under `english` the anime order flips: `[Arg0] ... [Dual-Audio]` and the Yameii English dub are Preferred, VARYG,
EMBER and Judas (Japanese audio, English subtitles) are Backup, and the Tsundere-Raws VOSTFR rows stay Clash. Under
`any` every row is Neutral and the label just describes it (`Several audio tracks, French subtitles`).

Known misses, ordering only: a lowercase language word in an all-lowercase name (`Stuart little german 1999 dvdrip
xvid`) reads as not stated, and a mixed-case code (`Dragon Ball Z [TV] [01-210] Rus (rus, eng. sub.)`) reads as English
subtitles only, so the Russian audio sorts as Preferred.

## The engine's file-list check

`TorrentEngineService.AddAsync` checks the file list right after the existing `FileListProblem` check, whenever the
request carries `Language`:

- It judges the main videos (the selected files, else the largest and any at least half its size) with the subtitle
  and audio files beside them (`ReleaseLanguage.WithSidecars`).
- It refuses only a Clash decided by explicit audio in the file names (`Refusable`), and only when `AcceptClash` is
  false: `Unusable = "audio_language"`, `Language = "audio_fr"`, message `Its files have French audio, so TorrentFlow
  skipped it.`
- The check needs the file list before admission. Since OPS-539 a magnet is admitted at once and the client holds it
  only until its file list passes the file rules (`MonoTorrentBackend`), which do not check language. So in practice
  the check runs for a release sent as a `.torrent` file, a cached `.torrent`, or a season pack (whose list is fetched
  before admission); a plain magnet is unchecked and its name verdict stands.
- Every check logs one Information line: `[builtin-engine] language check <hash> (<name>): category <category>, name
  <fit> <label>, files <fit> <label> (<basis>, <confidence>), accept clash <bool>`.

## Contracts

- `EngineAddRequest.SourceCategory`: the result's own category (`TorrentResult.Category`, nyaa's label). It is not
  `SearchCategory`. `EngineAddRequest.Language`: `EngineLanguageCheck(Want, NameFit, NameLabel, AcceptClash)`.
- `EngineAddResult.Language`: the code behind a refusal (with `Unusable = "audio_language"`), or the clash a
  last-resort send accepted.
- Settings: `GET /api/settings/client` returns `audioLanguage` (`auto` when unset); `PUT` accepts `auto`, `english` or
  `any`, anything else is a 400 `Choose one of the audio language options.` Stored in `ClientSetting.AudioLanguage`
  (null means auto).
- The picker (`GET /api/title/{workKey}/releases`) adds `language` (the label) and `languageFit` to each row, orders
  each group by fit and hides nothing. A hand pick always sends, with the clash accepted.
- The search page orders by the same verdict under `auto` (`ReleaseQuality.LanguagePreference`).
