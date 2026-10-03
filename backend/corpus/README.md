# Release-name corpus

Task 0.7, **OPS-646 / FEAT-35**, prepared for the Phase 3 normalizing Parser.
`names.tsv` contains **3,535 labelled rows**. It is UTF-8 without a BOM, uses LF
line endings, has a header, and has exactly 20 tab-separated fields per row.
It is data, not a test suite or a snapshot of either old parser.

## Inputs and review

- All **3,234** rows from `raw-names.tsv` are retained in their original order.
  `name` and `query` are preserved exactly, including mojibake, truncated names,
  advertisements, unrelated hits, comic archives and misleading results.
  Source, listed seeders and size remain in the input file; they are not parse
  expectations and are not used to infer language, coverage or safety.
- **301** historical regression rows were extracted from the commits in
  `regression-sources.tsv`, using `git show <commit>:<path>`. Parameterized
  release strings were expanded, including all 28 Frieren episode fixtures,
  their next-episode counterexamples, native-script names and resolution aliases.
  Repeated names are intentional when assertions or query contexts differ.
  Historical expected outcomes are summarized in `note`, particularly when
  episode matching, ranking or category filtering is different from work-name
  matching.
- A small PowerShell helper outside the repository, at
  `D:\code\memtest\name-corpus`, prefilled literal, obvious fields. No existing
  release parser was called. Human reading then checked and corrected all
  historical rows and **1,433 cache rows** covering the hard-set ambiguities:
  packs, ranges, unqualified anime numbers, specials, foreign and dual markers,
  year collisions, multilingual aliases, mojibake and non-video lookalikes.
  Repeated encode families were reviewed together, retaining each name's own
  numbers, quality and language tags.
- **1,734 rows are `hand`; 1,801 are `auto`.** `auto` honestly identifies
  rule-prefilled, unreviewed rows; it is not a claim of human certification.
  These labels should be reviewed when introducing new grammar, rather than
  changing the parser merely to reproduce a helper mistake.
- There are no Prison Break cache results in this supplied export. There are
  also no cache queries named `la casa de papel` or `koe no katachi`; those
  aliases occur in the Money Heist and A Silent Voice release names. No absent
  title was fabricated to improve coverage.

`AnimeEpisodeMappingTests.cs` was read but contributes **zero release-name
rows**: its strings are provider entries, aliases and relationship fixtures,
not release inputs to parse or match. Their absolute-offset assumptions must
not be invented by a name-only Parser. Cursor/backoff, tracker hashes, URLs,
assertion messages, quality-only tokens and output grouping keys are likewise
not standalone release fixtures.

## Column contract

