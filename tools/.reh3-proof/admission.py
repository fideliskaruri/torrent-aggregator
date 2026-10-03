import json
from pathlib import Path
import sqlite3
import urllib.error
import urllib.parse
import urllib.request

proof = Path(__file__).parent
db = r"D:\code\memtest\reh3-data\converted\torrentflow.db"
assert json.loads((proof / "scheduler-result.json").read_text())["seconds"] >= 600
c = sqlite3.connect(db)
c.row_factory = sqlite3.Row
before = {t: c.execute("SELECT count(*) FROM "+t).fetchone()[0]
          for t in ["Target", "Download", "DownloadFile", "MediaFile", "SearchCache", "ReleaseObservation"]}
results = []
rows = json.loads((proof / "accounting.json").read_text())
for row in rows:
    if not row["state"].startswith("owned"):
        continue
    body = {"season":row["season"],"episode":row["episode"]}
    request = urllib.request.Request(
        "http://127.0.0.1:3965/api/title/"+urllib.parse.quote(row["workKey"], safe=""),
        data=json.dumps(body).encode(),headers={"Content-Type":"application/json"},method="POST")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            status, result = response.status, json.load(response)
    except urllib.error.HTTPError as ex:
        status, result = ex.code, json.load(ex)
    results.append({"file":row["file"], "request":body, "status":status,"body":result})
    (proof / "owned-admission.json").write_text(json.dumps(
        {"results":results,"before":before,"complete":False},indent=2))
    results[-1]["passed"] = status == 200 and result.get("owned") == 1 and result.get("queued") == 0
after = {t: c.execute("SELECT count(*) FROM "+t).fetchone()[0] for t in before}
(proof / "owned-admission.json").write_text(json.dumps(
    {"results":results,"before":before,"after":after,"countsUnchanged":before == after,
     "passed":sum(r["passed"] for r in results),"failed":sum(not r["passed"] for r in results)},indent=2))
assert before == after
print("Owned admissions:",sum(r["passed"] for r in results),"passed;",
      sum(not r["passed"] for r in results),"failed; acquisition counts unchanged.")
