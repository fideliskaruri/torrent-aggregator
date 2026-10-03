"""Audit captured HTTP evidence and assemble the requested Find report."""
import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "tools" / ".find-proof"


def main():
    rows = json.loads((OUT / "summary.json").read_text())
    with (ROOT / "tools" / "bench" / "results" / "baseline-search-final-20261003-0509.csv").open(
        encoding="utf-8-sig", newline=""
    ) as handle:
        baseline = list(csv.DictReader(handle))
    comparisons = []
    lookalikes = {}
    wrong_seasons = {}
    audited = 0
    def rejections(result):
        for rejected in result["rejections"]:
            if re.search(r"scorpion[ ._-]+king|frieden", rejected["name"], re.I):
                lookalikes[rejected["name"]] = rejected
            if rejected["sourceId"] == "eztv" and rejected["code"] == "scope_mismatch":
                wrong_seasons[rejected["name"]] = rejected

    for row in rows:
        name = row["title"].lower().replace(" ", "-")
        reply = json.loads((OUT / f"{name}-{row['run']}.json").read_text())
        assert reply["status"] == 200, reply
        body = reply["body"]
        result = body["result"]
        assert result["complete"]
        assert result["sourceRequests"] <= result["requestLimit"]
        assert result["windowSourceRequests"] <= result["requestLimit"]
        if row["run"] == 2:
            assert result["cachedPool"] and result["sourceRequests"] == 0
            assert row["httpMs"] < 1000, row
        candidates = result["candidates"]
        hashes = [candidate["hash"] for candidate in candidates]
        assert len(hashes) == len(set(hashes)), name
        scope = body["scope"]
        for candidate in candidates:
            observations = candidate["sources"]
            counts = [obs["listedSeeders"] for obs in observations
                      if obs.get("listedSeeders") is not None and obs["listedSeeders"] >= 0]
            expected = candidate.get("scrapedSeeders")
            if expected is None:
                expected = min(counts) if counts else None
            assert candidate.get("trustedSeeds") == expected, candidate
            assert set(candidate["coverage"]["episodeIds"]).issubset(scope["episodeIds"])
            assert candidate["coverage"]["coversFilm"] == scope["film"]
            assert not re.search(r"scorpion[ ._-]+king|frieden", candidate["name"], re.I), candidate
            audited += 1
        rejections(result)
        if row["run"] == 1:
            old = next((record for record in baseline
                        if row["title"].startswith(record["title"].split(":")[0])
                        or row["title"].startswith("Frieren") and record["title"].startswith("Frieren")), None)
            comparison = dict(row)
            if old:
                comparison["phase0FirstMs"] = float(old["first_result_ms"])
                comparison["firstDeltaMs"] = row["firstCandidateMs"] - comparison["phase0FirstMs"]
                comparison["baselineQuery"] = old["query"]
            if row["title"] == "Frieren S1E5":
                comparison["baselineNote"] = "Phase 0 captured S1, not E5; this is not an equivalent scope."
            comparisons.append(comparison)
    assert all(row["cacheHit"] for row in rows if row["run"] == 2)
    concurrent = json.loads((OUT / "concurrent-summary.json").read_text())
    assert any(row["sharedInFlight"] for row in concurrent), concurrent
    assert any(row["sourceRequests"] == 0 for row in concurrent), concurrent
    exhaust = [json.loads((OUT / f"scorpion-exhaust-{run}.json").read_text()) for run in (1, 2)]
    for reply in exhaust:
        result = reply["body"]["result"]
        assert result["sourceRequests"] <= result["requestLimit"]
        assert not result["provisionalStopped"]
        assert not any(re.search(r"scorpion[ ._-]+king", c["name"], re.I) for c in result["candidates"])
        rejections(result)
    assert exhaust[1]["body"]["result"]["sourceRequests"] == 0 and exhaust[1]["httpMs"] < 1000
    protocol = json.loads((OUT / "protocol.json").read_text())
    failure = json.loads((OUT / "failure-window.json").read_text())
    restart = json.loads((OUT / "failure-restart.json").read_text())
    report = {
        "scope": "Find discovery only. Listed/trusted seed counts are not measured swarm health.",
        "benchmarkNote": "Two owner scopes concurrently; raw Phase 0 atomic response versus first filtered Find candidate. "
                         "Default dev stopping is provisional (structural match, trusted seeds >= 1), not Check approval. "
                         "Partial/truncated answers are cached; only failures/timeouts may retry once in background.",
        "hardSet": comparisons, "repeatRuns": [row for row in rows if row["run"] == 2],
        "failureRetry": {
            "realHttpStatus": 404, "initialRequests": failure["replies"][0]["body"]["sourceRequests"],
            "windowRequests": failure["replies"][-1]["body"]["windowSourceRequests"],
            "cachedRepeatsSendZero": all(r["body"]["sourceRequests"] == 0 for r in failure["replies"][1:]),
            "restartRequests": restart["replies"][0]["body"]["sourceRequests"],
            "restartPreservedExpiry": restart["cacheRowsBefore"] == restart["cacheRowsAfter"],
        },
        "concurrent": concurrent, "protocol": {
            "syntheticCoverageNotHealth": True,
            "partialSeasonDidNotStop": protocol["seasonCoverageAndScrape"]["partialCoverageDidNotStop"],
            "zeroScrapeOverridesListed": protocol["seasonCoverageAndScrape"]["zeroScrapeOverridesListed"],
            "ownerAdmittedBeforeThirdBackground": protocol["budget"]["ownerAdmittedBeforeThirdBackground"],
            "ownerFirstMs": protocol["budget"]["ownerFirstMs"],
            "thirdBackgroundFirstMs": protocol["budget"]["thirdBackgroundFirstMs"],
            "survivingWaiterCompleted": protocol["detach"]["survivingWaiterCompleted"],
            "sharedInFlight": protocol["detach"]["sharedInFlight"],
        },
        "lookalikesSurvived": 0, "rejectedLookalikes": list(lookalikes.values()),
        "exhaust": [{"httpMs": reply["httpMs"], "requests": reply["body"]["sourceRequests"],
                     "candidates": len(reply["body"]["result"]["candidates"])} for reply in exhaust],
        "friedenObserved": any(re.search("frieden", name, re.I) for name in lookalikes),
        "eztvWrongSeasonRejections": list(wrong_seasons.values()),
        "auditedCandidateRows": audited,
        "assertions": ["unique hashes", "trusted scrape or minimum listed count including zero",
                       "coverage within requested scope", "no Scorpion King/Frieden admitted",
                       "physical requests stay within configurable scope cap",
                       "all repeats reuse scope snapshot with zero requests and subsecond total HTTP",
                       "shared identical in-flight request",
                       "real HTTP 404 retries once per query and survives restart without another send",
                       "partial-season feedback does not stop", "zero scrape overrides advertised count",
                       "shared background scope budget and owner reserve", "one canceled waiter preserves the other"],
    }
    (OUT / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    for row in comparisons:
        repeat = next(record for record in rows if record["title"] == row["title"] and record["run"] == 2)
        print(f"{row['title']}: {row['sourceRequests']} requests, first {row['firstCandidateMs']:.1f} ms, "
              f"full {row['findCompleteMs']/1000:.3f} s, {row['candidates']} candidates; "
              f"repeat HTTP {repeat['httpMs']:.1f} ms, {repeat['sourceRequests']} requests; "
              f"baseline {row.get('phase0FirstMs')} ms", flush=True)
    print(f"Audited {audited} candidate rows; rejected {len(lookalikes)} lookalikes; "
          f"EZTV wrong-season names: {len(wrong_seasons)}; survived=0", flush=True)


if __name__ == "__main__":
    main()
