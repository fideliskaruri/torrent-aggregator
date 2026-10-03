import json
from pathlib import Path
import sqlite3
import time
import urllib.parse
import urllib.request

proof = Path(__file__).parent
db = Path(r"D:\code\memtest\epid-data\converted\torrentflow.db")
until = time.monotonic() + 180
while True:
    try:
        with urllib.request.urlopen("http://127.0.0.1:3967/api/health", timeout=5) as response:
            health = json.load(response)
        break
    except Exception:
        assert time.monotonic() < until, "Startup timeout"
        time.sleep(3)

c = sqlite3.connect(db)
c.row_factory = sqlite3.Row
result = {"health": health, "integrity": c.execute("pragma integrity_check").fetchone()[0],
          "fkFailures": len(c.execute("pragma foreign_key_check").fetchall()), "works": []}
for key, tmdb_id in [("rick-and-morty-2013", "60625"), ("series:rick and morty", "60625"),
                     ("family-guy", "1434")]:
    rows = [dict(r) for r in c.execute("""
        SELECT e.id,e.provider,e.providerEpisodeId,e.number,e.title,e.airAt,e.mappingStatus,
               s.number season FROM Episode e JOIN Season s ON s.id=e.seasonId
        JOIN Work w ON w.id=s.workId WHERE w.workKey=? AND e.mappingStatus!='unavailable'
        ORDER BY s.number,e.number""", (key,))]
    native = {}
    native_answers = []
    for cached in c.execute("select cacheKey,payloadJson,fetchedAt,complete from MetadataCache where provider='tmdb'"):
        if "/tv/" + tmdb_id + "/season/" not in cached[0]:
            continue
        payload = json.loads(cached[1])
        projection = {name: payload.get(name) for name in ["id", "name", "season_number"]}
        projection["episodes"] = [{name: e.get(name) for name in
            ["id", "name", "season_number", "episode_number", "air_date", "runtime"]}
            for e in payload.get("episodes", [])]
        native_answers.append({"path": cached[0][cached[0].index("/tv/"):],
                               "fetchedAt": cached[2], "complete": bool(cached[3]), "payload": projection})
        for e in payload.get("episodes", []):
            native[(payload["season_number"], e["episode_number"])] = e
    (proof / ("tmdb-native-" + tmdb_id + ".json")).write_text(
        json.dumps(native_answers, indent=2), encoding="utf8")
    positive = {(r["season"], r["number"]): r for r in rows if r["season"] > 0}
    expected = {coordinate: e for coordinate, e in native.items() if coordinate[0] > 0}
    differences = []
    for coord, row in positive.items():
        raw = native.get(coord)
        if raw is None or row["title"] != raw["name"]:
            differences.append({"coordinate": coord, "actual": row["title"],
                                "tmdb": None if raw is None else raw["name"]})
    http = []
    for season in sorted({r["season"] for r in rows if r["season"] > 0}):
        with urllib.request.urlopen("http://127.0.0.1:3967/api/title/" +
                urllib.parse.quote(key) + "?s=" + str(season), timeout=90) as response:
            body = json.load(response)
        rendered = {e["episode"] for e in body["episodes"]}
        assert rendered == {r["number"] for r in rows if r["season"] == season}, (key, season)
        http.append({"season": season, "episodes": len(rendered), "status": 200})
    result["works"].append({"key": key, "provider": rows[0]["provider"], "episodes": len(rows),
        "regularEpisodes": len(positive), "tmdbRegularEpisodes": len(expected),
        "missingRegularCoordinates": sorted(expected.keys()-positive.keys()),
        "extraRegularCoordinates": sorted(positive.keys()-expected.keys()),
        "titleDifferences": differences,
        "specials": sum(r["season"] == 0 for r in rows),
        "tmdbSpecials": sum(coord[0] == 0 for coord in native), "httpSeasons": http})
    (proof / ("episodes-" + key.replace(":", "-").replace(" ", "-") + ".json")).write_text(
        json.dumps(rows, indent=2), encoding="utf8")
result["duplicateProviderIdentities"] = [list(r) for r in c.execute("""
    select provider,providerEpisodeId,count(*) from Episode where providerEpisodeId is not null
    group by provider,providerEpisodeId having count(*)>1""")]
(proof / "tmdb-comparison.json").write_text(json.dumps(result, indent=2), encoding="utf8")
print(json.dumps(result, indent=2))
