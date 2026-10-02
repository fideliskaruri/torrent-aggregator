# Release language

How TorrentFlow decides whether a release's language fits what the owner wants, and what the grab ladder does about
it. The design is in `docs/audio-language-plan.md`; this page describes what the code does.

## The owner's rule: English audio or English subtitles

"Pick the best torrent but make sure it has English audio or subtitles." Every release gets one English verdict from
`ReleaseLanguage.EnglishRule` (carried on `LanguageVerdict.English` as an `EnglishCheck(Verdict, Reason, Evidence)`):
**Pass**, **Unknown** or **Fail**. The automatic picks, the release picker, the Find another source dialog and the
engine's check after add all read this one verdict; nothing keeps a second copy.

Evidence, strongest first: the video's own tracks (the header probe, or an indexer's track list), English sidecar files of
that video (`.en.srt`, `.eng.ass`, `Subs/2_English.srt`), name markers (`Dual Audio` reads as Japanese and English audio
for anime, English elsewhere), nyaa's English-translated category, then known groups. English subtitles always means a
track that carries the dialogue: an English track named "Signs", "Songs" or "Forced" never counts, while a forced flag
alone doesn't rule a track out (see "Track roles and sidecars" below). In order:

1. Preference `any`: Pass.
2. English audio (an English dub, dual audio): Pass. Once the header has listed audio tracks, only the header or the
   files can claim English audio.
3. The header was read, lists audio, has no untagged subtitles and no English subtitles: Fail. When its only English
   subtitle tracks are signs or forced, the reason says so (`The file has Japanese audio and English signs and songs
   only`).
4. English subtitles known (name, category, sidecar, header, indexer): Pass. Ambiguous English with subtitles not known
   to be another language: Pass.
5. Foreign audio that is not the work's original language, on one track: Fail (a Russian MVO).
6. Not anime, nothing stated, and the work's original language is English: Pass. Another known language: Unknown. Not known: Pass (the old heuristic).
7. Several audio tracks with subtitles not known: Unknown.
8. Raws (no subtitles): Fail. Foreign-only subtitles (VOSTFR, CHT): Fail. Mixed: Unknown. Every subtitle track listed
   (an indexer, or a header without audio tags) and the only English ones signs or forced: Fail. Anything else:
   Unknown, "English not stated".

Within a verdict the fit still orders releases (`ReleaseLanguage.Order` = verdict, then fit): for anime under `auto`,
Japanese audio with English subtitles (Preferred) comes before an English dub (Backup); `english` flips that.

## Automatic picks: Pass first, Unknown only without a healthy Pass, never Fail

- `GrabService.Eligible` orders each rung by quality, then `ReleaseLanguage.Order`.
- The ladder (`GrabService.Episode`, `Film`, `SeasonPack`) sends only Pass releases, in rung order and rank. A failed
  send still falls through to the next candidate, then the next rung. A release the engine refuses for its files
  (`audio_language`) counts as Fail (`LanguageHold.Refused`).
- Unknown releases are held across all rungs (`LanguageHold`). After the last rung they are sent, most seeders first,
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

## Track roles and sidecars

