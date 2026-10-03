"""Real HTTP evidence only. Does not call Find or inject a fake source or health verdict."""
import concurrent.futures
import csv
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "tools" / ".find-proof"
BASE = "http://127.0.0.1:3947"
CASES = [
    ("Scorpion S1", "tvmaze:44", 1, None),
    ("Little Fires Everywhere S1", "tvmaze:35319", 1, None),
    ("Frieren S1", "anilist:154587", 1, None),
    ("Frieren S1E5", "anilist:154587", 1, 5),
    ("A Silent Voice", "anilist:20954", None, None),
    ("Prison Break S1", "tvmaze:541", 1, None),
    ("Money Heist S1", "tvmaze:27436", 1, None),
    ("Rick and Morty S1", "tvmaze:216", 1, None),
    ("Sintel", "tmdb:movie:45745", None, None),
    ("Big Buck Bunny", "tmdb:movie:10378", None, None),
]


def get(path):
    start = time.perf_counter()
    try:
        with urllib.request.urlopen(BASE + path, timeout=600) as response:
            body = json.load(response)
            status = response.status
    except urllib.error.HTTPError as ex:
        status = ex.code
        body = json.load(ex)
    return {"status": status, "httpMs": (time.perf_counter() - start) * 1000, "body": body}


def run(case, iteration):
    title, key, season, episode = case
    params = {"workKey": key, "lane": "owner"}
    if season is not None:
        params["season"] = season
    if episode is not None:
        params["episode"] = episode
    reply = get("/api/dev/find?" + urllib.parse.urlencode(params))
    slug = title.lower().replace(" ", "-")
    (OUT / f"{slug}-{iteration}.json").write_text(json.dumps(reply, indent=2), encoding="utf-8")
    body = reply["body"]
    result = body.get("result") or {}
    candidates = result.get("candidates") or []
    row = {
        "title": title, "run": iteration, "status": reply["status"],
        **body.get("timings", {}), "candidates": len(candidates),
        "cacheHit": body.get("cacheHit", False), "allCacheHit": body.get("allCacheHit", False),
        "sharedInFlight": body.get("sharedInFlight", False),
        "top5": [{"name": c["name"], "hash": c["hash"], "seeds": c.get("trustedSeeds")} for c in candidates[:5]],
        "tier": result.get("tier"), "phase": result.get("namePhase"),
        "rejections": len(result.get("rejections", [])),
        "queries": len(result.get("queries", [])),
        "sourceRequests": sum((q.get("diagnostics") or {}).get("requests", 0)
                              for q in result.get("queries", []) if not q.get("cacheHit")),
        "error": body.get("error"),
    }
    print(json.dumps(row, ensure_ascii=True), flush=True)
    return row


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    # Resolve by verified provider IDs, not guessed slugs or identities.
    for title, key, _, _ in CASES:
        reply = get("/api/title/" + urllib.parse.quote(key, safe=":"))
        (OUT / (title.lower().replace(" ", "-") + "-metadata.json")).write_text(
            json.dumps(reply, indent=2), encoding="utf-8")
        print("metadata", title, reply["status"], reply["body"].get("known"), flush=True)
    rows = []
    def twice(case):
        return [run(case, 1), run(case, 2)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        for pair in executor.map(twice, CASES):
            rows.extend(pair)
            (OUT / "summary.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
    # Fresh numbering scope avoids a previously completed pool. Both HTTP requests share upstream work.
    concurrent_case = ("Scorpion S1E2 concurrent", "tvmaze:44", 1, 2)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        concurrent_rows = list(executor.map(lambda n: run(concurrent_case, n), ("a", "b")))
    (OUT / "concurrent-summary.json").write_text(json.dumps(concurrent_rows, indent=2), encoding="utf-8")
    baseline_path = ROOT / "tools" / "bench" / "results" / "baseline-search-final-20261003-0509.csv"
    with baseline_path.open(encoding="utf-8-sig", newline="") as handle:
        baseline = list(csv.DictReader(handle))
    (OUT / "baseline.json").write_text(json.dumps(baseline, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
