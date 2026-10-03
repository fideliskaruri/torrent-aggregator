import hashlib
import json
from pathlib import Path
import sqlite3
import time
import urllib.request

proof = Path(__file__).parent
db = Path(r"D:\code\memtest\reh3-data\converted\torrentflow.db")
tables = ["MediaFile", "Download", "DownloadFile", "Target", "Request", "WatchItem",
          "Follow", "AutoRule", "Attempt", "SearchCache", "ReleaseObservation", "ImportReview", "ImportDecision"]

def fetch(path):
    with urllib.request.urlopen("http://127.0.0.1:3965"+path, timeout=15) as r:
        return json.load(r)

def snapshot():
    c = sqlite3.connect(db)
    c.row_factory = sqlite3.Row
    c.execute("BEGIN")
    result = {}
    for table in tables:
        rows = [dict(r) for r in c.execute('SELECT * FROM "'+table+'"')]
        payload = json.dumps(sorted(rows, key=lambda r: json.dumps(r, sort_keys=True)), sort_keys=True)
        result[table] = {"count": len(rows), "sha256": hashlib.sha256(payload.encode()).hexdigest()}
    result["targetStates"] = dict(c.execute("SELECT state,count(*) FROM Target GROUP BY state"))
    result["integrity"] = c.execute("PRAGMA integrity_check").fetchone()[0]
    result["fkFailures"] = len(c.execute("PRAGMA foreign_key_check").fetchall())
    c.close()
    return result

def evidence(label):
    c = sqlite3.connect(db)
    c.row_factory = sqlite3.Row
    for table in ["MediaFile", "DownloadFile", "Download", "ImportReview", "ImportDecision", "Follow", "WatchItem"]:
        rows = [dict(r) for r in c.execute('SELECT * FROM "'+table+'"')]
        if table == "ImportReview":
            rows = [json.loads(r["snapshot"]) for r in rows]
        (proof / (label+"-"+table+".json")).write_text(json.dumps(rows, indent=2))
    ownership = [dict(r) for r in c.execute("""
        SELECT m.path,m.bytes,m.origin,m.status,m.workId,w.workKey,w.year,w.kind,
               e.number AS episode,s.number AS season,
               (SELECT value FROM WorkName n WHERE n.workId=w.id ORDER BY ordinal LIMIT 1) AS title
        FROM MediaFile m JOIN Work w ON m.workId=w.id
        LEFT JOIN Episode e ON m.episodeId=e.id LEFT JOIN Season s ON e.seasonId=s.id
    """)]
    (proof / (label+"-ownership.json")).write_text(json.dumps(ownership, indent=2))
    c.close()
    for name, path in {"health":"/api/health", "downloads":"/api/client/torrents",
                       "imports":"/api/library/imports", "watchlist":"/api/watchlist",
                       "rules":"/api/rules", "requests":"/api/requests",
                       "engine":"/api/dev/engine/torrents", "wanted":"/api/wanted",
                       "follows":"/api/follows"}.items():
        try:
            (proof / (label+"-http-"+name+".json")).write_text(json.dumps(fetch(path), indent=2))
        except Exception as ex:
            (proof / (label+"-http-"+name+".json")).write_text(json.dumps({"error":str(ex)}))

deadline = time.monotonic()+360
while True:
    try:
        health = fetch("/api/health")
        if health["status"] == "ok":
            break
    except Exception:
        pass
    assert time.monotonic() < deadline, "Server startup timed out"
    time.sleep(5)
evidence("start")
samples = []
start = time.monotonic()
while True:
    entry = {"seconds":time.monotonic()-start, "db":snapshot()}
    entry["engine"] = fetch("/api/dev/engine/torrents")
    samples.append(entry)
    (proof / "scheduler-samples.json").write_text(json.dumps(samples, indent=2))
    if time.monotonic()-start >= 600:
        break
    time.sleep(5)
evidence("end")
result = {"seconds":time.monotonic()-start, "samples":len(samples),
          "maximumGapSeconds":max(b["seconds"]-a["seconds"] for a,b in zip(samples,samples[1:])),
          "start":samples[0]["db"],"end":samples[-1]["db"],
          "unchangedTables":[t for t in tables if all(s["db"][t]==samples[0]["db"][t] for s in samples)]}
(proof / "scheduler-result.json").write_text(json.dumps(result, indent=2))
print(json.dumps(result))
