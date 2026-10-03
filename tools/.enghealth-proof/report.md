# OPS-836 and the Check side of OPS-751

Started 2026-10-03 20:54 +03. Detached snapshot of `rebuild`, isolated
`D:\code\memtest\wt-enghealth`, output `D:\code\memtest\bin-enghealth`, fresh
`enghealth-data`, port **3965 only**, scheduler disabled. No stable database,
payload, server or PID 3188 was accessed or modified.

## OPS-836: test throttle, not an unreachable Sintel swarm

The reported hash `43f4001de4ab25d521c63684e2b69804193ed9d9` is the
**576,700,012-byte classicalhd 1080p MKV**, not WebTorrent's smaller Sintel
MP4. Native BitTorrent peers can deliver it.

The original “zero verified bytes” snapshot actually shows **7 connected
seeders**, **131,233 bytes/s**, **463,273,984 allocated bytes**, and zero
hash-valid selected bytes. Allocation is sparse, not received data.
The deletion proof script set the whole physical receiver to **131,072 bytes/s**
before its incomplete-download fixture. It only cleared this after its
three-minute absence check and subsequent shared-pack deletion.

The original fixture's Removed timestamp is **20:33:32.097 +03**. Its required
180-second throttle interval therefore continued until at least **20:36:32.097**.
The public Sintel snapshot was taken at **20:36:16.509**: it overlapped that
throttled fixture. `original-control-context.json` preserves this timeline and
the original live transfer; `tools\.tdel-proof\proof.py` supplies the two rate
settings and their ordering. This was a contaminated production control.

### Real native controls and reproduction

| Measurement | Result |
|---|---|
| Cold Sintel Check | Good in a 4.111-second observation; 3 connected peers, 2 connected seeders, 2 byte senders, 425,984 payload bytes |
| Probe integrity qualification | That early sample had **zero complete pieces** and no hash failures. Good measured native delivery, not whole-file verification. |
| Unthrottled Sintel, video index 0 only | 50,331,648 verified selected bytes by 10.068 seconds; all **576,700,012** bytes complete by 60.212 seconds |
| Concurrent Bunny control, indices 0 and 1 | 1,310,720 verified bytes by 5.043 seconds; all **276,135,087** selected bytes complete by 60.212 seconds |
| Controlled 128 KiB/s Sintel repeat | At **120.609 seconds**, **15,679,488 transport bytes**, **7 connected seeders**, **zero verified pieces**, zero verified selected bytes |
| Same manager, throttle removed | Verified pieces appear within **8.066 seconds**; all **576,700,012** selected bytes complete within **44.689 seconds** |

The torrent has **70 pieces**, each nominally **8,388,608 bytes**. With requests
distributed across several native peers, a 128 KiB/s receiver can accumulate
payload in incomplete pieces without completing one during the observed window.
Removing the limit, without changing the release, selection or manager, resolves
the exact symptom. There is no evidence of an Engine picker defect or a falsely
connectable Check verdict. No release-ranking or health-policy change is warranted.

`throttled-transfer.json` includes the peer/seed counts over time, per-peer
payload bytes, choking/interested state, outstanding requests, complete piece
indices, discovery sources and tracker state. For example, the 75-second sample
had DHT **53**, torrent.eu.org **78**, opentrackr **39**, stealth.si **3**, and
PEX **4** newly-added-peer events. These are cumulative event counts, not unique
seeders or tracker scrape estimates. UDP announces delivered peers; gbitt HTTPS
was offline and supplied none. The connected peers are native `ipv4://` seeds,
not inaccessible WebRTC-only peers. The overall WebRTC/native swarm ratio was
not measured and is not inferred.

The TCP listen port accepted a loopback connection (`listen-reachability.json`).
Public NAT/inbound reachability was not measured. Successful native outbound
connections and two full downloads show that inbound reachability was not the
blocking factor in this reproduction.

The initial optional HTTPS `.torrent` URL controls hit a TLS failure and correctly
returned Unknown (`check-cold.json`). All qualified measurements above used the
actual hash, DHT and native trackers, not an unrelated WebTorrent torrent URL.

### Change

