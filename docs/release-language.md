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
