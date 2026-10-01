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
- The owner has since deleted these. `/api/client/torrents` is empty, every Frieren target reads "The requested file
  is no longer available", and no .torrent or file is left, so their real track headers can't be read.
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

By name and uploader description, both Frieren releases the owner got have Japanese audio. The files are gone, so
the headers can't be checked. Three explanations remain, and the plan covers all of them:

1. The owner saw a different download (another instance). Frieren results include Chinese-platform releases with
   high seeder counts, and nothing in the code would refuse them.
2. A Chinese subtitle track was the default in the `[HR]` files (they carry Chinese subtitles), so the player showed
   Chinese text. Layer 2 records the default audio and subtitle tracks, so the next case leaves evidence.
3. The uploader's description is wrong. Layer 2 reads the real tracks, so the description stops mattering.

Question for the owner, when back: which file was it, and was it the voices or the subtitles?

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
| `Dual Audio`, `Dual-Audio`, `DUAL`, `Dual.Multi` | original + English audio | `[HR] ... Dual.Multi` is dual audio + multi subs |
| `dub`, `dubbed`, `English Dub`, `EngDub` | English audio (anime) | unchanged meaning, now a backup instead of refused |
| `Multi-Subs`, `MultiSub`, `Multiple Subtitle`, `Multi Sub` | subtitles incl. English (assumed) | never "MULTi audio" |
| `[ENG]`, `ENG`, `English` with no dub/audio word | English subtitles (anime), English audio (other) | Erai-raws lists sub codes in brackets after `Multiple Subtitle` |
| bracket code lists after a subtitle marker (`[POR-BR][SPA][ARA][FRE][GER][ITA][RUS]`) | subtitle languages | not audio |
| `MULTi` (scene token, not followed by sub/subs) | several audio tracks, default unknown | backup rank; Layer 2 decides. Becomes French audio with a French marker or group |
| `FRENCH`, `TRUEFRENCH`, `VFF`, `VFQ`, `VFI`, `VF`, `VF2`, `VOF` | French audio | |
| `VOSTFR`, `SUBFRENCH`, `VOST`, `Sub FR` | original audio, French subtitles only | anime: clash "French subtitles only"; other: backup |
| groups `Tsundere-Raws`, `KAF` | French release groups: `MULTi` = French default audio, else French subs | proven by the headers in 1.2 |
| `国语`, `國語`, `普通话`, `中配`, `国配`, `台配`, `Mandarin` | Chinese (Mandarin) audio | |
| `粤语`, `粵語`, `Cantonese` | Chinese (Cantonese) audio | |
| `CHS`, `CHT`, `GB`, `BIG5`, `简体`, `繁體`, `简中`, `繁中`, `简日`, `繁日`, `中文字幕`, `内嵌`, `内封` | Chinese subtitles (`内嵌` = burned in) | `GB` only as a bracketed token, never inside a size such as `1.4GB` |
| `[Baha]`, `Bahamut`, `[ANi]` | Japanese audio, burned-in Chinese subtitles | anime: clash "Chinese subtitles only" |
| `iTALiAN`, `ITA` (not after `SUB`) | Italian audio | `SUB ITA` = Italian subtitles |
| `GERMAN`, `German DL`, `GER` (not in a sub list) | German audio (`DL` = German + original) | `GerSub` = subtitles |
| `SPANiSH`, `Castellano`, `Latino`, `LAT`, `ESP` | Spanish audio | `VOSE` = Spanish subtitles |
| `RUS`, `Russian`, `MVO`, `DVO`, `AVO` | Russian audio (voice-over) | `Rus Sub` = subtitles |
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
| `TorrentFlow.Library/Features/Grabs/GrabService.cs` | `Eligible` (fit filter and order), the reasons loop (~205), `Send` (pass `Language`, map `audio_language`), `Prepare` (read the setting) |
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
| P3 | Name layer on real results | `GET /api/title/{workKey}/releases` (the picker list, sends nothing) for Mushoku Tensei S3E14, Frieren S1E5, Slimes 300 Years S2E10, Scorpion S4E4, Practical Magic 1998, Squid Game S1E1 | Tsundere, VOSTFR, KAF, Baha/CHT rows carry the right note; ladder order puts a Japanese+English-subs release first for anime and keeps Korean audio as a backup for Squid Game |
| P4 | Ladder, name clash | fake feed: Tsundere-shape name (most seeders), then a neutral name with a jpn+en payload | Tsundere refused with "French audio" in the wanted detail; the neutral one downloads |
| P5 | Ladder, header clash | fake feed: neutral name with fre-default payload (most seeders), then a jpn+en one | probe refuses the first ("French audio"), no engine row, probe folder gone, bytes received under the cap (log); the second downloads; a second hunt reuses the `MediaProbes` row (no new probe in the log) |
| P6 | Subtitles rule | jpn + es-419-only payload | refused "Spanish subtitles only"; with `english` it is still refused (audio not English, no English subs) |
| P7 | Untagged and timeouts | untagged payload; then seeder stopped | untagged passes; offline probe gives up at 45 s, the grab continues unchecked, log says so |
| P8 | Settings switch | P4 with `any`, then with `english` plus an `[English Dub]` row | `any` takes the Tsundere-shape release; `english` takes the dub first |
| P9 | Films and packs | film feed with `FRENCH`/`iTALiAN` names; pack feed with a `.fr.srt`-only file list | refused at the name or file layer; detail counts them |
| P10 | Owner screens | Playwright at 390/768/1280 of Wanted and Activity after P4/P5 | the "9 French audio" style text shows and reads plainly |
| P11 | No regressions | hand-pick the Tsundere-shape release; search page lists all rows | the hand pick downloads (the owner's choice); search still shows French rows |

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
