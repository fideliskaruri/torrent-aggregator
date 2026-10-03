import collections
import json
import pathlib
import re

root = pathlib.Path(__file__).resolve().parents[2]
proof = root / "tools" / ".mcold-proof"
before = json.loads((proof / "before-timings.json").read_text())
after = json.loads((proof / "complete-timings.json").read_text())
shapes = json.loads((proof / "complete-shapes.json").read_text())
passed = all(r["status"] == 200 and r["seconds"] < (5 if r["mode"] == "cold" else .3) for r in after)
text = [
    "# OPS-848: cold Metadata reads", "",
    "## Outcome", "",
    "**All latency targets met.**" if passed else "**Improved, but the requested latency target is not fully met. Do not close OPS-848.**",
    f"Real HTTP responses: {sum(r['status'] == 200 for r in after)}/{len(after)} status 200. "
    f"Shape/full-content/stable-identity checks: {sum(not r['errors'] for r in shapes)}/{len(shapes)}.",
    "No timeouts were raised, no new process cache/background service was added, and no empty/partial response counts as a passing proof.",
    "", "## Three fresh runs per endpoint", "",
    "| Endpoint | Before cold (s) | After cold (s) | Before warm (s) | After warm (s) |",
    "|---|---|---|---|---|",
]
for name in ["all", "anime", "films", "series", "extras"]:
    def values(rows, mode):
        return ", ".join(f"{r['seconds']:.3f}" for r in rows if r["name"] == name and r["mode"] == mode)
    text.append(f"| {name} | {values(before,'cold')} | {values(after,'cold')} | {values(before,'warm')} | {values(after,'warm')} |")
text += [
    "", "Each endpoint/run starts a new process on 3962 with its own newly created empty data directory. "
    "No endpoint warms another endpoint's cache. Warm means its immediate second HTTP read. "
    "TMDB is configured only in the child environment. Scheduler disabled.",
    "", "## Measured cause and owning-module repair", "",
    "- The API calls Browse once. Metadata performed a catalog-wide verified-link scan, snapshot reads and a durable commit "
    "for each of up to 96 candidates in each rail, under one global semaphore. This serialized growing catalog work.",
    "- Cold All made 157 TMDB calls in baseline run 1, including 66 recent-film details. "
    "Type views also overflowed the 64-pending admission limit; AniList waits reached about 9.7s and incomplete rails were fetched again on warm reads. "
    "HTTP flights already coalesced requests; no inline retry existed. Provider queue/network timings are in provider-timings.json.",
    "- Native pools now use only card facts, compact labelled-name projections and bounded aliased AniList queries. "
    "A shared visible-card selector replenishes only actual shortages, up to the original five TMDB/two AniList page ceiling. "
    "Upstream replenishment is re-evaluated against downstream deduplication; canonical identities are assigned only to visible cards, in one listing commit. "
    "Existing canonical facts are never replaced by partial listings.",
    "- Browse reads distinct cached release details in one request-local batch, without recent-film network-detail fanout. "
    "Unchecked evidence uses the existing 21-day rule; checked cached details use the existing release-window calculation. "
    "Extras still resolves checked title details. The old server's BrowseService likewise reads existing release signals rather than awaiting each film's enrichment.",
    "- Browse did not use Fribb facts but started the full map download. Western resolution awaited that download, and loaded readers waited behind its network lock. "
    "Browse no longer invokes that unrelated job; western resolution does not wait for an anime map, and already-loaded readers bypass the refresh lock. "
    "Anime resolution/maintenance retain the map.",
    "- Typed exact-name/year resolution can use one unambiguous preferred TMDB identity directly. "
    "Fuzzy, ambiguous or absent matches still use the unchanged unified search. Extras recommendations use the same bulk listing persistence.",
    "- Provider deadlines/real 429 and Retry-After behavior remain unchanged. TMDB retains four concurrent calls without a second start budget. "
    "AniList overlaps four calls while retaining its 700ms start spacing and foreground reservation.",
    "", "## Verification and limitations", "",
    "- Build: isolated worktree, Release, zero warnings/errors. No unit tests. CatalogEndpoints.cs and all excluded modules remain untouched.",
    "- Captures compared against backend/contract/shapes.json and declared web types. "
    "Checks also reject missing rails, fewer than 24 cards, duplicate work keys, unstable canonical IDs, "
    "and Rick and Morty Extras without all 11 S1 episodes and real recommendations.",
    "- Discarded intermediate attempts are not evidence of success: oversized GraphQL batches returned no rails; "
    "later versions exposed real AniList 500s and downstream deduplication shortages. "
    "Those outcomes were explicitly rejected. One copied build output was corrupt; it was discarded and rebuilt directly before the final matrix.",
    "- The copied-data/converted-catalog, keyless, authenticated requester, personal watch-seed and genre-grid matrices were not run. "
    "A provider outage can still produce a partial BrowseResult; the unchanged API's handling of that partial result was not repaired here "
    "because CatalogEndpoints.cs belongs to another lane.",
    "- Native card projections intentionally do not fetch full synonym/season/airing enrichment. "
    "They remain unrefreshed partial identities; opening a title obtains the full facts.",
    "- Any cold sample >=5s or warm sample >=300ms in the table is a remaining failure, not rounded down.",
    "", "## Isolation and persistence", "",
    "- Detached worktree created from rebuild (428cb48): branch rebuild was already owned by the main worktree.",
    "- Final output built directly at D:\\code\\memtest\\bin-mcold; only 3962 was used.",
    "- Live 3930/PID 3188 and D:\\code\\memtest\\stable were not accessed or changed.",
    "- Only the seven owned Metadata files and this proof were copied back; tools/.gitignore was untouched.",
    "- Every proof child is stopped by its recorded literal PID. Worktree, isolated outputs and created data directories are removed at handoff.",
    "- Commit uses Refs: OPS-848, no Co-Authored-By. See the report's introducing commit for its SHA.",
]
summary = []
pattern = r"METADATA_TIMING (\w+) (\S+) queue_ms=([\d.]+) network_ms=([\d.]+) total_ms=([\d.]+)"
for path in sorted(proof.glob("before-*.log")):
    calls = [dict(provider=p, path=url, queue_ms=float(q), network_ms=float(n), total_ms=float(t))
             for p, url, q, n, t in re.findall(pattern, path.read_text(encoding="utf-8"))]
    summary.append({"file": path.name, "counts": dict(collections.Counter(c["provider"] for c in calls)), "calls": calls})
(proof / "provider-timings.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
(proof / "report.md").write_text("\n".join(text) + "\n", encoding="utf-8")
print("latency-targets-met:", passed)
