# Audio language plan (BUG-U, OPS-522)

Status: plan only. Nothing here is built yet. Phase 2 waits for critique.

Owner, 1 Oct: "frieren episodes downloading chinese audio. mushoku tensei getting french audio... seems we do need
ffmpeg to check such details before we download right? or we can check the titles of the files themselves?"

Short answer: no ffmpeg. The release name and file list catch most cases before anything downloads. The first piece
of the video file holds the track list (language, default flag), and a small built-in reader covers the rest.

## 1. Evidence

### 1.1 Owner instance (http://127.0.0.1:3930, build 2ecab67, GET only)

- `/api/history` has all 28 Frieren S01 grabs, sent 30 Sep 18:54 to 18:56 UTC, all from nyaa:
  - S01E01 to E18: `Sousou.no.Frieren.S01Exx.Hulu.1080p.AV1.OPUS.SHQ.Dual.Multi[HR]`
    (E01 hash `f39ca0c36ce6aa33aeb92422d0999ff46707cdd4`, nyaa.si/view/1749208). The uploader's page lists Audio 01
    Japanese, Audio 02 English, and SRT subtitles in many languages, Chinese among them.
  - S01E19 to E28: `[Judas] Sousou no Frieren (...) - S01Exx [1080p][HEVC x265 10bit][Multi-Subs] (Weekly)`
    (E19 nyaa.si/view/1768170). Japanese audio; subtitles Eng/Fre/Ger/Ita/Spa/Por/Rus/Ara.
- None of these finished on 3930. There is no Frieren completion notification, the engine table and
  `/api/client/torrents` are empty, and `D:\Torrents` has no Frieren file or .torrent. With the engine row gone,
  `TitleService.Reconcile` (TitleService.cs:76-81) marks every Frieren target "The requested file is no longer
  available". So their real track headers can't be read.
- Neither the instance's database (copied, read-only) nor `/api/activity` has any Mushoku Tensei grab. The owner
  saw that one somewhere else: an older or other instance, or a file in `D:\Torrents` left by one.

### 1.2 Files in `D:\Torrents` (MKV header read, read-only, first 1 MiB)

| File | Audio tracks (in order) | Subtitles | Verdict for an English speaker |
|---|---|---|---|
| `Ive Been Killing Slimes ... S02E11 MULTi AD 1080p CR WEB-DL AAC2.0 x264-Tsundere-Raws.mkv` | **fre (fr-FR), default** · jpn "Japan" · fre "Descriptive" | fre forced, fre, fre CC | French plays; no English subtitles at all |
| `... S02E12 MULTi 1080p CR WEB-DL AAC2.0 x264-Tsundere-Raws.mkv` | **fre (fr-FR), default** · jpn "Japan" | fre forced, fre, fre CC | same |
| `[Erai-raws] Digimon Beatbreak - 42 (REPACK) [...][MultiSub]` | jpn (ja) | en first, then pt-BR, es-419, es, ar, fr, de, ru | fine |
| `[GSF] Katainaka no Ossan Kensei ni Naru II - 05 [WEB 1080p]` | jpn (ja) | es-419 only | Japanese audio, Spanish subtitles only |
| `[HorribleSubs] Tensei Shitara Slime Datta Ken - 01 [1080p]` | jpn | untagged (Matroska default: eng) | fine |
| `Practical Magic 1998 ... BONE.mkv` (both cuts) | eng | eng, eng SDH, dut | fine |
| `Rick And Morty S09E01 720p HDTV H264-JFF.mkv` | eng | none | fine |
| `S02E08 Interdimensional Cable 2 Tempting Fate.mkv` | untagged x2 (Matroska default: eng) | untagged | fine |

(S02E10 of the Slimes show, Futurama S01E01 and two Scorpion files are unfinished: their first MiB is zeros.)

This is the French complaint, proven. In French-scene naming, "MULTi" means French plus the original. In these files
the French track comes first and has the default flag (absent flag = on), so every player opens it in French.
Switching to the Japanese track doesn't help either, because the only subtitles are French.

In every sample the Tracks element sits 0.3 to 4.4 KiB into the file, before attachments (fonts) and the first
cluster. The first piece of a torrent always holds it.

### 1.3 What the QA instances picked for Mushoku Tensei (database copies)

- anime-live, twice: `Mushoku Tensei Jobless Reincarnation S03E14 SUBFRENCH 1080p CR WEB-DL AAC2.0 H.264-Tsundere-Raws (VOSTFR, ...)`
  (Japanese audio, French subtitles only, same French group).
- Also picked: `[Yameii] ... S03E01 [English Dub]`, `[Erai-raws] ... [Multiple Subtitle] [ENG][POR-BR]...[FRE]...`,
  `[ToonsHub] ... 1080p BILI WEB-DL ... (Multi-Subs)`, `[Doomdos] ... [1080p IQ WEB-DL]`, `... x265-MeGusta`.

### 1.4 What a real Frieren search returns (owner's cached search, 238 results)

nyaa categories: 22 "Anime - English-translated", 12 "Anime - Non-English-translated", 10 "Anime - Raw". Families
that nothing stops today:

- Chinese platforms and groups: `[Feibanyama] ... IQIYI WebRip 2160p` (up to 1358 seeders), `[ToonsHub] ... BILI WEB-DL`,
  `[AUTISM] ...` listing "汉语" (Chinese).
- French: `Tsundere-Raws ... VOSTFR` (654 seeders), `VARYG ... CR WEB-DL MULTi ... (Multi-Audio, Multi-Subs)`,
  `Sousou.No.Frieren.S01.MULTi.1080p.BluRay.x265-KAF`.
- Many `Dual Audio` releases (Japanese plus English).

Trap seen in real names: `Multi-Subs`, `MultiSub` and `Multiple Subtitle` are subtitles, not "MULTi" audio, and
`[HR]`'s `Dual.Multi` means dual audio plus many subtitles.