| Column | Meaning |
| --- | --- |
| `name` | Unmodified release input. Never repair its encoding in this column. |
| `origin` | `cache` or `regression:<repository-relative source file>`. The corresponding historical commit is in `regression-sources.tsv`. |
| `query` | Original cache query; for historical fixtures, the asserted or implied work-name target. A year in parentheses can distinguish film targets. Empty means no meaningful target was supplied. |
| `title` | Human-readable work title extracted from the name, without group, year, coordinates or encoding jargon. Prefer the English alias **when actually present in the name**; do not invent it from the query or metadata. Preserve title numbers and cour/subtitle identity. `unknown` means no reliable title. Normalized spacing/punctuation is not a byte-level title assertion. |
| `year` | Explicit four-digit year, or empty if unstated. For a stated year interval, the first year is retained and the interval explained in reviewed notes. Numeric titles such as `1917`, `2012` and `Blade Runner 2049` are not release years. |
| `kind` | Structural only (OPS-671): `movie` is one unqualified title, not verified film identity; no coordinates/pack/non-feature markers defaults to movie, even for junk names or unusual containers. `episode` includes explicit episode ranges with an `episode range` note, not single-acquisition intent. `season_pack` means an implied whole season (bare S01, Season 1, Complete S01), never a partial episode range. `multi_season` states multiple seasons. `complete_series` includes explicit whole-series intent and unqualified [BD]/BD-box/Batch/Complete/Collection claims without season/episode facts. `special` retains explicit special intent. `other` requires explicit non-feature book/music/software/subtitle/font/extras markers; wrong work or unresolved catalog identity belongs to Plan. |
| `seasons` | Explicit season number, inclusive range (`1-3`) or comma-separated list (`1,7`). Empty means no season stated. Conflicting labels can be retained as a list with a note, rather than silently choosing one. |
| `episodes` | Explicit episode number, inclusive range or comma-separated coordinates. `a` prefixes absolute/unqualified anime numbering (`a33`, `a1-a28`). Both coordinate systems are retained when supplied: `8,a36` means seasonal episode 8 and absolute episode 36. Empty means no episode span stated. |
| `resolution` | `2160`, `1080`, `720`, `480`, or `unknown`. 4K/UHD and FHD aliases are normalized; cropped 1920-wide anime encodes belong to the 1080 class. An explicit encoded 1080p wins over “4K remastered”. Out-of-schema values (360p/400p), absent evidence and mixed per-season qualities are `unknown`, not rounded up. |
| `source_type` | Explicit `web`, `bluray`, `hdtv`, `dvd`, `cam`, `ts`, or `unknown`. An indexer/source website is not a video source type. Generic HDRip does not establish HDTV. |
| `codec` | Normalized explicit video codec: `h264`, `h265`, `av1`, `xvid`, `divx`, `vc1`, `vp9`, `h266`, or `unknown`. A comma-separated list is used when multiple encodes are explicitly advertised. Audio codecs are not video codecs. |
| `hdr` | Explicit `hdr`, `hdr10`, `hdr10+`, `dv`, `sdr`, a comma-separated combination, or `unknown`. Absence of an HDR tag does not prove SDR. |
| `audio_langs` | Sorted comma-separated ISO language codes, or `unknown`. Do not infer English from an English title, romaji from Japanese audio, language from a release group, or a concrete audio-language list from `DUAL` alone. Cantonese is `yue`; unspecified Chinese is `zh`. |
| `subs` | Explicit subtitle ISO codes, `multi`, `yes` (present but unspecified), or `unknown`. `CHS`/`CHT`, VOSTFR and English-sub markers are subtitle evidence, not audio proof. |
| `foreign` | `yes` only for clearly advertised non-English audio/language markers without an English, MULTi or dual exemption. Per the coordinator's correction, an explicit ENG/English marker, including `Ita Eng Subs`, makes this `no` even if audio tracks themselves are unverified; MULTi/dual also exempts refusal. Otherwise `unknown`. MULTi-**Subs** alone is not MULTi audio. Unknown is **not foreign** and is not a refusal reason. |
| `unsafe` | `yes` for name-visible CAM/TS/telesync/telecine, executable/script/shortcut payloads, archive-only names, password or codec-required bait; otherwise `no`. `no` means no name-visible red flag, **not** a verified safe file list. |
| `group` | Explicit release/fansub/uploader group, or empty if absent. Scene suffixes and genuine leading fansub brackets are recognized; technical brackets and tracker advertisements are not groups. |
| `matches_query_work` | `yes`, `no`, or `unsure`: semantic work identity against `query`, not “eligible to download this target”. Correct work names can still advertise the wrong episode, an unsafe release, foreign audio or unverified coverage. |
| `labelled_by` | `auto` for prefill only; `hand` after reading and checking/correcting the row. This is annotation provenance, not an application confidence score. |
| `note` | Ambiguity, historical assertion context, interpretation rationale and facts intentionally not inferred. Empty when the auto prefill has no additional claim. |

Seasons and episode ranges are **claims made by names**, not verified file
coverage. The Parser stays pure. Plan must compare names, years, mappings,
episode counts and sizes against Metadata; Check must supply file lists and
health. A bare `a33` is not automatically rewritten to `S02E05`. Likewise,
series season release years are not compared blindly to a show's premiere year.

