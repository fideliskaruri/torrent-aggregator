# OPS-849: native import duration

Source commit: **0181168** (`Refs: OPS-849`), on `rebuild`. No push.

## Root cause and fix

`dbe6771` delegated non-ISO runtime reads to an optional executable. Without
ffprobe on PATH, valid MKV files lost their runtime evidence and could never
be Confident. Library now owns the missing container read, rather than bypassing
the matcher's runtime check.

- `VideoDimensions.ReadDetails` dispatches by container signature, not extension.
- Native Matroska/WebM reads Segment > Info > Duration, accepting four- and
  eight-byte big-endian floats. TimecodeScale defaults to 1,000,000 ns; an
  explicitly invalid or zero scale invalidates duration. Scale may follow Duration.
- Video TrackType and PixelWidth/PixelHeight supply dimensions. Tracks may precede
  Info. A single 4,096-element budget covers the entire EBML traversal.
- Unknown-size Segment uses file length as its boundary. An unknown-size Cluster
  stops traversal immediately. Other unknown-size elements cannot cause an
  unbounded walk. Both metadata sections finish the read before packet data.
- AVI reads RIFF > LIST hdrl > avih, using microseconds per frame multiplied by
  total frames, and reads width/height. RIFF sizes and odd-byte padding are checked.
- `ImportMediaDetails` no longer starts any process or recommends installing
  ffprobe. Missing, invalid or unsupported duration still prevents Confident.
  MP4/MOV retains the existing bounded ISO implementation.

Production changes are confined to `backend\src\Library`; its README is updated.
No gates, state copies, background services, dependencies or unit tests were added.

## Real files and ffprobe cross-check

All figures are seconds. Test tools only:
`D:\code\memtest\jellyfin\jellyfin\ffmpeg.exe` and `ffprobe.exe`.

| File | Native | ffprobe | Absolute difference | Dimensions |
|---|---:|---:|---:|---|
| Full Sintel MKV, remuxed | 888.064000 | 888.064000 | 0.000000 | 1024×436 |
| Full Sintel WebM, VP8 transcode | 888.000000 | 888.000000 | 0.000000 | 320×136 |
| Full Sintel AVI, remuxed | 887.985792 | 888.149333 | 0.163541 | 1024×436 |
| Original Sintel MP4, regression read | 888.064000 | 888.064000 | 0.000000 | 1024×436 |
| Existing `[EMBER] Sousou no Frieren - 01.mkv` | 1559.968000 | 1559.968000 | 0.000000 | 1920×1080 |

The existing file is under
`D:\code\memtest\anime-seasons\downloads\Anime Series\Frieren Beyond Journey’s End\Season 01`.
Existing media was only read, never modified or copied into the proof.
The non-stable search found 166 `.mkv` paths, including sparse, malformed and
synthetic placeholders. **95 existing files had readable native duration** and
were cross-checked, plus the four licensed seed/derived files above:
**99 real-file cross-checks, all within one second**. Full results, including
paths and individual read counts, are in `cross-check.json`.

Measured native header reads:

| Container | Bytes read | Furthest header-read offset |
|---|---:|---:|
| Sintel MKV | 168 | 529 |
| Sintel WebM | 117 | 353 |
| Sintel AVI | 72 | 72 |
| Existing Frieren MKV above | 191 | 9511 |
| Maximum over every inspected file | 1285 | 23731 |

These counters come from a FileStream subclass measuring the actual published
Library methods via reflection. No reader was replaced or mocked. Packet payload
is not streamed or buffered into memory by these readers.

Raw on-disk header boundary fixtures additionally cover:
four-byte/default-scale/eight-byte-unknown Segment; eight-byte float/explicit scale
after Duration/Tracks first; NaN, infinity, negative and zero duration; absent
duration; zero and malformed scale; truncated/oversized elements; Cluster before
Info; odd RIFF padding; zero AVI frame count. Positive variants retain the
expected duration/dimensions; all unreadable variants return no duration.
These are proof-only file integration checks, not claims of actual video content.