### 1.5 Frieren "Chinese audio": what we can and can't say

By name and uploader description, both Frieren releases 3930 sent have Japanese audio. Neither finished (1.1), so
the headers can't be checked. Three explanations remain, and the plan covers all of them:

1. The owner saw a different download (another instance). Frieren results include Chinese-platform releases with
   high seeder counts, and nothing in the code would refuse them. Section 1.7 shows which single episodes other
   instances got in other languages, and why.
2. A Chinese subtitle track was the default in the `[HR]` files (they carry Chinese subtitles), so the player showed
   Chinese text. Layer 2 records the default audio and subtitle tracks, so the next case leaves evidence.
3. The uploader's description is wrong. Layer 2 reads the real tracks, so the description stops mattering.

Question for the owner, when back: which file was it, and was it the voices or the subtitles?

### 1.6 A western show hits the same traps (owner instance, rechecked after the 1 Oct 11:40 UTC restart)

The download folder on 3930 is `D:\Torrents`, so the Frieren files really are gone, and there are still 0 transfers.
History shows a Scorpion S01E01 ladder that has repeated since 30 Sep 19:15 UTC: 67 sends by 1 Oct 12:18 UTC, all
failed on "Couldn't get this release's file list from peers". Each cycle walks these candidates. The order shifts a
little as sources and seeders change:

- `Scorpion.S01E01.Pilot.1080p.x265.{Yabkal_mc}.mp4`
- `Scorpion S01E01 1080p WEBRip x264-xRed`
- `SCORPION (2014) S01E01 x264 (WEB-DL) 1080p nlsubs TBS` (Dutch subtitles)
- `Scorpion S01E01 1080p HDTV [G2G]`
- `Scorpion.S01E01.Pilot.1080p.WEB-DL.DD5.1.H.264-BS[rarbg]` (bitsearch) and `...-BS[rartv]` (apibay)
- `天蠍 Scorpion.S01E01.Pilot.1080p 英語繁中.mkv` (English audio, Traditional Chinese subtitles), sixth in every cycle
- `Scorpion.S01E01.MULTi.1080p.WEB.x264-CiELOS` (several audio tracks, default unknown), sent last in every cycle since
  apibay results appeared at 1 Oct 06:57 UTC, including after the restart

If any of these had returned a file list, nothing would have stopped it on language. The only language check is the
anime "dub" word.

This adds three traps for the marker table (3.1):
- `英語`, `英语` and `英配` name **English** audio inside an otherwise Chinese name.
- For a title whose preference is English, `繁中`, `简中` and `中字` are subtitles, maybe burned in, so that release is a
  backup, not a clash.
- `nlsubs` is Dutch subtitles, not Dutch audio. Same rule: a backup, not a clash.

### 1.7 Which episodes diverged, and why (owner detail, 1 Oct 15:00 local)

Owner: only some episodes came in another language, not whole seasons, and Frieren E28 is one of them.

**3930: nothing diverged in language.** All 28 Frieren S1 episodes were sent once each, on demand from nyaa, between
18:54:30 and 18:56:38 UTC on 30 Sep, before A2. None finished (1.1). There is no Mushoku Tensei anywhere on 3930: no
title, target, grab, history row or cached search.

| Episodes | Release (nyaa) | Audio, by name and uploader |
|---|---|---|
| E01 to E18 | `Sousou.no.Frieren.S01Exx.Hulu.1080p.AV1.OPUS.SHQ.Dual.Multi[HR]` | Japanese + English |
| E19 to E28 | `[Judas] Sousou no Frieren (...) - S01Exx [1080p][HEVC x265 10bit][Multi-Subs] (Weekly)` | Japanese |

E28 (`ffc9f924...`) matches E19 to E27. The group still changes at E19, for a reason that applies to every show:

- HR named E19 `...SHQ.2A.Multi[HR]` (288.4 MiB) instead of `Dual.Multi`. `AnimeAudio.Preference` knows only the
  words "sub" and "dual", so HR's E19 drops to rank 1, and the smallest rank-0 release, Judas `Multi-Subs`, wins.
- HR has no E20 to E28 on nyaa (checked live), so Judas stays the smallest seeded rank-0 1080p release. For E28 today
  the order is Judas 352.2 MiB, DKB 584.8 MiB, VARYG and NanDesuKa 1.4 GiB, LostYears 2.9 GiB, ZeroBuild 3.0 GiB.

Each episode is its own pick. The group changes whenever names, sizes or seeders change, and nothing checks that the
new group uses the same language. On 3930 both groups happen to be Japanese.

**Where single episodes did come in another language (QA instance database copies):**

- dupgrab, 28 Sep 00:07 to 00:19 UTC, a build from before a863a9b. Frieren S1 was mostly `Kitsune DUAL` from
  torrentscsv, with LostYears for E22 and E27. The odd ones out:
  - E11 and E28: `[Yameii] ... [English Dub]`
  - E12: `... [Hindi Japanese English French German Po...]` (multi-audio, default unknown)
  - E18: `Tsundere-Raws VOSTFR`
  - E20: ToonsHub `[Multi-Audio] MSubs`

  That build ordered by seeded, then resolution equal to the floor, then `Score ?? Seeders` descending, with no
  language check. Whichever group had the most seeders for that one episode won.
- anime-live, 28 Sep 09:18 to 10:16 UTC, a build between a863a9b and 8777f46:
  - Frieren E05: `Tsundere-Raws MULTi (CUSTOM) (VOSTFR, VF, ...)`, French default audio (the shape proven in 1.2)
  - Frieren E28: `... S01E28 VOSTFR ... -Tsundere-Raws (CR).mkv`, French subtitles only
  - Mushoku S03E14: Tsundere `SUBFRENCH`; S03E01: Yameii English Dub

**Mechanism 1: the curly apostrophe (Frieren, proven).**

