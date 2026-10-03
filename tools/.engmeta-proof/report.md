# Engine / Metadata root-cause proof: OPS-845 and OPS-846

2026-10-03. Isolated checkout initially at `54fa3be`, .NET 10, API port **3965**.
No Engine, API, Targets, Library, Store, Check or web code was changed.
Only Metadata and the existing local proof Seeder were changed.

## OPS-846: fixed and verified

**Root cause:** Metadata's name resolver treated a missing provider release year
as a different known release year. Real TMDB `/search/movie` returns two exact
`Big Buck Bunny` names:

| TMDB ID | Release date | Detail runtime | Detail title |
|---|---|---:|---|
| 10378 | 2008-04-10 | 8 minutes | Big Buck Bunny |
| 1627969 | empty | 0 minutes | Big Buck Bunny |

The second entry's description is `Honestly I don't know what to put here but ok`.
Both titles have exact name-match score 1.0. The old resolver compared
`2008 != null` and returned `ambiguous`; the watchlist API then returned its
generic 502 message. This is **not** a short-film/runtime filter or a missing
TMDB detail: explicit provider identity `tmdb:movie:10378` worked before the fix.
Sintel has one TMDB search hit (45745, 2010-09-30) and therefore worked.

**Fix in the owning module:** prefer a dated candidate over an equally matching
undated candidate; detect ambiguity from **distinct confirmed years across all
top-scoring matches**, rather than treating null as an extra year. Explicit year
filtering and explicit identity resolution remain unchanged. Provider cards are
not merged, invented or blacklisted, and there are no retries.

Real HTTP evidence:

| Case | Before | After |
|---|---|---|
| Name-only Bunny watchlist POST (`externalId=10378`, no provider) | 502, 100 ms warm; also 502 with a slug workKey | 200, correct `tmdb:movie:10378`, 2811 ms cold |
| Fresh-directory Bunny save, then two duplicates | failed before | 3/3 HTTP 200; 3513 / 75 / 36 ms; `existed=false,true,true` |
| Explicit TMDB Bunny identity | 200, 3462 ms | preserved |
| Name-only Sintel control | 200, 181 ms | 200, 977 ms |
| Ambiguous `The Thing`, no year | protected | 502, no title saved |
| `The Thing`, explicit 1982 | protected | `known=true`, 1982 |
| Bunny, wrong explicit year 2009 | protected | `known=false`, not silently resolved to 2008 |

Raw real-provider responses: `bunny-search-provider.json`,
`bunny-detail-provider.json`, `bunny-undated-provider.json`,
`sintel-search-provider.json`. HTTP responses are in `watch-*`, `fixed-watch-*`,
`fixed-year-*`, and `final6-bunny-name.json`.

## OPS-845: proof-tool defects corrected; historical 408 remains unproven

**Proven tooling defects:** the original `tools\.jelly-proof\Seeder\Program.cs`
hardcodes API **3973**, while the webjelly2 copy hardcodes **3972**. Both silently
swallow connection failures. A fully hashed seeder therefore does not establish
that it is discovering the intended TorrentFlow instance. Both also inject
every hash before the receiving engine has registered that hash. With an
unrelated listening metadata manager, the instrumented original tool logged
`EncryptionNegiotiationFailed` and `HandshakeFailed` for the absent movie hashes.
These were rejected pre-registration handshakes, not evidence that the film
bytes were missing or corrupt.

**Fix is in the proof Seeder, not Engine:** require an explicit loopback API URL;
read that instance's current BitTorrent port and registered active hashes;
advertise only the corresponding local movie peer, stop when that hash is no
longer active, fail on incomplete fixtures, and report discovery failures.
The existing advertisement loop is retained through metadata-to-payload
transition. No API admission retry, longer timeout, tracker substitution,
encryption change, DHT change or new Engine mechanism was added.

**Important limitation:** the owner's three historical 408s were **not
reproduced**. No report or server/seeder request logs exist in webjelly3's
artifact directory, so the precise tool binary/API endpoint used there cannot
be reconstructed. Instrumented, correctly addressed original-tool controls
succeeded **6/6**: immediate injection (2.484 / 1.005 s), aged early injection
(2.319 / 1.023 s), and an already-listening unrelated manager with 42 seconds of
premature handshakes (2.547 / 1.004 s). These controls disprove a claim that early
injection alone necessarily produces 408. OPS-845 must remain
**needs_verification**, not be represented as a proven Engine timeout fix.

### Final corrected-tool proof: 6/6 consecutive cold filings

Three separate fresh data directories and fresh library roots, with the same
seeder staying up across server restarts and new BitTorrent listen ports.
No cached torrent metadata was reused between rounds. Only Sintel and Big Buck
Bunny were fully transferred.

| Attempt | Film | POST status | Admission wall time |
|---|---|---:|---:|
| final5-1 | Sintel | 200, accepted | 2.030 s |
| final5-2 | Big Buck Bunny | 200, accepted | 1.005 s |
| final6-1 | Sintel | 200, accepted | 2.017 s |
| final6-2 | Big Buck Bunny | 200, accepted | 1.006 s |
| final7-1 | Sintel | 200, accepted | 2.024 s |
| final7-2 | Big Buck Bunny | 200, accepted | 1.005 s |

All three rounds completed **2/2 actual library filings**, not merely accepted
requests. Both complete files' SHA-256 values independently matched their full
seed fixtures in the final round (`final7-digests.json`): Sintel 129,241,752 bytes;
Bunny 276,134,947 bytes. Each round reached two media records approximately
18.3 / 18.9 / 18.5 seconds after the admissions. Final admission median:
**1.512 s**. Per-second real engine observations are retained in `final?-?.json`.

A rejected intermediate experiment advertised only once per port: metadata
worked, but Sintel stalled after the receiver's metadata-to-payload stop/rebind.
That experiment was discarded; it is not the final tool or counted in 6/6.
This confirms why ordinary peer discovery must remain available across the
receiver's manager lifecycle, rather than replacing it with one-shot injection.

## Build, review, scope and safety

- Final API and Seeder builds: **0 warnings, 0 errors**. No unit tests were added.
- Self-review checked match ordering, all tied confirmed years, strict explicit
  years, real remakes, full byte delivery, cross-restart discovery and file hashes.
- Runtime startup emits existing EF migration warnings and a missing-web-build
  warning; these are not build warnings and were not changed outside ownership.
- The TMDB credential was read into child processes only, never arguments,
  evidence, logs, source files or commits.
- Fixtures were **copied**, placed directly in the proof seed folder, never moved.
- Live API 3930 / PID 3188 and `D:\code\memtest\stable` were not touched.
- Only changed code, tool source and proof evidence are copied to branch `rebuild`.
  The foreign `tools\.gitignore` change is left alone.
- Cleanup: stop the literal owned PIDs, delete all created seed/cache, fresh data
  and library directories, and remove the isolated worktree. Keep proof evidence
  and the requested compiled output. Final cleanup confirmation is recorded below.

## Commits and completed cleanup

- **74ea94c**: Metadata root-cause fix and module documentation, `Refs: OPS-846`.
- **5474d1b**: corrected proof Seeder and usage documentation, `Refs: OPS-845`.
- No Co-Authored-By trailers, no unrelated files staged, and no push performed.
- At 21:34 local time, verified no listener on 3965, no `wt-engmeta` worktree,
  and no `engmeta-data*`, `engmeta-library*` or seeder-bin directories. The seed
  payload copies were inside the removed worktree. Only requested
  `D:\code\memtest\bin-engmeta` remains.
- All created server/seeder PIDs were stopped explicitly; last owned server
  **27656** and last seeder **59644** are stopped. Original fixtures and the
  foreign ignore-file edit remain untouched.
