# Release ranking

How the app decides which of ~40 search results to hand to the download engine.

This is the single most consequential piece of logic in the codebase: every
automated grab, every "Best" badge, and the order of every search page comes out
of it. It is also where the app's worst shipped bug lived.

## The bug this replaced

Ranking used to be an **additive score** (`ranking.ts`, before this change):

```ts
score += Math.log10((r.seeders ?? 0) + 1) * 25;   // ≈ 92 at 5,000 seeders
if (tags.includes("1080p")) score += 6;            // a rounding error
if (tags.includes("2160p")) score += 4;
if (tags.includes("hevc"))  score += 2;
```

Seeders were worth up to ~92 points. Resolution was worth 6. So a well-seeded
480p beat a modestly-seeded 1080p and automation grabbed it — which is exactly
what the user observed.

This was not a rare tie. Small, badly-encoded files are precisely what thousands
of people seed, so the failure was the *common* case on public indexers.

### Why "just raise the 1080p bonus" is the wrong fix

It is the tempting one-line fix and it does not work. **Every weighted sum has a
crossover point.** Whatever constant is chosen, some seeder count buys a
resolution downgrade:

| 1080p bonus | 480p wins once it has roughly… |
|---|---|
| 6 | 1.7× the seeders |
| 30 | 16× |
| 60 | 250× |

Public indexers produce 250× seeder gaps routinely (a 20,000-seed movie rip vs a
80-seed episode). Re-tuning moves the crossover; it never removes it. The named
unforced error here is *"keeping the additive score and just re-tuning the
numbers."*

## What it does instead

Quality is **not a term in a sum**. Releases are compared by a chain of
predicates where the **first non-zero comparison wins outright**
(`src/lib/torrents/quality.ts` → `compareReleases`):

| # | Key | Why it sits here |
|---|-----|------------------|
| 1 | **relevance** | The wrong show is wrong at any quality. |
| 2 | **junk / implausible** | A camcorder rip or a 40 MB "1080p" is worse than anything legitimate. |
| 3 | **viability** (seeders ≥ 3) | A release that cannot finish is worth less than one that can. |
| 4 | **resolution affinity** | The reported bug. Above seeders, so no swarm size can buy a quality change. |
| 5 | **seeders** (bucketed `round(log10 n)`) | Breaks ties between comparable releases only. |
| 6 | **recency**, then **size** | Final tiebreaks. |

Because it returns on the first non-zero comparison, **no term can ever
compensate for another**. That is the property the additive score lacked.

This is not a novel design: Sonarr, Radarr, FlexGet, autodl-irssi and
qBittorrent's RSS engine all express quality as an ordered comparison or a
reject predicate, and none of them adds it to a seeder score — five independent
implementations across three languages. Sonarr's `DownloadDecisionComparer` is
literally `comparers.Select(c => c(x, y)).FirstOrDefault(r => r != 0)`, with
seeders only 7th and quantised to `Math.Round(Math.Log10(n))`.

## Resolution is a *target*, not a ladder

`resolutionAffinity(res, target)` — default target **1080p**.

"More pixels is better" is the mirror image of the original bug. It makes a
10-seeder 2160p beat a 900-seeder 1080p, and a 4K release is routinely 15–60 GB:
on a home connection that is hours of transfer and tens of gigabytes of disk for
a file nobody asked for. Grabbing 2160p when 1080p was wanted is just as wrong
as grabbing 480p — it simply fails in the expensive direction instead of the
ugly one.

So the target wins outright and everything degrades away from it:

```
1080p  >  720p > 576p > 480p > 360p  >  2160p  >  unknown
└ target ┘  └── graceful downgrades ──┘   └ oversized ┘
```

Above-target sinks below *all* below-target options, because oversized should be
an explicit choice (raise the target) rather than something automation does on
the user's behalf. A user who wants 4K sets the target to 2160 and 2160 becomes
the exact match — the rule needs no special case.

## Nothing here rejects anything

`rankResults` returns **every** input release, reordered. This is load-bearing:

- Ordering cannot return an empty list, so it cannot starve a monitored show.
- It therefore cannot trip `advanceCursorAfterMiss` (`library/cursor.ts:66`),
  which rolls the cursor to the next season after 3 misses. A hard resolution
  floor would have made a 720p-only show roll `S01E12 → S02E01` and never
  download again — silent data loss.
- It needs no blocklist or stall handling to be safe.

A hard floor is reserved for something the user sets explicitly, and even then
it must not be counted as a miss.

### Related: thin swarms are skipped without being counted as a miss