- The catalog's English title is `Frieren: Beyond Journey’s End`, with U+2019. `EpisodeLadder` builds the
  preferred-quality, exact and mapped-absolute rungs from it unchanged (`cursor.Query(primaryTitle)`), and the
  adapters send it as is (`TorrentAdapters.EncodeUriComponent`).
- nyaa matches U+2019 literally. I checked all 28 episodes live (`evidence\nyaa-curly-rung-s1.txt`):
  - For 26 episodes the curly query returns nothing.
  - For E05 and E06 it returns exactly one release,
    `Frieren - Beyond Journey’s End S01E0x MULTi 1080p ... -Tsundere-Raws (CUSTOM) (VOSTFR, VF, ...)`.
  - Tsundere-Raws copies the Crunchyroll title, curly apostrophe included. English-subtitle groups write `'` or drop
    it: the same E28 query with `'` returns 8 releases (ToonsHub, ZeroBuild, LostYears, Yameii, Judas, ...).
- anime-live's rung diagnostics show the effect. Its only rung was the curly exact title:
  - E05: nyaa 1 (that Tsundere MULTi) and torrentscsv 3; the Tsundere release was sent.
  - E28: nyaa 0, apibay 1, torrentscsv 6; torrentscsv's `Tsundere-Raws VOSTFR` was sent.
  - Other episodes got other groups. That is "only specific episodes".
- On main, the mapped romaji rung (`Sousou no Frieren S01E28`) runs first, so the curly rungs run only when that rung
  is missing or nothing in it sends. It is missing for 5 minutes after a failed AniList mapping lookup, because a null
  mapping is cached (AniListEpisodeMapping.cs:65). Then E05 and E06 fall into the same trap.
- Mushoku's English title has no apostrophe. Its French picks (1.3) come from mechanism 2 and the missing language
  check.

**Mechanism 2: falling down the list (every title, code).**

- The ladder sends the first candidate of the first rung that has any. After a failed send it tries the next
  candidate, then the next rung, with no cap (GrabService.cs:185-232; a hash is never resent). On 3930, Scorpion
  S01E01 walked 67 sends this way (1.6). So when one episode's usual group can't hand over its file list in time,
  that episode goes to the next release in line, in whatever language.
- E28 today, in order:
  1. The first rung's rank-0 releases (Judas, DKB, VARYG, NanDesuKa, LostYears, ZeroBuild).
  2. Its rank-1 releases: EMBER, `Tsundere-Raws VOSTFR` (26 seeders) and NanDesuKa.
  3. The curly rungs: torrentscsv's Tsundere VOSTFR, KAWAII, MeGusta.
  4. `Sousou no Frieren - 28` and `葬送のフリーレン - 28`. These return mostly Chinese fansub releases
     (`❀拨雪寻春❀ 简繁日内封`, `DBD-Raws 简繁日双语`, `喵萌奶茶屋 繁日/简日双语`): Japanese audio with Chinese
     subtitles, some burned in, which reads as "Chinese" on screen.
  5. The all-category rungs.
- Background hunts drop the seeder minimum on every rung (GrabService.cs:174-175, called from AutomationService.cs:190),
  so near-dead releases on the lower rungs count too.

**Mechanism 3: A2 and E28/E29 (code and live results).**

- A2 (764562e, 1 Oct 01:31 UTC) came after every recorded pick (3930 on 30 Sep 18:54, the QA runs on 28 Sep), so it
  explains none of them.
- It doesn't move E28: season 1 has offset 0, and the first rung is still `Sousou no Frieren S01E28`.
- From E29 (TMDB S2E01) the rungs are `Sousou no Frieren S02E01`, `... 2nd Season - 01`, `- 29`,
  `葬送のフリーレン 第2期 - 29` and `S01E29`, then all categories. Live (`evidence\nyaa-e29-rungs.txt`):
  - `Sousou no Frieren S02E01` (27 results): EMBER Dual Audio (366.0 MiB) wins today on the word "Dual". The next by
    size are French audio: `[T3KASHi] ... MULTi ... (VF, VOSTFR)` 386.6 MiB and `...MULTi...-KAF` 471.6 MiB, with
    Tsundere MULTi (VF) at 1.4 GiB. One failed send stands between the first season 2 episode and French audio.
  - `Sousou no Frieren - 29` (24): Chinese fansubs dominate, for example `喵萌奶茶屋 [29][1080p][繁日雙語]` 765.9 MiB
    (burned-in Chinese), its `简日双语` twin, `喵萌奶茶屋&LoliHouse - 29 [简繁日内封字幕]` and
    `悠哈璃羽字幕社 [CHT][繁體內嵌]`, plus a Greek one, `[Greek-Nakama] S2 - 01`. `第2期 - 29` returns only
    `❀拨雪寻春❀` Chinese-subtitle releases.
  - Chinese groups number season 2 from 29, as A2's absolute rungs do, so they are the main source once the S02E01
    rung is used up.

**One signal that would have caught all of it on nyaa.** In these lists, every wrong-language nyaa release
(Tsundere-Raws, T3KASHi, KAF, the Chinese and Greek fansubs) is in nyaa's "Non-English-translated" category (1_3).
Every English-subtitle one is in "English-translated" (1_2). That category is stored on every result
(`TorrentAdapters.cs:129`) and never read.

**The owner's E28.** It wasn't 3930's: there, E28 is Japanese by name and never finished. Two QA instances did get a
wrong-language E28 (dupgrab: English dub; anime-live: French subtitles). The other possibility is the owner's main
install, which I must not touch. See open question 9.

## 2. Root cause in code

1. **No language gate on automatic picks.**
   - `GrabService.Eligible` (Library/Features/Grabs/GrabService.cs, ~line 287) filters on quality floor, sources and
     constraints, plus `AnimeAudio.Allowed`. That check only refuses anime names containing the word "dub".
   - `MULTi`, `VOSTFR`, `SUBFRENCH`, `国语`, `CHS/CHT/BIG5`, `Baha`, `ITA/GER/SPA/RUS/Hindi` and French groups all pass.
   - Films (`FilmSelection.Select`) have no language check at all.
