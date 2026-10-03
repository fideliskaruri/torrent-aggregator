import json, os, pathlib, subprocess, time, urllib.request, shutil, sys

source = pathlib.Path(__file__).resolve()
root = source.parents[2] if source.parent.name == ".mcold-proof" else source.parents[1]
proof = root / "tools" / ".mcold-proof"
proof.mkdir(exist_ok=True)
phase = sys.argv[1]
run_count = int(sys.argv[2]) if len(sys.argv) > 2 else 3
paths = [
    ("all", "/api/browse"), ("anime", "/api/browse?type=anime"),
    ("films", "/api/browse?type=films"), ("series", "/api/browse?type=series"),
    ("extras", "/api/title/rick-and-morty-2013/extras?t=Rick%20and%20Morty&type=tv&s=1"),
]
results = []
env = os.environ.copy()
env["TMDB_API_KEY"] = pathlib.Path(r"C:\Users\fwachira\.copilot\session-state\88fafede-1c4e-4fcb-aa69-48d8dede6235\files\debug30\tmdb.key").read_text().strip()
env["TORRENTFLOW_METADATA_TIMINGS"] = "1"
if len(sys.argv) > 3:
    paths = [p for p in paths if p[0] in sys.argv[3].split(",")]
for run in range(1, run_count + 1):
    for name, path in paths:
        data = pathlib.Path(r"D:\code\memtest") / f"mcold-{phase}-{run}-{name}"
        data.mkdir()
        log = (proof / f"{phase}-{run}-{name}.log").open("w", encoding="utf-8")
        process = subprocess.Popen(["dotnet", r"D:\code\memtest\bin-mcold\TorrentFlow.dll",
            "--urls", "http://127.0.0.1:3962", "--TorrentFlow:DataDirectory", str(data),
            "--TorrentFlow:Scheduler:Disabled", "true", "--background", "--no-browser"],
            env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            for _ in range(100):
                if process.poll() is not None:
                    raise RuntimeError(f"Proof server exited with {process.returncode}; inspect {phase}-{run}-{name}.log")
                try:
                    urllib.request.urlopen("http://127.0.0.1:3962/api/health", timeout=1).read()
                    break
                except Exception:
                    time.sleep(.1)
            for mode in ["cold", "warm"]:
                start = time.perf_counter()
                try:
                    with urllib.request.urlopen("http://127.0.0.1:3962" + path, timeout=120) as response:
                        status, payload = response.status, json.load(response)
                except Exception as error:
                    status, payload = 0, {"error": str(error)}
                seconds = round(time.perf_counter() - start, 3)
                (proof / f"{phase}-{run}-{name}-{mode}.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
                row = {"phase": phase, "run": run, "name": name, "mode": mode, "status": status, "seconds": seconds,
                    "rails": len(payload.get("rails", [])), "cards": sum(len(r.get("items", [])) for r in payload.get("rails", [])),
                    "episodes": len(payload.get("episodes", [])), "similar": len(payload.get("moreLikeThis", []))}
                results.append(row)
                print(json.dumps(row), flush=True)
                (proof / f"{phase}-timings.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
        finally:
            if process.poll() is None:
                subprocess.run(["powershell", "-NoProfile", "-Command", f"Stop-Process -Id {process.pid}"], stdout=subprocess.DEVNULL)
            process.wait(timeout=15)
            log.close()
            shutil.rmtree(data)