English-first **search ordering** belongs to Find and is not tested by parsing
an alias. Unknown resolution still cannot meet a hard minimum quality floor.
Unknown audio language, in contrast, must not trigger a foreign-language gate.

## Counts

### Kind

| Kind | Rows |
| --- | ---: |
| episode | 1,935 |
| movie | 1,013 |
| season_pack | 382 |
| other | 117 |
| multi_season | 64 |
| special | 15 |
| complete_series | 9 |
| **Total** | **3,535** |

### Origin and review

| Origin | Rows | Hand | Auto |
| --- | ---: | ---: | ---: |
| cache | 3,234 | 1,433 | 1,801 |
| regression: ReleaseGrammarTests.cs | 48 | 48 | 0 |
| regression: EpisodeMappingTests.cs | 68 | 68 | 0 |
| regression: AnimeEpisodeMappingTests.cs | 0 | 0 | 0 |
| regression: SeasonAndCursorTests.cs | 9 | 9 | 0 |
| regression: SwarmRankingTests.cs | 11 | 11 | 0 |
| regression: work-match.test.ts | 32 | 32 | 0 |
| regression: episodes.test.ts | 14 | 14 | 0 |
| regression: ranking.test.ts | 70 | 70 | 0 |
| regression: absolute-season-ranking.test.ts | 24 | 24 | 0 |
| regression: group-titles.test.ts | 25 | 25 | 0 |
| **Total** | **3,535** | **1,734** | **1,801** |

The full paths, not these shortened table labels, are stored in `origin`.

## Ten hardest names and their labels

| Name | Deliberate interpretation |
| --- | --- |
| `[Asakura] Tensei Shitara Slime Datta Ken 4th Season - 15 [1080p] \| That Time I Got Reincarnated as a Slime Season 4 \| Episode 87` | `episode`; season `4`; episodes `15,a87`; 1080; work match yes. Never replace local 15 with absolute 87. |
| `[9volt] Sousou no Frieren - 36 (S02E08) (WEB 1080p HEVC EAC-3)` | `episode`; season `2`; episodes `8,a36`; 1080/web/h265; audio and foreign unknown. Both numbering systems survive. |
| `Frieren S01E12 [01-12] 1080p` | `episode`; season `1`; episodes `12,a1-a12`; episode range excludes single-acquisition intent; contradictory scene label remains visible. |
| `[ANi]-Sousou-no-Frieren-S02--葬送的芙莉蓮-第二季--30-[1080P][Baha][WEB-DL][AAC-AVC][CHT][MP4]` | `episode`; season `2`; episodes `a30`; Chinese subtitles; audio/foreign unknown. Do not invent local episode 2 or treat CHT as Chinese audio. |
| `[千夏字幕组][葬送的芙莉莲_Sousou no Frieren][第39-38话][1080p_AVC][简体][合集]` | `episode`; episodes `a39-a38`; no season; Chinese subtitles; invalid descending episode range deliberately preserved and noted. |
| `Ð¡ÐºÐ¾Ñ€Ð¿Ð¸Ð¾Ð½ / Scorpion [02Ñ…01-03 Ð¸Ð· 22] (2015) HDTV 720Ñ€   ÐœÑ‚Ñ€ÑÐº` | `episode`; title Scorpion; year 2015; season `2`; episodes `1-3`; episode range; 720/hdtv; foreign unknown. Mojibake coordinate is readable; Cyrillic text is not audio proof. |
| `Money.Heist.aka.La.Casa.de.Papel S01&S02.1080p.--S03&S04&S05.2160p.--NF.WEB.HDR.DDP5.1-ZeLk@` | `multi_season`; seasons `1-5`; resolution unknown because S1-S2 claim 1080 and S3-S5 claim 2160; web/HDR; work match yes. |
| `Little Fires Everywhere S01E01 08 ITALiAN WEBRip x264 C0P` | `episode`; season `1`; episodes `1-8`; episode range; web/h264; resolution unknown; audio `it`; foreign yes. Space-separated range must not become one single-episode target. |
| `Rick And Morty S01 S07 1080p ITA ENG AAC x265 MaDTiA` | `multi_season`; seasons `1,7`, not `1-7`; 1080/h265; audio `en,it`; foreign no. Intermediate coverage is not stated. |
| `(C87) [LinkRingRin (Natsume Kei)] Nishimiya and Ishida Are, (A Silent Voice) [English] =TV= zip` | `other`; no season/episodes; explicit English, foreign no; unsafe yes; work match no. An English comic ZIP is not the animated film. |

