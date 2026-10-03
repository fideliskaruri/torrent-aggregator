import json, os, pathlib, sqlite3, subprocess, time, urllib.request, shutil, sys

root = pathlib.Path(__file__).resolve().parents[2]
proof = root / "tools" / ".mcold-proof"
phase = sys.argv[1]
runs = int(sys.argv[2]) if len(sys.argv) > 2 else 3
env = os.environ.copy()
env["TMDB_API_KEY"] = pathlib.Path(r"C:\Users\fwachira\.copilot\session-state\88fafede-1c4e-4fcb-aa69-48d8dede6235\files\debug30\tmdb.key").read_text().strip()
env["TORRENTFLOW_METADATA_TIMINGS"] = "1"
base = pathlib.Path(r"D:\code\memtest\mcold2-base")
donor = pathlib.Path(r"D:\code\memtest\rebuild-gatemeta\data\torrentflow.db")

def start(data, name):
    log = (proof / f"{name}.log").open("w", encoding="utf-8")
    p = subprocess.Popen(["dotnet", r"D:\code\memtest\bin-mcold2\TorrentFlow.dll",
        "--urls", "http://127.0.0.1:3962", "--TorrentFlow:DataDirectory", str(data),
        "--TorrentFlow:Scheduler:Disabled", "true", "--background", "--no-browser"],
        env=env, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(100):
        if p.poll() is not None:
            log.close()
            raise RuntimeError(f"Server {p.pid} exited; inspect {name}.log")
        try:
            urllib.request.urlopen("http://127.0.0.1:3962/api/health", timeout=1).read()
            return p, log
        except Exception:
            time.sleep(.1)
    stop(p, log)
    raise RuntimeError("Server never became ready")

def stop(p, log):
    if p.poll() is None:
        subprocess.run(["powershell", "-NoProfile", "-Command", f"Stop-Process -Id {p.pid}"], stdout=subprocess.DEVNULL)
    p.wait(timeout=15)
    log.close()

if not base.exists():
    base.mkdir()
    p, log = start(base, "map-base")
    stop(p, log)
    with sqlite3.connect(f"file:{donor}?mode=ro", uri=True) as db:
        row = db.execute("select * from MetadataCache where provider='fribb'").fetchone()
        columns = [r[1] for r in db.execute("pragma table_info(MetadataCache)")]
    assert row is not None
    with sqlite3.connect(base / "torrentflow.db") as db:
        assert db.execute("select count(*) from MetadataCache").fetchone()[0] == 0
        db.execute("insert into MetadataCache values (" + ",".join("?" for _ in row) + ")", row)
        db.commit()
    db.close()
    (proof / "map-fixture.json").write_text(json.dumps({
        "donor": str(donor), "columns": columns, "rows": 1, "provider": "fribb",
        "payloadBytes": len(row[columns.index("payloadJson")].encode()),
        "kind": row[columns.index("kind")], "cacheKey": row[columns.index("cacheKey")],
        "catalogRows": 0, "browseRows": 0, "anilistRows": 0}, indent=2), encoding="utf-8")

results = []
for run in range(1, runs + 1):
    data = pathlib.Path(r"D:\code\memtest") / f"mcold2-{phase}-{run}"
    if data.exists():
        shutil.rmtree(data)
    data.mkdir()
    with sqlite3.connect(f"file:{base / 'torrentflow.db'}?mode=ro", uri=True) as source_db:
        with sqlite3.connect(data / "torrentflow.db") as dest:
            source_db.backup(dest)
    dest.close()
    source_db.close()
    p, log = start(data, f"{phase}-{run}-anime")
    try:
        for mode in ("cold", "warm"):
            begin = time.perf_counter()
            with urllib.request.urlopen("http://127.0.0.1:3962/api/browse?type=anime", timeout=60) as response:
                status, payload = response.status, json.load(response)
            seconds = round(time.perf_counter() - begin, 3)
            (proof / f"{phase}-{run}-anime-{mode}.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
            result = {"phase": phase, "run": run, "name": "anime", "mode": mode,
                "status": status, "seconds": seconds, "rails": len(payload["rails"]),
                "cards": sum(len(r["items"]) for r in payload["rails"])}
            results.append(result)
            print(json.dumps(result), flush=True)
            (proof / f"{phase}-timings.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    finally:
        stop(p, log)
        shutil.rmtree(data)
