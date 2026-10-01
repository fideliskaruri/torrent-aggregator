# Audio language plan (BUG-U, OPS-522) and Find another source (FEAT-30)

Status: plan only. Nothing here is built yet. Phase 2 waits for critique. Section 6 adds the owner-approved
"Find another source" feature (1 Oct 15:26), which uses the language rule from section 3.

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

## 6. Find another source (FEAT-30, owner approved 1 Oct 15:26)

The owner asked for five things:

- Rename "Find another release" to "Find another source".
- Offer it on finished films and episodes too, owner only:
  - the title page (film hero and episode cards);
  - Downloads (film rows and the series dialog's episode cards).
- A finished download keeps its files until the new one is Ready, then they are deleted.
- The replaced release is blocked server-side, so no automatic pick takes it again, and the picker shows why.
- Extend the existing alternatives endpoints and `ReleaseSwapDialog` without forking them. The dialog shows each
  alternative's audio and subtitle languages from Layer 1.

Tracking: FEAT-30, plan task OPS-526. Bugs found on the way are in 6.8.

### 6.1 How Sonarr and Radarr do it

Read from their source (`develop` branches, 1 Oct). Paths are relative to `src/NzbDrone.Core/` unless they start
with `frontend/`.

**Language: names and tags before the download, file contents only after.**

- **Where it comes from.** Before a grab, the language comes from the release name, plus a `language` attribute
  when a Newznab or Torznab indexer sends one (`Indexers/Newznab/NewznabRssParser.cs`, `GetLanguages`).
- **How names are read.** `Parser/LanguageParser.cs` matches words (`japanese`, `chinese`, `french`) and tags
  (`FRENCH`, `TRUEFRENCH`, `VFF`, `ita`, `german`, `rus`). It keeps one language list per release, so audio and
  subtitles aren't told apart:
  - `[CHS]`, `[CHT]`, `[BIG5]`, `[GB]`, `简`, `繁` and `字幕` ("subtitles") all count as Chinese.
  - `VOSTFR` and `MULTi` count as nothing, because the French tag needs a separator before `FR`.
  - German `DL` adds "Original"; `ML` adds Original and English.
- **Sonarr v4 scoring.** Custom formats score languages. A Language condition
  (`CustomFormats/Specifications/LanguageSpecification.cs`) gets a score in the quality profile, and the profile's
  minimum score rejects the rest. "Original" resolves to the series' original language, and the condition has
  "except" and negate options.
- **Radarr's profile language.** Radarr also has a profile language (Any, Original or one language) that rejects
  outright, for example "Original Language (Japanese) is wanted, but found French"
  (`DecisionEngine/Specifications/LanguageSpecification.cs`, a permanent rejection).
- **File contents.** These are read only once the file is in the library. `MediaFiles/MediaInfo/UpdateMediaInfoService.cs`
  probes files on import and rescan. That feeds display and file naming, never the grab.

**Blocklist and re-search.**

- **What a row holds.** The series, its episodes, the release name, quality, languages, indexer, size, publish date,
  info hash and a message (`Blocklisting/BlocklistService.cs`, `Block`).
- **How it matches.** A torrent matches by info hash, or by title and indexer when there is no hash. The match covers
  the whole series (`Blocklisted(seriesId, release)`).
- **Who writes it.**
  - Failed-download handling (`Handle(DownloadFailedEvent)`).
  - The owner's "Remove from queue", which offers "Do not blocklist", "Blocklist and search" and "Blocklist only"
    (`frontend/src/Activity/Queue/RemoveQueueItemModal.tsx`).
- **Re-search.** `Download/RedownloadFailedDownloadService.cs` searches that episode again, or the whole season when
  every episode failed. It skips this when the owner chose "Blocklist only" or turned the setting off. A separate
  setting covers grabs made from interactive search.
- **Who reads it.** `DecisionEngine/Specifications/BlocklistSpecification.cs` rejects the release permanently with
  "Release is blocklisted", so RSS sync, automatic searches and re-searches skip it.
- **Interactive search.** It still lists a blocked release, with the rejection in a red popover, and its grab button
  still works (`frontend/src/InteractiveSearch/InteractiveSearchRow.tsx`).
- **Lifetime.** Entries stay until removed on the Blocklist page. Deleting the series deletes them.
- **Upgrades.** The old file stays until the new one is imported, then goes to the recycle bin
  (`MediaFiles/UpgradeMediaFileService.cs`).

**What we adopt, and where we differ.**

| Idea | Sonarr / Radarr | Here |
|---|---|---|
| Language before download | name + indexer tag, one language list | name + nyaa category (Layer 1) with audio and subtitles kept apart, plus the header read (Layer 2), which they don't have |
| Ranking | a custom-format score the owner builds | the fixed fit order Preferred, Neutral, Backup, Clash (3.1) from a three-choice setting (3.4): the same idea as a score with fixed weights |
| Block on failure | yes, then re-search | a failed video check blocks the release; the wanted queue's existing retry is the re-search (6.4.5) |
| Block when the owner removes a release | "Blocklist and search" in Remove from queue | Find another source blocks the release it replaces; picking the new one is the search |
| Match | info hash, whole series | info hash, per user; work and episode stored for the text (6.4.5) |
| Hand pick of a blocked release | listed as rejected, still grabbable | listed last with the reason and "Use it anyway" (6.4.5) |
| Replacing a finished file | upgrade: old file kept until the new one is imported | old files kept until the new one is Ready (6.4.4) |

### 6.2 What exists today

- **The name.** "Find another release" appears in:
  - `release-swap-dialog.tsx:268` (dialog title);
  - `downloads/page.tsx:2395` (film row More menu);
  - `series-download-dialog.tsx:488` and `:492` (the failed episode's button and its aria-label), `:579` (episode
    More menu) and `:694` (the header's "Find another release for {episode}").

  Comments mention it in `types.ts:62`, `release-card.tsx:3` and `release-swap-dialog.tsx:2`. `inbox.ts` and the
  toasts never name it; the toasts say "Switched to {release}". The server names it once: `DownloadOpenController.cs:65`
  "Delete it, or find another release."
- **Unfinished downloads only.** `canFindAnotherRelease` (`release-swap-dialog.tsx:75-79`) hides it for finished rows
  and season packs. The server refuses finished rows twice:
  - `ReleaseSwapService.cs:39-40`: "This download is already complete, so there's nothing to replace."
  - `ReleaseSwap.cs:35-36`: "Only downloads that haven't finished can be replaced."
- **Downloads only.** The dialog takes a Downloads `ClientTorrent`, but uses only `hash`, `name`, `workTitle` and the
  health fields (`state`, `queuePosition`, `peers`, `dlspeed`). The title page has a transfer `infoHash` but no
  `ClientTorrent`.
- **The swap is immediate** (`ReleaseSwap.cs:12-103`). It:
  1. adds the new row;
  2. marks both hashes as tried in `ReleaseAttempts` (:67-70);
  3. moves every link (`CarrySwapLinks`, :131-156): the target (reset to queued at 0%), grab jobs, the watchlist
     and requests, plus a "Replaced {hash}" history row;
  4. hard-deletes the old row (:72);
  5. removes its partial files without a tombstone (:79-86).
- **Nothing blocks a release outside the swap.**
  - `ReleaseAttempts` (key `UserId, WorkKey, Scope, Hash`, no reason column) is read only by the swap
    (`ReleaseSwapService.cs:50, 64`, `ReleaseSwap.cs:39-41` "That release has already been tried.").
  - The engine refuses a hash that failed its video check only while that row still exists
    (`TorrentEngineService.cs:295`, `RefusedRelease` at :389).
  - The ladder's attempted set lasts one run (`GrabService.cs:178, 218`).
  - There is no blocklist table.
- **"Ready".** The engine parks a finished row with `VerifiedAt` (`TorrentEngineService.cs:1508-1527`). It then runs
  the video check and the layout (`FinalizeLayoutLockedAsync`, :1540-1547) and raises `TorrentCompleted`, an
  in-memory event (:1557-1562). A row that fails the check (`LayoutOutcome.Invalid` or `Unchecked`) gets no event.
  The title page reads "downloaded" from the target (`TitleService.cs:93-95`).
- **Files.** Releases share the season folder, and the layout step moves finished files into place. Deleting with
  files goes through an `EngineDeletion` tombstone that a worker retries across restarts
  (`TorrentEngineService.cs:1249-1307`, `DeletionCleanup.cs`). Open uses the row's manifest; on the title page the row
  is found by the target's hash (`DownloadOpenController.cs:59-72`).

### 6.3 Name and copy

- **The action** is **Find another source** everywhere it's offered: menu items, buttons, aria-labels ("Find another
  source for Episode 28"), the series dialog header ("Find another source for {episode}") and the dialog title.
- **"Site" for search sites.** Inside the dialog, "source" already means a search site ("Look on", "All sources",
  `?source=`). The site picker therefore says **site**:
  - "All sites" and "Searching all sites…";
  - "Picks the best one on {site, or any site} and switches to it.";
  - "No other releases on {site}" (unchanged);
  - the server's "That site is turned off or can't search this kind of title. Choose another site."
    (`ReleaseSwapService.cs:86`).

  Code names (`source`, `data-swap-source*`) stay.
- **Server messages that tell the owner what to do** say "find another source":
  - `DownloadOpenController.cs:65`;
  - `TorrentEngineService.cs:114, 434, 435, 521, 1497`;
  - `MonoTorrentBackend.cs:236`;
  - `GrabService.cs:437`.
- **Server messages that stay.** Messages that describe what TorrentFlow does ("Trying another release.", "TorrentFlow
  is looking for another release.") stay. `CompletedMediaValidator`'s two messages also stay, because
  `RefusedRelease` (`TorrentEngineService.cs:389`) compares them as text.
- **`inbox.ts`** needs no rename, because it never names the action. A replacement's completion reaches the inbox
  through the existing completed status.
- **Dialog copy that depends on the current download** (from `current` in the GET, 6.4.7):

  | Current download | Note under the buttons | After picking |
  |---|---|---|
  | Unfinished (today) | "Switching removes this release's partial files. Completed files and other downloads are kept." | toast "Switched to {release}" |
  | Finished | "Your current file stays until the new one is ready. Then TorrentFlow deletes it and won't pick that release again." | toast "Downloading {release}. Your current file stays until the new one is ready." |
  | Files missing | "The files are already gone. The new one takes this download's place when it's ready." | the same toast as Finished |
  | A replacement is already downloading | "A new source is already downloading for this: {release} ({progress})." The list can't be used. | none |

- **Current-download box.** For a finished row, the box shows the current file's languages in place of peers, speed
  and stall time: "Current release · Ready", then "Audio: Chinese (default), Japanese · Subtitles: Chinese" with
  "from the file" or "from the name".

### 6.4 Design

#### 6.4.1 Where it's offered (owner only)

One web helper, `canFindAnotherSource(subject)`, replaces `canFindAnotherRelease`. It requires the built-in client,
a hash, and not a season pack row (`packEpisodes`). Whether the download has finished no longer matters, so none of
the three different "finished" tests (6.8) feed it. Imported rows still get the server's 409, and the dialog says why
(today's behaviour).

| Place | Today | Change |
|---|---|---|
| Downloads, film row More menu (`page.tsx:2389-2397`) | unfinished only | also finished and Files missing rows |
| Series dialog, episode card More menu (`series-download-dialog.tsx:573-581`) | unfinished only | also finished and Files missing episodes |
| Series dialog, visible card button (:482-494) and header button (:679-696) | failed episodes | unchanged, so finished cards gain no extra button |
| Title page, film hero (`title-detail.tsx` action row, about :1219-1345) | none | an outline button **Find another source** after Open and Show in folder (after the status link while downloading). Shown when `caps.canDownload` and the film has a built-in transfer hash |
| Title page, episode card (`episode-list.tsx:563-886`) | none | a small More menu (`…`) with **Find another source**. Shown when `canDownload`, the card has a transfer hash and it isn't `fromPack`. Passed through the card's existing `onAction` prop, so the memoised card fetches nothing |

Episodes that came in a season pack are left out for now (open question 17).

#### 6.4.2 One dialog for both pages

- **Location.** `ReleaseSwapDialog` moves to `web/src/components/releases/release-swap-dialog.tsx`, beside
  `release-card.tsx` and `release-picker-dialog.tsx`, because two pages use it. It is a move, not a copy.
- **Props.** It takes a small subject instead of a `ClientTorrent`: `{ hash, workTitle?, label?, live? }`.
  - `live` holds the fields the Downloads page already has (`state`, `queuePosition`, `peers`, `dlspeed`).
  - The title page passes `{ hash, workTitle, label: "Episode 28" }`.
- **Content.** The description line and the current-download box come from the new `current` block of the GET
  (6.4.7), so the title page needs no Downloads data.
- **Title page.** It mounts the dialog once, in `TitleDetail`. `onSwapped` refetches `/api/title/{workKey}` and shows
  the toast.

#### 6.4.3 Unfinished downloads (unchanged)

Today's immediate swap stays, with two changes:

- It writes a block for the old hash instead of marking both hashes as tried (6.4.5).
- It copies `ReplacesHash` to the new row when the row it replaces was itself a pending replacement (6.4.4).

#### 6.4.4 Finished downloads: old files stay until the new one is Ready

**Gates.** The finished refusals go: `ReleaseSwapService.cs:39-40`, and `IsDownloaded(old) || live?.Progress >= .9999`
in `ReleaseSwap.cs:35`. The `Origin != User` refusal stays.

**Mode.** `SwapAsync` picks one of two modes:

- **Deferred**, when the old row is finished and its files are present.
- **Immediate**, otherwise: unfinished, or Files missing, where there is nothing to keep.

Deferred swap:

1. **Same checks as today.** The hash must match the magnet, the release must not already be in Downloads, and it
   must fit in storage. The storage check counts the old files plus the new reservation, since both exist for a
   while. If it doesn't fit, the owner reads "There isn't room for the new download while the current file is kept.
   Free up {size}, or delete the current download first." and nothing changes.
2. **New row.** Created as today (same folder, category, work, `QueueKey` and lane), plus a new column
   `EngineTorrent.ReplacesHash = old.Hash`. The old row stays Parked with its manifest.
3. **Links stay on the old hash** (target, grab jobs, watchlist, requests).
   - The title page keeps "Downloaded" and Open on the old file, and requests stay fulfilled.
   - The title payload gains `transfer.replacing { progress, state }`, so the hero's status link and the episode card
     read "Replacing 42%".
4. **Block the old hash now** (reason `replaced`, `ReplacedBy` = the new hash), so automatic picks skip it from this
   moment.
5. **Start it** as today: `PromoteAsync`, or `ForceAsync` if the old row was forced.
6. **Same-name guard.** One metadata step already keeps a file in its release folder when the flat path is taken
   (`MonoTorrentBackend.DropWrapperAsync`, :259-287). In that step, a file whose flat path the replaced row's manifest
   owns goes into a folder named after the new release.
   - This also applies to single-file torrents, which today write straight into the season folder.
   - So a v2 with the same file name never hash-checks against, or overwrites, the old file. Without the guard,
     MonoTorrent could check the old file as partial data of the new torrent and then overwrite it. That isn't
     verified inside MonoTorrent; P23 proves the guard either way.
7. **Ready.** The new row is Ready when `FinalizeLayoutLockedAsync` (validate: true) returns `LaidOut` or
   `Unchanged`, not `Invalid` or `Unchecked` (:1540-1547). `CompleteReplacementAsync` runs right after that call,
   outside its hash lock (the delete takes its own), and before `TorrentCompleted` is raised (:1557-1562):
   1. `CarrySwapLinks(old, new)`, the existing method, called here instead of at swap time. A `ready` flag makes it
      set the target to downloaded at 100% at once; today it resets the target to queued at 0%, because the new row
      has only just started. It also writes the "Replaced" history row.
   2. `RemoveManyAsync([old.Hash], deleteFiles: true)`, the normal delete: a tombstone, the row removed, and the
      files deleted by the worker with retries across restarts. Files that another row owns are kept.
   3. `ReplacesHash` is cleared.
   4. The completion event gains `Replaced` (`EngineTorrentCompletedEventArgs`, `ITorrentEngine.cs:272`):
      - the notification reads "{Title}, episode 28: the new source is ready. The old file was removed.";
      - request checks see the moved links. They only re-check approved requests
        (`RequestDecisionService.OnTorrentCompletedAsync`), so fulfilled ones aren't announced twice.

   A new file that went into its own folder (step 6) stays there. Open and the title page follow the manifest.
8. **The new one fails** (an error, a failed video check, or the owner deletes it). The old row and its links are
   untouched. `ReleaseTargetsAsync` only releases targets on the failing hash (`CompletedLayoutFinalizer.cs:360-375`),
   and none point at the new one yet. A failed video check blocks the new hash (`failed_check`). The owner can open
   the dialog again.
9. **The old row is deleted first.** `RemoveManyAsync` finds the row whose `ReplacesHash` is the deleted hash and moves
   the links to it at once. Otherwise `Reconcile` would mark the episode "no longer available" while its replacement
   downloads.
10. **Restart.** `ReplacesHash` is persisted. On start, the engine re-runs `FinalizeLayoutLockedAsync(validate: true)`
    for finished rows that still have it, then completes them. This covers the OPS-530 window for replacements.
11. **A second swap while one is pending** on the old hash gets a 409: "A new source is already downloading for this.
    Wait for it, or delete it in Downloads first." The pending row is unfinished, so it can be swapped from Downloads
    with the immediate swap, which carries `ReplacesHash` forward.
12. **Downloads list.** Both rows show under the same film or episode (`ClientTorrentsController.cs:108-126`). The old
    row's note says "Being replaced"; the new row's says "Replaces {release} when ready" (DTO fields `replacedBy` and
    `replaces`).

**Immediate swap for Files missing rows.** The target may already be unlinked, because `Reconcile` sets it to
failed and clears `InfoHash` when the files are absent (`TitleService.cs:76-82`).

- `ReleaseSwapService` passes the target it resolves on `EngineReleaseSwap` as a new `TargetId`: by hash, or else by
  work and episode (`title` for a film).
- `CarrySwapLinks` also moves that target and clears its error, not only targets with `InfoHash == old.Hash`.
- The engine can't match on `Scope` itself, because the formats differ: the target's is `episode`, `season` or
  `title`, while the swap's is `s00001e00028`, `season:N` or `movie`.

This also closes `docs/todo-list.md:51`.

#### 6.4.5 The release blocklist

**Table.** `ReleaseBlock` replaces `ReleaseAttempt`: one concept ("don't pick this release again"), one table, as the
DRY rule in rules.md requires.

| Column | Notes |
|---|---|
| `UserId`, `Hash` | key; lowercase info hash |
| `WorkKey`, `Scope` | `Work.WorkKey`, plus the episode key (`s00001e00028`), `season:N` or `movie`; used for the text and for listing |
| `Title`, `Source` | release name and site, for the picker |
| `Reason` | `replaced` or `failed_check` |
| `ReplacedBy` | the new hash, for `replaced` |
| `BlockedAt` | |

- **Migration.** `ReplaceReleaseAttemptsWithBlocks` also adds `EngineTorrent.ReplacesHash`. It works like this:
  - It copies the old hashes that past swaps replaced as `replaced` blocks, found from the "Replaced {hash}" history
    rows (`DownloadHistories.Context = 'release-swap'`, `ReleaseSwap.cs:133-135`).
  - The owner's picks, which today are also marked "tried", are not carried over.
  - It then drops `ReleaseAttempts`.
  - The work key that `ReleaseSwapService.cs:50` reads from attempts now comes from the block's `ReplacedBy`.
- **Why match by hash, per user.**
  - One info hash is one torrent, so for a film or a one-episode release "this hash" is exactly "this work and
    episode".
  - The hash also survives two things an episode key doesn't:
    - A2 can give the same episode different page coordinates depending on the season-shape source (S1E29 or S2E1,
      1.7).
    - The swap derives a work key from the release name when the row has no work (`ReleaseSwapService.cs:52`).
  - Sonarr also matches by hash.
  - Packs: replacing one episode inside a pack isn't in this change, so a pack hash is only blocked when the whole pack
    is replaced or fails.
- **One helper**, `TorrentFlow.Data/ReleaseBlocks.cs`, holds `LoadAsync(db, userId)`, `AddAsync(...)` and
  `Note(block)`. It lives in Data because the Engine (writers) and the Library (readers) both use it.

**Writers.**

1. Any swap, for the hash it replaces (`replaced`).
2. A failed video check (`failed_check`): `CompletedLayoutFinalizer.MarkFailedCheckAsync`, for the not-a-video
   case only (`releaseTargets: true`, :89), not the unreadable one (:95).
   - `ReleaseTargetsAsync` (:360-375) already hands the episode back to the wanted queue (queued, no release). That
     is the re-search.
   - The block stops the queue from taking the same release again once its row is deleted (OPS-527). This keeps the
     promise "TorrentFlow will choose another release".
3. Not language refusals. Those depend on the setting and are worked out again on every pick. Their header facts are
   cached per hash (3.3).
4. Not send failures (no peers, metadata timeout), which are often temporary.

**Readers.** Every automatic pick and both pickers:

1. **Episode ladder and season packs.** `GrabService.Prepare` loads the blocks once, and `Eligible` drops blocked
   candidates first, with reason `blocked_replaced` or `blocked_failed`. This covers the wanted queue, the title
   page's Download and Retry, requests, rules for episodes, on demand, and season packs (`GrabService.Pack.cs:48`).
2. **Films.** The film path (`GrabService.cs:312-340`) skips `Eligible`, so it gets the same check, counted in
   `FilmRejection`.
3. **Rules' non-episode branch** (`AutomationService.cs:86-102`) skips blocked candidates. OPS-528 covers routing it
   through GrabService.
4. **Results with only a `.torrent` link** have no hash until the file is fetched.
   - `EngineAddRequest.SkipBlocked` makes the engine refuse a blocked hash with `Unusable = "blocked"`.
   - `GrabService.Send` sets it for automatic picks only, beside `Language` (3.2). Hand picks never set it.
   - `Send` maps the refusal to the candidate's reason.
5. **The two pickers**, swap alternatives (`ReleaseSwapService.Alternatives`) and "Pick a release yourself"
   (`ReleasePicker.Search`):
   - Blocked results are no longer silently dropped. They come back last in their group with a `blocked` note.
   - They are never the recommended one, and "Find the best one for me" never picks them.
   - Hashes already in Downloads stay excluded.
6. **`SwapAsync`** loses "That release has already been tried." (`ReleaseSwap.cs:39-41`). Picking a blocked release
   by hand is the owner's choice. The block stays, as in Sonarr, so automatic picks keep skipping it.
7. **Not the search page.** Its results are shared across titles and cached per query (`TorrentSearchService`,
   `ReleaseRanking`), and it is a raw search.

**What the owner reads.**

| Where | Text |
|---|---|
| Wanted and Activity detail | "40 results: 22 other episodes, 2 you replaced, 1 failed before" |
| Everything blocked | "We only found releases you replaced or that failed before." / "Pick a release yourself, or search for the title." |
| Picker card | badge **Blocked**, then "You replaced this on 1 Oct." or "This failed the video check on 1 Oct."; button **Use it anyway** |

**Lifetime.**

- Blocks stay when a title is removed from the library, so adding it again doesn't bring the bad release back. Sonarr
  deletes them with the series (open question 16).
- There is no unblock screen in this change. A hand pick still works, so a block is never a dead end (open
  question 15).

#### 6.4.6 Languages in the dialog

- **Per alternative.** Each one carries `audio`, `subtitles`, `languageFit` (`preferred | neutral | backup | clash`)
  and `languageNote` ("French audio", "Chinese subtitles only", "English dub").
  - They come from `ReleaseLanguage.Detect(title, null, sourceCategory)` and `Judge(want, facts)`, which is Layer 1
    (3.1): names and the nyaa category only.
  - Searching never downloads anything.
- **Card.** `ReleaseCard` gains one line under the title: "Audio: Japanese · Subtitles: English", or "Audio: not
  stated" when the name says nothing. The note joins the existing `why` line ("French audio, so automatic picks skip
  it"). "Pick a release yourself" uses the same card, so it shows the same line.
- **Order.** `ReleaseSwapService.Rank` (:143-186) sorts by the language fit first, then by today's score, the same
  order as `Eligible` (3.1). Clashes stay visible, because it is the owner's choice, but they sort last and never get
  "Best match".
- **Current download.** It shows the same line, read from the file on disk when it has finished (`MediaTracks`, the
  Layer 2 reader from 3.3, run on the local file's first MiB). Otherwise the line comes from its name.
- **"Find the best one for me" on a finished download** compares the top alternative's fit and quality with the
  current file. It doesn't compare live seeders, which a parked row doesn't have (`ConnectedSeeders ?? 0`,
  `ReleaseSwapService.cs:134`, 6.8). If nothing fits better, the owner reads "Nothing better than what you have was
  found on {site}. Your current file was kept."

#### 6.4.7 API (same routes, new fields)

```
GET /api/client/torrents/{hash}/alternatives[?source=]
{
  health,                                   // unchanged
  current: { title, state, finished, filesMissing,
             audio: [], subtitles: [], languageBasis: "file" | "name" | null,
             replacing?: { hash, title, progress } },
  alternatives: [{ token, hash, title, seeders, peers, sizeBytes?, quality?, source, why,
                   audio: [], subtitles: [], languageFit, languageNote?,
                   blocked?: { reason, note, at } }],
  sources, recommendedToken?                // never a blocked or clashing one
}
POST /api/client/torrents/{hash}/alternatives   { token } | { best: true, source? }   // body unchanged
-> EngineAddResult { ok, message, hash, pending }   // pending = true for a deferred swap
```

- **409s.** They stay for imported rows, packs and an unknown episode. One is added for "already downloading"
  (6.4.4 step 11). The "already complete" 409 goes.
- **Other endpoints.**
  - `GET /api/title/{workKey}` and `/progress` add `transfer.replacing`.
  - `GET /api/client/torrents` adds `replaces` and `replacedBy`.
- **Requesters.** The requester allow-list doesn't change, because these routes are owner-only
  (`RequesterAllowList.cs:20-36`).

### 6.5 Code map

| File | Change |
|---|---|
| `TorrentFlow.Data/Entities/ReleaseBlock.cs` (new), `ReleaseAttempt.cs` (deleted), `TorrentFlowDbContext.cs`, migration `ReplaceReleaseAttemptsWithBlocks` | the block table; `EngineTorrent.ReplacesHash` |
| `TorrentFlow.Data/ReleaseBlocks.cs` (new) | load, add, note: the one block rule |
| `TorrentFlow.Engine/ReleaseSwap.cs` | deferred and immediate modes; blocks instead of attempts; links found by target key; `ReplacesHash` carried |
| `TorrentFlow.Engine/TorrentEngineService.cs` | `CompleteReplacementAsync` after a Valid finalize; the start-up pass; `RemoveManyAsync` moves links to a pending replacement; the `SkipBlocked` refusal; action-name messages |
| `TorrentFlow.Engine/Client/MonoTorrentBackend.cs` | same-name guard beside `DropWrapperAsync`; message at :236 |
| `TorrentFlow.Engine/Layout/CompletedLayoutFinalizer.cs` | `failed_check` block in `MarkFailedCheckAsync` |
| `TorrentFlow.Core/Contracts/Engine/ITorrentEngine.cs` | `EngineAddRequest.SkipBlocked`, `EngineAddResult.Pending`, `EngineReleaseSwap.TargetId`, `EngineTorrentCompletedEventArgs.Replaced` |
| `TorrentFlow.Library/Features/Grabs/ReleaseSwapService.cs` | no finished gate; `current`; languages; blocked rows; fit-first `Rank`; the best rule for finished rows; the "site" message |
| `.../Grabs/GrabService.cs`, `GrabService.Pack.cs`, `FilmSelection.cs`, `EpisodeRejections.cs`, `GrabFailure.cs` | blocks in `Prepare`, `Eligible` and the film path; `SkipBlocked`; reason codes and labels |
| `.../Grabs/ReleasePicker.cs` | blocked and language fields |
| `.../Automation/AutomationService.cs` | block check in the non-episode branch |
| `.../Titles/TitleService.cs`, `TitleController.cs` | `transfer.replacing` |
| `TorrentFlow.Engine/Controllers/ClientTorrentsController.cs`, `DownloadOpenController.cs` | `replaces` and `replacedBy`; the action name at :65 |
| `TorrentFlow.Api/Notifications/DownloadNotificationWatcher.cs` | replacement wording |
| `web/src/components/releases/release-swap-dialog.tsx` (moved from `app/downloads/`) | subject prop, rename, copy per state, current languages, blocked rows, "site" wording |
| `web/src/components/releases/release-card.tsx`, `release-picker-dialog.tsx` | language line, Blocked badge, "Use it anyway" |
| `web/src/app/downloads/page.tsx`, `series-download-dialog.tsx`, `types.ts` | rename, `canFindAnotherSource`, row notes |
| `web/src/components/title/title-detail.tsx`, `episode-list.tsx`, `types.ts` | hero button, card menu, "Replacing x%", dialog mount |
| `docs/dotnet-port.md:25, 47`, `docs/todo-list.md:45, 47, 51`, `docs/api-open-file.md:86`, `docs/season-pack-fallback.md` | the new name; `ReleaseBlock` replaces `ReleaseAttempt`; blocks outlive the row |

### 6.6 Proof (no unit tests)

Same instance and fixture rules as section 4: port 3987, legal payloads only. Extra fixtures:

- two encodes of one open movie under a film's name, for example `Sintel.2010.720p` and `Sintel.2010.1080p`;
- episode-shaped releases, as in section 4;
- a v1 and v2 pair with the same file name and different bytes;
- one payload that isn't a real video.

| # | Proves | How | Pass when |
|---|---|---|---|
| P17 | Rename | Playwright at 390/768/1280: Downloads film menu, series dialog card menu, failed card button, header button; title page hero and card menu. Then `rg "Find another release" web/src server` | every label and aria-label says "Find another source"; `rg` finds nothing outside comments about history; the site picker says "All sites" |
| P18 | Finished film kept until Ready | the film fixture at 720p downloads to Ready; on the title page hero, Find another source, pick 1080p | POST returns `pending: true`. While it downloads: the old row is Ready, the old file's size and mtime are unchanged, `GET /api/title/{workKey}` still has the old hash and "downloaded", and the hero shows "Replacing x%". After Ready: the target has the new hash, the old row is gone, the tombstone is processed, the old file is gone, Activity shows "Replaced", and the notification uses the replacement wording |
| P19 | Finished episode, both entry points | P18 for one episode from the series dialog card menu, and for another from the title page card menu | as P18; other episodes untouched |
| P20 | Block honoured | after P18, delete the new download so the film is wanted again; the feed lists the blocked release with the most seeders; run the wanted queue; open both pickers; press "Find the best one for me" | the ladder skips it ("1 you replaced"); both pickers list it last with "You replaced this on …" and "Use it anyway"; best never picks it; a hand pick of it downloads and the block stays |
| P21 | `.torrent`-only candidate | a feed entry for the blocked release with a `.torrent` link and no hash | the engine refuses it as blocked and the ladder moves on; the same entry picked by hand downloads |
| P22 | Failed new source | a finished episode; pick the payload that isn't a real video | the new row fails its check; the old file and links are unchanged; a `failed_check` block exists; the dialog shows it as failed |
| P23 | Same file name | a finished episode from v1; pick v2 | the old file's hash is unchanged until Ready; v2 downloads into its own folder; after Ready only v2 remains |
| P24 | Restart while pending | stop the app mid-download, then start it again | `ReplacesHash` survives; the replacement completes as in P18 |
| P25 | Old row deleted first | while pending, delete the old row in Downloads | the links move to the replacement at once; the title page shows "Downloading x%", not "no longer available" |
| P26 | Files missing | remove a finished fixture file from my own download folder; Find another source from the row | it is offered; the dialog says the files are already gone; at Ready the episode is linked to the new row |
| P27 | Languages in the dialog | GET alternatives for crafted names (Tsundere `MULTi`, `VOSTFR`, `[CHT]`, `Dual Audio`, a neutral name); Playwright screenshots at 390/768/1280 | each card shows the right audio and subtitle line; clashes sort last and never get "Best match"; a finished row's current line says "from the file" |
| P28 | Storage | a storage cap that fits only one copy | the plain "isn't room" message; nothing changes |
| P29 | Owner only | a requester session in Playwright; GET and POST as requester | no button on the title page; the API returns 403 |
| P30 | Migration | start 3987 on a fresh copy of `memtest\stable\data`; count rows with sqlite before and after | replaced hashes become `replaced` blocks, the owner's picks don't, and `ReleaseAttempts` is gone |

### 6.7 Open questions for the critic (continued)

12. **Blocked releases in pickers.** Shown last with the reason and "Use it anyway" (recommended, as in Sonarr's
    interactive search), or hidden?
13. **Block key.** Info hash per user, with the work and episode stored for the text (recommended)? Or the work plus
    episode coordinates, which A2 makes unstable?
14. **What blocks.** The owner's replacement and a failed video check (recommended). Language refusals and send
    failures don't block.
15. **Unblocking.** None in this change, since a hand pick still works (recommended). Later, a Settings list like
    Sonarr's Blocklist page.
16. **Removing a title** keeps its blocks (recommended). Sonarr deletes them with the series.
17. **Episodes from a season pack.** Not in this change (recommended). `docs/season-pack-fallback.md` 4.4 already
    designs the per-episode release (`ReleaseFileAsync`), which this would build on.
18. **"Source" and "site".** The action says source, and the site picker says site. Agree?
19. **Server messages.** Advice to the owner says "find another source". Descriptions of what TorrentFlow does stay,
    and `CompletedMediaValidator`'s text stays because it is compared as text. Agree?
20. **Both rows in Downloads while pending** (recommended, with notes), or hide the old one until the swap completes?
21. **Order of work.** Four slices, each shipping on its own with its proofs:
    1. the rename and the languages in the dialog;
    2. the blocklist;
    3. deferred finished swaps;
    4. the title page entry points.

### 6.8 Found on the way

Filed:

- OPS-527 (FEAT-30): a failed release can be picked again once its row is gone. Fixed by 6.4.5.
- OPS-528 (FEAT-30): rules send non-episode releases straight to the engine.
- OPS-529 (FEAT-28): "Pick a release yourself" ignores the anime mapping and drops the ranking's reasons.
- OPS-530 (FEAT-17): a row parked just before its video check is never checked after a restart.
- OPS-531 (FEAT-16): Notifications hide "That torrent link was not found".

Noted, not filed (minor, or not reachable from the UI):

- `SwapBest` compares against `ConnectedSeeders ?? 0` (`ReleaseSwapService.cs:134`), so on a paused download any
  alternative with one seeder counts as better. 6.4.6 changes the rule for finished downloads.
- The season-pack swap, which the UI never offers, resolves one arbitrary claimed episode (`ReleaseSwapService.cs:54`)
  and leaves `FileIndex` set (`ReleaseSwap.cs:140-143`).
- The swap removes partial files without a tombstone (`ReleaseSwap.cs:79-86`).
- The swap's "already in your downloads" check has no user filter (`ReleaseSwap.cs:37`). There is only one local user
  today.
- Alternatives without a magnet are dropped (`ReleaseSwapService.cs:209`).
- The web tests "finished" in four places with three rules:
  - `progress >= 0.9999`: `canFindAnotherRelease` (`release-swap-dialog.tsx:78`) and `packLabel`
    (`release-display.ts:263`);
  - `>= 1`: `showsProgressBar` (:179);
  - state `downloaded`: `canOpenFinishedFile` (:190).

  The new gate uses none of them.