## Known ambiguities and boundaries

- “Complete”, “special”, “Part” and numbers can be title words, not grammar.
  `A Complete Unknown` is a movie; Silent Witness's “A Special Relationship”
  is an ordinary episode subtitle; `Example Cour 2 - 03` retains Cour 2 in
  the title, rather than claiming an episode range 2-3.
- `Sousou no Frieren 2nd Season S01E05` states two season systems. The corpus
  keeps `seasons=2,1`, `episodes=5` and explains the historical metadata mapping.
  This is not approval to hard-code a franchise offset in Parser.
- Anime main seasons bundled with OVAs, specials, scans or soundtracks are
  not automatically extras-only. A recut (`Frieren Henshu`), mini-anime
  (`Marumaru no Mahou`), manga and soundtrack are distinct intents.
- `Rick and Morty: The Anime`, Money Heist Korea, Berlin, Black Scorpion,
  Scorpion King and Mortal Kombat are not their substring-matched main works.
- French VOSTFR, Chinese subtitle tags and Portuguese `Subs` do not prove
  foreign audio. Explicit Japanese-only or Italian-only audio does, under
  the requested clear-marker rule; MULTi/dual is an exemption without inventing
  English tracks. Italian disc provenance (`ITBD`) alone is not audio evidence.
- Movie slot `Koe no Katachi - 00` is an anime-film naming convention, not a
  television S00 episode. Year intervals, truncated names and malformed ranges
  remain annotated rather than “fixed” using knowledge outside the name.
- Historical film matching permitted one year of production/festival slack;
  the 2025 Odyssey fixture remains a yes against the historical 2026 target.
  This records the fixture's asserted policy, not a decision that every future
  Plan year gate must allow it.
- No network, swarm, file-list, actual audio-track or payload inspection was
  performed. `unsafe=no`, work-match yes and a claimed complete pack are not
  admission decisions.

## Validation evidence

### Parser label review (OPS-667 / OPS-669)

`parser-label-corrections.tsv` records **287 field corrections across 180 rows**,
with the one-based `names.tsv` line, original name, old/new value and per-field
reason. Inputs, queries, row order and original provenance are unchanged: reviewing
one field does not recertify an entire auto row as hand. Range notes were also
updated to meet the existing structural validator.

Examples: `[5.1]` and bitrate/size numbers are not absolute episodes; an episode
range cannot swallow `480p`; explicit ordinal seasons and readable mojibake
coordinates survive; subtitle-only tags do not prove foreign audio; archive and
executable markers remain unsafe; a 1920-wide dimension is not a release year.
The Kind counts above reflect this review, not the initial annotation totals.

### Approved structural-kind policy and note repair (OPS-671 / OPS-675)

The coordinator resolved the earlier scope disagreement: a Parser never decides
whether a name is the right work or junk. Plan compares Metadata names/year,
runtime/size and file/unsafe evidence. An unqualified title defaults to movie;
EXE/password/archive safety does not independently turn it into other. Explicit
trailer/teaser/sample/extras/featurette/production-files, music, book, subtitle/font
packs, NCOP/NCED and software-version markers do. An unqualified [BD]/BD-box or
Batch/Complete/Collection cue claims complete_series, without catalog inference.
Explicit main-feature bundles retain their season/episode intent; quality-only
audio/container facts are never verified payload claims.

