# English audio or subtitles: staged downloads and one gate

Status: approved with the recommended defaults (owner away, 2 Oct): files with no language tags are held for the owner, a no-English automatic pick is deleted and replaced, external subtitles are a later lane, T6 merged as the base. Research and critique: OPS-600.

Progress: E1 (OPS-603) built the "what counts as English subtitles" part of P2: track roles (Full, SignsSongs, Forced,
Commentary, Unknown) kept on the verdict, the name beating the forced flag (a lone forced English track named for its
language is full, as SubsPlease ships it), commentary and audio description tracks never counting as English, hard-sub
markers (`English Hardsub`, `HC`, `hardcoded subs`) surviving the header, `und` tracks named by language, one judge
(`ReleaseLanguage.Verdict`, `JudgeRelease`) used by the file-list check, the header probe, the season pack check (each
mapped episode with its own closure, the name alone only when nothing maps), the picker and the swap dialog, and the
per-video sidecar closure (`VideoSidecars.Of`: generic sidecars only for a torrent's one video, samples aside; per-episode
folders and episode keys; NFC names), which season pack selections now download with each episode. The gate on the
finished files (P2) calls the same judge. Rules and real examples: docs/release-language.md, "Track roles and sidecars".

Owner rule: an automatic pick must have English audio or English subtitles. A hand pick always goes.

## What we want
- P1 Correct: no automatic pick reaches the Jellyfin library unless its files are confirmed English.
- P2 Cheap: don't download a whole release to learn it isn't English.
- P3 Fair: a release whose name says nothing is unknown, not no.
- P4 Never stuck: every check has a deadline and an exit.
- P5 Simple: one owner per decision, few states, restart-safe.

## Why it keeps breaking
The check runs beside the download and nothing waits for it. When the check is slower (small file, fast swarm, slow
or crashed probe, restart), the download wins and the check tries to undo it. Five of the six review bugs are that one
race. The sixth is a second chooser (Find the best one) that forgot the rule.

Facts behind the design (code on feat/english-rule, MonoTorrent 3.0.2, live checks):
- 249 of 266 owner grabs were magnets: no file list until metadata, and payload starts right after it.
- Downloads write straight into the library folders. Jellyfin can see half-downloaded files, junk, and a no-English
  release until something deletes it. A finished row is marked downloaded (VerifiedAt, Progress 1, Open allowed)
  before the layout step runs.
- The layout step validates containers but never reads languages. The track parsers (Matroska SeekHead to Tracks,
  MP4 moov anywhere) exist and work on local files.
- The verdict model drops track names and forced flags, so a "Signs" or "Forced" English track counts as English
  subtitles.
- Season packs select video files only, so their sidecar subtitles are never kept; and the file-list check reads every
  file in the torrent, so an unselected English sidecar can pass a foreign selected episode.
- Swaps, recovered rows and rows from before the check have no language state and skip it.
- MonoTorrent can fetch metadata only (`DownloadMetadataAsync`) and set `DoNotDownload` before `StartAsync`.
- AnimeTosho lists each anime torrent's subtitle tracks (language, name, forced) by info hash, before download.
  Live: `[YukiSubs] Sousou no Frieren - 29 (S02E01)` has one subtitle track, Turkish. `[EMBER] ... Dual Audio` has
  "Signs" (default) and "Dialogue".
- OpenSubtitles can find exact-sync subtitles from a file's first and last 64 KiB plus size; searching is free.

## The design: hints first, one gate that decides, files promoted only after it