2. **The order doesn't know language.**
   - `PreferRequestedQuality` sorts by seeded, then distance from the wanted resolution, then non-remux, then smallest
     size, then seeders. `EpisodeLadder.Select` sends the first.
   - For anime, `AnimeAudio.Preference` then moves names with `sub`/`Multi-Subs`/`Dual` up.
   - So a seeded 1080p release in the wrong language wins on size alone. That's why `[HR]` won Frieren: an AV1 encode
     (small) with a `Dual` marker.
3. **Two half rules for one concept (DRY).**
   - `AnimeAudio` (dub word only) and `ReleaseQuality.Describe`'s `LanguagePreference` disagree.
     `LanguagePreference` scores French words 0, scores `eng`/`english`/`dual audio`/`dub` 2 (a dub counts as good,
     even for anime) and knows no Chinese, Italian, German, Spanish, Russian or Hindi.
   - Its x800 weight in `ReleaseRanking.Rank` is smaller than two seeder doublings, and the ladder doesn't use that
     order anyway.
4. **Nothing reads the files.**
   - The engine checks the file list for programs and missing video (`MediaFileRules`), and the finished file for being
     real video (`CompletedMediaValidator`). Neither looks at track languages.
   - `MediaProbe` (table and entity) exists but nothing uses it.
5. **The one dub setting is hidden.** `AutomationOptions.PreferAnimeDub` is an appsettings key, not a setting the
   owner can see.
6. **Each episode is picked alone (1.7).**
   - No pick looks at the group its sibling episodes got. Each ladder orders by the keyword rank, then size, then
     seeders, so a name change (`[HR]` "Dual" to "2A") or a size change switches groups.
   - The English-title rungs keep the catalog's curly apostrophe. nyaa then returns only releases that copy it, which
     for Frieren means Tsundere-Raws (French) for E05 and E06 and nothing for the other episodes.
   - A failed send moves to the next candidate, then the next rung, with no cap and no language check. The absolute
     and native-title rungs (`- 28`, `葬送のフリーレン - 28`, and under A2 `- 29` and `第2期 - 29`) return mostly
     Chinese fansub releases. The season 2 `S02E01` rung has French `MULTi` releases right behind the dual-audio ones.
   - nyaa's category ("Non-English-translated", "Raw") is stored on every result (`TorrentAdapters.cs:129`) but never
     read.
7. **Nothing records which rung won.** `GrabJob.Query` holds the episode's display query (GrabService.cs:408), and
   the rung appears only in a Debug log line (GrabService.cs:209-215). So after the fact nobody can tell how an odd
   episode was found.

## 3. Design

### 3.1 One language rule: `ReleaseLanguage` (new, `server/TorrentFlow.Core/ReleaseLanguage.cs`)

It sits next to `MediaFileRules`, `ReleaseResolution` and `ReleaseEpisodeParser`, so Search, Library and Engine all
use the same code. It replaces `AnimeAudio` (deleted) and `ReleaseQuality`'s `LanguagePreference` (now derived from
it).

```
LanguageFacts Detect(string name, IEnumerable<string>? filePaths = null, string? sourceCategory = null)
LanguageFacts FromTracks(IReadOnlyList<MediaTrack> tracks)              // Layer 2 header facts
LanguageWant  Want(string preference, string? mediaType, string? originalLanguage)
LanguageFit   Judge(LanguageWant want, LanguageFacts facts)             // Preferred | Neutral | Backup | Clash(reason)
string        Label(string reasonCode)                                  // "audio_fr" -> "French audio"
```

- `LanguageFacts`: audio languages (named or implied), whether the default audio is known, subtitle languages,
  `NoSubtitles` (raw), `HardSubbed`, `Dub`, `DualAudio`, `MultiAudio`.
- `LanguageWant`: the preferred audio, the accepted backup audio, and whether non-English audio needs English
  subtitles.

**The rule (default, "auto"):**

| Title | Preferred audio | Accepted as backup (ranked last) | Refused (clash) |
|---|---|---|---|
| Anime | Japanese, with English subtitles | English dub | any other audio language; Japanese audio whose subtitles are known and none is English (foreign-only subs, raws) |
| Everything else | English | the title's original language (TMDB `original_language`, already on the catalog), with English subtitles | any other audio language |

- **"english"**: English is preferred everywhere. The original language (Japanese for anime) is the backup.
- **"any"**: no language checks. This is the old behaviour, minus the dub word check.

Why the original language is a backup outside anime: "English for everything else", read literally, would refuse
the Korean audio of a Korean drama or the Spanish audio of a Spanish series, even when that is all there is. The
complaint was about a third language (a French dub of a Japanese show). Open question 3 asks the critic.

**Name markers (Layer 1).** One table in `ReleaseLanguage`, word-bounded, case-insensitive, with CJK matched as text:

