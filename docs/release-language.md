# Release language

How TorrentFlow decides whether a release's language fits what the owner wants, and what the grab ladder does about
it. The design is in `docs/audio-language-plan.md`; this page describes what the code does.

## The owner's rule: English audio or English subtitles

"Pick the best torrent but make sure it has English audio or subtitles." Every release gets one English verdict from
`ReleaseLanguage.EnglishRule` (carried on `LanguageVerdict.English` as an `EnglishCheck(Verdict, Reason, Evidence)`):
**Pass**, **Unknown** or **Fail**. The automatic picks, the release picker, the Find another source dialog and the
engine's check after add all read this one verdict; nothing keeps a second copy.

Evidence, strongest first: the video header's tracks (the header probe), English sidecar files (`.en.srt`,
`.eng.ass`), name markers (`Dual Audio` reads as Japanese and English audio for anime, English elsewhere), nyaa's
English-translated category, then known groups. In order:

1. Preference `any`: Pass.
2. English audio (an English dub, dual audio): Pass. Once the header has listed audio tracks, only the header or the
   files can claim English audio.
3. The header was read, lists audio, has no untagged subtitles and no English subtitles: Fail.
4. English subtitles known (name, category, sidecar, header): Pass. Ambiguous English with subtitles not known to be
   another language: Pass.
5. Foreign audio that is not the work's original language, on one track: Fail (a Russian MVO).
6. Not anime, nothing stated, and the work's original language is English: Pass. Another known language: Unknown. Not known: Pass (the old heuristic).
7. Several audio tracks with subtitles not known: Unknown.
8. Raws (no subtitles): Fail. Foreign-only subtitles (VOSTFR, CHT): Fail. Mixed: Unknown. Anything else: Unknown,
   "English not stated".

Within a verdict the fit still orders releases (`ReleaseLanguage.Order` = verdict, then fit): for anime under `auto`,
Japanese audio with English subtitles (Preferred) comes before an English dub (Backup); `english` flips that.

## Automatic picks: Pass first, Unknown only without a healthy Pass, never Fail

- `GrabService.Eligible` orders each rung by quality, then `ReleaseLanguage.Order`.
- The ladder (`GrabService.Episode`, `Film`, `SeasonPack`) sends only Pass releases, in rung order and rank. A failed
  send still falls through to the next candidate, then the next rung. A release the engine refuses for its files
  (`audio_language`) counts as Fail (`LanguageHold.Refused`).
- Unknown releases are held across all rungs (`LanguageHold`). After the last rung they are sent, best seeded first,
  only when no healthy Pass release was tried (`LanguageHold.HealthySeeders` = 5 live seeders,
  `TorrentResult.Seeders`). A ladder cut short by a failed search keeps its holds for the retry.
- Fail releases are never sent automatically. There is no last-resort pass any more.
- When nothing with English could be sent and at least one match failed the rule, the result is
  `GrabFailure.NoEnglish` (code `no_english`, message `Waiting for an English release.`). The target stays queued
  with that message, the title payload shows `state: "waiting_english"`, and the wanted queue retries it on its
  usual schedule. The title page and Downloads show "Waiting for an English release" with Pick a release.
- Season packs: Fail packs are skipped; Pass packs are tried first; Unknown packs only when no healthy Pass pack exists.
- A release picked by hand always goes, whatever its verdict (`GrabService.SendPicked`, `AcceptClash`), and the
  engine never checks, stops or blocks it.

Every send writes two columns on its `GrabJob` row, returned by `/api/activity` as `rung` and `language`:

- `rung`: the rung that found the release, `kind: query`, for example `exact: Frieren Beyond Journey's End S01E05`.
  Films use `film: <title>`, hand picks `picked by hand`.
- `language`: the verdict, for example `pass (English subtitles): Japanese audio, English subtitles (preferred, name)`,
  or `picked by hand: fail (no subtitles): ...`.

Titles are made plain before any query is built (`TorrentFlow.Core.Text.Apostrophes`): `’ ‘ ʼ ´ ` ′` become `'`,
so the rung reads `Journey's End`, never `Journey’s End`. `EpisodeLadder.SearchTitleVariants` (and through it every
alias form), the AniList mapping's entry and franchise names, and the franchise lookup all use it.

## Real misses, hunt misses and messages

- A language hold or refusal is never a real miss. When any release was held back or refused for its language,
  `GrabResult.RealMiss` is false, so `AcquisitionTarget.RealMisses` does not grow and the season pack fallback does not
  count the attempt.
- Held rows carry a language reason code (`no_english`, `audio_fr`, `subs_zh`, ...) in their `CandidateRejection`, so
  they count as relevant results and the watchlist hunt never treats them as a hunt miss.
