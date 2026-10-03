"""Measure each source in a fresh process/gate, with actual HTTP transport timing."""
import json
import os
import pathlib
import subprocess
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
PROOF = ROOT / "tools" / ".sources-proof"


def millis(value):
    hours, minutes, seconds = value.split(":")
    return round((int(hours) * 3600 + int(minutes) * 60 + float(seconds)) * 1000, 1)


def main():
    env = os.environ.copy()
    env["ASPNETCORE_ENVIRONMENT"] = "Development"
    previous = json.loads((PROOF / "core.json").read_text(encoding="utf-8"))
    results = []
    for source in ["apibay", "nyaa", "eztv", "yts", "torrentscsv", "knaben", "animetosho"]:
        with (PROOF / f"cold-{source}.log").open("w", encoding="utf-8") as log:
            process = subprocess.Popen([
                "dotnet", str(ROOT / "backend" / ".sources-build" / "bin" / "Api" / "debug" / "TorrentFlow.dll"),
                "--urls", "http://127.0.0.1:3945", "--TorrentFlow:DataDirectory", r"D:\code\memtest\rebuild-dev\data",
                "--TorrentFlow:Scheduler:Disabled", "true", "--background", "--no-browser",
            ], env=env, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
            try:
                for _ in range(40):
                    try:
                        with urllib.request.urlopen("http://127.0.0.1:3945/api/health", timeout=1) as response:
                            if json.load(response)["ready"]:
                                break
                    except OSError:
                        time.sleep(.2)
                else:
                    raise AssertionError("Server not ready")
                query = "Frieren" if source in ("nyaa", "animetosho") else "Scorpion" if source == "eztv" else "Sintel"
                params = {"source": source, "q": query, "lane": "owner"}
                if source == "eztv":
                    params["imdb"] = "tt3514324"
                answers = []
                for mode in ["cold", "warm-idle"]:
                    if mode == "warm-idle":
                        time.sleep(2.1)
                    started = time.monotonic()
                    with urllib.request.urlopen("http://127.0.0.1:3945/api/dev/sources/search?" + urllib.parse.urlencode(params), timeout=8) as response:
                        answer = json.load(response)
                    diagnostics = answer["diagnostics"]
                    answers.append({"mode": mode, "httpMs": round((time.monotonic() - started) * 1000, 1),
                                    "queueMs": millis(diagnostics["queueWait"]),
                                    "upstreamMs": millis(diagnostics["upstreamElapsed"]), "response": answer})
                # The first HTTP admission is never delayed by source courtesy spacing.
                assert answers[0]["queueMs"] < 100, answers[0]
                matched = next(row for row in previous if row["source"] == source and row["query"] == query)
                results.append({"source": source, "query": query, "pid": process.pid,
                                "priorQueuedHttpMs": matched["latencyMs"],
                                "priorQueueMs": millis(matched["diagnostics"]["queueWait"]),
                                "measurements": answers})
                print(source, "cold", answers[0]["httpMs"], "queue", answers[0]["queueMs"],
                      "upstream", answers[0]["upstreamMs"], "warm", answers[1]["upstreamMs"],
                      "requests", answers[0]["response"]["diagnostics"]["requests"], flush=True)
            finally:
                process.terminate()
                process.wait(timeout=10)
                (PROOF / "cold.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    print("All seven fresh host PIDs stopped.")


if __name__ == "__main__":
    main()