| Marker | Means | Notes and traps |
|---|---|---|
| `JPN`, `JAP`, `Japanese`, `日语`, `日配` | Japanese audio | ToonsHub writes `JPN` before the audio codec |
| `Dual Audio`, `Dual-Audio`, `DUAL`, `Dual.Multi`, `2A`, `(Japanese, English Dubs)` | original + English audio | `[HR] ... Dual.Multi` is dual audio + multi subs; `[HR]` writes `2A` from E19 on (1.7) |
| `dub`, `dubbed`, `English Dub`, `EngDub`, `英配` | English audio (anime) | unchanged meaning, now a backup instead of refused |
| `Multi-Subs`, `MultiSub`, `Multiple Subtitle`, `Multi Sub` | subtitles incl. English (assumed) | never "MULTi audio" |
| `[ENG]`, `ENG`, `English`, `英語`, `英语` with no dub/audio word | English subtitles (anime), English audio (other) | Erai-raws lists sub codes in brackets after `Multiple Subtitle`; `天蠍 Scorpion ... 英語繁中` is English audio (1.6) |
| bracket code lists after a subtitle marker (`[POR-BR][SPA][ARA][FRE][GER][ITA][RUS]`) | subtitle languages | not audio |
| `MULTi` (scene token, not followed by sub/subs) | several audio tracks, default unknown | backup rank; Layer 2 decides. Becomes French audio with a French marker or group |
| `FRENCH`, `TRUEFRENCH`, `VFF`, `VFQ`, `VFI`, `VF`, `VF2`, `VOF` | French audio | |
| `VOSTFR`, `SUBFRENCH`, `VOST`, `Sub FR` | original audio, French subtitles only | anime: clash "French subtitles only"; other: backup |
| groups `Tsundere-Raws`, `KAF` | French release groups: `MULTi` = French default audio, else French subs | proven by the headers in 1.2 |
| `国语`, `國語`, `普通话`, `中配`, `国配`, `台配`, `Mandarin` | Chinese (Mandarin) audio | |
| `粤语`, `粵語`, `Cantonese` | Chinese (Cantonese) audio | |
| `CHS`, `CHT`, `GB`, `BIG5`, `简体`, `繁體`, `简中`, `繁中`, `中字`, `简日`, `繁日`, `中文字幕`, `内嵌`, `內嵌`, `内封`, `字幕组`, `字幕組`, `字幕社` | Chinese subtitles (`内嵌`/`內嵌` = burned in) | `GB` only as a bracketed token, never inside a size such as `1.4GB`; `繁日雙語`/`简日双语` are bilingual subtitles, not dual audio (1.7); with English audio they make the release a backup, not a clash |
| `[Baha]`, `Bahamut`, `[ANi]` | Japanese audio, burned-in Chinese subtitles | anime: clash "Chinese subtitles only" |
| `iTALiAN`, `ITA` (not after `SUB`) | Italian audio | `SUB ITA` = Italian subtitles |
| `GERMAN`, `German DL`, `GER` (not in a sub list) | German audio (`DL` = German + original) | `GerSub` = subtitles |
| `SPANiSH`, `Castellano`, `Latino`, `LAT`, `ESP` | Spanish audio | `VOSE` = Spanish subtitles |
| `RUS`, `Russian`, `MVO`, `DVO`, `AVO` | Russian audio (voice-over) | `Rus Sub` = subtitles |
| `nlsubs`, `NLSub`, `NL Subs` | Dutch subtitles | not Dutch audio; with English audio a backup, not a clash (1.6) |
| `HiNDi`, `Hindi`, `Tamil`, `Telugu` | Indian-language audio | `Dual Audio [Hindi-English]` contains English, so it is a backup, not a clash |
| `POLiSH`, `Lektor`, `Dubbing PL`, `Dublado`, `KOREAN`, `TURKISH`, `ARABIC` | that audio | `Legendado` = Portuguese subtitles |
| `RAW` token, nyaa "Anime - Raw" | Japanese audio, no subtitles | anime: clash "no subtitles" |
| nyaa "Anime - Non-English-translated" | subtitles not in English | anime: clash "no English subtitles" unless the name shows English subtitles |
| `IQIYI`, `iQ`, `BILI`, `B-Global`, `CR`, `AMZN`, `NF` | platform only | neutral: names alone don't tell, Layer 2 decides |

- **Order.** `Eligible` keeps the quality order and then stable-sorts by fit: Preferred 0, Neutral 1, Backup 2.
  Neutral means no marker; most English-sub fansubs (SubsPlease) and most western scene names are neutral. Clashes are
  removed. For anime this keeps today's "sub/Dual first" behaviour, generalised.
- **Reasons.**
  - Each refused candidate gets a reason code (`audio_fr`, `audio_zh`, `audio_it`, `audio_de`, `audio_es`, `audio_ru`,
    `audio_hi`, `audio_other`, `subs_fr`, `subs_zh`, `subs_other`, `no_subs`). It goes in the same list as
    `below_floor`, so `GrabFailure.Explain` reads "40 results: 22 other episodes, 9 French audio, 4 Chinese subtitles
    only".
  - Only the first reason counts, so a French release of another episode still counts as "other episodes".
  - `dub_not_preferred` goes away.

### 3.2 Layer 1b: the file list, at the engine (after metadata)

- `EngineAddRequest` gains `Language` (`LanguageWant?`).
  - `GrabService.Send` sets it for automatic picks: episode ladder, season pack, film, release swap.
  - Hand picks (`SendPicked`, the search page, manual adds) leave it null, so the owner's own choice is never refused.
- In `TorrentEngineService.AddAsync`, right after the existing `FileListProblem` refusal and before admission:
  - `ReleaseLanguage.Detect(name, keptFilePaths)` reads video file names (pack episodes often carry more tags), folder
    names, sidecar subtitles (`.fr.srt`, `.chs.ass`, `.eng.srt`) and sidecar audio (`.fre.mka`).
  - A clash returns `EngineAddResult(false, message) { Unusable = "audio_language", Language = "audio_fr" }`. No
    engine row is created, like the program-file refusal.
- `GrabService.Send` maps `Unusable == "audio_language"` to the candidate's reason (`audio_fr`) instead of
  `send_failed`. The ladder already moves to the next candidate after a failed send.

### 3.3 Layer 2: read the track list from the first piece

Where: `TorrentEngineService.AddAsync`, after Layer 1b passes and before admission. It runs only when `Language` is
set, the preference is not "any", and the main kept video is `.mkv`, `.mp4` or `.m4v`. Other containers pass,
unchecked.

**Main video.** The largest kept video file. For a season pack, the first kept episode only: one probe per pack.

