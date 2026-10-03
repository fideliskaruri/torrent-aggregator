"""Additional real HTTP checks for cancellation, priority, expiry and metadata waits."""
import concurrent.futures
import hashlib
import http.client
import json
import sqlite3
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "tools" / ".check-proof"
DATA = Path(r"D:\code\memtest\rebuild-check\data")
BASE = "http://127.0.0.1:3948"


def request(path, body=None, method=None):
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method=method)
    with urllib.request.urlopen(req, timeout=180) as response:
        data = response.read()
        return json.loads(data) if data else None


def candidate(label):
    return {"hash": hashlib.sha1(label.encode()).hexdigest(), "magnet": None,
            "name": label, "listedSeeders": 0, "torrentUri": None}


def main():
    report = {}
    for body in [{"candidates": []}, {"candidates": None},
                 {"candidates": [{"hash": "bad"}]},
                 {"candidates": [{"hash": "1" * 40, "magnet": "magnet:?xt=urn:btih:" + "2" * 40}]}]:
        try:
            request("/api/dev/check", body)
            raise AssertionError("Invalid input accepted")
        except urllib.error.HTTPError as ex:
            assert ex.code == 400
    report["invalidInputs400"] = 4
    cancelled = candidate("check-only-cancellation-OPS715")
    connection = http.client.HTTPConnection("127.0.0.1", 3948, timeout=5)
    connection.request("POST", "/api/dev/check", json.dumps({
        "candidates": [cancelled], "forceFresh": True}), {"Content-Type": "application/json"})
    time.sleep(.6)
    connection.close()
    time.sleep(1)
    state = request("/api/dev/check/status")
    with sqlite3.connect(DATA / "torrentflow.db") as db:
        count = db.execute("select count(*) from Verdict where hash=?", [cancelled["hash"]]).fetchone()[0]
    assert state["active"] == 0 and count == 0, (state, count)
    report["lastWaiterCancellation"] = {"verdictRows": count, "state": state}

    public = json.loads((ROOT / "tools" / ".engine-proof" / "fixtures.json").read_text())[0]
    survivor_candidate = {"hash": public["hash"], "magnet": public["magnet"],
                          "name": public["title"], "listedSeeders": None, "torrentUri": None}
    before = request("/api/dev/check/status")
    connection = http.client.HTTPConnection("127.0.0.1", 3948, timeout=5)
    connection.request("POST", "/api/dev/check", json.dumps({
        "candidates": [survivor_candidate], "forceFresh": True}), {"Content-Type": "application/json"})
    time.sleep(.2)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        survivor = pool.submit(request, "/api/dev/check", {
            "candidates": [survivor_candidate], "forceFresh": True})
        time.sleep(.5)
        connection.close()
        surviving_result = survivor.result()
    after = request("/api/dev/check/status")
    assert surviving_result["results"][0]["bytesDelivered"] > 0, surviving_result
    assert after["physicalProbes"] - before["physicalProbes"] == 1
    assert after["sharedWaiters"] - before["sharedWaiters"] == 1
    report["oneWaiterCancellation"] = {"survivor": surviving_result, "physicalProbes": 1}

    background = [candidate("check-background-" + str(i)) for i in range(6)]
    owner = [candidate("check-owner-" + str(i)) for i in range(12)]
    admitted = {}
    samples = []
    start = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        bg = pool.submit(request, "/api/dev/check", {"candidates": background, "forceFresh": True, "background": True})
        time.sleep(.7)
        ow = pool.submit(request, "/api/dev/check", {"candidates": owner, "forceFresh": True})
        while not bg.done() or not ow.done():
            status = request("/api/dev/check/status")
            engine = request("/api/dev/engine/torrents")
            seconds = time.perf_counter() - start
            for item in engine["diagnostics"]:
                admitted.setdefault(item["hash"], seconds)
            samples.append({"seconds": seconds, "status": status,
                            "hashes": [d["hash"] for d in engine["diagnostics"]]})
            time.sleep(.3)
        bg.result()
        ow.result()
    assert max(s["status"]["backgroundActive"] for s in samples) <= 2
    assert max(s["status"]["active"] for s in samples) <= 10
    owner_admissions = [admitted[r["hash"]] for r in owner]
    later_background = [admitted[r["hash"]] for r in background[2:]]
    assert max(owner_admissions) <= min(later_background), (owner_admissions, later_background)
    report["ownerPriority"] = {"ownerAdmittedSeconds": owner_admissions,
                               "queuedBackgroundAdmittedSeconds": later_background,
                               "peakBackground": max(s["status"]["backgroundActive"] for s in samples)}
    (OUT / "priority-samples.json").write_text(json.dumps(samples, indent=2), encoding="utf-8")

    summary = json.loads((OUT / "summary.json").read_text())
    unknowns = [r for r in summary["rows"] if r["band"] == "Unknown"][:4]
    waits = []
    for row in unknowns[:3]:
        waits.append(request("/api/dev/check/metadata-wait",
                             {"targetId": "metadata-cap-proof", "hash": row["hash"], "magnet": None}))
    fourth = request("/api/dev/check/metadata-wait",
                     {"targetId": "metadata-cap-proof", "hash": unknowns[3]["hash"], "magnet": None})
    assert fourth["handle"] is None and fourth["failure"]["code"] == "metadata_wait_capacity", fourth
    shared = request("/api/dev/check/metadata-wait",
                     {"targetId": "metadata-pack-shared", "hash": unknowns[0]["hash"], "magnet": None})
    engine = request("/api/dev/engine/torrents")
    assert len(engine["diagnostics"]) == 3 and not engine["torrents"]
    assert all(d["payloadBytesReceived"] == 0 for d in engine["diagnostics"]), engine
    request("/api/dev/check/metadata-wait/" + waits[0]["handle"]["token"], method="DELETE")
    assert len(request("/api/dev/engine/torrents")["diagnostics"]) == 3
    for wait in waits[1:] + [shared]:
        request("/api/dev/check/metadata-wait/" + wait["handle"]["token"], method="DELETE")
    assert not request("/api/dev/engine/torrents")["diagnostics"]
    report["metadataWaits"] = {"accepted": waits, "fourth": fourth, "shared": shared,
                               "physicalManagers": 3, "payloadBytes": 0}

    expired = summary["rows"][-1]["hash"]
    with sqlite3.connect(DATA / "torrentflow.db") as db:
        original = db.execute("select expiresAt from Verdict where hash=?", [expired]).fetchone()[0]
        db.execute("update Verdict set expiresAt='2000-01-01T00:00:00.0000000+00:00' where hash=?", [expired])
    cached = request("/api/dev/check?hashes=" + expired)
    assert cached[0]["band"] == "Unknown" and "expired" in cached[0]["reason"]
    with sqlite3.connect(DATA / "torrentflow.db") as db:
        db.execute("update Verdict set expiresAt=? where hash=?", [original, expired])
    report["expiredUnknown"] = {"storedOriginalExpiry": original, "readAfterForcedAge": cached}
    summary["edgeProof"] = report
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    (OUT / "edge-summary.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "metadataWaits"}), flush=True)


if __name__ == "__main__":
    main()
