# Plan

`ReleasePlanner : IPlan` is pure and references Domain only. It never resolves metadata,
parses names, reads files, probes a swarm, downloads, or persists a choice. Targets'
`PlanComposition` supplies Parser results for hash-bound file names and sidecar folders.

## Input and policy

- Supply complete `WorkSnapshot`, canonical targets, current owned videos, hash-scoped
  evidence and blocks. Candidate coverage from Find is not trusted as episode mapping.
- Target preferences override the optional matching `WorkPreferenceRow`. An explicit
  resolution floor and size cap are hard gates; preferred resolution is not a floor.
- `QueriesExhausted` defaults to false. Unknown health cannot be selected until this
  is true and a complete safe file list exists. Eligible Good/Weak alternatives always
  win. An Unknown assignment says **Waiting for seeders**; it is not measured healthy.
- A missing/expired verdict becomes Unknown. Dead within its measured validity is never
  selected. Check remains responsible for classification and validity windows.
- Release-name quality takes precedence; when omitted, every selected video must have a
  known parsed resolution before the minimum selected-video resolution is used.
- Unknown language and DUAL/MULTI releases pass without further work. Explicit
  incompatible language is refused, including before file-list availability.
  An explicit `any` policy disables this language gate for both release names and
  selected files; it does not disable safety, quality, identity or health gates.
  Target audio preferences override matching work preferences; missing/auto preferences
  default to English, never the work's original language. Callers must resolve the
  configured global setting into the target policy before invoking this pure planner.
- Owned items, including offline and not-yet-confirmed-missing videos, are excluded
  and are not reported as uncovered.

## Ordering and files

Hard gates precede lexicographic ordering: Good, Weak, Unknown; byte-sending peers;
measured bytes per second; exact preferred resolution, nearest above, nearest below
(unless a floor bars it), unknown; source quality; equivalent-rank missing-item coverage
and union-piece cost; recency; conservative listed seeds; stable hash.

Packs require a finished, confirmed season. Mapping uses exactly one catalog-confirmed
episode per video, excludes samples/extras/ranges and refuses duplicate episode videos.
Seasonless pack videos require a unique confirmed absolute mapping. A pack may cover
only part of the scope; remaining episodes stay uncovered. Other-season videos,
programs, archives and disc structures reject the pack.

Only missing items' videos and associated subtitle/audio sidecars are selected. Programs
anywhere in the torrent, including skipped files and Windows-trimmed double extensions,
are unsafe. Comics/images and archives-only lists cannot establish video eligibility.
Selected-item size caps include sidecars; bitrate plausibility is per video/runtime.

`PlanFileMetadata.PieceLength` allows exact union-of-touched-piece reservation, including
shared boundaries. Without geometry the planner conservatively reserves the whole
torrent, not a potentially understated sum of selected bytes.

All rejected candidates/items keep codes and plain text. Eligible alternatives not chosen
receive `lower_ranked`/`healthier_alternative`; every uncovered item gets `uncovered_item`.
Assignments explain measured health, quality fit, source and missing-item coverage.

## Isolated developer API and proof

In Development only, trusted loopback owners can:

- `GET /api/dev/plan-eval/metadata?workKey=...`: fetch the actual Domain snapshot.
- `POST /api/dev/plan-eval/`: `{ "workKey": "...", "input": <PlanInput> }`.
  Omit workKey to use the supplied snapshot (or ExplicitRaw). Resolving workKey replaces
  only `input.work`; target IDs must belong to the resolved snapshot.
  File parsing is supplied by Targets, not trusted caller-provided parses.

This is evaluation only, not task 3.6 Find/Check/Plan orchestration or admission.
Start the isolated API on port 3949 with its own data directory, then run
`python tools\bench\plan-proof.py`. Evidence lands in gitignored `tools\.plan-proof`.
Recorded Find names/hashes/parses and fresh metadata are real; all file lists, verdicts,
piece geometry and ownership are explicitly synthetic. Sintel and Big Buck Bunny's
recorded pools lack labelled 1080p variants, so their filename-quality evidence is also
explicitly synthesized. This proof establishes planning behaviour, not swarm health
or actual payload quality.