`automation/runner.ts` refuses to grab a release below `MIN_VIABLE_SEEDERS`,
because this app has **no stall detector and no blocklist** — a dead grab sits at
0% forever while the dedupe check reports "Already sent this release".

Crucially that skip is *not* a hunt miss. A miss means "this episode does not
exist"; here the episode plainly does exist, it just is not seeded yet, which is
the normal state of a release in its first minutes. Holding the cursor means the
next run picks it up once peers arrive.

## Deliberate trade-off: the one case a lower resolution wins

Viability is compared **above** resolution, so a 2-seeder 1080p loses to a
500-seeder 480p. This is intentional and it means the guarantee is:

> Among **viable** releases, no lower-affinity resolution ever outranks a higher
> one.

not the stronger "1080p always beats 480p". Ordering purely by resolution would
grab a 1-seeder 1080p that never finishes — a worse bug than the original, since
the old behaviour at least produced a watchable file. A watchable 480p beats an
unwatchable 1080p. `quality.test.ts` asserts both halves of this explicitly.

## One parser, one answer

`extractTags` (the UI chips) and `compareReleases` (the ordering) both call
`parseResolution`. They previously disagreed — `extractTags` did a naive
uppercase substring match while the ranker parsed properly — so a card could
display "1080p" on a release the ranker had read as something else. A test pins
them together.

The parser is ported from Sonarr's `QualityParser.ResolutionRegex`, including
its deliberate quirks:

- `1440p` and `FHD` fold into 1080 (1080-class, not a tier anyone encodes to).
- `4kto1080p` is **1080**, not 2160 — it is a downscale.
- bare `4k` is **not** a resolution token. It is marketing text that appears in
  the titles of 1080p files; only `[4K]` and `4k-UHD`/`4k-HEVC` count.
- Unknown resolution (`null`) is normal and common — plenty of Nyaa titles like
  `[Erai-raws] Show - 05` carry no token. Unknowns rank low but are never
  dropped, or the primary anime indexer starves.

## Sizes: demote, never reject

`isImplausible` only catches something claiming HD in under **50 MB**. A flat
"1080p must exceed 300 MB" rule misfires on legitimately short content — a
12-minute anime episode or an OVA at 1080p sits around 150–250 MB. Runtime is
not stored anywhere in this app, so a proper MB-per-minute bound (Sonarr's
approach) cannot be computed honestly; a hardcoded 45-minute assumption would
reject every movie and every season pack. Wrongly discarding a real release is
worse than ranking a fake one low, so the result is a demotion.

## `score` is a positional encoding, not a sum

`groupReleases` and the search API sort by `score`, so `score` must never
disagree with the comparator. `encodeScore` is therefore *positional*: each
field's multiplier exceeds the largest total every lower-priority field can
contribute, so a lower-priority field can never compensate for a higher one —
the same property the comparator has. A test asserts `score` is monotonically
non-increasing across the comparator's own output.

## Where this is enforced

`searchTorrents` runs `dedupe → applyFilters → rankResults`
(`aggregator.ts:162-166`) and **all four grab sites call it**:

- `automation/runner.ts` (library hunt)
- `rules/runner.ts` (auto-rules)
- `watchlist/check-releases.ts`
- `library/ondemand.ts`

So there is one ordering, shared by automation and the Search UI, and no
call-site migration was needed.

## Tests

`src/lib/torrents/quality.test.ts` is written as **properties over a matrix**,
not examples. An example test ("1080p beats 480p at 500 vs 50 seeders") passes
happily against a score that still breaks at 5,000 vs 5. The suite sweeps the
seeder ratio across four orders of magnitude
(`[3, 5, 12, 40, 150, 800, 2500, 20000]`, all pairs) precisely so that a
reintroduced sum cannot pass.

It also pins the traps that are easy to reintroduce:

- `\bcam\b` must not fire on *Camp Cretaceous*, *Cameron*, *Scam 1992*, *Camelot*.
- `DV` must not fire on `DVDRip` (that would claim Dolby Vision on a DVD rip).
- The `SxxEyy` token in an automation query must be stripped before computing
  relevance — otherwise `[SubsPlease] One Piece - 05 (1080p)` drops a relevance
  tier while a scene-formatted `One Piece S01E05 480p` sits above it, and the
  480p wins on filename format alone.
- There is deliberately **no "exact title" relevance tier**: `normalizeTitle`
  already strips quality tokens, so "exact" would only mean "carries no
  release-group prefix", which is a scene-naming convention rather than evidence
  of relevance.
- The comparator must be a valid total order (antisymmetric and transitive), or
  `Array.prototype.sort` is undefined behaviour.
