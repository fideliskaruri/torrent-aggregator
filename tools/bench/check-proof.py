"""Real HTTP swarm proof on the isolated Check instance. No full downloads."""
import concurrent.futures
import json
import re
import sqlite3
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "tools" / ".check-proof"
BASE = "http://127.0.0.1:3948"
DATA = Path(r"D:\code\memtest\rebuild-check\data")
CASES = [
    ("Scorpion 2014", "Scorpion S01", "knaben"),
    ("Little Fires Everywhere", "Little Fires Everywhere", "knaben"),
    ("Frieren S1", "Sousou no Frieren", "nyaa"),
    ("A Silent Voice", "Koe no Katachi", "nyaa"),
    ("Rick and Morty S1", "Rick and Morty S01", "knaben"),
    ("Prison Break", "Prison Break S01", "knaben"),
    ("Money Heist", "Money Heist S01", "knaben"),
]


def request(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as response:
        return json.load(response)


def save(name, value):
    (OUT / (name + ".json")).write_text(json.dumps(value, indent=2), encoding="utf-8")


def source(case):
    title, query, adapter = case
    result = request("/api/dev/sources/search?" + urllib.parse.urlencode(
        {"q": query, "source": adapter, "category": "anime" if adapter == "nyaa" else "all"}))
    save("source-" + title.lower().replace(" ", "-"), result)
    rows = sorted(result["results"], key=lambda r: r.get("listedSeeders") or 0, reverse=True)
    print(title, result["outcome"], len(rows), flush=True)
    return title, rows


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        sources = list(pool.map(source, CASES))
    selected, seen = [], set()
    for title, rows in sources:
        valid = [r for r in rows if len(r["hash"]) == 40 and
                 all(c in "0123456789abcdefABCDEF" for c in r["hash"])]
        if title == "Frieren S1":
            valid = [r for r in valid if not re.search(r"\bS0?2\b|Season\s+0?2\b", r["name"], re.I)]
        for row in valid[:3 if title == "Frieren S1" else 2]:
            hash_value = row["hash"].lower()
            if hash_value in seen:
                continue
            seen.add(hash_value)
            selected.append({"hash": hash_value, "magnet": row.get("magnet"),
                             "torrentUri": row.get("torrentUri"), "name": row["name"],
                             "listedSeeders": row.get("listedSeeders"), "title": title})
    save("hard-set-candidates", selected)
    assert len(selected) >= 15, f"Only {len(selected)} hard-set hashes obtained"
    selected = selected[:15]
    fixtures = json.loads((ROOT / "tools" / ".engine-proof" / "fixtures.json").read_text())
    for fixture in fixtures:
        selected.append({"hash": fixture["hash"], "magnet": fixture["magnet"],
                         "name": fixture["title"], "listedSeeders": None,
                         "torrentUri": urllib.parse.parse_qs(
                             urllib.parse.urlparse(fixture["magnet"]).query).get("xs", [None])[0]})
    for value in ["8bfa8af5174fac5a514f9c2fc5d6ac4d549773ef", "7c097ad3c45be663eef534e1b86645ba437ab827"]:
        selected.append({"hash": value, "magnet": None, "name": "Random unswarmed hash",
                         "listedSeeders": 0, "torrentUri": None})
    baseline = request("/api/dev/check/status")
    start = time.perf_counter()
    samples = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        batch = pool.submit(request, "/api/dev/check", {"candidates": selected, "forceFresh": True})
        time.sleep(1)
        duplicate = pool.submit(request, "/api/dev/check", {
            "candidates": [selected[0]] * 6, "forceFresh": True})
        while not batch.done() or not duplicate.done():
            state = request("/api/dev/check/status")
            engine = request("/api/dev/engine/torrents")
            samples.append({"seconds": time.perf_counter() - start, "check": state,
                            "engine": engine})
            time.sleep(.3)
        result, duplicates = batch.result(), duplicate.result()
    wall = (time.perf_counter() - start) * 1000
    save("batch", result)
    save("duplicates", duplicates)
    save("concurrency", samples)
    repeated_start = time.perf_counter()
    repeated = request("/api/dev/check", {"candidates": [selected[0]]})
    repeated_ms = (time.perf_counter() - repeated_start) * 1000
    save("cached", repeated)
    result_by_hash = {r["hash"]: r for r in result["results"]}
    rows = []
    for candidate in selected:
        r = result_by_hash[candidate["hash"]]
        rows.append({**candidate, "band": r["band"], "peers": r["connectedPeers"],
                     "seeders": r["connectedSeeders"], "senders": r["byteSendingPeers"],
                     "bytes": r["bytesDelivered"], "window": r["window"],
                     "queueWait": r["queueWait"], "reason": r["reason"],
                     "files": len(r["files"] or []), "expiresAt": r["expiresAt"]})
        assert r["band"] != "Good" or r["byteSendingPeers"] > 0, r
        assert r["band"] != "Dead" or r["byteSendingPeers"] == 0, r
    after = request("/api/dev/check/status")
    assert max(s["check"]["active"] for s in samples) <= 10
    assert max(len(s["engine"]["diagnostics"]) for s in samples) <= 10
    assert after["physicalProbes"] - baseline["physicalProbes"] == 20, after
    assert after["sharedWaiters"] - baseline["sharedWaiters"] >= 5
    assert repeated["results"][0]["fromCache"] and repeated_ms < 100, repeated_ms
    with sqlite3.connect(DATA / "torrentflow.db") as db:
        downloads = db.execute("select count(*) from Download").fetchone()[0]
        unknown = db.execute("select hash,checkedAt,expiresAt from Verdict where band='unknown'").fetchall()
        stored = db.execute("select count(*) from Verdict").fetchone()[0]
        metadata = db.execute("select count(*) from Release where filesJson is not null").fetchone()[0]
    probe_files = list((DATA / "engine" / "probes").rglob("*")) if (DATA / "engine" / "probes").exists() else []
    assert downloads == 0
    assert not [p for p in probe_files if p.is_file()]
    summary = {"rows": rows, "batchWallMs": wall, "cacheMs": repeated_ms,
               "peakActive": max(s["check"]["active"] for s in samples),
               "peakPhysicalManagers": max(len(s["engine"]["diagnostics"]) for s in samples),
               "physicalProbes": after["physicalProbes"] - baseline["physicalProbes"],
               "sharedWaiters": after["sharedWaiters"] - baseline["sharedWaiters"],
               "downloads": downloads, "probeFiles": len([p for p in probe_files if p.is_file()]),
               "storedVerdicts": stored, "permanentMetadataRows": metadata, "unknownExpiries": unknown,
               "startup": json.loads((OUT / "startup.json").read_text(encoding="utf-8-sig"))}
    save("summary", summary)
    print(json.dumps({k: v for k, v in summary.items() if k not in ["rows", "startup"]}), flush=True)
    for row in rows:
        print(json.dumps({k: row[k] for k in ["name", "listedSeeders", "band", "peers", "senders", "bytes"]},
                         ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