**Cache.** Look up `MediaProbes` by (InfoHash, FilePath) first. The table exists and is unused, so no migration is
needed. Store `Container`, `StreamsJson` (audio and subtitle tracks: language, default, forced, name), `ProbeVersion`
and `ProbedAt`. A later hunt that meets the same release reuses the result with no network. Unchecked outcomes are
not stored, so they can be retried.

**Fetch, bounded.**

- New backend call: `ITorrentBackend.OpenProbeAsync(byte[] torrent, int fileIndex, ct)` returns a reader with
  `ReadAsync(offset, count)`.
- `MonoTorrentBackend` builds it from a short-lived manager under `<EngineDirectory>\probe\<hash>`:
  - Every other file is set to DoNotDownload.
  - MonoTorrent's in-order piece requester (`AddStreamingAsync` + `StreamProvider.CreateStreamAsync`, the pattern
    removed with OPS-479) fetches only the pieces covering the bytes asked for.
  - Afterwards the manager is removed with its data and the probe folder deleted.
  - This is a bounded read into memory, never playback. Nothing is served or opened (see open question 6).
- Budget, as engine options:
  - `AudioProbeTimeoutSeconds` = 45.
  - `AudioProbeMaxBytes` = 16 MiB of payload received, checked against the manager's received-bytes counter.
  - The probe is skipped when one piece is larger than 8 MiB.
  - A `_probeGate` allows 2 probes at a time, like `_metadataGate`.

**Read.** A new `MediaTracks` reader in `server/TorrentFlow.Engine/Layout/`, beside `ContainerSniffer`, which already
tells Matroska from ISO media.

- **MKV.**
  - Walk EBML, then Segment, then its top-level children until `Tracks` (`0x1654AE6B`); stop at the first `Cluster`.
  - If `SeekHead` places `Tracks` beyond the bytes read, ask for that range within the budget.
  - Per `TrackEntry` (`0xAE`): `TrackType` (`0x83`: 2 audio, 17 subtitle), `Language` (`0x22B59C`, Matroska default
    `eng`), `LanguageBCP47` (`0x22B59D`, wins when present), `FlagDefault` (`0x88`, default 1), `FlagEnabled`
    (`0xB9`, default 1), `FlagForced` (`0x55AA`), `Name` (`0x536E`).
  - Track names such as "Japan" or "Descriptive" are kept for the record.
- **MP4.**
  - Read the top-level boxes. If `moov` comes after `mdat`, the `mdat` size gives its offset; ask for it within the
    budget, otherwise the file is unchecked.
  - For each `trak`: `hdlr` (`soun`, `sbtl`/`text`/`subt`), `mdhd` packed ISO-639-2/T language (`0x55C4` = `und`),
    `elng` when present, `tkhd` enabled flag.
  - The default audio is the first enabled audio track.

**Verdict.** `ReleaseLanguage.Judge(want, FromTracks(tracks))`, the same function as for names:

- The **default audio track** decides: the first enabled audio track with the default flag, else the first audio
  track. Players open that one, as the Tsundere-Raws files show.
- Default audio in the preferred or backup set: pass. Untagged, `und`, `mul` or `zxx`: pass, since we can't tell.
- Default audio in another known language: clash (`audio_fr`), even if a Japanese track exists further down.
- If the default audio is not English and the subtitle tracks are tagged but none is English: clash (`subs_fr`,
  `no_subs`). Erai-raws passes (en first). GSF (es-419 only) and Tsundere-Raws (fre only) are refused.
- Untagged subtitles count as `eng`, the Matroska default.
- Timeout, no peers, too-large pieces, an unknown container or a parse error: pass, unchecked, logged. A probe never
  blocks a download on its own failure.

**Refusal.** The same path as Layer 1b:

- The engine returns `EngineAddResult(false, "This release plays French audio, so TorrentFlow didn't download it.")
  { Unusable = "audio_language", Language = "audio_fr" }`.
- The ladder records "French audio" for that candidate and takes the next one.

**Not in this change (open question 7).** Running the same reader again on finished files in
`CompletedMediaValidator.ValidateAsync`, which already reads the head. It would catch releases whose probe timed out,
but it would throw away a whole finished download.

### 3.4 The setting

- `ClientSetting.AudioLanguage` (string, null = `auto`), plus an EF migration `AddAudioLanguage`.
- `SettingsClientController`: GET `audioLanguage` (~line 68, returns `auto` when null). PUT (~line 217) accepts
  `auto | english | any`; anything else gives 400 "Choose one of the audio language options."
- `GrabService.Prepare` reads it with the settings it already loads. `ReleaseLanguage.Want(setting, input.MediaType,
  catalog original language)` builds the want once per grab.
- `AutomationOptions.PreferAnimeDub` is removed (the owner's appsettings don't set it; checked during
  implementation). `docs/one-pipeline.md:27` is updated.
- Web, `web/src/app/settings/page.tsx`: a new `RadioGroup` fieldset (`data-audio-language`) beside "Minimum download
  quality" (~line 809), same shadcn pattern, saved with the form. Copy (plain words, no dashes):
  - Legend: **Audio language**
  - `auto`: **Japanese for anime, English for the rest**. "Anime comes with English subtitles. An English dub is used
    only when nothing else is found."
  - `english`: **English**. "Pick English dubs first, anime included."
  - `any`: **Any language**. "Don't check the language."
  - Help line: "Before downloading, TorrentFlow checks the release name, its file list and the start of the video,
    and skips other languages. Shows made in another language can also come in their original language with English
    subtitles."

### 3.5 What the owner reads

| Where | Text |
|---|---|
| Wanted / Activity detail (existing "What we saw") | "40 results: 22 other episodes, 9 French audio, 4 Chinese subtitles only" |
| Everything clashed (`GrabFailure.WrongLanguage`, code `audio_preference`, already a real miss) | "We only found season 3, episode 14 in other languages." / "Pick a release yourself, or change the audio language in Settings." Brief: "only had releases in other languages" |
| Engine refusal (Downloads / Activity) | "This release plays French audio, so TorrentFlow didn't download it." / "This release only has Chinese subtitles, so TorrentFlow didn't download it." |
| Pick a release yourself (`ReleasePicker` `Why`) | a note per row: "French audio", "Chinese subtitles only", "English dub"; nothing is hidden |