- Batch and result messages stay counts only, for example `12 results: 9 with no English audio or subtitles, 3 other
  episodes`. The words for each code come from `GrabFailure.ReasonLabel`.

## Outcomes by case

| Case | What happens |
| --- | --- |
| Pass by name | Sent in rank order. The engine checks it again once its file list is known. |
| Unknown by name | Held. Sent after the ladder only when no Pass release with 5+ seeders was tried. |
| Fail by name (raw, foreign subtitles only, foreign dub) | Never sent automatically. Counted for the waiting state. |
| Every match Fail | `no_english`: no download, the target waits for an English release and is retried on schedule. |
| File list Fail before admission (`.torrent` known) | The engine refuses: `Unusable = "audio_language"`, `Language = <code or no_english>`. The ladder moves on. |
| File list Fail after a magnet's metadata | Stopped, blocked (`ReleaseBlock`, reason `no_english`, origin `language_check`), its wanted items released so the finder picks again. |
| Header Fail | Same as a file-list fail after metadata. |
| Header probe timeout, no peers, busy queue | Kept. The Downloads row shows "English not confirmed". |
| Hand pick | Always goes; never checked, stopped or blocked. |

## The rule: `ReleaseLanguage`

`TorrentFlow.Core.ReleaseLanguage` is the one implementation. The grab ladder, the engine, the picker, the search
page order and (later) release swap all call it. Language codes go through `LanguageTag.Normalize`.

- `Detect(name, sourceCategory, files)` reads the facts. `Verdict(want, name, sourceCategory, files)` reads them and
  judges them. `Judge(want, facts)` judges facts read elsewhere.
