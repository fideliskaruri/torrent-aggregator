import hashlib
import json
from pathlib import Path
import sqlite3
import time

proof = Path(__file__).parent
base = Path(r"D:\code\memtest\epid-data")
old = sqlite3.connect(base / "source" / "torrentflow.db")
new = sqlite3.connect(base / "converted" / "torrentflow.db")
new.row_factory = sqlite3.Row
lineage = {}
for source, destination in [("EngineTorrent", "Download"), ("AcquisitionTarget", "Target"),
                            ("MediaRequest", "Request"), ("WatchListItem", "WatchItem"),
                            ("AutoRule", "AutoRule")]:
    source_ids = {r[0] for r in old.execute('SELECT id FROM "'+source+'"')}
    new_ids = {r[0] for r in new.execute('SELECT id FROM "'+destination+'"')}
    lineage[source] = {"oldCount": len(source_ids), "newCount": len(new_ids),
                       "missingIds": sorted(source_ids-new_ids), "extraIds": sorted(new_ids-source_ids)}
    assert not source_ids-new_ids, (source, source_ids-new_ids)
old_hashes = {r[0] for r in old.execute("SELECT hash FROM EngineTorrent")}
new_hashes = {r[0] for r in new.execute("SELECT hash FROM Download")}
assert old_hashes == new_hashes
lineage["downloadHashSetsEqual"] = True
reviews = [json.loads(r[0]) for r in new.execute("SELECT snapshot FROM ImportReview")]
decisions = {(r["reviewId"], r["itemId"]) for r in new.execute("SELECT * FROM ImportDecision")}
pending = {str(Path(i["path"]).relative_to(base / "media")): i
           for scan in reviews for i in scan["items"] if (scan["id"], i["id"]) not in decisions}
owned = {str(Path(r["path"]).relative_to(base / "media")): dict(r)
         for r in new.execute("""
           SELECT m.*,w.workKey,e.number AS episode,s.number AS season,
                  (SELECT value FROM WorkName n WHERE n.workId=w.id ORDER BY ordinal LIMIT 1) AS title
           FROM MediaFile m JOIN Work w ON m.workId=w.id
           LEFT JOIN Episode e ON e.id=m.episodeId LEFT JOIN Season s ON s.id=e.seasonId
         """)}
previous = {r["file"]:r for r in json.loads((Path(r"D:\code\platformApps-worktrees\rebuild\tools\.adopt2-proof\accounting.json")).read_text())}
inventory = json.loads((proof / "disk-inventory.json").read_text())
accounting = []
for i in inventory:
    name = i["relative"]
    if not i["video"]:
        continue
    assert (name in owned) != (name in pending), name
    assert (base / "media" / name).stat().st_size == i["bytes"]
    row = {"file":name, "bytes":i["bytes"], "adopt2":previous[name]["state"],
           "state":"owned ("+owned[name]["origin"]+")" if name in owned else "pending review"}
    if name in owned:
        row.update({k:owned[name][k] for k in ["workKey","title","season","episode","status"]})
    else:
        row["reason"] = pending[name]["message"]
        row["candidates"] = pending[name]["candidates"]
    row["changedAccounting"] = row["adopt2"] != row["state"]
    accounting.append(row)
assert len(accounting) == 25
(proof / "lineage.json").write_text(json.dumps(lineage, indent=2))
(proof / "accounting.json").write_text(json.dumps(accounting, indent=2))

def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(4*1024*1024):
            result.update(chunk)
    return result.hexdigest()

start = time.monotonic()
copies = []
for i in inventory:
    original = Path(r"D:\Torrents") / i["relative"]
    copy = base / "media" / i["relative"]
    source_stat = original.stat()
    a, b = digest(original), digest(copy)
    assert a == b, i["relative"]
    assert original.stat().st_size == source_stat.st_size and original.stat().st_mtime_ns == source_stat.st_mtime_ns
    copies.append({"file":i["relative"],"bytes":source_stat.st_size,
                   "sha256":a,"equal":True,"sourceStatUnchanged":True})
(proof / "payload-copy-digests.json").write_text(json.dumps(
    {"seconds":time.monotonic()-start,"files":copies}, indent=2))
print(json.dumps({"lineage":lineage,"owned":len(owned),"pending":len(pending),
                  "changed":sum(r["changedAccounting"] for r in accounting),
                  "all76PayloadDigestsEqual":True}))
