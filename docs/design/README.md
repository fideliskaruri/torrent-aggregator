# TorrentFlow backend rebuild: Phase 1 design

**OPS-658 / FEAT-35**. Design for coordinator review; no backend implementation except
compilable Domain types. Existing web/API remains. Sources: full rebuild-plan,
architecture-rethink, rules, behaviour-inventory, source-audit, captured API contract,
old EF mappings and read-only 3930-copy database inspected 2026-10-03.

| Document | Implementation responsibility |
|---|---|
| [1.1 Data model](1.1-data-model.md) | 35 application tables, fields/keys/write boundaries, intent/evidence/folder/path claims |
| [1.2 State machine](1.2-state-machine.md) | complete transitions+diagram, swap/stall/cap/restart/remove/owned/requests |
| [1.3 Interfaces](1.3-interfaces.md) | module contracts/dependencies, typed Store and settings, unchanged 93 HTTP routes |
| [1.4 Concurrency](1.4-concurrency.md) | audited sources/queues, search feedback/cache, measured Check, scheduler/calendar |
| [1.5 Library layout](1.5-library-layout.md) | actual Jellyfin naming, partials, roots, import/scan/delete/upgrade |
| [1.6 Migration](1.6-migration.md) | all 25 old tables+JSON/artifacts, 27 engine rows, payload proof and rollback |
| `backend\src\Domain\` | enums, immutable records for all 35 tables and typed module messages, 11 interfaces |

## Precedence and resolved defaults

Latest owner rules in rebuild-plan/rules override historical behaviour. In particular:
English first **including anime**; only clear foreign refused; all aired packs compete
with singles immediately; explicit quality is hard floor; no stage/English-proof hold;
seeding stops even for imports; imported/adopted/downloaded Owned looks identical.

| Ambiguity | Chosen default and reason |
|---|---|
| 19 draft tables vs later scope | 35 normalized tables, including ScopeIntent, RawIntent, UpgradeEvidence, WorkFolder and FilePathClaim; no Attempt work queues |
| Anime requested name vs today's layout | logical Anime; preserve physical **Anime Series** and item-folder pins; new roots use installation's existing folder names |
| “One engine row per target” vs safe replacement | fetching remains authoritative during swap; one Current+temporary Replacement, 20 min proof deadline, one slot; old partials retained until completed/progress+Good proof |
| Unknown swarm vs healthy selection | Unknown != Dead; exhaust good/weak/names; metadata-wait max 3/target outside cap, no payload; wanted Unknown TTL 45 min; .torrent file lists without peers |
| Requested quality vs nearest-below draft | explicit requested resolution hard floor; below only if no explicit floor; owner rule wins |
| 10-second early rethink probe vs later plan | 20-second total attachment+measurement, stop early on good proof |
| Swarm throughput without playback | 64 KiB/s +256 KiB over >=4 s, positive less=Weak; tunable benchmark defaults, no playback bitrate |
| “Almost no progress” | <1 MiB/10 active minutes and <=2 KiB/s in final minute; paused/capped/window time excluded |
| Background budget vs no owner rate limit | concurrency budget (2 background scopes/8 adapters), no global per-minute quotas |
| Source cooldown caps | default no-header 429 starts 30 s, caps exponential 300 s; honor larger valid Retry-After, skip not wait |
| Schema-only baseline vs real payload | actual copy lacks named final/stage hash dirs; do not call parked rows verified/owned without explicit copied payload |
| JSON file count | seven named side stores plus observed anime-map metadata sidecar, optional legacy retry journal; all reconciled |
| Unknown import metadata | review, no changes until confirmation; unknown facts NULL; no ffmpeg dependency or unknown-English wait |
| Follow/watch/preferences overlap | Follow auto-wants, WatchItem saved catalog/notify-only upgrades, WorkPreference one per-title policy |
| Idempotency without extra job truth | atomic Attempt receipt, CAS+durable leases; one Target per actual item across all users |
| Pack file completion | option (a) Engine drains/unselects/rebinds after all touching pieces complete; retain final binding for recovery; option (b) whole selected set if engine proof fails |
| Empty mounts and missing files | root marker+volume identity, >10% or >20 mass-vanish guard; two valid scans >=6 h apart before any reacquisition |
| Joint commit ownership | Library/Check return unsaved rows; Targets commits joint effects with enumerated Store capability exceptions |
| Live cutover | identity path map for real roots; scheduler paused until full scan+owner import review; exact-path Confident auto-adopt only; rollback tidy/promotion fenced |

No owner input needed to draft. Tuning constants and the shared MonoTorrent probe isolation
must be **verified in Phase 3**, not assumed proven. Raw Add torrent remains owner-explicit,
safety-checked, governed by RawIntent; explicit-folder completion enters import Review,
not fake catalog ownership.

## Inventory coverage

All **20 LOST IN PORT** entries and **15 known bugs/risks** are mapped below. “Designed”
is not “ported” or “runtime verified”; future phase gates tick the original 373 checkboxes.
Historical streaming/ffprobe/retention omissions are deliberately dropped per owner rules.

### LOST IN PORT (20/20)

| # | Inventory behaviour / source symbol | Design home | Outcome |
|---|---|---|---|
| L01 | attach fresh probe, delivered bytes/sending peers (`probeSwarm`) | 1.4 Check and ranking; IEngine probe capability | Restore in shared production engine |
| L02 | no reached/connected peers = Unknown (`classifySwarm`) | 1.4 evidence bands/metadata wait, 1.2 T10/T39 | Design corrected: actionable bounded Unknown wait; Phase 3 runtime proof pending |
| L03 | connected zero-byte peers = Dead (`classifySwarm`) | 1.4 full-window evidence table | Restore measured-window rejection, not listed-zero inference |
| L04 | enough delivery Good, insufficient positive Weak (`classifySwarm`) | 1.4 throughput defaults | Restore without playback threshold |
| L05 | early stop sufficient throughput (`runFreshProbe`) | 1.4 4-second minimum/metadata-wait path | Design corrected: early health stop plus separate bounded metadata wait; Phase 3 proof pending |
| L06 | reuse live measurements without changing manager (`probeSwarm`) | 1.4 capability/live-read rules; IEngine | Restore read-only |
| L07 | fail closed on uncertain liveness, cleanup only created handle (`probeSwarm`) | 1.4 isolation; 1.3 ProbeHandle | Restore with ownership token |
| L08 | caller abort never persisted (`probeAndRecord`) | 1.1 Verdict; 1.4 cache rules | Restore |
| L09 | normalized hash, human release name persisted (`recordSwarmMeasurement`) | 1.1 Release+Verdict; IParser.NormalizeInfoHash | Restore without duplicated name in Verdict |
| L10 | live snapshots not reusable probe measurements (`probeAndRecord`) | 1.4 FromLiveTransfer/Persistable; 1.1 Verdict | Restore |
| L11 | bulk expired/missing/invalid -> Unknown (`loadSwarmVerdicts`) | 1.4; ICheck.LoadAsync | Restore |
| L12 | recent named measurements with expiry correction (`listRecentSwarmMeasurements`) | 1.4; ICheck.RecentAsync | Restore |
| L13 | required playback bitrate+headroom (`requiredBitrateBps`) | 1.4 Good/Weak thresholds | Change to download-delivery evidence; no player |
| L14 | pre-rank by fresh measured verdict (`orderByVerdict`) | 1.4 Plan lexicographic ranking | Restore in one pure Plan |
| L15 | memo pre-ranked choice by target/quality (`getPreRanked`) | 1.1 no stored pick memo; 1.4 pool reuse/policy key | Change: reuse pool+verdict, recompute Plan against current facts |
| L16 | latest cached search by normalizedQuery (`getPreRanked`) | 1.1 SearchCache index; 1.4 cache lookup | Restore without guessed producer key |
| L17 | warm options equal speculative grab (`prewarmSearchOptions`) | 1.3 SearchRequest; 1.4 flight identity | Change: one shared Find contract, no warm-specific policy copy |
| L18 | bounded nonoverlap pre-rank/pre-probe timer (`runPreProbeTick`) | 1.4 worker budgets/speculative timing | Change: PipelineWorker responsibility, no fourth hosted service |
| L19 | skip live and fresh verdicts including Unknown (`preProbeUpcoming`) | 1.4 speculative checks+TTL | Restore |
| L20 | off/watching/monitored scopes (`resolvePreProbeScope`) | 1.4 ProbeScope; Follow/WatchItem | Change: saved tracking intent, not removed playback state |

### Known bugs and hazards (15/15)

| # | Inventory known bug | Design handling |
|---|---|---|
| B01 | Inflated dedupe health | 1.1 ReleaseObservation+Verdict; 1.4 conservative counts (no max) |
| B02 | Real swarm check lost | 1.4 required measurement before choice; 1.3 ICheck/IPlan evidence |
| B03 | Advertised 6 s not end-to-end | 1.4 per-source enqueue deadline, no patient inline waits/retries; distinguish whole pipeline |
| B04 | Destructive replacement ordering | Design corrected in 1.2 T21-T24/T40 and 1.5: fetching swap/deadline/slot, retained old partials until sustained proof; Phase 4/5 runtime proof pending |
| B05 | Manual selection not durable | 1.1 DownloadFile.selected; 1.2 T35; 1.3 persist before SelectAsync/recovery |
| B06 | Same-episode flight loses policy/cancellation | 1.2 acceptance revision; 1.4 policy-independent HTTP flight + per-waiter Plan/cancellation |
| B07 | Unknown language held after failed Pass | 1.2 no English-hold states; 1.4 only explicit foreign rejected; 1.6 drops stale hold |
| B08 | Retry/why lost on restart | 1.1 Target.reason/nextTry/misses/rank; 1.2 recovery keeps them |
| B09 | Unstable listen port | 1.1 Setting.engine; 1.4 choose/save before bind, save fallback |
| B10 | Policy lag (packs/English/staging) | 1.4 finished pack+single competition, 1.5 direct partial paths, 1.6 no legacy hold/fallback flag |
| B11 | Duplicate HTTP work risk OPS-654 | 1.4 Lazy<Task> inserted before starting shared work, identity-guarded cleanup |
| B12 | Import verification gap OPS-655 | 1.5 signature+changing-file checks before ownership, all import modes reviewed |
| B13 | Duplicate replacement OPS-656 | 1.5 collisions/duplicates review, no same-size overwrite or implicit deletion |
| B14 | Unreadable subtree concealed OPS-657 | 1.5 scan coverage incomplete, no Missing/deletion inference or zero allocation |
| B15 | MonoTorrent 3.0.2 per-hash piece contamination hazard | 1.4 explicit drain/invalidation+recheck or ownership transfer; Phase 3 blocked without proof |

Source audit follow-ups also covered: OPS-652 wrong-season EZTV responses are independently
checked by Parser/Plan; OPS-653 malformed RSS stays an explicit source error, not empty success.
API baseline OPS-648 requires explicit status/schema resolution at implementation review.

### Remaining inventory families (373 total behaviours)

| Inventory family | Design allocation / intentional changes |
|---|---|
| Domain | 1.1 stable identity/names/links/item keys; 1.3 immutable file/live/unknown contracts |
| Parser | 1.3 IParser fields; 1.4 metadata/size/year/floor gates; corpus gate retained |
| Plan | 1.4 health-first set cover, exact episode/file/safety/sidecar/piece mapping; no codec-for-player ranking |
| Metadata | 1.1 catalog/link/cache; 1.3 providers/shared season shape/browse; 1.4 naming/calendar |
| Sources | 1.4 all adapters/tier settings/host isolation/real cooldowns; 1.3 raw-only port |
| Engine | 1.3 IEngine; 1.4 limits/stalls/listen/resume; 1.2 instant cap/removal; 1.5 no staging |
| Check | L01-L13 above, 1.4 all evidence/cache/ownership safety |
| Find | L14-L17 above, 1.4 shared pool/cache/deadline/English-first; no alternate swap path |
| Library | 1.5 exact naming/claims/scan/import/root/presence/delete/operation recovery |
| Store | 1.1 constraints/owners/retention; 1.3 CAS transactions; 1.6 consistent backup/idempotency |
| Targets | 1.2 all transitions/requests/ownership; 1.4 schedules/windows/fresh release/speculation |
| Api | 1.3 all 93 routes, trusted access, user projections, settings, desktop, outbox; 1.2 requests |
| Cross-cutting | 1.3 host/static/API404/UTC/readiness/access; 1.5 traversal/physical paths; 1.6 backup/rollback |

## Phase 1 evidence and next gate

`dotnet build backend\TorrentFlow.Backend.slnx`: net10.0, nullable enabled,
warnings-as-errors, **0 warnings / 0 errors**. No unit tests added. Domain has no package/
project references or implementation bodies. Root Directory.Build.props enables NuGet
lockfiles; Domain's generated packages.lock.json contains an empty net10.0 dependency set.
Static checks confirmed 373 inventory behaviours, 20/20 LOST IN PORT rows, 15/15 bug/risk
rows, 35 typed Store records, 11 interfaces, all 25 migration tables and all 349 observed
old columns field-by-field, all 27 engine hashes, and valid relative documentation links.
Evidence is recorded on OPS-658; these
are static design checks, not future API or
filesystem runtime evidence. Neither 3930 nor 3931 touched; no commit.

Phase 1.7 critique produced **BL1-BL4, M1-M14, N1-N9**; all 27 have design/Domain resolutions
recorded at the end of [critique](critique.md). This is static design resolution, not
implementation or engine/filesystem verification. B04/L02/L05 are corrected in the design
but unverified, not “restored” at runtime. Required Phase 3/5 pack-rebind/restart and hash
handoff gates may force documented option (b); live migration/root scans/rollback are
future proof, not completed migration.

Coordinator verification must challenge schema/state/signature consistency, whole
373-behaviour port coverage, raw-add compatibility, shared probe isolation, real copied
payload availability and the bounded runtime defaults. Owner approves Phase 2 only after
that review. Do not turn design-default measurements into claims of measured performance.