## Real HTTP proof

The requested branch worktree creation refused because `rebuild` was already
checked out. A detached `rebuild` worktree at `b6cfb66` was used instead, with only
the four owned changed files copied into it.

Published `backend\src\Api\Api.csproj` Release with `-warnaserror` to
`D:\code\memtest\bin-mkv`: **0 build warnings, 0 errors**.
The proof harness also built with warnings treated as errors: **0 warnings**.
Existing startup warnings about migration transaction support and missing web
assets are unrelated; no browser/UI claims are made.

Server: fresh `D:\code\memtest\data-mkv`, **3961 only**, scheduler disabled,
`--background --no-browser`. The TMDB key was supplied to the child environment
only, never printed or written to evidence. **ffprobe was not on PATH**.
All assertions in `verify.ps1` passed against the final published reader.

| Real HTTP action | Result |
|---|---|
| Scan full `Sintel.mkv` | Confident, Sintel (2010) |
| Scan full `Sintel.webm` | Confident, Sintel (2010) |
| Scan full `Sintel.avi` | Confident, Sintel (2010) |
| Scan copied Sintel MKV bytes named `Dune (2021).mkv` | NeedsPick: “The file runtime does not fit this title.” |
| Scan header file without Duration named `Sintel (2010).mkv` | NeedsPick: runtime could not be read |
| TrackInPlace confirmation of full Sintel MKV | Imported successfully; ownership immediately reports 480p |
| Read actual fresh SQLite MediaFile row | 1024×436, 480p, runtime **888.064** seconds |

Captures: `http-sintel*.json`, `http-wrong-runtime.json`, `http-unreadable.json`,
`http-confirm.json`, `http-owned.json`, `persisted-media.json`.

## Reproduction tools

`ReaderProof.csproj` / `Program.cs` load the actual published Library assembly;
`edges.py` writes boundary fixtures; `verify.ps1` drives real HTTP and file checks.
For the licensed source
`tools\.filing-proof\seed\Sintel\Sintel.mp4`, fixture-generation arguments were:

```text
MKV:  -i <seed> -map 0:v:0 -map 0:a:0 -c copy <proof>\fixtures\Sintel.mkv
AVI:  -i <seed> -map 0:v:0 -map 0:a:0 -c copy <proof>\fixtures\Sintel.avi
WebM: -i <seed> -an -vf scale=320:-2 -c:v libvpx -deadline realtime -cpu-used 8 -b:v 250k <proof>\fixtures\Sintel.webm
```

The seed was only read. Its SHA-256 before and after:
`1DC6F2CA9762DFCC7D1B1843129A3E4F351D1FE935DEA2241C7B359C11EBC1D8`.

## Limits and review

The intentionally bounded Matroska read does not chase Info beyond the first
Cluster or derive duration from packet timestamps. Files without usable Info
Duration remain NeedsPick. AVI proof covers ordinary avih duration, not OpenDML
extended frame counts. MPEG/TS/ASF native duration is outside this change and
remains unavailable rather than invoking a production tool.

No real HTTP adoption/restart or Engine download filing was rerun; these reuse
the same changed reader. Source self-review checked signature dispatch, unsigned
size/overflow bounds, finite positive duration, element budgets, RIFF padding,
no executable calls, and unchanged matcher confidence policy. Independent
coordinator critic is still pending, so OPS-849 is left in needs_verification.

## Cleanup

Completed at approximately **22:07 +03:00**, within the 30-minute limit.
Proof PIDs **25176** and **51580** were stopped by literal PID; 3961 has no listener.
The detached worktree, published binaries, fresh data, generated/copy fixtures,
and proof build outputs were removed. Evidence and proof source files persist.
`tools/.gitignore` was neither modified nor staged by this lane.
PID **3188** remains alive; 3930 and `D:\code\memtest\stable` were never accessed.
`cleanup.json` records these checks.