- `LanguageWant.For(preference, mediaType, originalLanguage)`: the preference (`auto`, `english`, `any`), whether the
  title is anime, and the title's original language. `GrabService.LanguageWantAsync` asks the one anime rule
  (`AnimeIdentity`, plus the film identity's anime call) first, and fills the original language from `Work.OriginalLanguage`,
  else TMDB `original_language` for TMDB titles. Without either, for a non-anime title only English counts as wanted.
- `LanguageVerdict`: `Fit` (Preferred, Neutral, Backup, Clash), `Code` (`audio_fr`, `subs_zh`, `dub`, `multi`,
  `no_subs`; null when it fits), `Label` in plain words, `Basis` (`name`, `category`, `files`, `group`, `none`),
  `Confidence` (`high`, `medium`, `low`), `Refusable`, and the facts: `Audio`, `Subtitles`, `SubtitleState`.

Each claim has a confidence, strongest first:

| Confidence | Comes from | Example |
| --- | --- | --- |
| HeaderFact | the file's own audio and subtitle tracks (the header probe after add) | `jpn`, `eng` tracks |
| ExplicitAudio | an audio marker in the name or file names | `TRUEFRENCH`, `VF`, `German DL`, `[English Dub]`, `国语`, `JPN AAC2.0`, `Greek Audio`, `MVO` |
| ExplicitSubs | a subtitle marker | `VOSTFR`, `SUBFRENCH`, `CHS`, `CHT`, `BIG5`, `简繁`, `内封`, `Baha`, `Multi-Subs`, `MSubs`, `ESub`, `nlsubs`, `Subs.Ita.Eng`, `.en.srt` |
| ProviderCategory | the site's category | nyaa `Anime - English-translated` (1_2), `Non-English-translated` (1_3), `Raw` (1_4) |
| GroupHeuristic | a release group or the script | SubsPlease, Erai-raws, ToonsHub, VARYG, EMBER, Judas (English subtitles); Tsundere-Raws, T3KASHi, KAF (French); Ohys-Raws, Leopard-Raws (raw); NC-Raws, LoliHouse, ANi (Chinese); a bare `Dub` in a Cyrillic name (Russian) |

A higher confidence wins. A group or the script never refuses and never outweighs a marker. Rules that matter:

- Untagged is Neutral, never English. `English`, `[ENG]` and `英語` alone are ambiguous: audio or subtitles is not clear.
- `VOSTFR` is original audio with French subtitles, a strong negative for anime, not a fact about the audio.
- `MULTi` is several audio tracks with an unknown default (usually the original plus French). `Dual Audio`, `DUAL`
  and `2A` are Japanese and English audio; that alone is Neutral, not Preferred, because the subtitles are unknown.
- `English Dub` by name is a dub; the header probe confirms it after add when the file list leaves it open.
- A language next to `Dub`/`Dubbed` is that language's dub: `Uzbek Dubbed`, `Hindi Dubbed` and `Russian Dub` are
  foreign dubs (Fail). An unknown language-shaped word there (`-ian`, `-ish`, `-ese`, `-ek`) is a non-English dub,
  never English. Only `English Dub` or a bare `Dubbed` reads as an English dub.
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

## The engine's check after add

`TorrentEngineService` checks a transfer's English again once it knows more than the name. The request's
`EngineLanguageCheck(Want, NameFit, NameLabel, AcceptClash)` is kept with the engine row as `EngineLanguageState`
(column `languageCheckJson`: want, release name, site category, hand pick, state and reason).

- **Before admission**, when the `.torrent` bytes are known (a `.torrent` link, a cached file, a season pack):
  `FileListLanguage` judges the main videos (the selected files, else the largest and any at least half its size) with
  the subtitle and audio files beside them (`ReleaseLanguage.WithSidecars`); the worst verdict counts. A Fail (or an
  explicit-audio clash, `Refusable`) is refused unless it is a hand pick: `Unusable = "audio_language"`, `Language =
  <code or no_english>`, message `Its files have no English audio or subtitles (...), so TorrentFlow skipped it.`
- **Once a magnet's metadata arrives**, the monitor tick runs the same file-list check on the live file list, right
  after `FileListProblem` (the client still holds the transfer at that point). State `pending` becomes `failed`,
  `passed` (confirmed English: subtitles or audio stated explicitly) or `probing`.
- **Header probe**: what the file list leaves open goes to a bounded queue (8 entries, one worker). The worker reads
  the headers of up to 3 main videos in a probe client of its own (`ProbeHeadersAsync(..., alongside: true)`,
  `HeaderProbeBudget.Default`: 45 seconds, 32 MB per file), saves the tracks to `HeaderProbeCache`, and judges
  `ReleaseLanguage.WithHeader(...)`. Pass becomes `passed`; Fail becomes `failed`; anything else, a timeout, no peers
  or a full queue becomes `unconfirmed`. A restart requeues rows left in `probing`.
- **A fail** (file list or header) on a transfer still downloading: the row turns to an error (`No English audio or
  subtitles (<reason>). TorrentFlow stopped it and will look for another release.`), the release is blocked
  (`ReleaseBlock`, reason `no_english`, origin `language_check`), its wanted items are released, and the transfer is
  detached. The finder picks again and skips the blocked release.
- **Unconfirmed**: kept; `EngineTorrentInfo.LanguageNote` is `English not confirmed` and the Downloads row shows it.
- **Hand picks** (`AcceptClash`) are stored as `hand_pick` and never checked, stopped or blocked.
- Every check logs one Information line (`[builtin-engine] language check ...`, `English check ... from its file
  list`, `English header check ...`).

## Contracts

- `EngineAddRequest.SourceCategory`: the result's own category (`TorrentResult.Category`, nyaa's label). It is not
  `SearchCategory`. `EngineAddRequest.Language`: `EngineLanguageCheck(Want, NameFit, NameLabel, AcceptClash)`.
- `EngineAddResult.Language`: the code behind a refusal (with `Unusable = "audio_language"`), or the clash a hand pick
  accepted.
- `EngineTorrentInfo.languageNote`: `English not confirmed` while the check after add could not confirm English.
- Title payloads: an episode or film transfer has `state: "waiting_english"` while its target waits for an English
  release (`GrabFailure.IsWaitingForEnglish`).
- Settings: `GET /api/settings/client` returns `audioLanguage` (`auto` when unset); `PUT` accepts `auto`, `english` or
  `any`, anything else is a 400 `Choose one of the audio language options.` Stored in `ClientSetting.AudioLanguage`
  (null means auto). `any` turns the English rule off.
- `ReleaseLanguageInfo` (the swap dialog's `languages`, and the picker's `languages`) carries `english` (`pass`,
  `unknown`, `fail`) and `englishReason`.
- The picker (`GET /api/title/{workKey}/releases`) and the Find another source dialog order by the English verdict,
  then fit, then the shared score (`ReleaseSwapService.Rank(..., first: ReleaseLanguage.Order)`), and hide nothing.
  The dialog never recommends a Fail release as its Best match, and it judges the current release with its site
  category (kept with the engine row, else read from the search when the same release turns up). A hand pick always
  sends.
- The search page orders by the same verdict under `auto` (`ReleaseQuality.LanguagePreference`).
- The work's original language: `GrabService.LanguageWantAsync` reads `Work.OriginalLanguage` (ISO 639-1) and falls back
  to the TMDB catalog lookup. English means an untagged non-anime release passes, another known language leaves it Unknown, and no original language at all falls back to Pass.
