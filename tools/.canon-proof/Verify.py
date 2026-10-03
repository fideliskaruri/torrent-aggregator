import json
from pathlib import Path
import sqlite3
import sys
import urllib.request

proof = Path(__file__).parent
base = "http://127.0.0.1:3961"


def call(route, name, body=None):
    request = urllib.request.Request(base + route, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=120) as response:
        result = json.load(response)
    (proof / (name + ".json")).write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def ownership(title):
    return {"seasons": title["seasons"], "episodes": sorted([
        {"episode": e.get("episode"), "owned": e.get("owned")} for e in title["episodes"]],
        key=lambda e: e["episode"])}


provider = call("/api/title/tmdb:tv:60625?season=1", "provider-title")
legacy = call("/api/title/rick-and-morty-2013?season=1", "legacy-title")
assert ownership(provider) == ownership(legacy), "Aliases differ in episode ownership"
assert provider["seasons"][0]["downloadedEpisodes"] == 11
assert sum(e.get("owned") is not None for e in provider["episodes"]) == 11
assert all(e["owned"]["resolution"] == 1080 for e in provider["episodes"])
for key in ["tmdb:tv:60625", "rick-and-morty-2013"]:
    result = call("/api/title/" + key, "admission-" + key.replace(":", "-"),
                  {"season": 1, "episode": 8, "preferredResolution": 1080})
    assert result["owned"] == 1 and result["queued"] == 0, result
search = call("/api/search/titles?q=Rick%20and%20Morty", "search")
hit = next(r for r in search["results"] if r["title"] == "Rick and Morty" and r["year"] == 2013)
opened = call("/api" + hit["href"], "search-opened")
assert ownership(opened) == ownership(provider)
library = call("/api/watchlist", "library")
entries = [r for r in library["items"] if r["title"] == "Rick and Morty"]
assert len(entries) == 1 and entries[0]["ready"], entries
database = sqlite3.connect(sys.argv[1] if len(sys.argv) > 1 else
                          r"D:\code\memtest\canon-data\converted\torrentflow.db")
database.row_factory = sqlite3.Row
rows = [dict(r) for r in database.execute(
    "select w.id,w.workKey,l.provider,l.externalId,l.status from Work w join WorkLink l on l.workId=w.id "
    "where l.externalId in ('60625','tt2861424','275274','216')")]
assert len({r["id"] for r in rows if r["status"] == "verified"}) == 1, rows
assert database.execute("pragma integrity_check").fetchone()[0] == "ok"
assert not database.execute("pragma foreign_key_check").fetchall()
summary = {"ownershipIdentical": True, "season1Owned": 11, "resolution": 1080,
           "admissions": "Both keys owned=1 queued=0", "canonicalLinks": rows,
           "searchOpensOwned": True, "libraryEntries": len(entries),
           "integrity": "ok", "foreignKeyViolations": 0}
(proof / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
print(json.dumps(summary, indent=2))
