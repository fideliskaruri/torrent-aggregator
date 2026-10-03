"""Integration proofs through a real host and loopback HTTP sites (never unit tests)."""
import concurrent.futures
import datetime
import http.server
import json
import os
import pathlib
import subprocess
import threading
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
PROOF = ROOT / "tools" / ".sources-proof"
EVENTS = []
LOCK = threading.Lock()
START = time.monotonic()


class Site(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("q", [""])[0]
        self.answer(query, False)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.answer(body["query"], True)

    def answer(self, query, knaben):
        with LOCK:
            EVENTS.append({"query": query, "path": self.path, "at": round(time.monotonic() - START, 3)})
        if query.startswith("hang"):
            time.sleep(10)
        if query.startswith("hold"):
            time.sleep(4.2)
        if query == "rate":
            time.sleep(1)
        if query == "partial-timeout" and "after=" in self.path:
            time.sleep(10)
        if query == "insecure-redirect":
            self.send_response(302)
            self.send_header("Location", "http://localhost:3946/redirected")
            self.end_headers()
            return
        status = 429 if query.startswith("rate") else 503 if query.startswith("unavailable") else 200
        self.send_response(status)
        if query == "rate":
            self.send_header("Retry-After", "9")
        if query == "rate-long":
            self.send_header("Retry-After", "500")
        if query == "unavailable-date":
            import email.utils
            self.send_header("Retry-After", email.utils.formatdate(time.time() + 12, usegmt=True))
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        if self.path.startswith("/nyaa"):
            body = (b'<!DOCTYPE rss [<!ENTITY external SYSTEM "http://localhost:3946/xxe">]>'
                    b'<rss><channel><title>&external;</title></channel></rss>') if query == "dtd" else (
                    b'<rss><channel><item><title>A & broken RSS</title></item></channel></rss>')
        elif self.path.startswith("/csv"):
            body = json.dumps({"next": 1, "torrents": [
                {"name": f"Unparsed name {i}", "infohash": f"{i+1:040x}", "size_bytes": 12345, "seeders": 5}
                for i in range(25)]}).encode()
        elif query == "partial":
            body = json.dumps([{"id": str(i), "name": f"Raw release {i}", "info_hash": f"{i+1:040x}",
                                "seeders": str(i), "size": "12345"} for i in range(100)]).encode()
        elif knaben:
            body = b'{"hits":[],"total":{"value":0,"relation":"eq"}}'
        else:
            body = b'[]'
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


def call(query, source="apibay", lane="owner", stream=False):
    params = urllib.parse.urlencode({"q": query, "source": source, "lane": lane, "stream": str(stream).lower()})
    start = time.monotonic()
    with urllib.request.urlopen("http://127.0.0.1:3945/api/dev/sources/search?" + params, timeout=9) as response:
        if stream:
            rows = []
            for line in response:
                rows.append({"atMs": round((time.monotonic() - start) * 1000), "batch": json.loads(line)})
            return rows
        answer = json.load(response)
    return {"latencyMs": round((time.monotonic() - start) * 1000), "answer": answer}


def main():
    PROOF.mkdir(exist_ok=True)
    stub = http.server.ThreadingHTTPServer(("127.0.0.1", 3946), Site)
    threading.Thread(target=stub.serve_forever, daemon=True).start()
    env = os.environ.copy()
    env["ASPNETCORE_ENVIRONMENT"] = "Development"
    output = (PROOF / "stub-server.log").open("w", encoding="utf-8")
    process = subprocess.Popen([
        "dotnet", str(ROOT / "backend" / ".sources-build" / "bin" / "Api" / "debug" / "TorrentFlow.dll"),
        "--urls", "http://127.0.0.1:3945", "--TorrentFlow:DataDirectory", r"D:\code\memtest\rebuild-dev\data",
        "--TorrentFlow:Scheduler:Disabled", "true",
        "--TorrentFlow:Sources:apibay:BaseUrl", "http://127.0.0.1:3946/apibay",
        "--TorrentFlow:Sources:nyaa:BaseUrl", "http://127.0.0.1:3946/nyaa",
        "--TorrentFlow:Sources:knaben:BaseUrl", "http://localhost:3946/knaben",
        "--TorrentFlow:Sources:torrentscsv:BaseUrl", "http://localhost:3946/csv",
        "--TorrentFlow:Sources:yts:Enabled", "false",
        "--background", "--no-browser"
    ], env=env, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT)
    (PROOF / "stub-server.pid").write_text(str(process.pid), encoding="utf-8")
    evidence = {"pid": process.pid, "checks": {}}
    try:
        for _ in range(40):
            try:
                with urllib.request.urlopen("http://127.0.0.1:3945/api/health", timeout=1) as response:
                    if json.load(response)["ready"]:
                        break
            except (OSError, ValueError):
                time.sleep(0.2)
        else:
            raise AssertionError("Bench server did not become ready.")
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            evidence["checks"]["deadline"] = call("hang-deadline")
            assert evidence["checks"]["deadline"]["answer"]["outcome"] == "TimedOut"
            assert 5700 <= evidence["checks"]["deadline"]["latencyMs"] <= 6500
            # All eight enqueue together; only the first three can start before their shared six-second budget.
            futures = [pool.submit(call, f"queued-{i}") for i in range(8)]
            evidence["checks"]["enqueueDeadline"] = [future.result() for future in futures]
            denied = [r for r in evidence["checks"]["enqueueDeadline"] if r["answer"]["outcome"] == "TimedOut"]
            assert denied and all(r["answer"]["diagnostics"]["requests"] == 0 for r in denied)
            assert all(5700 <= r["latencyMs"] <= 6500 for r in denied)
            time.sleep(2.1)
            first = pool.submit(call, "hold-first", lane="background")
            for _ in range(30):
                with LOCK:
                    if any(e["query"] == "hold-first" for e in EVENTS):
                        break
                time.sleep(0.05)
            bg1 = pool.submit(call, "lane-bg1", lane="background")
            time.sleep(0.1)
            bg2 = pool.submit(call, "lane-bg2", lane="background")
            time.sleep(0.1)
            owner = pool.submit(call, "lane-owner")
            evidence["checks"]["priority"] = {
                "first": first.result(), "bg1": bg1.result(), "bg2": bg2.result(), "owner": owner.result()}
            ordered = [e["query"] for e in EVENTS if e["query"].startswith("lane-")]
            evidence["checks"]["priority"]["startOrder"] = ordered
            assert ordered[0] == "lane-owner", ordered
        evidence["checks"]["stream"] = call("partial", stream=True)
        assert len(evidence["checks"]["stream"]) >= 4
        assert evidence["checks"]["stream"][-1]["batch"]["complete"] is False
        assert len(evidence["checks"]["stream"][-1]["batch"]["results"]) == 80
        evidence["checks"]["malformedRss"] = call("bad-feed", "nyaa")
        assert evidence["checks"]["malformedRss"]["answer"]["outcome"] == "Failed"
        evidence["checks"]["dtd"] = call("dtd", "nyaa")
        assert evidence["checks"]["dtd"]["answer"]["outcome"] == "Failed"
        assert not any(e["path"].startswith("/xxe") for e in EVENTS)
        evidence["checks"]["partialDeadline"] = call("partial-timeout", "torrentscsv", stream=True)
        partial = evidence["checks"]["partialDeadline"]
        assert len(partial) >= 3 and partial[0]["atMs"] < 2000
        assert partial[-1]["batch"]["outcome"] == "TimedOut"
        assert len(partial[-1]["batch"]["results"]) == 25
        assert partial[-1]["batch"]["complete"] is False
        evidence["checks"]["disabled"] = call("setting-disabled", "yts")
        assert evidence["checks"]["disabled"]["answer"]["diagnostics"]["code"] == "Disabled"
        assert evidence["checks"]["disabled"]["answer"]["diagnostics"]["requests"] == 0
        evidence["checks"]["optInDefault"] = call("default-disabled", "archive")
        assert evidence["checks"]["optInDefault"]["answer"]["diagnostics"]["code"] == "Disabled"
        evidence["checks"]["fallbackDefault"] = call("fallback-enabled", "bitsearch")
        assert evidence["checks"]["fallbackDefault"]["answer"]["outcome"] == "Unconfigured"
        evidence["checks"]["insecureRedirect"] = call("insecure-redirect")
        assert evidence["checks"]["insecureRedirect"]["answer"]["diagnostics"]["code"] == "InvalidRedirect"
        assert not any(e["path"].startswith("/redirected") for e in EVENTS)
        evidence["checks"]["noCooldown503"] = call("unavailable")
        evidence["checks"]["after503"] = call("after-503")
        assert evidence["checks"]["after503"]["answer"]["outcome"] == "Success"
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            rated = pool.submit(call, "rate")
            for _ in range(60):
                with LOCK:
                    if any(e["query"] == "rate" for e in EVENTS):
                        break
                time.sleep(0.05)
            evidence["checks"]["queuedCooldown"] = call("queued-cooling")
            evidence["checks"]["429"] = rated.result()
        assert evidence["checks"]["queuedCooldown"]["answer"]["outcome"] == "CoolingDown"
        assert evidence["checks"]["queuedCooldown"]["latencyMs"] < 1500
        assert evidence["checks"]["queuedCooldown"]["answer"]["diagnostics"]["requests"] == 0
        evidence["checks"]["cooldown"] = call("skip-me")
        evidence["checks"]["sharedHostCooldown"] = call("skip-nyaa", "nyaa")
        evidence["checks"]["independentSite"] = call("independent", "knaben")
        cooled = evidence["checks"]["cooldown"]
        assert cooled["answer"]["outcome"] == "CoolingDown" and cooled["latencyMs"] < 500
        assert cooled["answer"]["retryAt"] is not None and cooled["answer"]["diagnostics"]["requests"] == 0
        assert evidence["checks"]["sharedHostCooldown"]["answer"]["outcome"] == "CoolingDown"
        assert evidence["checks"]["independentSite"]["answer"]["outcome"] == "Success"
        assert not any(e["query"] in ("skip-me", "skip-nyaa") for e in EVENTS)
        time.sleep(9.1)
        evidence["checks"]["date503"] = call("unavailable-date")
        evidence["checks"]["dateCooldown"] = call("skip-date")
        assert evidence["checks"]["dateCooldown"]["answer"]["outcome"] == "CoolingDown"
        time.sleep(12.1)
        evidence["checks"]["default429"] = call("rate-no-header")
        now = datetime.datetime.now(datetime.timezone.utc)
        due = datetime.datetime.fromisoformat(evidence["checks"]["default429"]["answer"]["retryAt"])
        assert 29 <= (due - now).total_seconds() <= 31
        evidence["checks"]["defaultCooldown"] = call("skip-default")
        assert evidence["checks"]["defaultCooldown"]["answer"]["outcome"] == "CoolingDown"
        time.sleep(30.1)
        evidence["checks"]["repeated429"] = call("rate-no-header")
        now = datetime.datetime.now(datetime.timezone.utc)
        due = datetime.datetime.fromisoformat(evidence["checks"]["repeated429"]["answer"]["retryAt"])
        assert 59 <= (due - now).total_seconds() <= 61
        evidence["checks"]["long429"] = call("rate-long", "knaben")
        now = datetime.datetime.now(datetime.timezone.utc)
        due = datetime.datetime.fromisoformat(evidence["checks"]["long429"]["answer"]["retryAt"])
        assert 499 <= (due - now).total_seconds() <= 501
        evidence["checks"]["longCooldown"] = call("skip-long", "knaben")
        assert evidence["checks"]["longCooldown"]["answer"]["outcome"] == "CoolingDown"
        evidence["passed"] = True
    finally:
        evidence["upstreamStarts"] = EVENTS
        (PROOF / "infrastructure.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
        process.terminate()
        process.wait(timeout=10)
        evidence["stoppedPid"] = process.pid
        (PROOF / "infrastructure.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
        stub.shutdown()
        stub.server_close()
        output.close()
    print(json.dumps({key: value.get("latencyMs", value.get("startOrder", "recorded"))
                      if isinstance(value, dict) else "recorded" for key, value in evidence["checks"].items()}, indent=2))
    print("PASS", process.pid, "stopped")


if __name__ == "__main__":
    main()