Engine diagnostics now expose the **actual physical download limit**, available
peers, connection success/failure counts, newly-discovered peers by source,
last DHT announce, piece size, tracker state/failure and per-peer bytes/requests.
The event observer is drained with manager removal and server disposal.
`TierLastAnnounceSucceeded` is explicitly tier-level rather than a misleading
per-tracker success claim. This makes the same test contamination visible without
guessing that zero verified progress means zero network delivery.

**OPS-836 is resolved as a false production-stall finding caused by the proof
receiver's global throttle.** The actual corrective action was removing that
test limit; no Engine transfer algorithm or Check verdict fix is needed.

## OPS-751: verdict cache works; bounded scope stopping remains in Targets

| Real HTTP check | Cold | Repeat 1 | Repeat 2 |
|---|---:|---:|---:|
| Native Sintel/Bunny Good verdicts | 4,870 ms | 23 ms | Not needed |
| Two real Unknown Bunny candidates | 20,332 ms | **31 ms** | **4 ms** |
| Cumulative physical probes for Unknown controls | 2 | **2** | **2** |
| Unknown cache hits | 0 | 2 | 4 |

The Unknown hashes are `69033cebd0f892bf7e9181b8002923936b9ac604` and
`2f24d03eab998ca672b8c1ef567a184609236c02`. All warm answers have `fromCache=true`;
their measurement timestamps and expiry stay unchanged. Good verdicts retain
the six-hour expiry. Wanted Unknown retains the existing 45-minute policy.

After restarting the final image, a single request for both Good and both Unknown
hashes returned **four cache hits, zero physical probes, zero active/queued
flights** (`cached-after-restart.json`). Check's durable cache short-circuits
repeated probes both within a process and across a restart.

The uncovered 2160p Bunny plans reproduce the reported planner issue:

| Plan | Total | Source HTTP | Completed fresh probes | Submissions | Verdict cache hits |
|---|---:|---:|---:|---:|---:|
| Cold | 31,461 ms | 12 | 4 | 7 | 3 |
| Warm 1 | **28,019 ms** | **0** | 3 | 6 | 7 |
| Warm 2 | **28,013 ms** | **0** | 3 | 6 | 10 |

**Every fresh completed probe in either warm run had no completed measurement in
the preceding run.** It is not a cached verdict being ignored:
`plan-repeat-analysis.json` joins the hashes and prior evidence. The previous
plan's 28-second deadline canceled unfinished checks; they correctly had no
persisted verdict. Each subsequent request starts another bounded scope pass,
reuses every completed measurement, and submits previously unfinished/unmeasured
hashes. No safe Check cache change fixes that stopping/budget reset.

### Precise remaining ownership

**Targets / `DiscoveryPlan.RunAsync` owns the residual OPS-751 work.**
Reuse the previous bounded scope's stopping/submission decision for unchanged
scope, policy, source pool and valid verdict evidence, and respect its next-try
scheduling rather than restarting a full 28-second pass on each identical read.
Invalidate that reuse when the relevant scope/policy/pool/verdict lifetime changes.
Canceled hashes must remain unmeasured; do not manufacture a six-hour verdict
or silently classify them Dead/Good. Scope stopping and retry bookkeeping belong
in Targets, not another Check cache.

Check's README now documents this boundary. No Targets, Plan, Library, Store,
API, web or source code was edited. OPS-751 remains open/blocked for Targets;
its Check portion is verified and requires no behavioral cache fix.

## Validation, review and cleanup

- Final isolated build: **0 warnings, 0 errors**, `build-final.log`.
- Real HTTP readiness, native transfer, throttle/unthrottle, cache and restart
  checks; **no unit tests**, no invented seed counts or fake engine snapshots.
- Final image readiness and physical limit are in `health-final.json` and
  `diagnostics-final.json`. Per-manager observer lifetimes and the change's
  owner/loopback diagnostic exposure were reviewed.
- Only the Engine implementation/README, Check README and this report are shipped.
  The foreign `tools/.gitignore` edit is left untouched.
- Full licensed payloads were removed through real Engine HTTP; the final Engine
  snapshot is empty. Private server PIDs and worktree/payload cleanup are recorded
  in `cleanup.json`. The owner's server and all other agents' ports were untouched.