Labels: French, Chinese, Italian, German, Spanish, Russian, Hindi, Japanese, English; "another language" otherwise.

### 3.6 Code map

| File | Change |
|---|---|
| `TorrentFlow.Core/ReleaseLanguage.cs` | new: the one rule (markers, want, judge, labels) |
| `TorrentFlow.Library/Features/Grabs/AnimeAudio.cs` | deleted |
| `TorrentFlow.Library/Features/Grabs/GrabService.cs` | `Eligible` (fit filter and order), the reasons loop (~205), `Send` (pass `Language`, map `audio_language`, store the rung and verdict on the `GrabJob`), `Prepare` (read the setting) |
| `.../Grabs/EpisodeLadder.cs` | plain apostrophes in rung queries (3.7) |
| `TorrentFlow.Core/Text/Apostrophes.cs` | new: the one apostrophe helper; `TorrentFlow.Metadata/Title/AnimeFranchiseService.cs:145` uses it too |
| `TorrentFlow.Data/Entities/GrabJob.cs` | `Rung`, `Language` (same migration as `AudioLanguage`) |
| `.../Grabs/GrabService.Pack.cs`, `FilmSelection.cs`, `ReleaseSwapService.cs` (~95), `ReleasePicker.cs` | the same fit; films count language in `Summarize`/`Explain` |
| `.../Grabs/GrabFailure.cs` | `ReasonLabel` via `ReleaseLanguage.Label`, `WrongLanguage` replaces `DubOnly`, `FromCandidates` |
| `TorrentFlow.Search/ReleaseQuality.cs`, `ReleaseRanking.cs` | `LanguagePreference` derived from `ReleaseLanguage` (search page order only) |
| `TorrentFlow.Core/Contracts/Engine/ITorrentEngine.cs` | `EngineAddRequest.Language`, `EngineAddResult.Language`, `Unusable` doc gains `audio_language` |
| `TorrentFlow.Engine/TorrentEngineService.cs` | Layer 1b and Layer 2 after `FileListProblem`, `_probeGate` |
| `TorrentFlow.Engine/Client/ITorrentBackend.cs`, `MonoTorrentBackend.cs` | `OpenProbeAsync` |
| `TorrentFlow.Engine/Layout/MediaTracks.cs` | new: the MKV/MP4 track reader, using `ContainerSniffer` |
| `TorrentFlow.Data/Entities/ClientSetting.cs` + migration | `AudioLanguage` |
| `TorrentFlow.Engine/Controllers/SettingsClientController.cs` | GET/PUT `audioLanguage` |
| `TorrentFlow.Library/Features/Automation/AutomationOptions.cs` | `PreferAnimeDub` removed |
| `web/src/app/settings/page.tsx` | the Audio language fieldset |
| `docs/one-pipeline.md`, `docs/todo-list.md` (row 35), `docs/api-open-file.md` ("Checking downloads") | describe the language check |

### 3.7 Per-episode drift (1.7)

The language rule (3.1 to 3.3) removes the harm. A refused release is never sent, so falling down the list can't land
on another language. These changes remove the causes and keep the evidence:

- **Plain apostrophes in queries.** `EpisodeLadder` turns `’` and `‘` into `'` in every title it queries with,
  through one new helper, `TorrentFlow.Core/Text/Apostrophes.cs`. `AnimeFranchiseService` (line 145), which does the
  same replacement inline today, uses it too. The English-title rungs then find what nyaa lists under
  `Journey's End`, instead of only Tsundere-Raws.
- **Read nyaa's category.** `ReleaseLanguage.Detect` already takes `sourceCategory` (3.1). For anime,
  "Non-English-translated" and "Raw" are a clash unless the name shows English subtitles. So the wrong-language nyaa
  releases in 1.7 are refused even when their names alone are unclear.
- **Record the winning rung.** `GrabJob` gains `Rung` (kind and query, for example
  `mapped-season: Sousou no Frieren S01E28`) and `Language` (the verdict and its basis: name, files or header). Both
  go in the `AddAudioLanguage` migration, and `/api/activity` returns them. There is no new screen.
- **Not in this bug:** keeping a season with one group (open question 10).

## 4. Proof (no unit tests)

Instance:

- Build and publish to `D:\code\memtest\audiolang\app`, run on port 3987.
- Data copied from `D:\code\memtest\stable\data` without downloads; download folder `D:\code\memtest\audiolang\dl`,
  set before first start; `TMDB_API_KEY` from the brief's key file.
- No copyrighted payload is ever downloaded. Real titles are only searched or listed. Anything that downloads uses
  legal open-movie payloads.

Fixtures (outside the repo, in `D:\code\memtest\audiolang\fixtures`):

- MKVs made from CC-BY open movies (Sintel, Tears of Steel). A small Python header editor rewrites only the `Tracks`
  element (languages, default flags, an extra audio entry) and absorbs the size change in the `Void` that follows it,
  so the rest of the file is untouched.
- Shapes: jpn+en subs; Tsundere shape (fre default, jpn second, fre subs); zh default; jpn+es-419 subs only;
  untagged; eng only; MP4 with `moov` first and last.
- They are served by a local Torznab feed (a custom source on my instance) and a local tracker plus seeder
  (python-libtorrent in a venv under `memtest\audiolang\tools`).
- Release names are crafted, for example `[X] Sousou no Frieren - 01 [1080p] MULTi -Tsundere-Raws`. The extra local
  ports are to be confirmed by the orchestrator, since the brief assigns only 3987.