Every audio and subtitle track the judge reads is kept on the verdict as a `TrackFact` (`LanguageFacts.Tracks`): kind,
language (`LanguageTag.Normalize`), name, forced and default flags, the source (`header` for the header probe, `indexer`
for a site's track list such as AnimeTosho, `file` for a sidecar) and, for subtitles, a role (`ReleaseLanguage.Role`).
The name beats the forced flag:

- **Commentary**: a name saying commentary or audio description (`Commentary`, `Director's Commentary`, `English (Audio
  Description)`), flagged or not, checked before every other role: a commentary track is never the dialogue. An audio
  track (or an external audio file) so named makes no audio language claim either: an English commentary beside
  Japanese audio is not English audio.
- **Forced**: a name saying forced (`Forced`, `English (Forced)`, `Latin American (Forced)`, `Foreign parts only`),
  flagged or not. MP4 tx3g tracks have no forced flag, so their name decides.
- **SignsSongs**: a name saying signs or songs (`Signs`, `Songs`, `S&S`, `Signs & Songs`, `English[Signs]`, `English Signs
  [CR]`, `Lyrics`, `Karaoke`, `OP/ED`).
- **Full**: a name saying dialogue, full or captions (`Dialogue`, `Full`, `Full Subtitles`, `English[CC]`, `SDH`, `English
  Closed Captions [CR]`), flagged or not, which wins over signs words (`Dialogue & Signs`); and any other name: plain
  `English`, `English / English(US)`, a source or group (Erai-raws names its English track `CR`, ASW `English subs`).
- **Unknown**: no name at all.
- **The forced flag on a track whose name says nothing about its role** (plain `English`, or no name) only marks the
  forced track when another track of its language carries the dialogue: two tracks named `English`, one forced, make the
  forced one Forced and the other Full. With no such track beside it the flag is a display hint, since players show
  forced tracks by default: SubsPlease flags its one English track forced. That track counts as Full at slightly lower
  confidence (`TrackFact.ForcedHint`; the English check's evidence is `ExplicitSubs` instead of `HeaderFact`). The
  video's sidecar files count as tracks beside it.

English subtitles are an English track that carries the dialogue (`TrackFact.EnglishSubtitles`):

1. any English track that isn't flagged forced and isn't named signs, songs, S&S, forced or commentary counts as full;
2. otherwise an English track whose name doesn't say signs, songs, S&S, forced or commentary counts as full, its forced
   flag read as a display hint, at slightly lower confidence (this covers SubsPlease, and also a plain `English` flagged
   forced next to a `Signs` track: the name beats the flag);
3. otherwise, when every English track is named signs, songs, S&S, forced or commentary, there are no English subtitles
   ("The file has Japanese audio and English commentary subtitles only").

A signs, songs, forced or commentary track is kept as a fact but never makes a subtitle language claim. A track tagged `und` or
untagged takes its language from its name (`English`, `Eng`, `英語`, `Inglés`, `Anglais`, `Englisch`, `Español`, `Japanese
(SDH)`; `ReleaseLanguage.NameLanguage`); with no telling name it stays unknown and keeps the verdict open. Once a file's
subtitle tracks are listed (by its header, or by an indexer), each with a language, they replace whatever the name, the
site category or a group says about subtitles; burned-in subtitles are the exception. Burned-in means a hard-sub marker
in the name (`Hardsub`, `HARDSUBS`, `HardSubbed`, `hardcoded subs`, `hard-subbed`, `HC`, `Baha`, `内嵌`; `LanguageFacts.HardSubbed`):
no track list can show those subtitles, so the name's subtitle claims survive the header, and `English Hardsub` with
Japanese audio and no subtitle track passes. A bare `Hardsub` names no language, so it only keeps a weak English guess
that a header without English still fails.

Sidecar files get the same roles from the words after the base name: `.commentary.` is Commentary, `.forced.` and
`English (Forced).srt` are Forced, `.signs.` SignsSongs, `.sdh.` Full, and `Show - 05.en.ass` or `2_English.srt` (no role
words) count as English subtitles.

**One judge.** `ReleaseLanguage.Verdict(want, name, sourceCategory, files, tracks)` takes one video's path and its own
sidecars (`files`) plus the tracks read from it, and returns the verdict with its English check. `JudgeRelease` runs it
for each main video of a file list (the selected ones, else the largest and any at least half its size), each with only
its own sidecars and tracks; the worst counts. The engine's file-list check and header probe, the season pack check,
the picker, the swap dialog and the search order all come through it, and so will the gate on the finished files.

**The sidecar closure.** `VideoSidecars.Of(video, files)` returns the subtitle and audio files that belong to one video in
a torrent's file list, and nothing else (paths compare in Unicode NFC, so a name written decomposed still matches):

- the same base name beside it or in a folder below it: `Show - 05.mkv` with `Show - 05.en.ass`, `Show - 05.eng.srt`,
  `Show - 05.en.forced.srt` or the external audio `Show - 05.mka` (never `Show - 10.en.ass` for `Show - 1.mkv`); or the
  same episode (`SeasonPackFiles.EpisodeKey`: S01E05, 1x05, or an absolute `- 05`, `[05]`, `E05`) when no other video is
  that episode: `Show.S01E05.en.srt` for `Show.S01E05.1080p.WEB.mkv`, `[Grp] Show - 05.en.ass` for `[Grp] Show - 05
  [1080p][CRC].mkv`;
- a folder below it named after it or its episode: `Subs/Show.S01E05.1080p.WEBRip.x265-RARBG/2_English.srt`,
  `Subs/S01E05/English.srt`;
- when no other video sits in its folder or below it, every file in that folder or in a `Subs` folder right in it:
  `Pack/01/Subs/English.srt` for `Pack/01/Show.S01E01.mkv`;
- when it is the torrent's only video, every other subtitle and audio file, wherever it sits: `Subs/2_English.srt`,
  `Subs/3_English.srt` (RARBG and YTS films). Every video counts, however small (a featurette, a second episode), so a
  film with a featurette gets no top-level `Subs/English.srt`; only a sample (`MediaFileRules.IsSample`: `sample` in the
  file name, or a `Sample` folder) is excepted.

A file named for another video, or for another video's episode, is never its own.

A selected episode is judged with its own closure only, so an unselected episode's English sidecar can no longer pass a
foreign selected one. A season pack's selection (`GrabService.SeasonPack`) adds each claimed episode's closure, so its own
subtitles and external audio download and are kept with it; the layout already moves subtitles next to their video. Once
a pack's episode files are mapped, the pack's call is the worst of its episodes, each judged with its own closure; the
name alone decides only when no file maps (a `VOSTFR` pack whose episodes carry English sidecars passes). The search
still never probes a pack whose name alone fails.

**The picker and the swap dialog** label each release with the same judge, reading the header tracks the engine kept for
that release (`MediaProbeTracks`, the MediaProbe table), and the transfer's own files (each main video with its closure)
for the release being replaced.

Real track lists, judged as indexer tracks for anime under `auto`: `org` is feed.animetosho.org (`files[].attachments[]`
of type subtitle), `xyz` is feed.animetosho.xyz (`files[].info.mediainfo`, every audio and text track with its title,
language, default and forced flags; the two sites number releases differently). `main` is what main 7047530 decided
from the same tracks:

| Release (site id) | English subtitle tracks: name, forced flag, role | main | Now |
| --- | --- | --- | --- |
| `[EMBER] Frieren: Beyond Journey's End S02E01 [1080p] [Dual Audio HEVC WEBRip DDP]` (org 745796) | `Signs` SignsSongs (default); `Dialogue` Full | English subtitles | English subtitles (Dialogue) |
| `Frieren Beyond Journeys End S02E01 ... MULTi AAC2.0 H 264-VARYG` (org 741310) | `Forced` forced, Forced; no name, Unknown (default) | English subtitles | English subtitles (the unnamed track) |
| `[Judas] Sousou no Frieren (Season 02) [1080p][HEVC x265 10bit][Dual-Audio][Multi-Subs] (Batch)`, `Frieren - S02E01v2.mkv` (xyz 603237) | `English` Full; `English[CC]` Full; `English[Signs]` SignsSongs | English subtitles | English subtitles (and English audio) |
| `[Ironclad] Frieren: Beyond Journey's End - S02 (BD 1080p AV1)`, `S02E01` (xyz 630440) | `English (Forced)` forced, Forced; `English` Full (default); `English (Signs & Songs)` SignsSongs | English subtitles | English subtitles (and English audio) |
| `[SubsPlease] Tensei Shitara Ken Deshita S2 - 01 (720p)` (xyz 693000) | `English` forced (default), the only English track and Japanese audio: Full, flag read as a display hint | English subtitles | English subtitles, evidence `ExplicitSubs` |
| `[Judas] Hokuto no Ken (2026) - S01E07 [Dual-Audio][Multi-Subs]` (org 764685) | `English` forced, Forced; `English` Full | English subtitles | English subtitles |
| `[Ironclad] Dorohedoro - S02E08 (WEB 1080p AV1) (Multi-Audio, Multi-Subs)` (org 763971) | `English (Forced)` forced, Forced; `English` Full; `English (SDH)` Full | English subtitles | English subtitles |
| `[YukiSubs] Sousou no Frieren - 29 (S02E01) (WEB 1080p HEVC EAC-3)` (org 754053) | none; one Turkish track | no English | Fail: Turkish subtitles only |
| `[Erai-raws] Snowball Earth - 06 [1080p CR WEBRip HEVC AAC][MultiSub]` (org 764673) | `CR` Full | English subtitles | English subtitles |
| `[ToonsHub] KILL BLUE S01E04 1080p AMZN WEB-DL MULTi DDP2.0 H.264` (org 764608) | no name, Unknown; `SDH` Full | English subtitles | English subtitles |
| `[ASW] Kamiina Botan, Yoeru Sugata wa Yuri no Hana - 05 [1080p HEVC x265 10Bit][AAC]` (org 764652) | `English subs` Full | English subtitles | English subtitles |
| `[Yameii] SNOWBALL EARTH - S01E06 [English Dub] [CR WEB-DL 1080p H264 AAC]` (org 764549) | `English Signs [CR]` SignsSongs | English subtitles | Tracks alone: Fail, English signs and songs only; with the name: Pass, English dub |
| `For Whom The Alchemist Exists 2019 SUBFRENCH 1080p CR WEB-DL ... -Tsundere-Raws` (org 761589) | `United States` Full | English subtitles | English subtitles |

Header track lists (the header probe's shape; the name `[EMBER] ... [Multi-Subs]` claims English subtitles and is
overridden once the tracks are listed):

| Header tracks | main | Now |
| --- | --- | --- |
| Japanese audio; English `Signs` only | English subtitles | Fail: The file has Japanese audio and English signs and songs only |
| Japanese audio; English `Signs` and `Dialogue` (the real EMBER header also has English audio) | English subtitles | Pass: English subtitles |
| Japanese audio; only `English (Forced)`, flagged or not, or `Forced` in an MP4 with no flag | English subtitles | Fail: ... English forced subtitles only |
| Japanese audio; only `English` (or an unnamed English track) flagged forced | English subtitles | Pass: English subtitles, evidence `ExplicitSubs` |
| Japanese audio; two `English` tracks, one flagged forced | English subtitles | Pass: English subtitles (the unflagged one; the flagged one is Forced) |
| Japanese audio; `Dialogue` flagged forced | English subtitles | Pass: English subtitles (the name says full) |
| Japanese audio; `Signs` plus `English` flagged forced | English subtitles | Pass: English subtitles, evidence `ExplicitSubs` |
| Japanese audio; `Signs & Songs` plus `English (Forced)` | English subtitles | Fail: ... English signs and forced subtitles only |
| Japanese audio; `English` flagged forced plus a full French track | English subtitles | Pass: English subtitles, evidence `ExplicitSubs` |
| Japanese audio; `und` subtitle named `English`, `英語` or `Inglés` | name decides | Pass: English subtitles |
| Japanese audio; `und` subtitle, no name, plain release name | name decides | Unknown: English not stated |
| Japanese audio; only `Commentary` (or `Director's Commentary`, `English (Audio Description)`, a `.en.commentary.srt` sidecar) | English subtitles | Fail: ... English commentary subtitles only |
| Japanese audio; `Commentary` plus `English` | English subtitles | Pass: English subtitles |
| Japanese audio plus an English audio track named `Commentary` | English audio | Fail: The file has Japanese audio and no English subtitles |
| `[Group] Show - 01 [English Hardsub]` (or `ENG.HARDSUBS`, `English hardcoded subs`, `English hard-subbed`, `HC` with `ENGSUB`): Japanese audio, no subtitle track | English subtitles, then Fail once the header was read | Pass: English subtitles, evidence `ExplicitSubs` |
| `[Group] Show - 01 [English Subs]` (soft): Japanese audio, no subtitle track | English subtitles, then Fail | Fail: The file has Japanese audio and no English subtitles |

Closure cases (`VideoSidecars.Of`; b3decc8 is the first E1 commit):

| Files | Video | b3decc8 | Now |
| --- | --- | --- | --- |
| `Movie.2020/Movie.2020.1080p.mkv` 8 GB, `Movie.2020/Featurettes/Making.Of.mkv` 300 MB, `Movie.2020/Subs/English.srt` | the film | `Subs/English.srt` | none (two videos) |
| the same with `Sample/movie.2020.sample.mkv` instead of the featurette | the film | `Subs/English.srt` | `Subs/English.srt` (a sample is excepted) |
| `Pack/01/Show.S01E01.mkv`, `Pack/01/Subs/English.srt`, `Pack/02/Show.S01E02.mkv`, `Pack/02/Subs/English.srt` | episode 1 | none | `Pack/01/Subs/English.srt` |
| `Show.S01/Show.S01E0{1,2}.1080p.WEB.mkv`, `Show.S01/Subs/S01E0{1,2}/English.srt` | episode 2 | none | `Subs/S01E02/English.srt` |
| `[Grp] Show - 0{1,2} [1080p][CRC].mkv`, `[Grp] Show - 0{1,2}.en.ass` | episode 2 | none | `[Grp] Show - 02.en.ass` |
| `Pokémon - 01.mkv` (NFC), `Pokémon - 01.en.ass` (NFD), `Pokémon - 02.mkv`, `Pokémon - 02.en.ass` | episode 1 | none | `Pokémon - 01.en.ass` |
| `[Grp] Show S01 VOSTFR 1080p`: each episode with `.en.srt` and `.fr.srt` (season pack check) | episodes 1, 2 | Fail: French subtitles only (the name) | Pass: English subtitles (each episode's closure) |

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

- `Detect(name, sourceCategory, files)` reads the facts. `Verdict(want, name, sourceCategory, files, tracks)` is the one
  judge: it reads one video and its own sidecars (`files`) plus that video's tracks (`WithTracks`) and judges them.
  `JudgeRelease` runs it per main video of a file list. `Judge(want, facts)` judges facts read elsewhere.
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
| HeaderFact | the file's own audio and subtitle tracks (the header probe after add), or the same tracks as an index read them before download (AnimeTosho, "Hints before download") | `jpn`, `eng` tracks |
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

## Hints before download

What an index says about a release's files, before anything downloads (`docs/english-gates-plan.md`, section 3). A hint
feeds the same rule through `ReleaseLanguage.Verdict(want, name, category, hint)`: each main video is read like the
header probe reads a file, its own tracks through the shared `WithHeader` and `Judge`, plus, in a torrent with one main
video, its subtitle and audio files through `WithSidecars`; the worst one counts. A hint only orders releases and lets an
automatic pick skip one that clearly has no English. It never passes a release at the files' own check: the engine's
file-list and header checks (and the coming gate on the finished files) run as before.

- A hint Fail is a language hold like a name Fail (`subs_tr` for Turkish-only subtitles, `no_subs`, ...): never sent
  automatically, counted for "Waiting for an English release". A hint Pass moves an Unknown name up to Pass, so it is
  sent before Unknown releases. No hint: the name verdict, as before.
- Held Unknown releases are judged again before the ladder sends them: a hint that arrived meanwhile (a later rung's
  search found it cached) keeps a no-English one back.
- The grab ladder, the release picker, Find another source (`ReleaseSwapService`) and the search page order all read it.
  The activity log's language column names the index: `pass (English subtitles): English subtitles (preferred, header, animetosho)`.
- The release picker and Find another source show the language label plus "from AnimeTosho" or "from file list"
  (`ReleaseLanguageInfo.Hint`). Requesters never see release rows.

| Source | Lookup | Evidence | Applies to |
| --- | --- | --- | --- |
| AnimeTosho | `feed.animetosho.org/json?show=torrent&btih=<hash>` | each file's subtitle tracks (language, name, default, forced), and audio tracks from `info.mediainfo` when present, as `MediaTrack` with `Source = "indexer"`; judged like header facts | releases AnimeTosho or nyaa (English-translated, 1_2) listed; a cached answer counts for any site that lists the same hash |
| apibay | `apibay.org/f.php?id=<TPB id>` | file names: `.en.srt`, `Subs/English.srt`, `2_English.srt` | releases TPB listed (the adapter keeps the TPB id as `SiteId`, even when another site's listing of the same hash was kept); only torrents with one main video |

Track names and forced flags are kept on the tracks (`MediaTrack.Name`, `Forced`), so the track-roles rule (a "Signs"
or "Forced" English track is not full English subtitles) applies to hints as soon as the shared judge has it.

Fetching (`LanguageHints`, `server/TorrentFlow.Search/LanguageHints.cs`):

- Runs beside the tracker scrape, for the top 8 candidates per source by the current ranking. A search waits at most
  3 seconds for them; an interactive search with no anime candidates waits only while the scrape runs, so film searches
  don't get slower. A missing or slow hint is no hint; lookups still running finish in the background and fill the cache
  for the next search (the ladder's next rung, the wanted queue's retry, the picker).
- One cache, the `ReleaseHint` table (source, key, state, files, attempts, retryAt). `complete` answers are kept for
  good: a hash's files never change. An item AnimeTosho is still processing, or a lookup that failed after it was sent,
  is `pending` and asked again after 2 minutes; one it doesn't have (404), one it skipped (it never processes those) or
  apibay's "Filelist not found" is `missing` and asked again after 10 minutes; each answer in a row doubles the wait, up
  to a day. A lookup still waiting in the site's line when its time ran out records nothing.
- Polite: one line per site for hint lookups, starts at least 1 s apart for AnimeTosho (up to 3 open, it answers in
  about 2 s) and 2 s for apibay (one at a time). With the sites' own search pacing (1 s and 2 s) that stays at about
  2 requests a second to AnimeTosho. Requests go through `IndexerHttp` with the adapters' user agent, so a 429 or a 503
  with Retry-After cools the site for searches and hints alike; a lookup during a cool-down is simply no hint.
- At most 16 lookups wait in one site's line; past that a candidate gets no hint this time. A source turned off in
  Settings is not asked.
- AnimeTosho stopped processing new items in May 2026 and says its feed will shut down. Episodes released after that
  come back `missing` and are asked again with backoff; older episodes keep working from the cache.

## The engine's check after add

`TorrentEngineService` checks a transfer's English again once it knows more than the name. The request's
`EngineLanguageCheck(Want, NameFit, NameLabel, AcceptClash)` is kept with the engine row as `EngineLanguageState`
(column `languageCheckJson`: want, release name, site category, hand pick, state and reason).

- **Before admission**, when the `.torrent` bytes are known (a `.torrent` link, a cached file, a season pack):
  `FileListLanguage` judges the main videos (the selected files, else the largest and any at least half its size), each
  with only its own subtitle and audio files (`ReleaseLanguage.JudgeRelease`, `VideoSidecars.Of`); the worst verdict
  counts. A Fail (or an
  explicit-audio clash, `Refusable`) is refused unless it is a hand pick: `Unusable = "audio_language"`, `Language =
  <code or no_english>`, message `Its files have no English audio or subtitles (...), so TorrentFlow skipped it.`
- **Once a magnet's metadata arrives**, the monitor tick runs the same file-list check on the live file list, right
  after `FileListProblem` (the client still holds the transfer at that point). State `pending` becomes `failed`,
  `passed` (confirmed English: subtitles or audio stated explicitly) or `probing`. The check also runs for a transfer
  that finished before the tick saw it, and a finished transfer is not parked or laid out while its state is
  `pending` or `probing`: it stays loaded until the check settles.
- **Header probe**: what the file list leaves open goes to a bounded queue (8 entries, one worker). The worker reads
  the headers of up to 3 main videos in a probe client of its own (`ProbeHeadersAsync(..., alongside: true)`,
  `HeaderProbeBudget.Default`: 45 seconds, 32 MB per file), saves the tracks to `HeaderProbeCache` (rows in the
  `MediaProbeTracks` shape), and judges each read video with its own sidecars and header tracks
  (`ReleaseLanguage.JudgeRelease`, track roles applied). Only a finished probe settles it: Pass becomes `passed`, Fail
  becomes `failed`.
  A partial probe (one file read, another timed out), anything else, a timeout, no peers, a full queue or a probe that
  throws becomes `unconfirmed`, once, with the reason. Shutting down is not a failure: a restart requeues rows left
  in `probing` that load again. A finished row (parked or downloaded) that does not load again has its `pending` or
  `probing` check settled once at startup as `unconfirmed` ("check interrupted"); nothing is downloaded again. A parked
  row still loaded (its detach failed) is checked before it is detached and laid out.
- **A fail** (file list or header) on a transfer still downloading: the row turns to an error (`No English audio or
  subtitles (<reason>). TorrentFlow stopped it and will look for another release.`), the release is blocked
  (`ReleaseBlock`, reason `no_english`, origin `language_check`), its wanted items are released, and the transfer is
  detached. The finder picks again and skips the blocked release. The stopped release's files stay in the downloads
  folder until the row is removed, like any failed download. A fail that lands on a transfer already parked or in
  the library (which the tick does not allow while probing) keeps its files and only blocks the release.
- **Unconfirmed**: kept; `EngineTorrentInfo.LanguageNote` is `English not confirmed` and the Downloads row shows it.
- **Hand picks** (`AcceptClash`) are stored as `hand_pick` and never checked, stopped or blocked.
- Every check logs one Information line (`[builtin-engine] language check ...`, `English check ... from its file
  list`, `English header check ...`, which lists each track's kind, language, name and role).

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
  `unknown`, `fail`) and `englishReason`; `basis` may be `indexer` for an indexer's track list.
- The picker (`GET /api/title/{workKey}/releases`) and the Find another source dialog order by the English verdict,
  then fit, then the shared score (`ReleaseSwapService.Rank(..., first: ReleaseLanguage.Order)`), and hide nothing.
  Blocked releases go last in both, and neither a blocked nor a Fail release is ever the Best match. "Find the best
  one for me" (`SwapBest`) takes that same Best match; with only blocked or Fail releases left it says no better
  release was found. The dialog judges the current release with its site
  category (kept with the engine row, else read from the search when the same release turns up). A hand pick always
  sends.
- The search page orders by the same verdict under `auto` (`ReleaseQuality.LanguagePreference`).
- The work's original language: `GrabService.LanguageWantAsync` reads `Work.OriginalLanguage` (ISO 639-1) and falls back
  to the TMDB catalog lookup. English means an untagged non-anime release passes, another known language leaves it Unknown, and no original language at all falls back to Pass.
