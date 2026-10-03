import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import time

proof = Path(__file__).parent
base = Path(r"D:\code\memtest\reh3-data")
source = Path(r"D:\code\memtest\stable\data")
old_media = Path(r"D:\Torrents")
assert not base.exists(), "Fresh destination required"
start = time.monotonic()
(base / "source").mkdir(parents=True)
live = sqlite3.connect(source.joinpath("torrentflow.db").as_uri() + "?mode=ro", uri=True)
copy = sqlite3.connect(base / "source" / "torrentflow.db")
live.backup(copy)
copy.close()
live.close()
for item in source.iterdir():
    if item.name.startswith("torrentflow.db"):
        continue
    target = base / "source" / item.name
    if item.is_dir():
        shutil.copytree(item, target)
    else:
        shutil.copy2(item, target)
inventory = []
for root, dirs, files in os.walk(old_media, followlinks=False):
    for name in dirs + files:
        path = Path(root) / name
        assert not path.is_symlink() and not path.is_junction(), str(path)
    for name in files:
        original = Path(root) / name
        relative = original.relative_to(old_media)
        shadow = base / "media" / relative
        shadow.parent.mkdir(parents=True, exist_ok=True)
        length = original.stat().st_size
        shutil.copy2(original, shadow)
        assert shadow.stat().st_size == length
        inventory.append({"relative": str(relative), "bytes": length,
                          "video": original.suffix.lower() in [".mkv", ".mp4", ".avi", ".m4v", ".webm", ".mov", ".ts"]})
(proof / "path-map.json").write_text(json.dumps({str(old_media): str(base / "media")}), encoding="utf-8")
(proof / "disk-inventory.json").write_text(json.dumps(inventory, indent=2), encoding="utf-8")
snapshot = base / "source" / "torrentflow.db"
c = sqlite3.connect(snapshot)
counts = {r[0]: c.execute('SELECT count(*) FROM "' + r[0] + '"').fetchone()[0]
          for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
(proof / "old-counts.json").write_text(json.dumps(counts, indent=2), encoding="utf-8")
result = {"seconds": time.monotonic()-start, "files": len(inventory),
          "videos": sum(i["video"] for i in inventory), "logicalBytes": sum(i["bytes"] for i in inventory),
          "sourceSnapshotSha256": hashlib.sha256(snapshot.read_bytes()).hexdigest(),
          "mediaMode": "Actual byte-for-byte file copies via shutil.copy2, original roots read only",
          "sourceMode": "Read-only SQLite backup API plus copies of all side files and subdirectories"}
(proof / "preparation.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
print(json.dumps(result))