| # | Proves | How | Pass when |
|---|---|---|---|
| P1 | Setting API | GET/PUT `/api/settings/client` `audioLanguage` | default `auto`; each value round-trips; `french` gets 400 with the plain message |
| P2 | Setting UI | Playwright at 390/768/1280: pick each option, save, reload | screenshots; choice persists; no clipping |
| P3 | Name layer on real results | `GET /api/title/{workKey}/releases` (the picker list, sends nothing) for Mushoku Tensei S3E14, Frieren S1E5, Slimes 300 Years S2E10, Scorpion S1E1 (the 1.6 ladder), Practical Magic 1998, Squid Game S1E1 | Tsundere, VOSTFR, KAF, Baha/CHT rows carry the right note; ladder order puts a Japanese+English-subs release first for anime, puts the Scorpion `英語繁中`, `nlsubs` and `MULTi` rows after the plain English ones without refusing them, and keeps Korean audio as a backup for Squid Game |
| P4 | Ladder, name clash | fake feed: Tsundere-shape name (most seeders), then a neutral name with a jpn+en payload | Tsundere refused with "French audio" in the wanted detail; the neutral one downloads |
| P5 | Ladder, header clash | fake feed: neutral name with fre-default payload (most seeders), then a jpn+en one | probe refuses the first ("French audio"), no engine row, probe folder gone, bytes received under the cap (log); the second downloads; a second hunt reuses the `MediaProbes` row (no new probe in the log) |
| P6 | Subtitles rule | jpn + es-419-only payload | refused "Spanish subtitles only"; with `english` it is still refused (audio not English, no English subs) |
| P7 | Untagged and timeouts | untagged payload; then seeder stopped | untagged passes; offline probe gives up at 45 s, the grab continues unchecked, log says so |
| P8 | Settings switch | P4 with `any`, then with `english` plus an `[English Dub]` row | `any` takes the Tsundere-shape release; `english` takes the dub first |
| P9 | Films and packs | film feed with `FRENCH`/`iTALiAN` names; pack feed with a `.fr.srt`-only file list | refused at the name or file layer; detail counts them |
| P10 | Owner screens | Playwright at 390/768/1280 of Wanted and Activity after P4/P5 | the "9 French audio" style text shows and reads plainly |
| P11 | No regressions | hand-pick the Tsundere-shape release; search page lists all rows | the hand pick downloads (the owner's choice); search still shows French rows |
| P12 | One season, one language | `GET /api/title/{workKey}/releases` (sends nothing) for Frieren S1 E04 to E07, E18, E19 and E28; once normally, once with the AniList metadata source switched off on my instance so the romaji rung is missing | in both runs each episode's first row has Japanese audio with English subtitles; `[HR] 2A` counts as dual audio; Tsundere-Raws rows say "French audio" or "French subtitles only" and are never first |
| P13 | Plain apostrophes | Debug log of the rung list, and the recorded `Rung`, for Frieren S1E05 and E28 | queries read `Journey's End`; the E28 English-title rung gets the English-subtitle releases the straight-apostrophe search returns (8 today) |
| P14 | Falling down the list | fake feed for 4 episodes of one show; for one episode the Japanese release's seeder is offline (no file list), and that episode also has a Tsundere-shape `MULTi` and a neutral Japanese release | the ladder moves past the failed send to the neutral Japanese release; the Tsundere one is never sent ("French audio" in the detail); all 4 episodes end Japanese |
| P15 | Season 2 under A2 | picker list for Frieren S2E01 on real results; a fake feed with only a French `S02E01 MULTi` and a Chinese `- 29 [繁日雙語]` release | real list: a dual-audio or English-subtitle release first, T3KASHi/KAF/Tsundere rows say "French audio", 喵萌奶茶屋/悠哈璃羽 rows say "Chinese subtitles only". Fake feed: nothing sent; the wanted detail says "We only found season 2, episode 1 in other languages." |
| P16 | Evidence kept | `/api/activity` after P4, P5 and P14 | each grab shows its rung and language verdict |

## 5. Open questions for the critic

1. **Default track rule.** Refuse when the default audio is French even though a Japanese track exists (MULTi)?
   Recommended: yes. The headers prove players open French, and the subtitles are French too.
2. **Foreign-only subtitles and raws for anime.** Refuse or rank last? Recommended: refuse. Without English subtitles
   the episode can't be followed. English-subbed releases of a simulcast appear within hours, the wanted queue keeps
   looking, and the owner can still hand-pick.
3. **Outside anime, the original language as a backup** (TMDB `original_language`) rather than a refusal.
   Recommended, so Korean or Spanish originals still download.
4. **English-only file for anime found by the header.** Accepted as the backup (no deferral). Names marked as dubs
   already rank last. Deferring to "try every other candidate first" needs a fallback list in the ladder.
5. **Probe cost.** Every automatic pick is probed once (cached per hash and file), at about 2 to 20 s and at most
   16 MiB. A 28-episode season means 28 probes behind a gate of 2. Alternative: probe only anime, or only names
   Layer 1 calls neutral or backup.
6. **rules.md says "No in-app playback or streaming".** The probe borrows MonoTorrent's in-order piece requester for a
   bounded read only. Confirm that this is in bounds.
7. **Safety net on finished files.** Leave it out (recommended for now), or add it to `CompletedMediaValidator`?
8. **Default subtitle language.** Record it only (recommended), or also refuse when a non-English subtitle track is
   the default? That second rule might explain the Frieren report (open with the owner).
9. **Which install had the owner's E28?** 3930's E28 is Japanese by name and never finished. If it was the main
   install (port 3000), may someone read its Frieren history (GET only) to confirm the release? Was it the voices or
   the subtitles (1.5)?
10. **One group per season.** Should a pick prefer the group the season's other episodes already have, after the
    language fit? Recommended: not in this bug. The language rule removes the harm, and sticking to one group would
    override the quality order.
11. **Apostrophe fix in this bug?** Recommended: yes. It's small, and it is one of the root causes for Frieren E05
    and E06.
