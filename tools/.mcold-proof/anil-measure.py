import json, os, pathlib, shutil, sqlite3, subprocess, sys, time, urllib.request

root = pathlib.Path(__file__).resolve().parents[2]
proof = root / "tools" / ".mcold-proof"
phase = sys.argv[1]
runs = int(sys.argv[2]) if len(sys.argv) > 2 else 3
route = sys.argv[3] if len(sys.argv) > 3 else "/api/browse?type=anime"
env = os.environ.copy()
env["TORRENTFLOW_METADATA_TIMINGS"] = "1"
env["TMDB_API_KEY"] = pathlib.Path(r"C:\Users\fwachira\.copilot\session-state\88fafede-1c4e-4fcb-aa69-48d8dede6235\files\debug30\tmdb.key").read_text().strip()
results = []
for run in range(1, runs + 1):
    data = pathlib.Path(r"D:\code\memtest") / f"anil-{phase}-{run}"
    assert not data.exists(), str(data)
    data.mkdir()
    log = (proof / f"{phase}-{run}-anime.log").open("w", encoding="utf-8")
    process = subprocess.Popen(["dotnet", r"D:\code\memtest\bin-anil\TorrentFlow.dll",
        "--urls", "http://127.0.0.1:3962", "--TorrentFlow:DataDirectory", str(data),
        "--TorrentFlow:Scheduler:Disabled", "true", "--background", "--no-browser"],
        env=env, stdout=log, stderr=subprocess.STDOUT)
    try:
        for attempt in range(150):
            assert process.poll() is None, f"Server {process.pid} exited"
            try:
                urllib.request.urlopen("http://127.0.0.1:3962/api/health", timeout=1).read()
                break
            except Exception:
                time.sleep(.1)
        else:
            raise RuntimeError("Server never became ready")
        for mode in ("cold", "warm"):
            start = time.perf_counter()
            with urllib.request.urlopen("http://127.0.0.1:3962" + route, timeout=30) as response:
                payload = json.load(response)
                status = response.status
            seconds = round(time.perf_counter() - start, 3)
            (proof / f"{phase}-{run}-anime-{mode}.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
            result = {"phase": phase, "route":route, "run": run, "mode": mode, "pid": process.pid,
                "status": status, "seconds": seconds,
                "rails": [{"id": rail["id"], "count":len(rail["items"]),
                    "providerIds":[card["providerId"] for card in rail["items"]]}
                    for rail in payload["rails"]]}
            results.append(result)
            print(json.dumps({k:v for k,v in result.items() if k!="rails"}) +
                f" rails={len(payload['rails'])} cards={sum(len(r['items']) for r in payload['rails'])}", flush=True)
        with sqlite3.connect(f"file:{data / 'torrentflow.db'}?mode=ro", uri=True) as db:
            caches = [{"key":key,"complete":complete,"pages":{k:len(v.get("media",[]))
                for k,v in json.loads(body).get("data",{}).items()}}
                for key, complete, body in db.execute(
                "select cacheKey,complete,payloadJson from MetadataCache where provider='anilist'")]
            results[-1]["providerCache"] = caches
        db.close()
    finally:
        if process.poll() is None:
            subprocess.run(["powershell", "-NoProfile", "-Command", f"Stop-Process -Id {process.pid}"], check=True)
        process.wait(timeout=15)
        log.close()
        (proof / f"{phase}-timings.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
        shutil.rmtree(data)
