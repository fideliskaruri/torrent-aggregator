import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import time

proof = Path(__file__).parent
base = Path(r"D:\code\memtest\thold-data")
source = Path(r"D:\code\memtest\stable\data")
media = Path(r"D:\Torrents")
assert not base.exists()
started = time.monotonic()
(base / "source").mkdir(parents=True)
live = sqlite3.connect(source.joinpath("torrentflow.db").as_uri() + "?mode=ro", uri=True)
copy = sqlite3.connect(base / "source" / "torrentflow.db")
live.backup(copy)
copy.close()
live.close()
for item in source.iterdir():
    if item.name.startswith("torrentflow.db"):
        continue
    dest = base / "source" / item.name
    shutil.copytree(item, dest) if item.is_dir() else shutil.copy2(item, dest)
inventory = []
for root, dirs, files in os.walk(media, followlinks=False):
    for name in dirs + files:
        path = Path(root) / name
        assert not path.is_symlink() and not path.is_junction(), str(path)
    for name in files:
        original = Path(root) / name
        relative = original.relative_to(media)
        dest = base / "media" / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        stat = original.stat()
        shutil.copy2(original, dest)
        assert dest.stat().st_size == stat.st_size
        inventory.append({"relative": str(relative), "bytes": stat.st_size, "mtimeNs": stat.st_mtime_ns})
(proof / "path-map.json").write_text(json.dumps({str(media): str(base / "media")}))
(proof / "preparation.json").write_text(json.dumps({
    "seconds": time.monotonic() - started, "files": inventory,
    "sourceSnapshotSha256": hashlib.sha256((base / "source" / "torrentflow.db").read_bytes()).hexdigest(),
    "source": "read-only SQLite backup, all sidefiles copied",
    "media": "real byte copies; no links, no original path writable by proof server"
}, indent=2))
print("Copied", len(inventory), "files in", time.monotonic() - started, "seconds")
