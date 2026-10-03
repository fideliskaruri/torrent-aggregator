import json
from pathlib import Path
import sqlite3

proof = Path(__file__).parent
db = Path(r"D:\code\memtest\epid-data\converted\torrentflow.db")
c = sqlite3.connect(db)
counts = {r[0]: c.execute('SELECT count(*) FROM "'+r[0]+'"').fetchone()[0]
          for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
(proof / "converted-counts.json").write_text(json.dumps(counts, indent=2))
paths = []
for table in ["StorageRoot", "MediaFile", "DownloadFile", "WorkFolder", "FilePathClaim", "FileOperation"]:
    columns = [r[1] for r in c.execute('pragma table_info("'+table+'")')
               if "path" in r[1].lower() or r[1] == "externalItemFolder"]
    for column in columns:
        for row in c.execute('SELECT "'+column+'" FROM "'+table+'"'):
            value = row[0]
            if value:
                assert value.lower().startswith(r"d:\code\memtest\epid-data".lower()), (table, column, value)
                paths.append({"table": table, "column": column, "path": value})
settings = json.loads(c.execute("SELECT valueJson FROM Setting WHERE section='scheduler'").fetchone()[0])
settings.update(enabled=True, firstFullRootScanComplete=True, importReviewComplete=True, intervalMinutes=1)
c.execute("UPDATE Setting SET valueJson=? WHERE section='scheduler'", (json.dumps(settings),))
c.commit()
(proof / "path-audit.json").write_text(json.dumps(paths, indent=2))
(proof / "scheduler-config.json").write_text(json.dumps(settings, indent=2))
print("Validated", len(paths), "active paths; scheduler enabled, legacy flags acknowledged.")
