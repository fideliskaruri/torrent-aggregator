import json
import pathlib
import shutil
import sqlite3

root = pathlib.Path(r"D:\code\memtest\apic2")
source = pathlib.Path(r"D:\code\memtest\stable\data")
old = root / "old"
old.mkdir(parents=True, exist_ok=False)
with sqlite3.connect(f"file:{source / 'torrentflow.db'}?mode=ro", uri=True) as live:
    with sqlite3.connect(old / "torrentflow.db") as copy:
        live.backup(copy)
for path in source.rglob("*"):
    relative = path.relative_to(source)
    if "backups" in relative.parts or path.name.startswith("torrentflow.db"):
        continue
    if path.is_file() and not path.is_symlink():
        destination = old / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)
(root / "path-map.json").write_text(json.dumps({}), encoding="utf-8")
print("Read-only SQLite backup and side-file copy complete.")