### 1. Promotion: downloads are staged, the library only gets checked files
- Every transfer has a final path (what the owner sees, today's SavePath) and a stage path:
  `<download root>\.staging\<hash>`, on the same drive, outside every Jellyfin library. Payload is written to the
  stage path.
- States after the payload is complete: Completed, Checking, Promoted (or Held, or Rejected). Open, "downloaded",
  notifications, request Available and Library ready all wait for Promoted.
- Promotion moves the kept files (the video plus its own sidecars) into the final path with Jellyfin names, and leaves
  junk behind (OPS-578, OPS-587, OPS-597 land here).
- Storage accounting includes the staging folder. Stage and final must be on the same volume (a rename); otherwise
  the setting is refused with a plain message.
- Upgrade: rows already downloading keep writing where they are and go through the check before they are counted as
  done; rows already done are left alone.

### 2. The gate: the finished files decide (every automatic pick)
- On completion, read the real tracks from the staged files (local, no network, no race) plus their own sidecars.
- Verdicts, per video file:
  - Pass: an English audio track, or a full English subtitle track (en/eng or BCP-47 en, or named English; not named
    Signs, Songs, S&S or Forced; a forced flag rules a track out only next to another English track that carries the
    dialogue, otherwise it is a display hint, as SubsPlease uses it), or an English sidecar of that video (`.en.srt`, `.eng.ass`,
    `English.srt`, `2_English.srt`; not `.forced.`). Untagged audio counts as English only for a non-anime title
    whose original language is English.
  - Fail: tracks are tagged and none of them is English. Anime with no subtitle track, no sidecar and no
    English-tagged audio is a raw (Fail), unless its name says English dub.
  - Unknown: tags missing or `und` with no telling names.
- Pass: promoted. Fail: not promoted; the release is blocked, its staged files deleted, the finder picks again. Row:
  "No English in this release. Looking for another." Unknown: see decision 1.
- Season packs: each episode file is judged with its own sidecars. Passing episodes are promoted; failing ones are
  queued again on their own; if most fail, the pack is blocked.
- Hand picks: always promoted; the result is shown on the row, never acted on.
- Swaps, requests, retries and recovered rows carry provenance (automatic or hand) so none skips the gate.

### 3. Hints before and during the download (save bandwidth, never decide)
- Ranking hints before the pick: name, site category, group; AnimeTosho track data for anime (cached per hash; misses
  retried with backoff, since fresh episodes take minutes to process); file lists from `.torrent` links and apibay;
  later, learned group profiles scoped by group, show and source, minimum samples, ranking only.
- Preflight for the top automatic candidate only, through one lane-aware queue and one metadata cache shared with the
  existing inspect path: metadata only, then the file-list check on the selected files and their own sidecars, then,
  only if still unknown, a header peek. A clear Fail skips the release before any payload. Anything else adds the
  torrent from the fetched bytes with priorities set before start.
- These steps can only skip a release early. They can never make it pass; the gate does that.

### How each review bug disappears
| Bug | Why it can't happen |
|---|---|
| Fast magnet finishes before the check | The files are only promoted after the gate; nothing races |
| Fail after park | Nothing counts as done before the gate |
| Partial probe passes | Probes are hints; the gate reads the real files |
| Probe crash loop | A failed hint is just no hint |
| Find the best one picks no-English | Swaps go through the same gate; T5 gives one chooser |
| Unknowns not by seeders | Same chooser |

## Options for later (owner decides)
- External English subtitles: OpenSubtitles hash search (exact sync, free to search) or SubDL, writing `Movie.en.srt`.
  Lets a healthy release without subtitles pass. Needs the owner's free API key.
- Audition: preflight the top 2 or 3 candidates at once and measure real peers and speed; commit to the best that
  passes. With T5 and T7.
- SeaDex best-release hints for anime ranking.

## Plan
| Deliverable | Task | Size |
|---|---|---|
| Ship | M0 Merge T6 after its restart fix (parser, verdicts, holds, blocks, picker fixes) | S |
| Promotion | P1 Final and stage paths, promotion states, Open and done-ness after promotion, storage accounting, upgrade reconciliation, provenance on every path | M |
| Gate | P2 Final track check per file with its own sidecars; track roles (full, signs, forced) kept in the verdict model; block, delete, re-pick; per-episode closure for packs | M |
| Filing | P3 Promote kept files with Jellyfin names; leave junk (OPS-578, 587, 597) | S |
| Hints | H1 Preflight for the top candidate (lane-aware queue, shared metadata cache, early Fail only) | M |
| Hints | H2 AnimeTosho tracks by hash; apibay file lists | S |
| Hints | H3 Learned group profiles, ranking only | S |
| Later | X1 External subtitles; X2 Audition (with T5/T7) | M each |

Order: M0, P1, P2 with P3, then H1, H2, H3.

## Decisions (recommended default first)
1. Unknown at the gate (no language tags on the files): hold it in staging with Keep and Find another on the row,
   keep looking for a confirmed release meanwhile (recommended); or promote it with "English not confirmed".
2. A Fail on an automatic pick: delete the staged files and pick another (recommended), or keep them held for a look.
3. External English subtitles as a later lane: yes (recommended) or no.
4. Merge T6 now as the base (recommended), or hold until the promotion work exists.