The initial policy pass in `parser-kind-policy-corrections.tsv` lists **1,655 changed cells across 1,546
rows**, including **106 kinds**, **three restored explicit absolute ranges**, and
all changed notes. Inputs, queries, origins and annotation provenance remain
unchanged. Trailer/production-files/subtitle-only rows are other; bare unknown
titles and known films use the same structural default. Movie collections are
unqualified collection claims rather than catalog-certified single films.

The OPS-679 audio-codec review appends two historical correction entries for
**line 247**, restoring `A Silent Voice 2016 JAPANESE BRRip XviD MP3-VXT` to
movie and explaining that MP3 encodes the film's audio. Video source, video codec
or resolution evidence prevents an audio-format token alone from implying other;
explicit OST/soundtrack/album/theme/ED/OP-song markers still establish music.
All **469 audio-bearing rows** were scanned. The only other existing other row
with video evidence is line 2179, explicitly Behind the Scenes; it stays other.
No additional erroneous audio-triggered labels were found.

Exactly **1,480 notes** contained `System.Collections.Generic.List` type names,
not recoverable list contents. Only that corrupt placeholder was removed; surviving
correction text remains. Empty notes honestly mean no surviving annotation.
The validator now flags this token in **any column**; it rejected all 1,480
corrupt rows before repair and reports zero flags after repair.

Use `bench parse` for parser accuracy, separately from the structural validator.

The initial external PowerShell validator checked encoding, schema and
preservation plus 12 selected fields; that small set did not catch the
coordinator's counterexamples. Its old episode-range-kind expectations are
superseded by the corpus-wide script below. The current validator checks
UTF-8/LF, final newline, 20 fields and every cache `name`/`query` ordinally
against the original 3,234 rows, plus all correction invariants. This is
structural/data validation, not a unit test or evidence that the new Parser
already passes the corpus.

### Coordinator correction pass

`validate-labels.ps1` now validates all hand and auto rows, not a sample:
single-season `S2 - 06`, `2nd Season - 06` and `S2 06` must not be multi-season;
episode tokens/ranges must not be season packs; explicit English markers
must not leave foreign unknown or yes. Episode ranges retain their full span
and an `episode range` note. The explicitly complete underscore pack
`Complete_S01_03` is distinguished from dash-separated episode notation.

Run `pwsh -File backend\corpus\validate-labels.ps1` from the repository root.
Validation exits nonzero and lists flagged names. Its optional `-Fix` mode
applies the documented corrections while preserving names, origins, queries
and annotation provenance. It also validates UTF-8/LF, field counts and all
3,234 original cache name/query pairs.

The first corpus-wide pass changed 164 rows: 56 season-token errors, 97
episode-range pack flags, 57 episode-token pack flags and 13 unknown-language
English-marker flags (categories overlap; no foreign=yes English flags).
A repeated-season range such as `S01E01-S01E13` was also corrected to `1-13`.
The initial detector also caught the complete underscore-season pack; it was
restored to seasons `1-3` and explicitly exempted from the spaced-dash rule.

A reproducible random sample of **30 hand rows**, PowerShell `Get-Random`
seed **646**, was then read across every field. **8/30 rows had additional
errors**: seven missing/incorrect explicit release groups and one missing
mini-anime absolute number. The corresponding group error class was corrected
across all rows, and the same 30 were reread with **0/30 remaining observed
errors**. `hand-sample-review.tsv` preserves the sampled names, final labels,
findings and resolutions. This is a manual sample, not proof of zero errors
in unsampled annotations. All current validation flags are zero.

No servers on ports 3930/3931 were contacted or changed. Repository changes
remain within `backend\corpus`; original generation helpers remain outside
the repository. Nothing was committed.
